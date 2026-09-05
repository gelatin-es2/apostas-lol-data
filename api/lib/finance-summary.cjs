'use strict';

// Agregacao pura do GET /api/finance/summary (contrato em ingles, 2026-09-05). Sem I/O:
// recebe as transacoes e os documentos JA buscados/filtrados/ordenados/limitados pelo
// gateway (listTransactionsForMonths/listDocuments) e so soma/mapeia — filtro por mes,
// ordenacao e limite de documentos sao responsabilidade do gateway, nunca duplicados aqui.
const { financeCategoryLabel } = require('./finance-categories.cjs');
const { monthsWindow } = require('./finance-api-common.cjs');
const { publicFinanceJobErrorMessage } = require('./finance-error-codes.cjs');
const { publicResult } = require('./finance-public-job.cjs');
const { round2 } = require('./finance-extract-contract.cjs');

function mapDocument(doc) {
  const result = publicResult(doc);
  return {
    id: doc.id,
    status: doc.status,
    doc_kind: result?.doc_kind ?? null,
    institution: result?.institution ?? null,
    account_label: result?.account_label ?? null,
    ref_month: result?.ref_month ?? null,
    period_start: result?.period_start ?? null,
    period_end: result?.period_end ?? null,
    lines_detected: result?.lines_detected ?? null,
    inserted: result?.inserted ?? null,
    duplicates: result?.duplicates ?? null,
    skipped: result?.skipped ?? null,
    reconciliation: result?.reconciliation ?? null,
    note: doc.note ?? null,
    error_code: doc.error_code ?? null,
    // Nunca repassa o error_message cru do banco (pode carregar detalhe tecnico do
    // worker) — mesmo tratamento de publicJob em api/bets/register.js.
    error_message: publicFinanceJobErrorMessage(doc),
    created_at: doc.created_at ?? null,
  };
}

function monthTotals(monthTransactions) {
  let income = 0;
  let expenses = 0;
  for (const tx of monthTransactions) {
    const amount = Number(tx.amount) || 0;
    if (amount > 0) income += amount;
    else if (amount < 0) expenses += -amount;
  }
  return { income, expenses };
}

// Chave de "mesma fatura" pro card_bill_stated: institution + account_label. Duas fotos
// da MESMA fatura (mesma chave) nao podem somar 2x — so a mais recente (por created_at)
// entra na soma. Bancos diferentes (Nubank + Inter) tem chaves diferentes e somam, porque
// sao faturas de verdade diferentes fechando no mesmo mes.
function statementKey(result) {
  return `${result.institution ?? ''}␟${result.account_label ?? ''}`;
}

function computeCardBillStated(documents, month) {
  const latestByKey = new Map();
  for (const doc of documents) {
    if (doc?.status !== 'registered') continue;
    const result = doc.result && typeof doc.result === 'object' ? doc.result : null;
    if (!result || result.doc_kind !== 'fatura' || result.ref_month !== month) continue;
    if (typeof result.statement_total !== 'number' || !Number.isFinite(result.statement_total)) continue;

    const key = statementKey(result);
    const createdAtMs = doc.created_at ? Date.parse(doc.created_at) : NaN;
    const current = latestByKey.get(key);
    if (!current || (Number.isFinite(createdAtMs) && createdAtMs > current.createdAtMs)) {
      latestByKey.set(key, {
        statementTotal: result.statement_total,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -Infinity,
      });
    }
  }
  if (!latestByKey.size) return null;
  let sum = 0;
  for (const entry of latestByKey.values()) sum += entry.statementTotal;
  return round2(sum);
}

function summarizeFinance({ month, transactions = [], documents = [] }) {
  const monthTx = transactions.filter((tx) => tx?.ref_month === month);
  // Universo de income/expenses/categorias/estabelecimentos: so o mes alvo e so linha
  // que NAO esta marcada pra ignorar (auto por regra ou manual pelo dono).
  const activeTx = monthTx.filter((tx) => tx.ignore_in_totals !== true);

  const { income, expenses } = monthTotals(activeTx);
  const balance = income - expenses;

  // card_bill ignora o flag ignore_in_totals de proposito: e o total gasto no cartao no
  // mes, sem excecao — so pagamento_fatura (que e da CONTA, nao do cartao) fica de fora.
  // Estorno entra como valor positivo e reduz o total, exatamente como na fatura real.
  let cardBill = 0;
  for (const tx of monthTx) {
    if (tx.source === 'cartao' && tx.category !== 'pagamento_fatura') {
      cardBill += -(Number(tx.amount) || 0);
    }
  }

  const categoryTotals = new Map();
  const merchantTotals = new Map();
  for (const tx of activeTx) {
    const amount = Number(tx.amount) || 0;
    if (amount >= 0) continue; // by_category e top_merchants sao "pra onde foi o dinheiro" — so saida
    const spent = -amount;

    const categoryEntry = categoryTotals.get(tx.category) || { total: 0, count: 0 };
    categoryEntry.total += spent;
    categoryEntry.count += 1;
    categoryTotals.set(tx.category, categoryEntry);

    const merchantKey = tx.merchant || tx.description || '';
    const merchantEntry = merchantTotals.get(merchantKey) || { total: 0, count: 0 };
    merchantEntry.total += spent;
    merchantEntry.count += 1;
    merchantTotals.set(merchantKey, merchantEntry);
  }

  const byCategory = [...categoryTotals.entries()]
    .map(([category, entry]) => ({ category, label: financeCategoryLabel(category), total: round2(entry.total), count: entry.count }))
    .sort((a, b) => b.total - a.total);

  const topMerchants = [...merchantTotals.entries()]
    .map(([merchant, entry]) => ({ merchant, total: round2(entry.total), count: entry.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // Agrupa TODAS as transacoes por mes numa unica passada (Map por ref_month) em vez de
  // filtrar o array inteiro de novo pra cada um dos 6 meses da janela.
  const totalsByMonth = new Map();
  for (const tx of transactions) {
    if (tx?.ignore_in_totals === true || !tx?.ref_month) continue;
    const entry = totalsByMonth.get(tx.ref_month) || { income: 0, expenses: 0 };
    const amount = Number(tx.amount) || 0;
    if (amount > 0) entry.income += amount;
    else if (amount < 0) entry.expenses += -amount;
    totalsByMonth.set(tx.ref_month, entry);
  }
  const months = monthsWindow(month, 6).map((m) => {
    const totals = totalsByMonth.get(m) || { income: 0, expenses: 0 };
    return { month: m, income: round2(totals.income), expenses: round2(totals.expenses), balance: round2(totals.income - totals.expenses) };
  });

  // documents ja chega filtrado/ordenado/limitado pelo gateway (listDocuments) — aqui e
  // so mapear pro formato publico, sem refiltrar nem reordenar.
  const documentsOut = documents.map(mapDocument);

  return {
    month,
    income: round2(income),
    expenses: round2(expenses),
    balance: round2(balance),
    card_bill: round2(cardBill),
    card_bill_stated: computeCardBillStated(documents, month),
    by_category: byCategory,
    top_merchants: topMerchants,
    months,
    documents: documentsOut,
    counts: {
      transactions: monthTx.length,
      ignored: monthTx.filter((tx) => tx.ignore_in_totals === true).length,
    },
  };
}

module.exports = { summarizeFinance, round2 };
