'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FinanceExtractError, normalizeForKey, computeFinanceDedupKey, validateFinanceExtract,
} = require('../lib/finance-extract-contract.cjs');
const { FINANCE_CATEGORY_SLUGS } = require('../lib/finance-categories.cjs');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function faturaFixture(overrides = {}) {
  return {
    document: {
      doc_kind: 'fatura',
      institution: 'Nubank',
      account_label: 'Cartão final 1234',
      period_start: '2026-08-08',
      period_end: '2026-09-07',
      ref_month: '2026-09',
      statement_total: 500.0,
      skipped: [{ line: 'linha ilegivel no rodape', reason: 'ilegivel' }],
      ...overrides.document,
    },
    transactions: overrides.transactions || [
      { occurred_on: '2026-08-14', description: 'IFD*IFOOD BR', merchant: 'iFood', amount: -45.9, category: 'alimentacao' },
      { occurred_on: '2026-08-14', description: 'IFD*IFOOD BR', merchant: 'iFood', amount: -45.9, category: 'alimentacao' },
      { occurred_on: '2026-08-20', description: 'Pagamento recebido', amount: 300.0, category: 'pagamento_fatura' },
      {
        occurred_on: '2026-08-05', description: 'Compra parcelada', amount: -50.0, category: 'compras',
        installment_current: 2, installment_total: 10,
      },
      { occurred_on: '2026-08-10', description: 'Posto Shell', amount: -120.0, category: 'transporte' },
    ],
  };
}

test('fatura de 5 linhas: linhas identicas viram dedup_key distintas, ignore forcado em pagamento_fatura, ref_month herdado do documento', () => {
  const { rows, result } = validateFinanceExtract(faturaFixture(), { ownerId: OWNER_ID, jobId: JOB_ID });

  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.ref_month === '2026-09'));
  assert.ok(rows.every((row) => row.source === 'cartao'));
  assert.ok(rows.every((row) => row.owner_id === OWNER_ID && row.job_id === JOB_ID));
  assert.ok(rows.every((row) => row.category_source === 'auto'));

  // as duas linhas de IFD*IFOOD sao idênticas no extract — precisam de dedup_key
  // diferentes (dupIndex 0 e 1), senao a segunda seria descartada como duplicata falsa.
  assert.notEqual(rows[0].dedup_key, rows[1].dedup_key);
  assert.match(rows[0].dedup_key, /^[a-f0-9]{64}$/);
  assert.match(rows[1].dedup_key, /^[a-f0-9]{64}$/);

  const pagamento = rows.find((row) => row.category === 'pagamento_fatura');
  assert.equal(pagamento.ignore_in_totals, true, 'pagamento_fatura tem ignore_in_totals forcado mesmo sem o LLM marcar');

  const parcelada = rows.find((row) => row.description === 'Compra parcelada');
  assert.equal(parcelada.installment_current, 2);
  assert.equal(parcelada.installment_total, 10);

  assert.equal(result.lines_detected, 6, '5 transactions + 1 skipped');
  assert.equal(result.skipped, 1);
  assert.ok(result.reconciliation);
  assert.equal(result.reconciliation.sum_lines, 261.8);
  assert.equal(result.reconciliation.statement_total, 500);
  assert.equal(result.reconciliation.diff, 238.2);
});

test('extrato: ref_month da linha vem do occurred_on, nao do documento', () => {
  const extrato = {
    document: {
      doc_kind: 'extrato', institution: 'Itau', account_label: null,
      period_start: '2026-08-01', period_end: '2026-08-31', ref_month: '2026-08',
      statement_total: null, skipped: [],
    },
    transactions: [
      { occurred_on: '2026-07-31', description: 'Compra fim de mes', amount: -10, category: 'compras' },
      { occurred_on: '2026-08-15', description: 'Salario', amount: 3000, category: 'renda' },
    ],
  };
  const { rows, result } = validateFinanceExtract(extrato, { ownerId: OWNER_ID, jobId: JOB_ID });
  assert.equal(rows[0].ref_month, '2026-07');
  assert.equal(rows[1].ref_month, '2026-08');
  assert.ok(rows.every((row) => row.source === 'conta'));
  assert.equal(result.reconciliation, null, 'sem statement_total nao ha reconciliacao');
});

test('doc_kind "outro" (ou qualquer valor fora de fatura/extrato) rejeita com unsupported_document', () => {
  const extract = faturaFixture({ document: { doc_kind: 'outro' } });
  let error;
  try {
    validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof FinanceExtractError);
  assert.equal(error.code, 'unsupported_document');
});

test('amount zero ou nao numerico falha com extraction_failed', () => {
  for (const badAmount of [0, '45.90', null, undefined, NaN]) {
    const extract = faturaFixture({
      transactions: [{ occurred_on: '2026-08-14', description: 'x', amount: badAmount, category: 'outros' }],
    });
    let error;
    try {
      validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof FinanceExtractError, `amount ${badAmount} deveria falhar`);
    assert.equal(error.code, 'extraction_failed');
  }
});

test('categoria fora da lista fechada falha com extraction_failed', () => {
  const extract = faturaFixture({
    transactions: [{ occurred_on: '2026-08-14', description: 'x', amount: -10, category: 'categoria_inventada' }],
  });
  assert.throws(() => validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID }), (error) => {
    assert.ok(error instanceof FinanceExtractError);
    assert.equal(error.code, 'extraction_failed');
    return true;
  });
});

test('ano da linha fora de +-1 do ref_month falha', () => {
  const extract = faturaFixture({
    transactions: [{ occurred_on: '2020-08-14', description: 'x', amount: -10, category: 'outros' }],
  });
  assert.throws(() => validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID }), /extraction_failed|ano/i);
});

test('sem transactions (vazio) falha com extraction_failed', () => {
  const extract = faturaFixture({ transactions: [] });
  let error;
  try {
    validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof FinanceExtractError);
  assert.equal(error.code, 'extraction_failed');
});

test('lista de categorias validas do contrato bate com finance-categories.cjs', () => {
  const extract = faturaFixture({
    transactions: FINANCE_CATEGORY_SLUGS.map((slug, index) => ({
      occurred_on: '2026-08-01', description: `linha ${index}`, amount: -1, category: slug,
    })),
  });
  const { rows } = validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID });
  assert.equal(rows.length, FINANCE_CATEGORY_SLUGS.length);
});

test('computeFinanceDedupKey e insensivel a acento/caixa no texto normalizado', () => {
  const base = {
    ownerId: OWNER_ID, source: 'cartao', occurredOn: '2026-08-14', amount: -45.9,
    installmentCurrent: null, installmentTotal: null, dupIndex: 0,
  };
  const keyA = computeFinanceDedupKey({ ...base, institution: 'Nubank', description: 'IFOOD BR' });
  const keyB = computeFinanceDedupKey({ ...base, institution: 'NUBANK', description: 'ifood br' });
  const keyC = computeFinanceDedupKey({ ...base, institution: 'Nübànk', description: 'ÍFOOD  BR' });
  assert.equal(keyA, keyB);
  assert.equal(keyA, keyC);
});

test('computeFinanceDedupKey muda quando dupIndex muda (linhas identicas ficam distintas)', () => {
  const base = {
    ownerId: OWNER_ID, source: 'cartao', institution: 'Nubank', occurredOn: '2026-08-14',
    amount: -45.9, description: 'IFOOD BR', installmentCurrent: null, installmentTotal: null,
  };
  const key0 = computeFinanceDedupKey({ ...base, dupIndex: 0 });
  const key1 = computeFinanceDedupKey({ ...base, dupIndex: 1 });
  assert.notEqual(key0, key1);
});

test('normalizeForKey remove acento, baixa caixa e colapsa espaco', () => {
  assert.equal(normalizeForKey('  Educação   Ação  '), 'educacao acao');
  assert.equal(normalizeForKey(null), '');
});

test('reenvio do mesmo documento reproduz a mesma chave (idempotencia de reenvio)', () => {
  const extract = faturaFixture();
  const first = validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: JOB_ID });
  const second = validateFinanceExtract(extract, { ownerId: OWNER_ID, jobId: 'outro-job-mesmo-envio' });
  assert.deepEqual(first.rows.map((row) => row.dedup_key), second.rows.map((row) => row.dedup_key));
});
