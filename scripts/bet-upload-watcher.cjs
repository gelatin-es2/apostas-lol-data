#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createJobClient } = require('./bet-upload-jobs.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'cron-data', 'bet-upload-work');
const LOGS_DIR = path.join(RUNTIME_DIR, 'logs');
const LOCK_PATH = path.join(RUNTIME_DIR, '.watcher.lock');
const PROMPT_PATH = path.join(REPO_ROOT, 'scripts', 'bet-upload-worker-prompt.txt');
const DEFAULT_INTERVAL_MS = 60_000;
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

const DEFAULT_WORKER_TIMEOUT_MS = 480_000; // 8 min
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias
const ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

const MAX_WORKER_ATTEMPTS = 3;
const DEAD_LETTER_WORKER_ID = 'bet-upload-watcher-deadletter';
const MAX_ATTEMPTS_ERROR_CODE = 'max_attempts_exceeded';
const MAX_ATTEMPTS_MESSAGE = 'Não consegui processar este print após várias tentativas.';

// Casa com <id>.png|.jpg|.webp, <id>-batch.json ou <id>-result.json — nunca a pasta logs/
// nem o .watcher.lock (nenhum dos dois bate no formato de uuid + sufixo).
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORPHAN_FILE_RE = new RegExp(`^${UUID_SOURCE}(?:\\.(?:png|jpg|webp)|-batch\\.json|-result\\.json)$`, 'i');

function isEligibleJob(job, now = Date.now()) {
  if (job?.status === 'queued') return true;
  if (job?.status !== 'processing') return false;
  const leaseMs = Date.parse(job.lease_expires_at || '');
  return Number.isFinite(leaseMs) && leaseMs <= now;
}

function isDeadLetterJob(job, maxAttempts = MAX_WORKER_ATTEMPTS) {
  const attempts = Number(job?.attempts);
  return Number.isFinite(attempts) && attempts >= maxAttempts;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadWatcherConfig(env = process.env) {
  const configProject = typeof env.BET_CONFIG_PROJECT === 'string' && env.BET_CONFIG_PROJECT.trim()
    ? path.resolve(env.BET_CONFIG_PROJECT.trim())
    : REPO_ROOT;
  return require(path.join(configProject, '.claude', 'scripts', '_load-config.cjs')).loadConfig();
}

function acquireLock(options = {}) {
  const lockPath = options.lockPath || LOCK_PATH;
  const now = Number(options.now || Date.now());
  const currentPid = Number(options.pid || process.pid);
  const isAlive = options.pidIsAlive || pidIsAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const createdMs = Date.parse(existing.created_at || '');
    if (isAlive(Number(existing.pid)) && Number.isFinite(createdMs) && now - createdMs < STALE_LOCK_MS) {
      return null;
    }
  } catch {}

  const temporaryPath = `${lockPath}.${currentPid}.${now}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ pid: currentPid, created_at: new Date(now).toISOString() }), { flag: 'wx' });
  try {
    if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true });
    fs.renameSync(temporaryPath, lockPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(current.pid) === currentPid) fs.rmSync(lockPath, { force: true });
    } catch {}
  };
}

// Sobe Claude Code headless (sem UI, sem confirmação) autenticado pela assinatura local —
// nunca pela API paga. No Windows o binário só é achado de forma confiável via cmd.exe /c.
function workerCommand(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const config = options.config || loadWatcherConfig(env);
  env.SUPABASE_URL = config.supabaseUrl;
  env.SUPABASE_SECRET_KEY = config.supabaseKey;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const claudeArgs = ['-p', '--allowedTools', 'Read,Write,Glob,Bash(node *)', '--max-turns', '120'];
  return {
    command: process.platform === 'win32' ? 'cmd.exe' : 'claude',
    args: process.platform === 'win32' ? ['/d', '/s', '/c', 'claude', ...claudeArgs] : claudeArgs,
    env,
  };
}

function ensureLogsDir(logsDir = LOGS_DIR) {
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function logPathForDate(logsDir = LOGS_DIR, date = new Date()) {
  return path.join(logsDir, `worker-${date.toISOString().slice(0, 10)}.log`);
}

function appendWorkerLog(text, options = {}) {
  const logsDir = ensureLogsDir(options.logsDir);
  const target = options.logPath || logPathForDate(logsDir);
  fs.appendFileSync(target, text);
}

// Roda toda execução: sem isso o diretório de logs cresce pra sempre.
function pruneOldLogs(options = {}) {
  const logsDir = options.logsDir || LOGS_DIR;
  const maxAgeMs = options.maxAgeMs ?? LOG_RETENTION_MS;
  const now = options.now || Date.now();
  let entries;
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!/^worker-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(logsDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.rmSync(full, { force: true });
        removed += 1;
      } catch {}
    }
  }
  return removed;
}

// Roda toda execução: TEMP que sobrevive a um crash do worker (ou a um job nunca
// finalizado) nunca deve acumular pra sempre em cron-data/bet-upload-work.
function sweepOrphanFiles(options = {}) {
  const workDir = options.workDir || RUNTIME_DIR;
  const maxAgeMs = options.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const now = options.now || Date.now();
  let entries;
  try {
    entries = fs.readdirSync(workDir, { withFileTypes: true });
  } catch {
    return { removed: 0, files: [] };
  }
  const removedFiles = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    if (!ORPHAN_FILE_RE.test(entry.name)) continue;
    const full = path.join(workDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.rmSync(full, { force: true });
        removedFiles.push(entry.name);
      } catch {}
    }
  }
  return { removed: removedFiles.length, files: removedFiles };
}

// Mata a árvore inteira do processo, não só o handle direto do spawn — no Windows
// o cmd.exe /c sobe um node.exe neto que sobrevive a um child.kill() comum.
function killChildTree(child, options = {}) {
  if (process.platform === 'win32' && Number.isInteger(child?.pid)) {
    try {
      (options.spawnImpl || spawn)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {}
}

function runWorker(options = {}) {
  const prompt = fs.readFileSync(options.promptPath || PROMPT_PATH, 'utf8');
  const spec = workerCommand(options);
  const timeoutMs = Number(options.timeoutMs ?? process.env.WORKER_TIMEOUT_MS ?? DEFAULT_WORKER_TIMEOUT_MS);
  const logsDir = options.logsDir || LOGS_DIR;
  const logPath = options.logPath || logPathForDate(logsDir);

  return new Promise((resolve, reject) => {
    const startedAt = new Date();
    const child = (options.spawnImpl || spawn)(spec.command, spec.args, {
      cwd: REPO_ROOT,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    child.stdout?.on?.('data', (chunk) => { stdout += chunk; });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk; });

    function writeLog(result) {
      const finishedAt = new Date();
      const header = `[${startedAt.toISOString()}] worker cycle iniciado pid=${child.pid ?? 'n/a'} timeout_ms=${timeoutMs}\n`;
      const footer = `[${finishedAt.toISOString()}] worker cycle finalizado code=${result.code ?? 'null'} signal=${result.signal ?? 'null'}\n`;
      const body = `${header}--- stdout ---\n${stdout}--- stderr ---\n${stderr}${footer}`;
      try {
        appendWorkerLog(body, { logsDir, logPath });
      } catch {}
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      writeLog(result);
      resolve(result);
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        (options.killImpl || killChildTree)(child, options);
        finish({ code: null, signal: 'timeout' });
      }, timeoutMs);
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        appendWorkerLog(`[${new Date().toISOString()}] worker falhou ao subir: ${error.message}\n`, { logsDir, logPath });
      } catch {}
      reject(error);
    });
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.stdin.end(prompt);
  });
}

async function runWatcherCycle(options = {}) {
  const now = options.now || Date.now();

  pruneOldLogs({ logsDir: options.logsDir, maxAgeMs: options.logRetentionMs, now });
  sweepOrphanFiles({ workDir: options.workDir, maxAgeMs: options.orphanMaxAgeMs, now });

  const client = options.client || createJobClient(options.clientOptions);
  const jobs = await client.list();
  const eligible = Array.isArray(jobs) ? jobs.filter((job) => isEligibleJob(job, now)) : [];
  if (!eligible.length) return { idle: true, eligible: 0, dead_lettered: 0, worker_invoked: false };

  // client.list() já vem ordenado por created_at asc, igual à seleção FIFO do claim RPC —
  // o próximo claim() vai pegar exatamente este job, esteja ele morto ou não.
  const next = eligible[0];
  const maxAttempts = options.maxAttempts || MAX_WORKER_ATTEMPTS;

  if (isDeadLetterJob(next, maxAttempts)) {
    const claimed = await client.claim(options.deadLetterWorkerId || DEAD_LETTER_WORKER_ID, options.deadLetterLeaseSeconds || 60);
    let deadLettered = 0;
    if (claimed) {
      await client.finish({
        p_job_id: claimed.id,
        p_claim_token: claimed.claim_token,
        p_status: 'error',
        p_bet_id: null,
        p_error_code: MAX_ATTEMPTS_ERROR_CODE,
        p_error_message: MAX_ATTEMPTS_MESSAGE,
        p_result: null,
      });
      deadLettered = 1;
    }
    return { idle: false, eligible: eligible.length, dead_lettered: deadLettered, worker_invoked: false };
  }

  const result = await (options.runWorker || runWorker)(options.workerOptions);
  return {
    idle: false,
    eligible: eligible.length,
    dead_lettered: 0,
    worker_invoked: true,
    worker_exit_code: result?.code ?? null,
    worker_signal: result?.signal || null,
  };
}

async function main(argv = process.argv.slice(2), options = {}) {
  const once = argv.includes('--once');
  const intervalArg = argv.find((arg) => arg.startsWith('--interval-ms='));
  const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) : DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 15_000) throw new Error('interval-ms precisa ser >= 15000');

  const release = acquireLock(options.lockOptions);
  if (!release) return { skipped: true, reason: 'already_running' };
  try {
    do {
      const result = await runWatcherCycle(options);
      if (!options.quiet) process.stdout.write(`${JSON.stringify(result)}\n`);
      if (once) return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (true);
  } finally {
    release();
  }
}

module.exports = {
  acquireLock,
  workerCommand,
  isEligibleJob,
  isDeadLetterJob,
  main,
  runWorker,
  runWatcherCycle,
  pruneOldLogs,
  sweepOrphanFiles,
  killChildTree,
  MAX_WORKER_ATTEMPTS,
  DEAD_LETTER_WORKER_ID,
  MAX_ATTEMPTS_ERROR_CODE,
  MAX_ATTEMPTS_MESSAGE,
  LOGS_DIR,
  RUNTIME_DIR,
  PROMPT_PATH,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
