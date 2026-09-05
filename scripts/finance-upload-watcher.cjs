#!/usr/bin/env node
'use strict';

// Watcher de Financas: COMPOE o watcher de bets (scripts/bet-upload-watcher.cjs) via
// require em vez de copiar a logica de lock/loop/dead-letter/timeout/kill-tree — a
// unica coisa especifica daqui e o client (fila/RPCs proprias), os paths de runtime
// (fila/lock/logs proprios) e a varredura de <uuid>-extract.json (o `sweepOrphanFiles`
// de bets nao cobre esse sufixo). NUNCA editar scripts/bet-upload-watcher.cjs a partir
// deste arquivo nem duplicar workerCommand/runWorker/runWatcherCycle aqui.

const fs = require('fs');
const path = require('path');
const betWatcher = require('./bet-upload-watcher.cjs');
const { createFinanceJobClient } = require('./finance-upload-jobs.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'cron-data', 'finance-upload-work');
const LOGS_DIR = path.join(RUNTIME_DIR, 'logs');
const LOCK_PATH = path.join(RUNTIME_DIR, '.watcher.lock');
const PROMPT_PATH = path.join(REPO_ROOT, 'scripts', 'finance-upload-worker-prompt.txt');
const DEAD_LETTER_WORKER_ID = 'finance-upload-watcher-deadletter';
const ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h — mesmo prazo do sweep de bets

// Casa exclusivamente com <uuid>-extract.json — o unico TEMP que o sweep generico de
// bets (regex .png|.jpg|.webp|-batch.json|-result.json) nao cobre. `-result.json` de
// financas ja e coberto pelo sweep generico (mesmo sufixo usado pelos dois pipelines).
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTRACT_ORPHAN_RE = new RegExp(`^${UUID_SOURCE}-extract\\.json$`, 'i');

function sweepExtractOrphans(options = {}) {
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
    if (!EXTRACT_ORPHAN_RE.test(entry.name)) continue;
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

// Monta as options que scripts/bet-upload-watcher.cjs `main`/`runWatcherCycle` esperam,
// trocando so o que precisa ser proprio de financas: client, diretorios de fila/log,
// lock, worker id do dead-letter e o prompt. NUNCA altera workerCommand (Claude Code
// headless continua o mesmo binario/credencial local, so muda o prompt que ele le).
function createFinanceWatcherOptions(overrides = {}) {
  const client = overrides.client || createFinanceJobClient(overrides.clientOptions);
  const logsDir = overrides.logsDir || LOGS_DIR;
  return {
    client,
    workDir: overrides.workDir || RUNTIME_DIR,
    logsDir,
    lockOptions: { lockPath: LOCK_PATH, ...(overrides.lockOptions || {}) },
    deadLetterWorkerId: overrides.deadLetterWorkerId || DEAD_LETTER_WORKER_ID,
    workerOptions: { promptPath: PROMPT_PATH, logsDir, ...(overrides.workerOptions || {}) },
    runWorker: overrides.runWorker,
    quiet: overrides.quiet,
  };
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  sweepExtractOrphans({ workDir: overrides.workDir || RUNTIME_DIR, now: overrides.now });
  const options = createFinanceWatcherOptions(overrides);
  return betWatcher.main(argv, options);
}

module.exports = {
  sweepExtractOrphans,
  createFinanceWatcherOptions,
  main,
  RUNTIME_DIR,
  LOGS_DIR,
  LOCK_PATH,
  PROMPT_PATH,
  DEAD_LETTER_WORKER_ID,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
