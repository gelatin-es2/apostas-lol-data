'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { runWatcherCycle } = require('../../scripts/bet-upload-watcher.cjs');
const {
  sweepExtractOrphans, createFinanceWatcherOptions, main, RUNTIME_DIR, LOGS_DIR, LOCK_PATH, PROMPT_PATH, DEAD_LETTER_WORKER_ID,
} = require('../../scripts/finance-upload-watcher.cjs');
const { createFinanceJobClient } = require('../../scripts/finance-upload-jobs.cjs');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

const financeWatcherSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/finance-upload-watcher.cjs'), 'utf8');
const financeVbs = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-finance-upload-watcher-hidden.vbs'), 'utf8');
const financeCmd = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-finance-upload-watcher.cmd'), 'utf8');
const installPs1 = fs.readFileSync(path.resolve(__dirname, '../../tools/install-finance-upload-watcher.ps1'), 'utf8');
const uninstallPs1 = fs.readFileSync(path.resolve(__dirname, '../../tools/uninstall-finance-upload-watcher.ps1'), 'utf8');
const financePrompt = fs.readFileSync(path.resolve(__dirname, '../../scripts/finance-upload-worker-prompt.txt'), 'utf8');

test('paths e ids de runtime sao proprios de financas, nunca colidem com o de bets', () => {
  assert.match(RUNTIME_DIR, /cron-data[\\/]finance-upload-work$/);
  assert.match(LOGS_DIR, /cron-data[\\/]finance-upload-work[\\/]logs$/);
  assert.match(LOCK_PATH, /cron-data[\\/]finance-upload-work[\\/]\.watcher\.lock$/);
  assert.match(PROMPT_PATH, /scripts[\\/]finance-upload-worker-prompt\.txt$/);
  assert.equal(DEAD_LETTER_WORKER_ID, 'finance-upload-watcher-deadletter');
});

test('createFinanceWatcherOptions monta o shape exato que scripts/bet-upload-watcher.cjs espera', () => {
  const fakeClient = { async list() { return []; } };
  const options = createFinanceWatcherOptions({ client: fakeClient, quiet: true });
  assert.equal(options.client, fakeClient);
  assert.equal(options.workDir, RUNTIME_DIR);
  assert.equal(options.logsDir, LOGS_DIR);
  assert.deepEqual(options.lockOptions, { lockPath: LOCK_PATH });
  assert.equal(options.deadLetterWorkerId, DEAD_LETTER_WORKER_ID);
  assert.deepEqual(options.workerOptions, { promptPath: PROMPT_PATH, logsDir: LOGS_DIR });
  assert.equal(options.quiet, true);
});

test('createFinanceWatcherOptions aceita overrides de workDir/logsDir/lockOptions/workerOptions', () => {
  const options = createFinanceWatcherOptions({
    client: {},
    workDir: '/tmp/custom-work',
    logsDir: '/tmp/custom-logs',
    lockOptions: { lockPath: '/tmp/custom.lock' },
    workerOptions: { timeoutMs: 1000 },
  });
  assert.equal(options.workDir, '/tmp/custom-work');
  assert.equal(options.logsDir, '/tmp/custom-logs');
  assert.deepEqual(options.lockOptions, { lockPath: '/tmp/custom.lock' });
  assert.deepEqual(options.workerOptions, { promptPath: PROMPT_PATH, logsDir: '/tmp/custom-logs', timeoutMs: 1000 });
});

test('dead-letter via runWatcherCycle com createFinanceWatcherOptions nunca repassa p_bet_id pro HTTP da RPC de financas', async () => {
  // O composto (scripts/bet-upload-watcher.cjs::runWatcherCycle) monta o payload de
  // dead-letter com p_bet_id:null SEMPRE, ignorando qual client foi injetado — quem
  // tem que descartar essa chave e o client.finish de financas antes do POST (ver
  // finance-upload-worker.test.cjs). Este teste prova a composicao ponta a ponta:
  // client REAL (createFinanceJobClient) + fetchImpl fake capturando o HTTP de fato.
  const now = Date.parse('2026-09-04T12:00:00Z');
  const httpCalls = [];
  const client = createFinanceJobClient({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      httpCalls.push({ url, options });
      if (url.includes('/rpc/claim_finance_upload_job')) return jsonResponse([{ id: 'fin-job-1', claim_token: 'tok-1' }]);
      if (url.includes('/rpc/finish_finance_upload_job')) return jsonResponse([{ id: 'fin-job-1', status: 'error' }]);
      return jsonResponse([]);
    },
  });
  const options = createFinanceWatcherOptions({ client, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'finance-watcher-dl-')) });
  const result = await runWatcherCycle({
    ...options,
    now,
    client: { async list() { return [{ id: 'fin-job-1', status: 'queued', attempts: 3, created_at: '2026-09-04T10:00:00Z' }]; }, claim: client.claim, finish: client.finish },
    async runWorker() { throw new Error('nao deveria invocar o worker'); },
  });

  assert.equal(result.dead_lettered, 1);
  const finishCall = httpCalls.find((call) => call.url.includes('/rpc/finish_finance_upload_job'));
  assert.ok(finishCall, 'a RPC de finish precisa ter sido chamada');
  const sentBody = JSON.parse(finishCall.options.body);
  assert.equal('p_bet_id' in sentBody, false, 'p_bet_id nunca pode chegar no HTTP da RPC de financas');
  assert.equal(sentBody.p_job_id, 'fin-job-1');
  assert.equal(sentBody.p_claim_token, 'tok-1');
  assert.equal(sentBody.p_status, 'error');
  assert.equal(sentBody.p_error_code, 'max_attempts_exceeded');
});

test('sweepExtractOrphans apaga somente <uuid>-extract.json com mais de 48h, nunca -result.json nem outros TEMPs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-orphans-'));
  try {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const now = Date.parse('2026-09-04T00:00:00Z');
    const oldMs = now - 72 * 60 * 60 * 1000;
    const freshMs = now - 1 * 60 * 60 * 1000;

    const oldExtract = path.join(dir, `${uuid}-extract.json`);
    const oldResult = path.join(dir, `${uuid}-result.json`);
    const oldImage = path.join(dir, `${uuid}.png`);
    const freshUuid = '22222222-2222-4222-8222-222222222222';
    const freshExtract = path.join(dir, `${freshUuid}-extract.json`);
    const lockFile = path.join(dir, '.watcher.lock');

    for (const file of [oldExtract, oldResult, oldImage, freshExtract, lockFile]) fs.writeFileSync(file, 'x');
    for (const file of [oldExtract, oldResult, oldImage, lockFile]) fs.utimesSync(file, new Date(oldMs), new Date(oldMs));
    fs.utimesSync(freshExtract, new Date(freshMs), new Date(freshMs));

    const { removed, files } = sweepExtractOrphans({ workDir: dir, now });
    assert.equal(removed, 1);
    assert.deepEqual(files, [`${uuid}-extract.json`]);
    assert.equal(fs.existsSync(oldExtract), false);
    assert.equal(fs.existsSync(oldResult), true, 'sweep proprio nao toca -result.json (isso ja e coberto pelo sweep generico de bets)');
    assert.equal(fs.existsSync(oldImage), true, 'sweep proprio nao toca imagem (coberta pelo sweep generico de bets)');
    assert.equal(fs.existsSync(freshExtract), true, 'extract recente nao pode ser apagado');
    assert.equal(fs.existsSync(lockFile), true, '.watcher.lock nunca pode ser tocado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main varre orfaos de extract antes de delegar pro watcher de bets composto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-watcher-main-'));
  try {
    const uuid = '33333333-3333-4333-8333-333333333333';
    const now = Date.parse('2026-09-04T00:00:00Z');
    const oldExtract = path.join(dir, `${uuid}-extract.json`);
    fs.writeFileSync(oldExtract, 'x');
    fs.utimesSync(oldExtract, new Date(now - 72 * 60 * 60 * 1000), new Date(now - 72 * 60 * 60 * 1000));

    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-watcher-lock-'));
    const client = { async list() { return []; } };
    const result = await main(['--once'], {
      client, workDir: dir, now, lockOptions: { lockPath: path.join(lockDir, '.watcher.lock') }, quiet: true,
    });

    assert.equal(fs.existsSync(oldExtract), false, 'main precisa varrer orfaos antes de delegar');
    assert.deepEqual(result, { idle: true, eligible: 0, dead_lettered: 0, worker_invoked: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher de financas nunca altera workerCommand nem duplica logica de lock/spawn do de bets', () => {
  assert.match(financeWatcherSource, /require\(['"]\.\/bet-upload-watcher\.cjs['"]\)/);
  assert.doesNotMatch(financeWatcherSource, /function workerCommand/);
  assert.doesNotMatch(financeWatcherSource, /function runWorker\(/);
  assert.doesNotMatch(financeWatcherSource, /function acquireLock/);
  assert.doesNotMatch(financeWatcherSource, /\bcodex\b/i);
});

test('.vbs e .cmd de financas trocam so o script, mantem BET_CONFIG_PROJECT e nunca vazam secret', () => {
  assert.match(financeVbs, /finance-upload-watcher\.cjs/);
  assert.match(financeVbs, /BET_CONFIG_PROJECT/);
  assert.match(financeVbs, /C:\\Users\\Elvis\\projects\\apostas-lol-data/);
  assert.doesNotMatch(financeVbs, /bet-upload-watcher\.cjs/);
  assert.doesNotMatch(financeVbs, /SUPABASE_(?:SECRET|SERVICE_ROLE)|sb_secret_|Bearer/i);

  assert.match(financeCmd, /finance-upload-watcher\.cjs/);
  assert.match(financeCmd, /BET_CONFIG_PROJECT=C:\\Users\\Elvis\\projects\\apostas-lol-data/);
  assert.doesNotMatch(financeCmd, /bet-upload-watcher\.cjs/);
});

test('install/uninstall .ps1 usam o nome de tarefa e os paths proprios de financas', () => {
  assert.match(installPs1, /ApostasLoL-FinanceUploadWatcher/);
  assert.match(installPs1, /run-finance-upload-watcher-hidden\.vbs/);
  assert.match(installPs1, /finance-upload-watcher\.cjs/);
  assert.match(installPs1, /cron-data\\finance-upload-work\\logs\\/);
  assert.doesNotMatch(installPs1, /ApostasLoL-BetUploadWatcher/);

  assert.match(uninstallPs1, /ApostasLoL-FinanceUploadWatcher/);
  assert.match(uninstallPs1, /finance-upload-watcher\.cjs/);
  assert.doesNotMatch(uninstallPs1, /ApostasLoL-BetUploadWatcher/);
});

test('prompt do worker de financas contem os comandos-chave e nunca menciona termos do pipeline de bets', () => {
  assert.match(financePrompt, /purge 25/);
  // 900s (15 min) — o worker morre por timeout em 12 min; um lease de 3600s deixaria o
  // job travado como "processing" por quase 1h depois de o worker ja ter sumido.
  assert.match(financePrompt, /claim claude-finance 900/);
  assert.match(financePrompt, /cron-data\/finance-upload-work\/<id>\.<ext>/);
  assert.match(financePrompt, /<id>-extract\.json/);
  assert.match(financePrompt, /register <id> <claim_token>/);
  assert.match(financePrompt, /cleanup <id>/);
  assert.match(financePrompt, /unreadable_image/);
  assert.match(financePrompt, /unsupported_document/);
  assert.match(financePrompt, /extraction_failed/);
  assert.match(financePrompt, /NUNCA invente linha/);
  assert.match(financePrompt, /1\.234,56/);

  assert.doesNotMatch(financePrompt, /bet-logger/i);
  assert.doesNotMatch(financePrompt, /lolesports/i);
  assert.doesNotMatch(financePrompt, /register-batch/i);
  assert.doesNotMatch(financePrompt, /bet_upload/i);
});
