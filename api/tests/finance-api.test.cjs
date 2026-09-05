'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFinanceGateway } = require('../lib/finance-gateway.cjs');
const { createUploadHandler } = require('../finance/upload.js');
const { createSummaryHandler } = require('../finance/summary.js');
const { createTransactionsHandler } = require('../finance/transactions.js');
const { currentMonthSaoPaulo, monthsWindow, sanitizeSearch } = require('../lib/finance-api-common.cjs');
const { COOKIE_NAME, createAccessSession } = require('../lib/bet-upload-auth.cjs');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')}`;
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '223e4567-e89b-42d3-a456-426614174000';

// Mesma trava de acesso do bets — o cookie agora vale pra /api inteiro, entao o ambiente
// de teste e o mesmo (nenhuma env nova pra financas).
process.env.BET_UPLOAD_OWNER_ID = OWNER_ID;
process.env.BET_UPLOAD_SESSION_SECRET = 'x'.repeat(48);
const AUTH_COOKIE = `${COOKIE_NAME}=${createAccessSession({ ownerId: OWNER_ID, secret: process.env.BET_UPLOAD_SESSION_SECRET })}`;
const withAuth = (headers) => ({ ...headers, cookie: AUTH_COOKIE });
const SAME_ORIGIN_HEADERS = withAuth({ host: 'apostas.example', 'sec-fetch-site': 'same-origin' });

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

// --- fetch fake pro gateway (fila de respostas, registra cada chamada) -------------------
function fetchQueue(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const item = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof item === 'function' ? item(url, init) : item;
    },
  };
}

function jsonResponse(status, body, headersMap = {}) {
  const lowerHeaders = Object.fromEntries(Object.entries(headersMap).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lowerHeaders[String(name).toLowerCase()] ?? null },
    async text() { return body === undefined ? '' : JSON.stringify(body); },
  };
}

// =========================================================================================
// Gateway: createFinanceGateway com fetch fake (exige env; nunca bate no Supabase real)
// =========================================================================================

function withGatewayEnv(run) {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.test', SUPABASE_SECRET_KEY: 'fake-secret' });
  try {
    return run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('gateway: createJob renomeia description para note antes de mandar pro Supabase', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(201, [{ id: 'job-1', note: 'nota', status: 'queued' }])]);
    const gateway = createFinanceGateway(fetchImpl);
    const job = await gateway.createJob({
      owner_id: OWNER_ID, ingestion_hash: 'h'.repeat(64), storage_path: `${OWNER_ID}/h.png`, mime_type: 'image/png', description: 'nota', status: 'queued',
    });
    assert.equal(job.id, 'job-1');
    assert.match(calls[0].url, /\/rest\/v1\/finance_upload_jobs$/);
    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.note, 'nota');
    assert.equal('description' in sentBody, false);
  });
});

test('gateway: uploadImage e deleteImage usam o bucket finance-uploads', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, null), jsonResponse(200, null)]);
    const gateway = createFinanceGateway(fetchImpl);
    await gateway.uploadImage(`${OWNER_ID}/h.png`, Buffer.from('x'), 'image/png');
    await gateway.deleteImage(`${OWNER_ID}/h.png`);
    assert.match(calls[0].url, /\/storage\/v1\/object\/finance-uploads\//);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[1].url, /\/storage\/v1\/object\/finance-uploads\//);
    assert.equal(calls[1].init.method, 'DELETE');
  });
});

test('gateway: listTransactionsForMonths pagina de 1000 em 1000 ate a pagina voltar menor (2003 linhas = 3 chamadas) e seleciona so os campos que o summary usa', async () => {
  await withGatewayEnv(async () => {
    const page = (n) => Array.from({ length: n }, (_, i) => ({ id: `tx-${i}` }));
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, page(1000)), jsonResponse(200, page(1000)), jsonResponse(200, page(3))]);
    const gateway = createFinanceGateway(fetchImpl);
    const rows = await gateway.listTransactionsForMonths(OWNER_ID, '2026-04', '2026-09');
    assert.equal(calls.length, 3);
    assert.equal(rows.length, 2003);
    assert.match(calls[0].url, /offset=0\b/);
    assert.match(calls[1].url, /offset=1000\b/);
    assert.match(calls[2].url, /offset=2000\b/);
    assert.match(calls[0].url, /ref_month=gte\.2026-04/);
    assert.match(calls[0].url, /ref_month=lte\.2026-09/);
    const selectMatch = decodeURIComponent(calls[0].url).match(/select=([^&]+)/);
    assert.deepEqual(selectMatch[1].split(','), ['id', 'ref_month', 'amount', 'ignore_in_totals', 'source', 'category', 'merchant', 'description']);
  });
});

test('gateway: queryTransactions nao manda Prefer count=exact e calcula total = null quando a pagina veio cheia', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, [{ id: 't1' }, { id: 't2' }])]);
    const gateway = createFinanceGateway(fetchImpl);
    const { items, total } = await gateway.queryTransactions(OWNER_ID, { limit: 2, offset: 0 });
    assert.equal(items.length, 2);
    assert.equal(total, null);
    assert.equal(calls[0].init.headers.Prefer, undefined);
    assert.match(calls[0].url, /limit=2&offset=0/);
  });
});

test('gateway: queryTransactions total = offset + items.length quando a pagina voltou incompleta', async () => {
  await withGatewayEnv(async () => {
    const { fetchImpl } = fetchQueue([jsonResponse(200, [{ id: 't1' }])]);
    const gateway = createFinanceGateway(fetchImpl);
    const { items, total } = await gateway.queryTransactions(OWNER_ID, { limit: 10, offset: 20 });
    assert.equal(items.length, 1);
    assert.equal(total, 21);
  });
});

test('gateway: queryTransactions monta filtros month/source/category/q so quando presentes', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, [], { 'Content-Range': '*/0' })]);
    const gateway = createFinanceGateway(fetchImpl);
    await gateway.queryTransactions(OWNER_ID, { month: '2026-09', source: 'cartao', category: 'mercado', q: 'ifood', limit: 10, offset: 0 });
    assert.match(calls[0].url, /ref_month=eq\.2026-09/);
    assert.match(calls[0].url, /source=eq\.cartao/);
    assert.match(calls[0].url, /category=eq\.mercado/);
    assert.match(calls[0].url, /or=\(description\.ilike\.\*ifood\*,merchant\.ilike\.\*ifood\*\)/);
  });
});

test('gateway: listDocuments monta o filtro or= exatamente como no contrato (union ref_month / nao-registered ultimos 30d)', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, [])]);
    const gateway = createFinanceGateway(fetchImpl);
    await gateway.listDocuments(OWNER_ID, '2026-09', '2026-08-10T00:00:00.000Z');
    assert.match(calls[0].url, /or=\(result->>ref_month\.eq\.2026-09,and\(status\.neq\.registered,created_at\.gte\./);
    assert.match(calls[0].url, /order=created_at\.desc/);
    assert.match(calls[0].url, /limit=50/);
  });
});

test('gateway: updateTransaction e deleteTransaction filtram por id e owner_id', async () => {
  await withGatewayEnv(async () => {
    const { calls, fetchImpl } = fetchQueue([jsonResponse(200, [{ id: 'tx-1' }]), jsonResponse(200, [{ id: 'tx-1' }])]);
    const gateway = createFinanceGateway(fetchImpl);
    await gateway.updateTransaction('tx-1', OWNER_ID, { category: 'mercado' });
    await gateway.deleteTransaction('tx-1', OWNER_ID);
    assert.match(calls[0].url, /id=eq\.tx-1/);
    assert.match(calls[0].url, new RegExp(`owner_id=eq\\.${OWNER_ID}`));
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[1].init.method, 'DELETE');
  });
});

// =========================================================================================
// api/finance/upload.js
// =========================================================================================

function makeUploadDeps(overrides = {}) {
  const calls = { upload: [], delete: [], create: [] };
  const deps = {
    ownerId: OWNER_ID,
    findJobByHash: async () => null,
    uploadImage: async (...args) => calls.upload.push(args),
    deleteImage: async (...args) => calls.delete.push(args),
    createJob: async (job) => {
      calls.create.push(job);
      return { id: JOB_ID, status: 'queued', note: job.description ?? null, error_code: null, error_message: null, result: null, created_at: '2026-09-04T12:00:00Z', purge_after: '2026-09-18T12:00:00Z', image_deleted_at: null, updated_at: '2026-09-04T12:00:00Z' };
    },
    getJobForOwner: async () => null,
    ...overrides,
  };
  return { deps, calls };
}

test('upload POST enfileira e devolve job.note sem storage_path/owner_id', async () => {
  const { deps, calls } = makeUploadDeps();
  const response = fakeResponse();
  await createUploadHandler(() => deps)({
    method: 'POST', headers: SAME_ORIGIN_HEADERS, body: { image_data_url: PNG_DATA_URL, note: 'contexto' },
  }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.job.status, 'queued');
  assert.equal(response.body.job.note, 'contexto');
  assert.equal(response.body.job.storage_path, undefined);
  assert.equal(response.body.job.owner_id, undefined);
  assert.equal(calls.create[0].description, 'contexto');
});

test('upload POST recusa 401 sem cookie de acesso, mesmo same-origin', async () => {
  const response = fakeResponse();
  await createUploadHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST', headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' }, body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'unauthorized');
});

test('upload POST fecha 403 sem Origin nem sec-fetch-site', async () => {
  const response = fakeResponse();
  await createUploadHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST', headers: {}, body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('upload POST valida imagem depois da trava de acesso', async () => {
  const { deps } = makeUploadDeps();
  const response = fakeResponse();
  await createUploadHandler(() => deps)({ method: 'POST', headers: SAME_ORIGIN_HEADERS, body: {} }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_image');
});

test('upload GET (status) retorna 200 com job publico e sem campos privados', async () => {
  const { deps } = makeUploadDeps({
    getJobForOwner: async (id, ownerId) => ({
      id,
      status: 'registered',
      note: 'nota',
      owner_id: ownerId,
      storage_path: 'private/x.png',
      claim_token: 'token-privado',
      worker_id: 'worker-1',
      error_code: null,
      error_message: null,
      result: { doc_kind: 'fatura', institution: 'Nubank', account_label: null, ref_month: '2026-09', period_start: '2026-08-08', period_end: '2026-09-07', statement_total: 100, lines_detected: 1, inserted: 1, duplicates: 0, skipped: 0, reconciliation: null },
      created_at: '2026-09-01T00:00:00Z',
      purge_after: '2026-09-15T00:00:00Z',
      image_deleted_at: null,
      updated_at: '2026-09-01T00:00:00Z',
    }),
  });
  const response = fakeResponse();
  await createUploadHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.job.note, 'nota');
  assert.equal(response.body.job.result.doc_kind, 'fatura');
  assert.equal(response.body.job.storage_path, undefined);
  assert.equal(response.body.job.owner_id, undefined);
  assert.equal(response.body.job.claim_token, undefined);
  assert.equal(response.body.job.worker_id, undefined);
});

test('upload GET com id malformado -> 400 invalid_job_id (nem chega a criar deps)', async () => {
  const response = fakeResponse();
  await createUploadHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { id: 'nao-e-uuid' },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_job_id');
});

test('upload GET job inexistente -> 404 job_not_found', async () => {
  const { deps } = makeUploadDeps({ getJobForOwner: async () => null });
  const response = fakeResponse();
  await createUploadHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'job_not_found');
});

// =========================================================================================
// api/finance/summary.js
// =========================================================================================

function makeSummaryDeps(overrides = {}) {
  const calls = { listTransactionsForMonths: [], listDocuments: [] };
  const deps = {
    ownerId: OWNER_ID,
    listTransactionsForMonths: async (ownerId, from, to) => { calls.listTransactionsForMonths.push({ ownerId, from, to }); return []; },
    listDocuments: async (ownerId, month, sinceIso) => { calls.listDocuments.push({ ownerId, month, sinceIso }); return []; },
    ...overrides,
  };
  return { deps, calls };
}

test('summary GET com month invalido -> 400 invalid_month', async () => {
  const { deps } = makeSummaryDeps();
  const response = fakeResponse();
  await createSummaryHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { month: '2026-13' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_month');
});

test('summary GET sem month usa o mes atual de Sao Paulo e busca a janela de 6 meses', async () => {
  const { deps, calls } = makeSummaryDeps();
  const response = fakeResponse();
  await createSummaryHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: {} }, response);
  assert.equal(response.statusCode, 200);
  const expectedMonth = currentMonthSaoPaulo();
  assert.equal(response.body.month, expectedMonth);
  assert.equal(calls.listTransactionsForMonths.length, 1);
  assert.equal(calls.listTransactionsForMonths[0].to, expectedMonth);
  assert.equal(calls.listTransactionsForMonths[0].from, monthsWindow(expectedMonth, 6)[0]);
  assert.equal(calls.listDocuments[0].month, expectedMonth);
});

test('summary GET com month explicito repassa a janela correta pro gateway', async () => {
  const { deps, calls } = makeSummaryDeps();
  const response = fakeResponse();
  await createSummaryHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { month: '2026-01' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.month, '2026-01');
  assert.equal(calls.listTransactionsForMonths[0].from, '2025-08');
  assert.equal(calls.listTransactionsForMonths[0].to, '2026-01');
});

test('summary GET recusa 401 sem cookie e 403 sem sinal same-site', async () => {
  const noAuth = fakeResponse();
  await createSummaryHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' }, query: {},
  }, noAuth);
  assert.equal(noAuth.statusCode, 401);

  const crossSite = fakeResponse();
  await createSummaryHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: {}, query: {},
  }, crossSite);
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.body.code, 'cross_site_request');
});

// =========================================================================================
// api/finance/transactions.js
// =========================================================================================

function makeTxDeps(overrides = {}) {
  const calls = { queryTransactions: [], updateTransaction: [], deleteTransaction: [] };
  const deps = {
    ownerId: OWNER_ID,
    queryTransactions: async (ownerId, params) => { calls.queryTransactions.push({ ownerId, params }); return { items: [], total: 0 }; },
    updateTransaction: async (id, ownerId, patch) => { calls.updateTransaction.push({ id, ownerId, patch }); return null; },
    deleteTransaction: async (id, ownerId) => { calls.deleteTransaction.push({ id, ownerId }); return 0; },
    ...overrides,
  };
  return { deps, calls };
}

test('sanitizeSearch remove coringa/virgula/parenteses e limita a 60 chars', () => {
  assert.equal(sanitizeSearch('*a,b(c)%'), 'abc');
  assert.equal(sanitizeSearch('  Café   com Leite  '), 'Café com Leite');
  assert.equal(sanitizeSearch('a'.repeat(200)).length, 60);
  assert.equal(sanitizeSearch(42), '');
});

test('transactions GET sem filtro usa limit=100 offset=0 e nao manda filtros vazios', async () => {
  const { deps, calls } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, items: [], total: 0, limit: 100, offset: 0 });
  assert.deepEqual(calls.queryTransactions[0].params, { month: undefined, source: undefined, category: undefined, q: undefined, limit: 100, offset: 0 });
});

test('transactions GET repassa filtros validos e sanitiza a busca livre', async () => {
  const { deps, calls } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({
    method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { month: '2026-09', source: 'cartao', category: 'mercado', q: '*ifood%', limit: '20', offset: '10' },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.queryTransactions[0].params, { month: '2026-09', source: 'cartao', category: 'mercado', q: 'ifood', limit: 20, offset: 10 });
});

test('transactions GET valida month/source/category/query/pagination', async () => {
  const { deps } = makeTxDeps();
  const factory = () => deps;
  const cases = [
    [{ month: 'abc' }, 'invalid_month'],
    [{ source: 'boleto' }, 'invalid_source'],
    [{ category: 'jogos' }, 'invalid_category'],
    [{ q: ['a', 'b'] }, 'invalid_query'],
    [{ limit: '0' }, 'invalid_pagination'],
    [{ limit: '201' }, 'invalid_pagination'],
    [{ offset: '-1' }, 'invalid_pagination'],
  ];
  for (const [query, code] of cases) {
    const response = fakeResponse();
    await createTransactionsHandler(factory)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query }, response);
    assert.equal(response.statusCode, 400, `esperava 400 pra ${JSON.stringify(query)}`);
    assert.equal(response.body.code, code, `esperava ${code} pra ${JSON.stringify(query)}`);
  }
});

test('transactions GET nunca vaza owner_id/dedup_key/raw mesmo se o gateway devolver', async () => {
  const { deps } = makeTxDeps({
    queryTransactions: async () => ({ items: [{ id: 't1', owner_id: OWNER_ID, dedup_key: 'x'.repeat(64), raw: { a: 1 }, amount: -10 }], total: 1 }),
  });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.items[0].owner_id, undefined);
  assert.equal(response.body.items[0].dedup_key, undefined);
  assert.equal(response.body.items[0].raw, undefined);
  assert.equal(response.body.items[0].amount, -10);
});

test('transactions GET recusa 401 sem cookie', async () => {
  const response = fakeResponse();
  await createTransactionsHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' }, query: {},
  }, response);
  assert.equal(response.statusCode, 401);
});

test('transactions PATCH categoria valida seta category_source manual', async () => {
  const { deps, calls } = makeTxDeps({
    updateTransaction: async (id, ownerId, patch) => { calls.updateTransaction.push({ id, ownerId, patch }); return { id, category: patch.category, category_source: 'manual', amount: -10 }; },
  });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, category: 'mercado' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.item.category, 'mercado');
  assert.equal(response.body.item.category_source, 'manual');
  assert.equal(calls.updateTransaction[0].patch.category, 'mercado');
  assert.equal(calls.updateTransaction[0].patch.category_source, 'manual');
  assert.ok(typeof calls.updateTransaction[0].patch.updated_at === 'string');
});

test('transactions PATCH categoria pagamento_fatura sem ignore_in_totals explicito forca ignore_in_totals=true (AUTO_IGNORE_CATEGORIES)', async () => {
  const { deps, calls } = makeTxDeps({
    updateTransaction: async (id, ownerId, patch) => { calls.updateTransaction.push({ id, ownerId, patch }); return { id, category: patch.category, ignore_in_totals: patch.ignore_in_totals, amount: -10 }; },
  });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, category: 'pagamento_fatura' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.updateTransaction[0].patch.ignore_in_totals, true);
});

test('transactions PATCH categoria comum sem ignore_in_totals explicito forca ignore_in_totals=false', async () => {
  const { deps, calls } = makeTxDeps({
    updateTransaction: async (id, ownerId, patch) => { calls.updateTransaction.push({ id, ownerId, patch }); return { id, category: patch.category, ignore_in_totals: patch.ignore_in_totals, amount: -10 }; },
  });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, category: 'mercado' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.updateTransaction[0].patch.ignore_in_totals, false);
});

test('transactions PATCH categoria + ignore_in_totals explicito: a escolha do dono vence a regra automatica', async () => {
  const { deps, calls } = makeTxDeps({
    updateTransaction: async (id, ownerId, patch) => { calls.updateTransaction.push({ id, ownerId, patch }); return { id, category: patch.category, ignore_in_totals: patch.ignore_in_totals, amount: -10 }; },
  });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({
    method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, category: 'pagamento_fatura', ignore_in_totals: false },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.updateTransaction[0].patch.ignore_in_totals, false);
});

test('transactions PATCH categoria invalida -> 400 invalid_category', async () => {
  const { deps } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, category: 'jogos' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_category');
});

test('transactions PATCH id invalido -> 400 invalid_transaction_id', async () => {
  const { deps } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: 'nao-uuid', category: 'mercado' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_transaction_id');
});

test('transactions PATCH ignore_in_totals nao booleano -> 400 invalid_ignore_flag', async () => {
  const { deps } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, ignore_in_totals: 'sim' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_ignore_flag');
});

test('transactions PATCH notes acima do limite -> 400 invalid_notes', async () => {
  const { deps } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, notes: 'a'.repeat(501) } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_notes');
});

test('transactions PATCH sem nenhum campo -> 400 empty_patch', async () => {
  const { deps } = makeTxDeps();
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'empty_patch');
});

test('transactions PATCH transacao inexistente -> 404 transaction_not_found', async () => {
  const { deps } = makeTxDeps({ updateTransaction: async () => null });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'PATCH', headers: SAME_ORIGIN_HEADERS, body: { id: JOB_ID, ignore_in_totals: true } }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'transaction_not_found');
});

test('transactions PATCH fecha 403 fail-closed sem Origin nem sec-fetch-site', async () => {
  const response = fakeResponse();
  await createTransactionsHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'PATCH', headers: {}, body: { id: JOB_ID, ignore_in_totals: true },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('transactions DELETE remove e retorna deleted:1', async () => {
  const { deps, calls } = makeTxDeps({ deleteTransaction: async (id, ownerId) => { calls.deleteTransaction.push({ id, ownerId }); return 1; } });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'DELETE', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, deleted: 1 });
  assert.equal(calls.deleteTransaction[0].id, JOB_ID);
});

test('transactions DELETE inexistente -> 404 transaction_not_found', async () => {
  const { deps } = makeTxDeps({ deleteTransaction: async () => 0 });
  const response = fakeResponse();
  await createTransactionsHandler(() => deps)({ method: 'DELETE', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'transaction_not_found');
});

test('transactions DELETE id invalido -> 400 (nem chega a criar deps)', async () => {
  const response = fakeResponse();
  await createTransactionsHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'DELETE', headers: SAME_ORIGIN_HEADERS, query: { id: 'nao-uuid' },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_transaction_id');
});

test('transactions metodo nao suportado -> 405', async () => {
  const response = fakeResponse();
  await createTransactionsHandler(() => ({ ownerId: OWNER_ID }))({ method: 'PUT', headers: SAME_ORIGIN_HEADERS, query: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.body.code, 'method_not_allowed');
});
