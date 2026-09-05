'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeFinance, round2 } = require('../lib/finance-summary.cjs');
const fixture = require('./finance-transactions.fixture.json');

function summarizeFixture(overrides = {}) {
  return summarizeFinance({
    month: '2026-09',
    transactions: fixture.transactions,
    documents: fixture.documents,
    ...overrides,
  });
}

test('totais do mes: income, expenses, balance e card_bill (estorno positivo reduz o total)', () => {
  const summary = summarizeFixture();
  assert.equal(summary.month, '2026-09');
  assert.equal(summary.income, 5420);
  assert.equal(summary.expenses, 2612.45);
  assert.equal(summary.balance, 2807.55);
  // card_bill ignora o flag ignore_in_totals (so exclui categoria pagamento_fatura) e o
  // estorno do Amazon (+120) entra positivo, reduzindo o total gasto no cartao.
  assert.equal(summary.card_bill, 452.45);
});

test('pagamento de fatura entra ignorado nos totais mas conta em counts.ignored', () => {
  const summary = summarizeFixture();
  assert.equal(summary.counts.transactions, 16);
  assert.equal(summary.counts.ignored, 2); // tx-06 (pagamento_fatura auto) + tx-14 (ignore manual)
});

test('by_category: so saidas, total positivo, ordenado desc, com label da lista fechada', () => {
  const summary = summarizeFixture();
  assert.equal(summary.by_category.length, 10);
  assert.deepEqual(summary.by_category[0], { category: 'moradia', label: 'Moradia', total: 1200, count: 1 });
  assert.deepEqual(summary.by_category[1], { category: 'apostas', label: 'Apostas', total: 500, count: 1 });
  assert.deepEqual(summary.by_category.at(-1), { category: 'transporte', label: 'Transporte', total: 18, count: 1 });
  for (let i = 1; i < summary.by_category.length; i += 1) {
    assert.ok(summary.by_category[i - 1].total >= summary.by_category[i].total, 'by_category precisa estar desc');
  }
  // categoria "apostas" (deposito/saque de casa) entra pelo valor, sem tratamento especial.
  assert.ok(summary.by_category.some((c) => c.category === 'apostas'));
});

test('top_merchants: chave merchant||description, top 8 por total desc', () => {
  const summary = summarizeFixture();
  assert.equal(summary.top_merchants.length, 8);
  assert.deepEqual(summary.top_merchants[0], { merchant: 'Aluguel Setembro', total: 1200, count: 1 });
  assert.deepEqual(summary.top_merchants.at(-1), { merchant: 'iFood', total: 78, count: 2 });
  assert.ok(!summary.top_merchants.some((m) => m.merchant === 'Netflix'), 'Netflix (55.90) fica fora do top 8');
  assert.ok(!summary.top_merchants.some((m) => m.merchant === 'Uber'), 'Uber (18.00) fica fora do top 8');
});

test('months: 6 itens asc terminando no mes pedido, com zero nos meses vazios (agrupado num unico passe)', () => {
  const summary = summarizeFixture();
  assert.equal(summary.months.length, 6);
  assert.deepEqual(summary.months.map((m) => m.month), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(summary.months[0], { month: '2026-04', income: 0, expenses: 0, balance: 0 });
  assert.deepEqual(summary.months[1], { month: '2026-05', income: 0, expenses: 0, balance: 0 });
  assert.deepEqual(summary.months[2], { month: '2026-06', income: 0, expenses: 0, balance: 0 });
  assert.deepEqual(summary.months[3], { month: '2026-07', income: 4700, expenses: 310, balance: 4390 });
  assert.deepEqual(summary.months[4], { month: '2026-08', income: 4800, expenses: 490, balance: 4310 });
  assert.deepEqual(summary.months[5], { month: '2026-09', income: 5420, expenses: 2612.45, balance: 2807.55 });
});

test('card_bill_stated: soma a fatura mais recente POR institution+account_label; bancos diferentes somam, 2 fotos da mesma fatura nao', () => {
  const summary = summarizeFixture();
  // job-a (05/09) e job-f (01/09) sao a MESMA fatura Nubank/Cartao final 1234 — so a
  // mais recente (job-a, 3118.90) entra. job-g e Inter (chave diferente) e soma por
  // cima: 3118.90 + 850.00 = 3968.90.
  assert.equal(summary.card_bill_stated, 3968.90);
});

test('card_bill_stated e null quando nenhum documento registered bate com o mes', () => {
  const summary = summarizeFixture({ month: '2026-10' });
  assert.equal(summary.card_bill_stated, null);
});

test('documents: so mapeia pro formato publico (filtro/ordem/limite ja vieram do gateway) e nunca vaza error_message cru', () => {
  const summary = summarizeFixture();
  assert.deepEqual(summary.documents.map((d) => d.id), fixture.documents.map((d) => d.id));

  const rejected = summary.documents.find((d) => d.id === 'job-d');
  assert.equal(rejected.error_message, 'Isso não parece fatura de cartão nem extrato bancário.');
  assert.doesNotMatch(JSON.stringify(rejected), /mensagem interna/);

  const registered = summary.documents.find((d) => d.id === 'job-a');
  assert.equal(registered.doc_kind, 'fatura');
  assert.equal(registered.institution, 'Nubank');
  assert.equal(registered.reconciliation.diff, 0);

  const queued = summary.documents.find((d) => d.id === 'job-c');
  assert.equal(queued.doc_kind, null, 'job ainda na fila nao tem result nenhum');
  assert.equal(queued.note, 'foto celular');
});

test('round2 neutraliza ruido de ponto flutuante', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(2612.4499999999998), 2612.45);
  assert.equal(round2(-45.9 - 32.1), -78);
  assert.equal(round2(0), 0);
});

test('arredondamento: totais agregados nunca saem com ruido de float', () => {
  const summary = summarizeFinance({
    month: '2026-01',
    transactions: [
      { ref_month: '2026-01', source: 'cartao', category: 'alimentacao', amount: -10.10, merchant: 'A', description: 'a', ignore_in_totals: false },
      { ref_month: '2026-01', source: 'cartao', category: 'alimentacao', amount: -20.20, merchant: 'A', description: 'a', ignore_in_totals: false },
    ],
    documents: [],
  });
  assert.equal(summary.expenses, 30.30);
  assert.equal(summary.by_category[0].total, 30.30);
  assert.equal(summary.top_merchants[0].total, 30.30);
});

test('transacao ignorada manualmente nao entra em nenhum agregado', () => {
  const summary = summarizeFixture();
  assert.ok(!summary.by_category.some((c) => c.category === 'alimentacao' && c.count === 3), 'tx-14 (ignore manual) nao pode contar em alimentacao');
  const alimentacao = summary.by_category.find((c) => c.category === 'alimentacao');
  assert.equal(alimentacao.count, 2);
  assert.equal(alimentacao.total, 78);
});
