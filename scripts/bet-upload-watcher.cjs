#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createJobClient } = require('./bet-upload-jobs.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'cron-data', 'bet-upload-work');
const LOCK_PATH = path.join(RUNTIME_DIR, '.watcher.lock');
const PROMPT_PATH = path.join(REPO_ROOT, 'scripts', 'bet-upload-codex-prompt.txt');
const DEFAULT_INTERVAL_MS = 60_000;
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

function isEligibleJob(job, now = Date.now()) {
  if (job?.status === 'queued') return true;
  if (job?.status !== 'processing') return false;
  const leaseMs = Date.parse(job.lease_expires_at || '');
  return Number.isFinite(leaseMs) && leaseMs <= now;
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

function codexCommand(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const config = options.config || require('../.claude/scripts/_load-config.cjs').loadConfig();
  env.SUPABASE_URL = config.supabaseUrl;
  env.SUPABASE_SECRET_KEY = config.supabaseKey;
  delete env.OPENAI_API_KEY;
  return {
    command: process.platform === 'win32' ? 'cmd.exe' : 'codex',
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', 'codex', 'exec', '--ephemeral', '--sandbox', 'danger-full-access', '--cd', REPO_ROOT, '-']
      : ['exec', '--ephemeral', '--sandbox', 'danger-full-access', '--cd', REPO_ROOT, '-'],
    env,
  };
}

function runCodex(options = {}) {
  const prompt = fs.readFileSync(options.promptPath || PROMPT_PATH, 'utf8');
  const spec = codexCommand(options);
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl || spawn)(spec.command, spec.args, {
      cwd: REPO_ROOT,
      env: spec.env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.stdin.end(prompt);
  });
}

async function runWatcherCycle(options = {}) {
  const client = options.client || createJobClient(options.clientOptions);
  const jobs = await client.list();
  const eligible = Array.isArray(jobs) ? jobs.filter((job) => isEligibleJob(job, options.now || Date.now())) : [];
  if (!eligible.length) return { idle: true, eligible: 0, codex_invoked: false };

  const result = await (options.runCodex || runCodex)(options.codexOptions);
  return {
    idle: false,
    eligible: eligible.length,
    codex_invoked: true,
    codex_exit_code: result?.code ?? null,
    codex_signal: result?.signal || null,
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

module.exports = { acquireLock, codexCommand, isEligibleJob, main, runCodex, runWatcherCycle };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
