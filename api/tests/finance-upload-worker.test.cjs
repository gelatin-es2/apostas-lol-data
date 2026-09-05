'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createFinanceJobClient, purgeExpiredImages, resolveExtractPath, cleanupJobFiles, registerExtract, main, WORK_DIR, BUCKET,
} = require('../../scripts/finance-upload-jobs.cjs');
const { FINANCE_ERROR_CODE_ALLOWLIST } = require('../lib/finance-error-codes.cjs');

const TEST_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'test-service-key',
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('WORK_DIR e BUCKET sao proprios de financas', () => {
  assert.match(WORK_DIR, /finance-upload-work$/);
  assert.equal(BUCKET, 'finance-uploads');
});

test('list pede colunas de finance_upload_jobs (note em vez de description, image_deleted_at em vez de screenshot_deleted_at)', async () => {
  let requestedUrl;
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url) => { requestedUrl = url; return jsonResponse([]); },
  });
  assert.deepEqual(await client.list(), []);
  assert.match(requestedUrl, /\/rest\/v1\/finance_upload_jobs\?/);
  assert.match(requestedUrl, /select=[^&]*note/);
  assert.match(requestedUrl, /select=[^&]*image_deleted_at/);
  assert.doesNotMatch(requestedUrl, /bet_id|screenshot_deleted_at/);
  assert.match(requestedUrl, /status=in\.\(queued,processing\)/);
});

test('claim chama a RPC claim_finance_upload_job com worker/lease', async () => {
  const calls = [];
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([{ id: 'job-1', status: 'processing', claim_token: 'claim-1' }]);
    },
  });
  const job = await client.claim('claude-finance', 3600);
  assert.equal(job.status, 'processing');
  assert.match(calls[0].url, /\/rpc\/claim_finance_upload_job$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_worker_id: 'claude-finance', p_lease_seconds: 3600 });
});

test('download baixa do bucket finance-uploads apos validar processing+claim_token', async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'finance-download-'));
  const outPath = path.join(dir, 'sub', 'job.png');
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/rest/v1/finance_upload_jobs')) return jsonResponse([{ storage_path: 'owner-1/hash.png' }]);
      return { ok: true, status: 200, async arrayBuffer() { return Buffer.from('img-bytes'); } };
    },
  });
  try {
    const resolved = await client.download('job-1', 'claim-1', outPath);
    assert.equal(resolved, path.resolve(outPath));
    assert.equal(fs.readFileSync(resolved, 'utf8'), 'img-bytes');
    assert.match(calls[0].url, /status=eq\.processing/);
    assert.match(calls[0].url, /claim_token=eq\.claim-1/);
    assert.match(calls[1].url, /\/storage\/v1\/object\/finance-uploads\/owner-1\/hash\.png$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTransactions usa on_conflict=owner_id,dedup_key com ignore-duplicates', async () => {
  const calls = [];
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([{ id: 'tx-1' }]);
    },
  });
  const rows = [{ owner_id: 'o1', dedup_key: 'k1' }, { owner_id: 'o1', dedup_key: 'k2' }];
  const inserted = await client.insertTransactions(rows);
  assert.deepEqual(inserted, [{ id: 'tx-1' }]);
  assert.match(calls[0].url, /\/rest\/v1\/finance_transactions\?on_conflict=owner_id,dedup_key$/);
  assert.equal(calls[0].options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
  assert.deepEqual(JSON.parse(calls[0].options.body), rows);
});

test('insertTransactions com lista vazia nao bate na rede', async () => {
  let calls = 0;
  const client = createFinanceJobClient({ env: TEST_ENV, fetchImpl: async () => { calls += 1; return jsonResponse([]); } });
  assert.deepEqual(await client.insertTransactions([]), []);
  assert.equal(calls, 0);
});

test('finish descarta p_bet_id antes do POST (dead-letter do watcher composto manda essa chave)', async () => {
  const calls = [];
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([{ id: 'job-1', status: 'error' }]);
    },
  });
  await client.finish({
    p_job_id: 'job-1', p_claim_token: 'claim-1', p_status: 'error', p_bet_id: null,
    p_error_code: 'max_attempts_exceeded', p_error_message: 'msg', p_result: null,
  });
  assert.match(calls[0].url, /\/rpc\/finish_finance_upload_job$/);
  const sentBody = JSON.parse(calls[0].options.body);
  assert.equal('p_bet_id' in sentBody, false, 'p_bet_id nunca pode ir no body — a RPC de financas nao tem esse parametro');
  assert.deepEqual(sentBody, {
    p_job_id: 'job-1', p_claim_token: 'claim-1', p_status: 'error',
    p_error_code: 'max_attempts_exceeded', p_error_message: 'msg', p_result: null,
  });
});

test('finish sem p_bet_id no payload segue funcionando normalmente', async () => {
  const calls = [];
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse([{ id: 'job-1', status: 'registered' }]); },
  });
  await client.finish({ p_job_id: 'job-1', p_claim_token: 'claim-1', p_status: 'registered', p_error_code: null, p_error_message: null, p_result: { ok: true } });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_job_id: 'job-1', p_claim_token: 'claim-1', p_status: 'registered', p_error_code: null, p_error_message: null, p_result: { ok: true },
  });
});

test('resolveExtractPath aceita somente <uuid>-extract.json dentro do WORK_DIR', () => {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const id = '55555555-5555-4555-8555-555555555555';
  const good = path.join(WORK_DIR, `${id}-extract.json`);
  const wrongSuffix = path.join(WORK_DIR, `${id}-batch.json`);
  const outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'finance-outside-'));
  const outsideExtract = path.join(outsideDir, `${id}-extract.json`);
  fs.writeFileSync(good, '{}');
  fs.writeFileSync(wrongSuffix, '{}');
  fs.writeFileSync(outsideExtract, '{}');
  try {
    assert.equal(resolveExtractPath(good), fs.realpathSync(good));
    assert.throws(() => resolveExtractPath(wrongSuffix), /-extract\.json/);
    assert.throws(() => resolveExtractPath(outsideExtract), /cron-data\/finance-upload-work/);
  } finally {
    fs.rmSync(good, { force: true });
    fs.rmSync(wrongSuffix, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('cleanup apaga somente os TEMPs exatos do job (imagem, extract, result) e ignora ausentes', () => {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const id = '66666666-6666-4666-8666-666666666666';
  const png = path.join(WORK_DIR, `${id}.png`);
  const extract = path.join(WORK_DIR, `${id}-extract.json`);
  const untouched = path.join(WORK_DIR, `${id}-untouched.txt`);
  fs.writeFileSync(png, 'img');
  fs.writeFileSync(extract, '{}');
  fs.writeFileSync(untouched, 'nao mexe');
  try {
    const output = cleanupJobFiles(id);
    assert.deepEqual(output.removed.sort(), [`${id}-extract.json`, `${id}.png`].sort());
    assert.equal(fs.existsSync(png), false);
    assert.equal(fs.existsSync(extract), false);
    assert.equal(fs.existsSync(untouched), true);
  } finally {
    fs.rmSync(untouched, { force: true });
  }
});

test('cleanup rejeita job_id que nao e uuid', () => {
  assert.throws(() => cleanupJobFiles('../../etc/passwd'), /uuid valido/);
  assert.throws(() => cleanupJobFiles('*'), /uuid valido/);
});

test('CLI finish coage error_code desconhecido para extraction_failed e preserva o original no result', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  await main(['finish', 'job-1', 'claim-1', 'rejected', 'nonsense_code', 'mensagem', '-'], { quiet: true, client });
  assert.equal(calls[0].p_error_code, 'extraction_failed');
  assert.deepEqual(calls[0].p_result, { original_error_code: 'nonsense_code' });
  assert.equal('p_bet_id' in calls[0], false, 'CLI de financas nunca monta p_bet_id');
});

test('CLI finish aceita o formato legado de 7 args descartando o 4o quando for exatamente "-"', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  const originalWrite = process.stderr.write;
  const stderrChunks = [];
  process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
  try {
    await main(['finish', 'job-1', 'claim-1', 'rejected', '-', 'unsupported_document', 'mensagem', '-'], { quiet: true, client });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(calls[0].p_job_id, 'job-1');
  assert.equal(calls[0].p_claim_token, 'claim-1');
  assert.equal(calls[0].p_status, 'rejected');
  assert.equal(calls[0].p_error_code, 'unsupported_document');
  assert.equal(calls[0].p_error_message, 'mensagem');
  assert.equal('p_bet_id' in calls[0], false);
  assert.ok(stderrChunks.some((chunk) => /formato legado/.test(chunk)), 'precisa avisar no stderr que caiu no formato legado');
});

test('CLI finish com 6 args (formato canonico) nao precisa de nenhum aviso', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  const originalWrite = process.stderr.write;
  const stderrChunks = [];
  process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
  try {
    await main(['finish', 'job-1', 'claim-1', 'error', 'extraction_failed', 'mensagem', '-'], { quiet: true, client });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(calls[0].p_error_code, 'extraction_failed');
  assert.equal(stderrChunks.length, 0);
});

test('CLI finish preserva codigo conhecido da allowlist sem tocar no result', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  for (const code of FINANCE_ERROR_CODE_ALLOWLIST) {
    await main(['finish', 'job-1', 'claim-1', 'rejected', code, 'mensagem', '-'], { quiet: true, client });
  }
  assert.equal(calls.length, FINANCE_ERROR_CODE_ALLOWLIST.length);
  assert.ok(calls.every((call, index) => call.p_error_code === FINANCE_ERROR_CODE_ALLOWLIST[index]));
  assert.ok(calls.every((call) => call.p_result === null));
});

test('purge lista imagens vencidas (GET), apaga do storage (DELETE, 404 tolerado) e marca image_deleted_at (PATCH)', async () => {
  const calls = [];
  const responses = [
    jsonResponse([
      { id: 'job-1', storage_path: 'owner/one.png' },
      { id: 'job-2', storage_path: 'owner/two.png' },
    ]),
    jsonResponse({}, 404), // delete job-1: ja tinha sido apagado antes
    jsonResponse(null, 204), // patch job-1
    { ok: true, status: 200, async text() { return ''; } }, // delete job-2 (sem body)
    jsonResponse(null, 204), // patch job-2
  ];
  const client = createFinanceJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); },
  });
  const summary = await purgeExpiredImages(client, { limit: 25 });
  assert.equal(summary.claimed, 2);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.already_missing, 1);
  assert.equal(summary.jobs.length, 2);

  assert.match(calls[0].url, /\/rest\/v1\/finance_upload_jobs\?/);
  assert.match(calls[0].url, /image_deleted_at=is\.null/);
  assert.match(calls[0].url, /status=in\.\(registered,rejected,error\)/);
  assert.match(calls[0].url, /purge_after=lte\./);

  assert.equal(calls[1].options.method, 'DELETE');
  assert.match(calls[1].url, /\/storage\/v1\/object\/finance-uploads\/owner\/one\.png$/);

  assert.equal(calls[2].options.method, 'PATCH');
  assert.match(calls[2].url, /finance_upload_jobs\?id=eq\.job-1$/);
  const patchBody = JSON.parse(calls[2].options.body);
  assert.ok(patchBody.image_deleted_at);
  assert.ok(patchBody.updated_at);
});

test('CLI cleanup delega pro helper', async () => {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const id = '77777777-7777-4777-8777-777777777777';
  const resultFile = path.join(WORK_DIR, `${id}-result.json`);
  fs.writeFileSync(resultFile, '{}');
  const output = await main(['cleanup', id], { quiet: true, client: {} });
  assert.deepEqual(output, { id, removed: [`${id}-result.json`] });
  assert.equal(fs.existsSync(resultFile), false);
});

// ---------------------------------------------------------------- registerExtract E2E

function makeExtractFile(id, document, transactions) {
  const extractPath = path.join(WORK_DIR, `${id}-extract.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(extractPath, JSON.stringify({ document, transactions }));
  return extractPath;
}

function faturaDoc(overrides = {}) {
  return {
    doc_kind: 'fatura', institution: 'Nubank', account_label: 'Cartão final 1234',
    period_start: '2026-08-08', period_end: '2026-09-07', ref_month: '2026-09',
    statement_total: null, skipped: [], ...overrides,
  };
}

test('registerExtract E2E: valida, insere, finaliza registered e grava result.json pra idempotencia', async (t) => {
  const id = '88888888-8888-4888-8888-888888888888';
  const claimToken = 'claim-tok-1';
  const extractPath = makeExtractFile(id, faturaDoc(), [
    { occurred_on: '2026-08-14', description: 'IFOOD BR', amount: -45.9, category: 'alimentacao' },
    { occurred_on: '2026-08-15', description: 'Uber', amount: -20, category: 'transporte' },
  ]);
  t.after(() => cleanupJobFiles(id));

  const finishCalls = [];
  const client = {
    async getClaimedJob(jobId, token) {
      assert.equal(jobId, id);
      assert.equal(token, claimToken);
      return { id: jobId, owner_id: 'owner-1', note: null, storage_path: 'owner-1/hash.png' };
    },
    async insertTransactions(rows) {
      assert.equal(rows.length, 2);
      return rows.map((row, index) => ({ id: `tx-${index}` }));
    },
    async finish(payload) { finishCalls.push(payload); return { id, status: 'registered' }; },
  };

  const output = await registerExtract(client, { jobId: id, claimToken, extractPath });
  assert.equal(output.ok, true);
  assert.equal(output.inserted, 2);
  assert.equal(output.duplicates, 0);
  assert.equal(finishCalls.length, 1);
  assert.equal(finishCalls[0].p_status, 'registered');
  assert.equal(finishCalls[0].p_result.inserted, 2);
  assert.equal(finishCalls[0].p_result.duplicates, 0);

  assert.equal(fs.existsSync(path.join(WORK_DIR, `${id}-result.json`)), true, 'idempotencia depende do cache local');
});

test('registerExtract retry: reaproveita <id>-result.json e nao reinsere', async (t) => {
  const id = '99999999-9999-4999-8999-999999999999';
  const claimToken = 'claim-tok-2';
  const extractPath = makeExtractFile(id, faturaDoc(), [
    { occurred_on: '2026-08-14', description: 'IFOOD BR', amount: -45.9, category: 'alimentacao' },
  ]);
  t.after(() => cleanupJobFiles(id));

  let insertCalls = 0;
  const finishCalls = [];
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'owner-1/hash.png' }; },
    async insertTransactions(rows) { insertCalls += 1; return rows.map(() => ({ id: 'tx-1' })); },
    async finish(payload) { finishCalls.push(payload); return { id, status: 'registered' }; },
  };

  const first = await registerExtract(client, { jobId: id, claimToken, extractPath });
  const second = await registerExtract(client, { jobId: id, claimToken, extractPath });

  assert.equal(insertCalls, 1, 'insertTransactions so pode rodar na primeira chamada');
  assert.equal(finishCalls.length, 2, 'finish pode ser chamado de novo (RPC idempotente do lado dela)');
  assert.deepEqual(first, second);
});

test('registerExtract retry com extract DIFERENTE (rows_hash mudou): insert roda de novo em vez de reaproveitar o cache', async (t) => {
  const id = 'ffffffff-6666-4666-8666-666666666666';
  const claimToken = 'claim-tok-hash';
  const extractPath = path.join(WORK_DIR, `${id}-extract.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(extractPath, JSON.stringify({
    document: faturaDoc(),
    transactions: [{ occurred_on: '2026-08-14', description: 'IFOOD BR', amount: -45.9, category: 'alimentacao' }],
  }));
  t.after(() => cleanupJobFiles(id));

  let insertCalls = 0;
  const finishCalls = [];
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'x' }; },
    async insertTransactions(rows) { insertCalls += 1; return rows.map(() => ({ id: 'tx-1' })); },
    async finish(payload) { finishCalls.push(payload); return { id, status: 'registered' }; },
  };

  const first = await registerExtract(client, { jobId: id, claimToken, extractPath });
  assert.equal(insertCalls, 1);
  assert.equal(first.inserted, 1);

  // Worker reescreve o MESMO <id>-extract.json com conteudo DIFERENTE (outra transacao,
  // outro dedup_key) e roda register de novo no MESMO job ainda processing.
  fs.writeFileSync(extractPath, JSON.stringify({
    document: faturaDoc(),
    transactions: [{ occurred_on: '2026-08-15', description: 'Uber corrigido', amount: -20, category: 'transporte' }],
  }));

  const second = await registerExtract(client, { jobId: id, claimToken, extractPath });
  assert.equal(insertCalls, 2, 'rows_hash mudou — o cache antigo nao pode ser reaproveitado');
  assert.equal(second.inserted, 1);
  assert.equal(finishCalls.length, 2);
});

test('registerExtract: JSON invalido no extract LANCA Error (nunca finaliza) — job continua processing pro worker corrigir e repetir', async (t) => {
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const claimToken = 'claim-tok-3';
  const extractPath = path.join(WORK_DIR, `${id}-extract.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(extractPath, '{ isso nao e json valido');
  t.after(() => cleanupJobFiles(id));

  let finishCalls = 0;
  let insertCalls = 0;
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'x' }; },
    async insertTransactions() { insertCalls += 1; return []; },
    async finish() { finishCalls += 1; return { id, status: 'error' }; },
  };

  await assert.rejects(() => registerExtract(client, { jobId: id, claimToken, extractPath }), (error) => {
    assert.match(error.message, /extract invalido/);
    assert.doesNotMatch(error.message, /[A-Za-z]:\\|cron-data/);
    return true;
  });
  assert.equal(finishCalls, 0, 'JSON invalido nao pode fechar o job — so um deslize pequeno do worker');
  assert.equal(insertCalls, 0);
});

test('registerExtract: erro de validacao de conteudo (categoria fora da lista) LANCA Error com o campo/motivo — nunca finaliza nem insere', async (t) => {
  const id = 'dddddddd-4444-4444-8444-444444444444';
  const claimToken = 'claim-tok-5';
  const extractPath = makeExtractFile(id, faturaDoc(), [
    { occurred_on: '2026-08-14', description: 'x', amount: -1, category: 'categoria_inventada' },
  ]);
  t.after(() => cleanupJobFiles(id));

  let finishCalls = 0;
  let insertCalls = 0;
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'x' }; },
    async insertTransactions() { insertCalls += 1; return []; },
    async finish() { finishCalls += 1; return { id, status: 'error' }; },
  };

  await assert.rejects(() => registerExtract(client, { jobId: id, claimToken, extractPath }), (error) => {
    assert.match(error.message, /extract invalido/);
    assert.match(error.message, /category/, 'mensagem precisa apontar o campo que falhou, pro worker saber o que corrigir');
    assert.doesNotMatch(error.message, /[A-Za-z]:\\|cron-data/);
    return true;
  });
  assert.equal(finishCalls, 0);
  assert.equal(insertCalls, 0);
});

test('registerExtract: worker corrige o extract depois de um erro de validacao e repete register — insere uma vez e finaliza registered', async (t) => {
  const id = 'eeeeeeee-5555-4555-8555-555555555555';
  const claimToken = 'claim-tok-6';
  const extractPath = path.join(WORK_DIR, `${id}-extract.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // 1a tentativa: categoria invalida.
  fs.writeFileSync(extractPath, JSON.stringify({
    document: faturaDoc(),
    transactions: [{ occurred_on: '2026-08-14', description: 'IFOOD BR', amount: -45.9, category: 'categoria_inventada' }],
  }));
  t.after(() => cleanupJobFiles(id));

  let insertCalls = 0;
  const finishCalls = [];
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'x' }; },
    async insertTransactions(rows) { insertCalls += 1; return rows.map(() => ({ id: 'tx-1' })); },
    async finish(payload) { finishCalls.push(payload); return { id, status: 'registered' }; },
  };

  await assert.rejects(() => registerExtract(client, { jobId: id, claimToken, extractPath }), /extract invalido/);
  assert.equal(insertCalls, 0);

  // worker corrige o arquivo (categoria valida) e roda o MESMO comando register de novo.
  fs.writeFileSync(extractPath, JSON.stringify({
    document: faturaDoc(),
    transactions: [{ occurred_on: '2026-08-14', description: 'IFOOD BR', amount: -45.9, category: 'alimentacao' }],
  }));

  const output = await registerExtract(client, { jobId: id, claimToken, extractPath });
  assert.equal(output.ok, true);
  assert.equal(output.inserted, 1);
  assert.equal(insertCalls, 1, 'insertTransactions so roda depois da correcao, nunca na tentativa invalida');
  assert.equal(finishCalls.length, 1);
  assert.equal(finishCalls[0].p_status, 'registered');
});

test('registerExtract: doc_kind "outro" finaliza rejected com unsupported_document', async (t) => {
  const id = 'bbbbbbbb-2222-4222-8222-222222222222';
  const claimToken = 'claim-tok-4';
  const extractPath = makeExtractFile(id, faturaDoc({ doc_kind: 'outro' }), [
    { occurred_on: '2026-08-14', description: 'x', amount: -1, category: 'outros' },
  ]);
  t.after(() => cleanupJobFiles(id));

  const finishCalls = [];
  const client = {
    async getClaimedJob() { return { id, owner_id: 'owner-1', note: null, storage_path: 'x' }; },
    async insertTransactions() { throw new Error('nao deveria inserir'); },
    async finish(payload) { finishCalls.push(payload); return { id, status: 'rejected' }; },
  };

  const output = await registerExtract(client, { jobId: id, claimToken, extractPath });
  assert.equal(output.ok, false);
  assert.equal(output.status, 'rejected');
  assert.equal(output.error_code, 'unsupported_document');
  assert.equal(finishCalls[0].p_status, 'rejected');
  assert.equal(finishCalls[0].p_error_code, 'unsupported_document');
  assert.equal(finishCalls[0].p_result, null);
});

test('registerExtract: job nao esta processing (claim_token errado/expirado) falha alto e nunca insere', async () => {
  const id = 'cccccccc-3333-4333-8333-333333333333';
  const extractPath = makeExtractFile(id, faturaDoc(), [
    { occurred_on: '2026-08-14', description: 'x', amount: -1, category: 'outros' },
  ]);
  const client = {
    async getClaimedJob() { return null; },
    async insertTransactions() { throw new Error('nao deveria inserir'); },
    async finish() { throw new Error('nao deveria finalizar'); },
  };
  try {
    await assert.rejects(
      () => registerExtract(client, { jobId: id, claimToken: 'claim-errado', extractPath }),
      /não está processing/,
    );
  } finally {
    cleanupJobFiles(id);
  }
});
