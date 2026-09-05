'use strict';

const crypto = require('crypto');
const { FINANCE_CATEGORY_SLUGS, AUTO_IGNORE_CATEGORIES, isFinanceCategory } = require('./finance-categories.cjs');

const MAX_TRANSACTIONS = 500;
const MAX_SKIPPED = 100;
const MAX_INSTITUTION_LENGTH = 80;
const MAX_ACCOUNT_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_MERCHANT_LENGTH = 120;
const MAX_SKIPPED_LINE_LENGTH = 300;
const MAX_SKIPPED_REASON_LENGTH = 200;

const REF_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_KINDS = new Set(['fatura', 'extrato']);

class FinanceExtractError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'FinanceExtractError';
    this.code = code;
    this.detail = detail || null;
  }
}

function fail(detail) {
  // Toda falha de validacao de CONTEUDO do extract (data impossivel, categoria fora
  // da lista, valor zerado etc) cai em extraction_failed — so doc_kind invalido tem
  // codigo proprio (unsupported_document), ver validateDocumentKind.
  throw new FinanceExtractError('extraction_failed', detail);
}

// NFKD + remove diacriticos + lowercase + colapsa espaco: usado SOMENTE na chave de
// dedup, nunca no dado exibido (o texto original mantem acento/caixa).
function normalizeForKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function round2(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

// Espelho de S2.4: 7 partes unidas por \x1f identificam a linha "de verdade" (sem
// dupIndex ainda) — usado tambem por validateTransaction pra contar repeticoes no mesmo
// extract. `dedup_key` = sha256(signature + '\x1f' + dupIndex): unica fonte da formula,
// nunca duplicar a lista de partes em outro lugar.
function buildFinanceSignature({ ownerId, source, institution, occurredOn, amount, description, installmentCurrent, installmentTotal }) {
  return [
    String(ownerId ?? ''),
    String(source ?? ''),
    normalizeForKey(institution),
    String(occurredOn ?? ''),
    Number(amount).toFixed(2),
    normalizeForKey(description),
    `${installmentCurrent ?? ''}/${installmentTotal ?? ''}`,
  ].join('\x1f');
}

// dupIndex existe pra que linhas IDENTICAS no mesmo extract (ex. 2 compras iguais no
// mesmo dia) virem chaves distintas, sem impedir que o reenvio do MESMO documento
// reproduza as mesmas chaves (idempotencia do upload duplicado).
function hashFinanceSignature(signature, dupIndex) {
  return crypto.createHash('sha256').update(`${signature}\x1f${dupIndex ?? 0}`).digest('hex');
}

function computeFinanceDedupKey({
  ownerId, source, institution, occurredOn, amount, description,
  installmentCurrent, installmentTotal, dupIndex,
}) {
  const signature = buildFinanceSignature({ ownerId, source, institution, occurredOn, amount, description, installmentCurrent, installmentTotal });
  return hashFinanceSignature(signature, dupIndex);
}

function sanitizeText(value, { maxLen, required = false, fieldName = 'campo' } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${fieldName} obrigatorio ausente`);
    return null;
  }
  if (typeof value !== 'string') fail(`${fieldName} precisa ser texto`);
  const sanitized = value.replace(/\s+/g, ' ').trim();
  if (!sanitized) {
    if (required) fail(`${fieldName} obrigatorio vazio`);
    return null;
  }
  if (maxLen && [...sanitized].length > maxLen) {
    fail(`${fieldName} excede ${maxLen} caracteres`);
  }
  return sanitized;
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sanitizeOptionalIsoDate(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (!isValidIsoDate(value)) fail(`${fieldName} precisa ser data ISO valida (AAAA-MM-DD)`);
  return value;
}

function sanitizeStatementTotal(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('statement_total precisa ser numero positivo ou null');
  }
  return round2(value);
}

function sanitizeInstallment(value, fieldName) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) fail(`${fieldName} precisa ser inteiro >= 1`);
  return num;
}

function sanitizeSkipped(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail('document.skipped precisa ser lista');
  if (list.length > MAX_SKIPPED) fail(`document.skipped excede ${MAX_SKIPPED} itens`);
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`document.skipped[${index}] invalido`);
    const line = sanitizeText(entry.line, { maxLen: MAX_SKIPPED_LINE_LENGTH, required: true, fieldName: `document.skipped[${index}].line` });
    const reason = sanitizeText(entry.reason, { maxLen: MAX_SKIPPED_REASON_LENGTH, fieldName: `document.skipped[${index}].reason` });
    return { line, reason };
  });
}

function validateDocument(rawDocument) {
  if (!rawDocument || typeof rawDocument !== 'object') {
    throw new FinanceExtractError('unsupported_document', 'document ausente ou invalido');
  }
  if (!DOC_KINDS.has(rawDocument.doc_kind)) {
    throw new FinanceExtractError('unsupported_document', 'doc_kind precisa ser fatura ou extrato');
  }
  if (!REF_MONTH_RE.test(rawDocument.ref_month || '')) fail('ref_month invalido (esperado AAAA-MM)');

  return {
    doc_kind: rawDocument.doc_kind,
    institution: sanitizeText(rawDocument.institution, { maxLen: MAX_INSTITUTION_LENGTH, required: true, fieldName: 'institution' }),
    account_label: sanitizeText(rawDocument.account_label, { maxLen: MAX_ACCOUNT_LABEL_LENGTH, fieldName: 'account_label' }),
    period_start: sanitizeOptionalIsoDate(rawDocument.period_start, 'period_start'),
    period_end: sanitizeOptionalIsoDate(rawDocument.period_end, 'period_end'),
    ref_month: rawDocument.ref_month,
    statement_total: sanitizeStatementTotal(rawDocument.statement_total),
    skipped: sanitizeSkipped(rawDocument.skipped),
  };
}

function validateTransaction(tx, index, document, ownerId, jobId, signatureCounts) {
  if (!tx || typeof tx !== 'object') fail(`transactions[${index}] invalido`);

  const occurredOn = tx.occurred_on;
  if (!isValidIsoDate(occurredOn)) fail(`transactions[${index}].occurred_on invalido (esperado AAAA-MM-DD)`);
  const refYear = Number(document.ref_month.slice(0, 4));
  const occurredYear = Number(occurredOn.slice(0, 4));
  if (Math.abs(occurredYear - refYear) > 1) fail(`transactions[${index}].occurred_on fora do intervalo de +-1 ano do ref_month`);

  const description = sanitizeText(tx.description, { maxLen: MAX_DESCRIPTION_LENGTH, required: true, fieldName: `transactions[${index}].description` });
  const merchant = sanitizeText(tx.merchant, { maxLen: MAX_MERCHANT_LENGTH, fieldName: `transactions[${index}].merchant` });

  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount === 0) {
    fail(`transactions[${index}].amount precisa ser numero finito diferente de zero`);
  }
  const amount = round2(tx.amount);
  if (amount === 0) fail(`transactions[${index}].amount arredonda para zero`);

  if (!isFinanceCategory(tx.category)) fail(`transactions[${index}].category invalida`);
  const category = tx.category;

  const installmentCurrent = sanitizeInstallment(tx.installment_current, `transactions[${index}].installment_current`);
  const installmentTotal = sanitizeInstallment(tx.installment_total, `transactions[${index}].installment_total`);
  if (installmentCurrent !== null && installmentTotal !== null && installmentCurrent > installmentTotal) {
    fail(`transactions[${index}] parcela atual maior que o total`);
  }

  const source = document.doc_kind === 'fatura' ? 'cartao' : 'conta';
  const refMonth = document.doc_kind === 'fatura' ? document.ref_month : occurredOn.slice(0, 7);
  const ignoreInTotals = Boolean(tx.ignore_in_totals) || AUTO_IGNORE_CATEGORIES.includes(category);

  const signature = buildFinanceSignature({
    ownerId, source, institution: document.institution, occurredOn, amount, description, installmentCurrent, installmentTotal,
  });
  const dupIndex = signatureCounts.get(signature) || 0;
  signatureCounts.set(signature, dupIndex + 1);

  const dedupKey = hashFinanceSignature(signature, dupIndex);

  return {
    owner_id: ownerId,
    job_id: jobId,
    source,
    institution: document.institution,
    account_label: document.account_label,
    occurred_on: occurredOn,
    ref_month: refMonth,
    description,
    merchant,
    amount,
    category,
    category_source: 'auto',
    ignore_in_totals: ignoreInTotals,
    installment_current: installmentCurrent,
    installment_total: installmentTotal,
    dedup_key: dedupKey,
    raw: { index: index + 1, ...tx },
  };
}

// Contrato completo do extract: valida document + transactions[], deriva as colunas
// prontas pro insert (rows) e monta o `result` de S2.6 (sem inserted/duplicates —
// isso so existe depois do insert real, ver scripts/finance-upload-jobs.cjs).
function validateFinanceExtract(input, { ownerId, jobId } = {}) {
  if (!ownerId) throw new Error('ownerId obrigatorio');
  const document = validateDocument(input && input.document);

  const rawTransactions = input && input.transactions;
  if (!Array.isArray(rawTransactions) || rawTransactions.length < 1 || rawTransactions.length > MAX_TRANSACTIONS) {
    fail(`transactions precisa ter 1..${MAX_TRANSACTIONS} itens`);
  }

  const signatureCounts = new Map();
  const rows = rawTransactions.map((tx, index) => validateTransaction(tx, index, document, ownerId, jobId, signatureCounts));

  const sumLines = round2(-rows
    .filter((row) => row.category !== 'pagamento_fatura')
    .reduce((acc, row) => acc + row.amount, 0));

  let reconciliation = null;
  if (document.statement_total !== null) {
    reconciliation = {
      sum_lines: sumLines,
      statement_total: document.statement_total,
      diff: round2(document.statement_total - sumLines),
    };
  }

  const result = {
    doc_kind: document.doc_kind,
    institution: document.institution,
    account_label: document.account_label,
    period_start: document.period_start,
    period_end: document.period_end,
    ref_month: document.ref_month,
    statement_total: document.statement_total,
    lines_detected: rows.length + document.skipped.length,
    skipped: document.skipped.length,
    reconciliation,
  };

  return { document, rows, result };
}

// Copia de sanitizeItemError (scripts/bet-upload-jobs.cjs): nunca deixa path de
// arquivo local vazar pra mensagem publica/gravada no banco.
function sanitizeFinanceError(error) {
  const message = String(error?.message || 'dados invalidos')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/)[^ ]+/g, '[path]')
    .slice(0, 300);
  return message || 'dados invalidos';
}

module.exports = {
  FinanceExtractError,
  normalizeForKey,
  computeFinanceDedupKey,
  validateFinanceExtract,
  sanitizeFinanceError,
  round2,
  MAX_TRANSACTIONS,
  MAX_SKIPPED,
  FINANCE_CATEGORY_SLUGS,
};
