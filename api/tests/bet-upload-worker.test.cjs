'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createJobClient, purgeExpiredScreenshots, main, configFromEnv } = require('../../scripts/bet-upload-jobs.cjs');

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

test('fallback padrao reutiliza o loader local que le .env', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-jobs.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/\.claude\/scripts\/_load-config\.cjs'\)\.loadConfig\(\)/);
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
  const job = await client.claim('codex-local', 1800);
  assert.equal(job.status, 'processing');
  assert.match(calls[0].url, /\/rpc\/claim_bet_upload_job$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_worker_id: 'codex-local',
    p_lease_seconds: 1800,
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-service-key');
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
