'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acquireLock, workerCommand, isEligibleJob, isDeadLetterJob, runWatcherCycle, runWorker,
  pruneOldLogs, sweepOrphanFiles, MAX_WORKER_ATTEMPTS, MAX_ATTEMPTS_ERROR_CODE, MAX_ATTEMPTS_MESSAGE,
} = require('../../scripts/bet-upload-watcher.cjs');
const watcherVbs = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-bet-upload-watcher-hidden.vbs'), 'utf8');

function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('idle e processing com lease viva nao invocam o worker', async () => {
  let workerCalls = 0;
  const now = Date.parse('2026-08-13T12:00:00Z');
  const result = await runWatcherCycle({
    now,
    client: { async list() { return [{ status: 'processing', lease_expires_at: '2026-08-13T12:05:00Z' }]; } },
    async runWorker() { workerCalls += 1; return { code: 0 }; },
  });
  assert.deepEqual(result, { idle: true, eligible: 0, dead_lettered: 0, worker_invoked: false });
  assert.equal(workerCalls, 0);
});

test('somente queued ou processing com lease expirada invocam um turno', async () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  assert.equal(isEligibleJob({ status: 'queued' }, now), true);
  assert.equal(isEligibleJob({ status: 'processing', lease_expires_at: '2026-08-13T11:59:59Z' }, now), true);
  assert.equal(isEligibleJob({ status: 'processing', lease_expires_at: null }, now), false);
  assert.equal(isEligibleJob({ status: 'registered' }, now), false);

  let workerCalls = 0;
  const result = await runWatcherCycle({
    now,
    client: { async list() { return [{ status: 'queued', attempts: 0 }, { status: 'processing', lease_expires_at: '2026-08-13T11:00:00Z', attempts: 0 }]; } },
    async runWorker() { workerCalls += 1; return { code: 0, signal: null }; },
  });
  assert.equal(result.eligible, 2);
  assert.equal(result.worker_invoked, true);
  assert.equal(result.dead_lettered, 0);
  assert.equal(workerCalls, 1);
});

test('workerCommand sobe Claude Code headless e remove OPENAI_API_KEY/ANTHROPIC_API_KEY do child', () => {
  const spec = workerCommand({
    env: { OPENAI_API_KEY: 'must-not-pass', ANTHROPIC_API_KEY: 'must-not-pass-either', WATCHER_TEST: 'yes' },
    config: { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'service-key' },
  });
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spec.env.WATCHER_TEST, 'yes');
  assert.equal(spec.env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(spec.env.SUPABASE_SECRET_KEY, 'service-key');
  assert.ok(spec.args.includes('-p'));
  assert.ok(spec.args.includes('--allowedTools'));
  assert.ok(spec.args.includes('Read,Write,Glob,Bash(node *)'));
  assert.ok(spec.args.includes('--max-turns'));
  assert.ok(spec.args.includes('120'));
  assert.ok(spec.args.includes('--fallback-model'));
  assert.ok(spec.args.includes('claude-opus-5'));
  assert.doesNotMatch(JSON.stringify(spec.args), /codex|exec|ephemeral|sandbox/i);
  if (process.platform === 'win32') {
    assert.equal(spec.command, 'cmd.exe');
    assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(spec.args[3], 'claude');
  } else {
    assert.equal(spec.command, 'claude');
  }
});

test('runWorker grava stdout/stderr no log do dia com timestamp e contexto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-upload-worker-'));
  try {
    const promptPath = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptPath, 'prompt de teste');
    const logsDir = path.join(dir, 'logs');
    const child = makeFakeChild();
    let spawnCalls = 0;
    const promise = runWorker({
      promptPath,
      logsDir,
      env: {},
      config: { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' },
      spawnImpl: () => { spawnCalls += 1; return child; },
    });
    child.stdout.emit('data', Buffer.from('linha de stdout'));
    child.stderr.emit('data', Buffer.from('linha de stderr'));
    child.emit('exit', 0, null);
    const result = await promise;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(spawnCalls, 1);
    assert.equal(child.stdin.end !== undefined, true);
    const files = fs.readdirSync(logsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^worker-\d{4}-\d{2}-\d{2}\.log$/);
    const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
    assert.match(content, /linha de stdout/);
    assert.match(content, /linha de stderr/);
    assert.match(content, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] worker cycle iniciado pid=4242/);
    assert.match(content, /worker cycle finalizado code=0 signal=null/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeout mata a arvore do child e resolve com signal timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-upload-worker-timeout-'));
  try {
    const promptPath = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptPath, 'p');
    const logsDir = path.join(dir, 'logs');
    const child = makeFakeChild(9999);
    const killCalls = [];
    const result = await runWorker({
      promptPath,
      logsDir,
      timeoutMs: 20,
      env: {},
      config: { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' },
      spawnImpl: () => child,
      killImpl: (c) => killCalls.push(c.pid),
    });
    assert.deepEqual(result, { code: null, signal: 'timeout' });
    assert.deepEqual(killCalls, [9999]);
    const files = fs.readdirSync(logsDir);
    const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
    assert.match(content, /worker cycle finalizado code=null signal=timeout/);

    // exit tardio depois do timeout nao pode resolver/rejeitar de novo nem duplicar log
    child.emit('exit', 0, null);
    assert.equal(fs.readdirSync(logsDir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job com attempts >= MAX_WORKER_ATTEMPTS vira dead-letter sem invocar o worker', async () => {
  assert.equal(MAX_WORKER_ATTEMPTS, 3);
  assert.equal(isDeadLetterJob({ attempts: 3 }), true);
  assert.equal(isDeadLetterJob({ attempts: 2 }), false);
  assert.equal(isDeadLetterJob({}), false);

  const now = Date.parse('2026-08-13T12:00:00Z');
  const finishCalls = [];
  let claimCalls = 0;
  let workerCalls = 0;
  const result = await runWatcherCycle({
    now,
    client: {
      async list() { return [{ id: 'job-1', status: 'queued', attempts: 3, created_at: '2026-08-13T10:00:00Z' }]; },
      async claim(workerId, leaseSeconds) { claimCalls += 1; return { id: 'job-1', claim_token: 'tok-1' }; },
      async finish(payload) { finishCalls.push(payload); return { id: 'job-1', status: 'error' }; },
    },
    async runWorker() { workerCalls += 1; return { code: 0, signal: null }; },
  });

  assert.equal(workerCalls, 0, 'job veneno nao pode chegar a invocar o worker');
  assert.equal(claimCalls, 1);
  assert.equal(finishCalls.length, 1);
  assert.equal(finishCalls[0].p_job_id, 'job-1');
  assert.equal(finishCalls[0].p_claim_token, 'tok-1');
  assert.equal(finishCalls[0].p_status, 'error');
  assert.equal(finishCalls[0].p_bet_id, null);
  assert.equal(finishCalls[0].p_error_code, MAX_ATTEMPTS_ERROR_CODE);
  assert.equal(finishCalls[0].p_error_message, MAX_ATTEMPTS_MESSAGE);
  assert.deepEqual(result, { idle: false, eligible: 1, dead_lettered: 1, worker_invoked: false });
});

test('dead-letter cede a vaga sem finish se outro worker ganhou a corrida do claim', async () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  let workerCalls = 0;
  let finishCalls = 0;
  const result = await runWatcherCycle({
    now,
    client: {
      async list() { return [{ id: 'job-1', status: 'queued', attempts: 5 }]; },
      async claim() { return null; },
      async finish() { finishCalls += 1; },
    },
    async runWorker() { workerCalls += 1; return { code: 0 }; },
  });
  assert.equal(workerCalls, 0);
  assert.equal(finishCalls, 0);
  assert.deepEqual(result, { idle: false, eligible: 1, dead_lettered: 0, worker_invoked: false });
});

test('pruneOldLogs remove somente worker-*.log com mais de 14 dias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-upload-logs-'));
  try {
    const now = Date.parse('2026-08-14T00:00:00Z');
    const oldFile = path.join(dir, 'worker-2026-07-01.log');
    const freshFile = path.join(dir, 'worker-2026-08-13.log');
    const unrelatedFile = path.join(dir, 'not-a-worker-log.txt');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    fs.writeFileSync(unrelatedFile, 'unrelated');
    const oldMs = now - 20 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(oldMs), new Date(oldMs));
    const removed = pruneOldLogs({ logsDir: dir, now });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
    assert.equal(fs.existsSync(unrelatedFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepOrphanFiles apaga TEMPs de uuid com mais de 48h e nunca toca logs/ ou .watcher.lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-upload-orphans-'));
  try {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const now = Date.parse('2026-08-14T00:00:00Z');
    const oldMs = now - 72 * 60 * 60 * 1000;
    const freshMs = now - 1 * 60 * 60 * 1000;

    const oldPng = path.join(dir, `${uuid}.png`);
    const oldBatch = path.join(dir, `${uuid}-batch.json`);
    const oldResult = path.join(dir, `${uuid}-result.json`);
    const freshUuid = '22222222-2222-4222-8222-222222222222';
    const freshPng = path.join(dir, `${freshUuid}.png`);
    const lockFile = path.join(dir, '.watcher.lock');
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir);
    const logInsideLogs = path.join(logsDir, 'worker-2020-01-01.log');

    for (const file of [oldPng, oldBatch, oldResult, freshPng, lockFile, logInsideLogs]) {
      fs.writeFileSync(file, 'x');
    }
    for (const file of [oldPng, oldBatch, oldResult, lockFile, logInsideLogs]) {
      fs.utimesSync(file, new Date(oldMs), new Date(oldMs));
    }
    fs.utimesSync(freshPng, new Date(freshMs), new Date(freshMs));

    const { removed, files } = sweepOrphanFiles({ workDir: dir, now });
    assert.equal(removed, 3);
    assert.deepEqual(files.sort(), [`${uuid}-batch.json`, `${uuid}-result.json`, `${uuid}.png`].sort());
    assert.equal(fs.existsSync(oldPng), false);
    assert.equal(fs.existsSync(oldBatch), false);
    assert.equal(fs.existsSync(oldResult), false);
    assert.equal(fs.existsSync(freshPng), true, 'arquivo recente nao pode ser apagado');
    assert.equal(fs.existsSync(lockFile), true, '.watcher.lock nunca pode ser tocado');
    assert.equal(fs.existsSync(logInsideLogs), true, 'logs/ nunca pode ser tocado pela varredura de orfaos');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher implantado reutiliza config canonica sem copiar credenciais', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-watcher.cjs'), 'utf8');
  assert.match(source, /BET_CONFIG_PROJECT/);
  assert.doesNotMatch(source, /\bcodex\b/i);
  assert.match(watcherVbs, /BET_CONFIG_PROJECT/);
  assert.match(watcherVbs, /C:\\Users\\Elvis\\projects\\apostas-lol-data/);
  assert.doesNotMatch(watcherVbs, /SUPABASE_(?:SECRET|SERVICE_ROLE)|sb_secret_|Bearer/i);
});

test('lock vivo impede segunda instancia e release preserva ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-upload-watcher-'));
  const lockPath = path.join(dir, '.watcher.lock');
  try {
    const release = acquireLock({ lockPath, pid: 111, now: Date.now(), pidIsAlive: (pid) => pid === 111 });
    assert.equal(typeof release, 'function');
    assert.equal(acquireLock({ lockPath, pid: 222, now: Date.now(), pidIsAlive: (pid) => pid === 111 }), null);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
