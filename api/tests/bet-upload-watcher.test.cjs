'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireLock, codexCommand, isEligibleJob, runWatcherCycle } = require('../../scripts/bet-upload-watcher.cjs');

test('idle e processing com lease viva nao invocam Codex', async () => {
  let codexCalls = 0;
  const now = Date.parse('2026-08-13T12:00:00Z');
  const result = await runWatcherCycle({
    now,
    client: { async list() { return [{ status: 'processing', lease_expires_at: '2026-08-13T12:05:00Z' }]; } },
    async runCodex() { codexCalls += 1; return { code: 0 }; },
  });
  assert.deepEqual(result, { idle: true, eligible: 0, codex_invoked: false });
  assert.equal(codexCalls, 0);
});

test('somente queued ou processing com lease expirada invocam um turno', async () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  assert.equal(isEligibleJob({ status: 'queued' }, now), true);
  assert.equal(isEligibleJob({ status: 'processing', lease_expires_at: '2026-08-13T11:59:59Z' }, now), true);
  assert.equal(isEligibleJob({ status: 'processing', lease_expires_at: null }, now), false);
  assert.equal(isEligibleJob({ status: 'registered' }, now), false);

  let codexCalls = 0;
  const result = await runWatcherCycle({
    now,
    client: { async list() { return [{ status: 'queued' }, { status: 'processing', lease_expires_at: '2026-08-13T11:00:00Z' }]; } },
    async runCodex() { codexCalls += 1; return { code: 0, signal: null }; },
  });
  assert.equal(result.eligible, 2);
  assert.equal(result.codex_invoked, true);
  assert.equal(codexCalls, 1);
});

test('comando usa Codex OAuth e remove OPENAI_API_KEY do child', () => {
  const spec = codexCommand({
    env: { OPENAI_API_KEY: 'must-not-pass', WATCHER_TEST: 'yes' },
    config: { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'service-key' },
  });
  assert.ok(spec.args.includes('exec'));
  assert.ok(spec.args.includes('--ephemeral'));
  assert.ok(spec.args.includes('--sandbox'));
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.WATCHER_TEST, 'yes');
  assert.equal(spec.env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(spec.env.SUPABASE_SECRET_KEY, 'service-key');
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
