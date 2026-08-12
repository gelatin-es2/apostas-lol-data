'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/2026-08-12-bet-upload.sql'),
  'utf8',
);

test('migration nao altera schema, grants, constraints, indices ou policies de bets', () => {
  const forbidden = [
    /alter table public\.bets/i,
    /create (?:unique )?index[\s\S]*?on public\.bets/i,
    /drop index[\s\S]*?bets_/i,
    /(?:grant|revoke)[^;]*on (?:table )?public\.bets/i,
    /(?:create|drop) policy[^;]*on public\.bets/i,
    /comment on (?:column|table|constraint) public\.bets/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(migration, pattern);
  assert.match(migration, /bet_id uuid references public\.bets\(id\)/);
});

test('fila tem estados fechados, hash unico e trilha auditavel', () => {
  assert.match(migration, /create table if not exists public\.bet_upload_jobs/);
  assert.match(migration, /ingestion_hash text not null unique/);
  assert.match(migration, /status in \('queued', 'processing', 'registered', 'rejected', 'error'\)/);
  for (const field of ['storage_path', 'owner_id', 'bet_id', 'error_code', 'error_message', 'result', 'attempts', 'finished_at']) {
    assert.match(migration, new RegExp(`\\b${field}\\b`), `campo ausente: ${field}`);
  }
});

test('claim usa lock atomico, lease e recupera processamento expirado', () => {
  assert.match(migration, /create or replace function public\.claim_bet_upload_job/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at < now\(\)/);
  assert.match(migration, /claim_token = gen_random_uuid\(\)/);
  assert.match(migration, /attempts = attempts \+ 1/);
});

test('finish exige claim valido e repeticao terminal idempotente', () => {
  assert.match(migration, /create or replace function public\.finish_bet_upload_job/);
  assert.match(migration, /status = 'processing'[\s\S]*claim_token = p_claim_token[\s\S]*lease_expires_at >= now\(\)/);
  assert.match(migration, /status = p_status[\s\S]*claim_token = p_claim_token/);
  assert.match(migration, /registered requires bet_id/);
});

test('jobs privados: owner somente le e RPCs ficam restritos a service_role', () => {
  assert.match(migration, /alter table public\.bet_upload_jobs enable row level security/);
  assert.match(migration, /owner_id = auth\.uid\(\)/);
  assert.match(migration, /revoke all on table public\.bet_upload_jobs from anon, authenticated/);
  assert.match(migration, /grant select on table public\.bet_upload_jobs to authenticated/);
  assert.match(migration, /grant execute on function public\.claim_bet_upload_job[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.finish_bet_upload_job[\s\S]*to service_role/);
});

test('retencao do print e exatamente created_at mais 14 dias', () => {
  assert.match(migration, /purge_after timestamptz not null default \(now\(\) \+ interval '336 hours'\)/);
  assert.match(migration, /purge_after = created_at \+ interval '336 hours'/);
  assert.match(migration, /screenshot_deleted_at >= purge_after/);
  assert.match(migration, /screenshot_deleted_at timestamptz/);
});

test('purge atomico ignora queued e processing e preserva job e storage_path', () => {
  const start = migration.indexOf('create or replace function public.claim_bet_upload_purge');
  const end = migration.indexOf('create or replace function public.finish_bet_upload_purge');
  const claimPurge = migration.slice(start, end);
  assert.match(claimPurge, /purge_after <= now\(\)/);
  assert.match(claimPurge, /status in \('registered', 'rejected', 'error'\)/);
  assert.doesNotMatch(claimPurge, /status in \([^)]*queued|status in \([^)]*processing/);
  assert.match(claimPurge, /for update skip locked/);
  assert.match(claimPurge, /purge_lease_expires_at < now\(\)/);

  const finishPurge = migration.slice(end, migration.indexOf('revoke all on function', end));
  assert.match(finishPurge, /purge_after <= now\(\)/);
  assert.match(finishPurge, /screenshot_deleted_at = now\(\)/);
  assert.doesNotMatch(finishPurge, /delete from public\.bet_upload_jobs/);
  assert.doesNotMatch(finishPurge, /storage_path\s*=\s*null/);
});

test('purge e idempotente e acessivel somente ao service_role', () => {
  assert.match(migration, /purge_claim_token = p_purge_claim_token[\s\S]*screenshot_deleted_at is not null/);
  assert.match(migration, /revoke all on function public\.claim_bet_upload_purge\(text, integer\) from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.finish_bet_upload_purge\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.claim_bet_upload_purge\(text, integer\) to service_role/);
  assert.match(migration, /grant execute on function public\.finish_bet_upload_purge\(uuid, uuid\) to service_role/);
});
