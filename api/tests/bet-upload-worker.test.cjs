'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createJobClient, purgeExpiredScreenshots, main, configFromEnv, cleanupJobFiles } = require('../../scripts/bet-upload-jobs.cjs');
const { ERROR_CODE_ALLOWLIST } = require('../lib/bet-upload-error-codes.cjs');

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

test('config explicita ganha e nao chama fallback local', () => {
  let fallbackCalls = 0;
  const config = configFromEnv(TEST_ENV, {
    loadConfig() {
      fallbackCalls += 1;
      return { supabaseUrl: 'https://fallback.invalid', supabaseKey: 'fallback-key' };
    },
  });
  assert.deepEqual(config, { url: 'https://example.supabase.co', key: 'test-service-key' });
  assert.equal(fallbackCalls, 0);
});

test('config incompleta usa loadConfig canonico sem sobrescrever valor explicito', () => {
  let fallbackCalls = 0;
  const config = configFromEnv({ SUPABASE_URL: 'https://explicit.supabase.co/' }, {
    loadConfig() {
      fallbackCalls += 1;
      return {
        supabaseUrl: 'https://from-dotenv.supabase.co',
        supabaseKey: 'dotenv-service-key',
        source: '.env',
      };
    },
  });
  assert.deepEqual(config, { url: 'https://explicit.supabase.co', key: 'dotenv-service-key' });
  assert.equal(fallbackCalls, 1);
});

test('fallback padrao reutiliza loader local ou BET_CONFIG_PROJECT sem copiar secrets', (t) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-jobs.cjs'), 'utf8');
  assert.match(source, /BET_CONFIG_PROJECT/);
  const configProject = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bet-upload-config-'));
  t.after(() => fs.rmSync(configProject, { recursive: true, force: true }));
  const scriptsDir = path.join(configProject, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, '_load-config.cjs'), "module.exports={loadConfig(){return {supabaseUrl:'https://external.supabase.co',supabaseKey:'external-key'}}};\n");
  assert.deepEqual(configFromEnv({ BET_CONFIG_PROJECT: configProject }), {
    url: 'https://external.supabase.co', key: 'external-key',
  });
});

test('config ausente falha com mensagem sanitizada', () => {
  let error;
  try {
    configFromEnv({}, {
      loadConfig() {
        throw new Error('C:\\Users\\operator\\private\\.env: raw loader failure');
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /Configuracao Supabase ausente/);
  assert.doesNotMatch(error.message, /C:\\Users|raw loader failure|operator\\private/);
});

test('claim envia worker e lease ao RPC atomico', async () => {
  const calls = [];
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([{ id: 'job-1', status: 'processing', claim_token: 'claim-1' }]);
    },
  });
  const job = await client.claim('claude-local', 1800);
  assert.equal(job.status, 'processing');
  assert.match(calls[0].url, /\/rpc\/claim_bet_upload_job$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_worker_id: 'claude-local',
    p_lease_seconds: 1800,
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-service-key');
});

test('list inclui description como contexto auditavel do job', async () => {
  let requestedUrl;
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse([]);
    },
  });
  assert.deepEqual(await client.list(), []);
  assert.match(requestedUrl, /select=[^&]*description/);
});

test('finish aceita repeticao idempotente do mesmo resultado terminal', async () => {
  const calls = [];
  const terminal = { id: 'job-1', status: 'registered', bet_id: 'bet-1' };
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([terminal]);
    },
  });
  const payload = {
    p_job_id: 'job-1',
    p_claim_token: 'claim-1',
    p_status: 'registered',
    p_bet_id: 'bet-1',
    p_error_code: null,
    p_error_message: null,
    p_result: { source: 'bet-logger-extract' },
  };
  assert.deepEqual(await client.finish(payload), terminal);
  assert.deepEqual(await client.finish(payload), terminal);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.endsWith('/rpc/finish_bet_upload_job')));
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('CLI finish coage error_code desconhecido pra extraction_failed e preserva o original no result', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  await main(['finish', 'job-1', 'claim-1', 'rejected', '-', 'nonsense_code', 'mensagem', '-'], { quiet: true, client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_error_code, 'extraction_failed');
  assert.deepEqual(calls[0].p_result, { original_error_code: 'nonsense_code' });
});

test('CLI finish preserva error_code conhecido sem tocar no result', async () => {
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  for (const code of ERROR_CODE_ALLOWLIST) {
    await main(['finish', 'job-1', 'claim-1', 'rejected', '-', code, 'mensagem', '-'], { quiet: true, client });
  }
  assert.equal(calls.length, ERROR_CODE_ALLOWLIST.length);
  assert.ok(calls.every((call, index) => call.p_error_code === ERROR_CODE_ALLOWLIST[index]));
  assert.ok(calls.every((call) => call.p_result === null));
});

test('CLI finish preserva result existente ao coagir codigo desconhecido', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bet-upload-finish-result-'));
  const resultPath = path.join(dir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify({ source: 'worker' }));
  const calls = [];
  const client = { async finish(payload) { calls.push(payload); return payload; } };
  try {
    await main(['finish', 'job-1', 'claim-1', 'error', '-', 'weird_code', 'mensagem', resultPath], { quiet: true, client });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(calls[0].p_result, { source: 'worker', original_error_code: 'weird_code' });
  assert.equal(calls[0].p_error_code, 'extraction_failed');
});

test('cleanup apaga somente os TEMPs exatos do job e ignora ausentes', (t) => {
  const workDir = path.resolve(__dirname, '../../cron-data/bet-upload-work');
  fs.mkdirSync(workDir, { recursive: true });
  const id = '33333333-3333-4333-8333-333333333333';
  const png = path.join(workDir, `${id}.png`);
  const batch = path.join(workDir, `${id}-batch.json`);
  // <id>-result.json intencionalmente ausente pra provar que cleanup nao falha quando falta
  const untouched = path.join(workDir, `${id}-untouched.txt`);
  fs.writeFileSync(png, 'img');
  fs.writeFileSync(batch, '{}');
  fs.writeFileSync(untouched, 'nao mexe');
  t.after(() => { fs.rmSync(png, { force: true }); fs.rmSync(batch, { force: true }); fs.rmSync(untouched, { force: true }); });

  const output = cleanupJobFiles(id);
  assert.equal(output.id, id);
  assert.deepEqual(output.removed.sort(), [`${id}-batch.json`, `${id}.png`].sort());
  assert.equal(fs.existsSync(png), false);
  assert.equal(fs.existsSync(batch), false);
  assert.equal(fs.existsSync(untouched), true, 'arquivo fora do padrao <id>.<ext>/-batch/-result nunca pode ser tocado');
});

test('cleanup rejeita job_id que nao e uuid (sem curinga, sem path fora do padrao)', () => {
  assert.throws(() => cleanupJobFiles('../../etc/passwd'), /uuid valido/);
  assert.throws(() => cleanupJobFiles('*'), /uuid valido/);
  assert.throws(() => cleanupJobFiles(''), /job_id obrigat/);
});

test('CLI cleanup delega pro helper e retorna a lista de removidos', async () => {
  const workDir = path.resolve(__dirname, '../../cron-data/bet-upload-work');
  fs.mkdirSync(workDir, { recursive: true });
  const id = '44444444-4444-4444-8444-444444444444';
  const resultFile = path.join(workDir, `${id}-result.json`);
  fs.writeFileSync(resultFile, '{}');
  // cleanup nao fala com o Supabase: passa um client fake so pra nao exigir SUPABASE_URL/KEY no ambiente.
  const output = await main(['cleanup', id], { quiet: true, client: {} });
  assert.deepEqual(output, { id, removed: [`${id}-result.json`] });
  assert.equal(fs.existsSync(resultFile), false);
});

test('registerBatch envia lote inteiro para uma unica RPC transacional', async () => {
  const calls = [];
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        total: 2, inserted: 2, reused: 0,
        bet_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      });
    },
  });
  const items = [{ item_index: 1 }, { item_index: 2 }];
  const result = await client.registerBatch('job-1', 'claim-1', items);
  assert.equal(result.total, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/register_bet_upload_batch$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_job_id: 'job-1', p_claim_token: 'claim-1', p_items: items,
  });
});

test('resposta perdida nao dispara retry automatico nem segunda RPC', async () => {
  let calls = 0;
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, async text() { throw new Error('socket closed after commit'); } };
    },
  });
  await assert.rejects(() => client.registerBatch('job-1', 'claim-1', [{ item_index: 1 }]), /socket closed/);
  assert.equal(calls, 1);
});

test('worker rejeita resposta parcial/inconsistente mesmo com HTTP 200', async () => {
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async () => jsonResponse({
      total: 2, inserted: 1, reused: 0,
      bet_ids: ['11111111-1111-4111-8111-111111111111'],
    }),
  });
  await assert.rejects(
    () => client.registerBatch('job-1', 'claim-1', [{ item_index: 1 }, { item_index: 2 }]),
    /incompleta ou inconsistente/,
  );
});

test('runner usa client injetado sem rede e sem escrita para list/claim', async () => {
  const calls = [];
  const client = {
    async list() { calls.push('list'); return []; },
    async claim(worker, lease) { calls.push({ worker, lease }); return null; },
  };
  assert.deepEqual(await main(['list'], { client, quiet: true }), []);
  assert.equal(await main(['claim', 'test-worker', '600'], { client, quiet: true }), null);
  assert.deepEqual(calls, ['list', { worker: 'test-worker', lease: 600 }]);
});

test('purge usa claim atomico, DELETE privado e finish auditavel', async () => {
  const calls = [];
  const responses = [
    jsonResponse([{ id: 'job-1', storage_path: 'owner/hash.png', purge_claim_token: 'purge-1' }]),
    jsonResponse({}, 404),
    jsonResponse([{ id: 'job-1', storage_path: 'owner/hash.png', screenshot_deleted_at: '2026-08-26T00:00:00Z' }]),
  ];
  const client = createJobClient({
    env: TEST_ENV,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });
  const claimed = await client.claimPurge('purger-1', 600);
  assert.equal(claimed.purge_claim_token, 'purge-1');
  assert.match(calls[0].url, /\/rpc\/claim_bet_upload_purge$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_worker_id: 'purger-1', p_lease_seconds: 600 });

  assert.deepEqual(await client.deleteScreenshot(claimed.storage_path), { already_missing: true });
  assert.equal(calls[1].options.method, 'DELETE');
  assert.match(calls[1].url, /\/storage\/v1\/object\/bet-screenshots\/owner\/hash\.png$/);

  const finished = await client.finishPurge(claimed.id, claimed.purge_claim_token);
  assert.equal(finished.screenshot_deleted_at, '2026-08-26T00:00:00Z');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    p_job_id: 'job-1', p_purge_claim_token: 'purge-1',
  });
});

test('orquestrador de purge processa elegiveis e para no primeiro null', async () => {
  const calls = [];
  const jobs = [
    { id: 'job-1', storage_path: 'owner/one.png', purge_claim_token: 'token-1' },
    { id: 'job-2', storage_path: 'owner/two.png', purge_claim_token: 'token-2' },
    null,
  ];
  const client = {
    async claimPurge(worker, lease) { calls.push({ type: 'claim', worker, lease }); return jobs.shift(); },
    async deleteScreenshot(storagePath) {
      calls.push({ type: 'delete', storagePath });
      return { already_missing: storagePath.includes('two') };
    },
    async finishPurge(id, token) {
      calls.push({ type: 'finish', id, token });
      return { id, screenshot_deleted_at: '2026-08-26T00:00:00Z' };
    },
  };
  const summary = await purgeExpiredScreenshots(client, { workerId: 'purger', leaseSeconds: 900, limit: 10 });
  assert.deepEqual(summary, {
    claimed: 2,
    deleted: 1,
    already_missing: 1,
    jobs: [
      { id: 'job-1', screenshot_deleted_at: '2026-08-26T00:00:00Z' },
      { id: 'job-2', screenshot_deleted_at: '2026-08-26T00:00:00Z' },
    ],
  });
  assert.equal(calls.filter((call) => call.type === 'delete').length, 2);
  assert.equal(calls.filter((call) => call.type === 'finish').length, 2);
});

test('purge nao finaliza auditoria quando delete falha', async () => {
  let finished = false;
  const client = {
    async claimPurge() { return { id: 'job-1', storage_path: 'owner/hash.png', purge_claim_token: 'token' }; },
    async deleteScreenshot() { throw new Error('storage unavailable'); },
    async finishPurge() { finished = true; },
  };
  await assert.rejects(purgeExpiredScreenshots(client, { limit: 1 }), /storage unavailable/);
  assert.equal(finished, false);
});
