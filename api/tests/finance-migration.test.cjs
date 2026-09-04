'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { FINANCE_CATEGORY_SLUGS } = require('../lib/finance-categories.cjs');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/2026-09-04-finance.sql'),
  'utf8',
);

const rollback = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/2026-09-04-finance.rollback.sql'),
  'utf8',
);

test('migration tem cabecalho padrao, transacao unica e select de verificacao apos o commit', () => {
  assert.match(migration, /Rodar UMA VEZ no SQL Editor do painel Supabase/);
  assert.match(migration, /Rollback: migrations\/2026-09-04-finance\.rollback\.sql/);
  assert.match(migration, /E SEGURO/);
  assert.match(migration, /^begin;$/m);
  assert.match(migration, /^commit;$/m);

  const beginIndex = migration.indexOf('begin;');
  const commitIndex = migration.indexOf('commit;');
  const selectIndex = migration.indexOf("'ok' as status");
  assert.ok(beginIndex >= 0 && commitIndex > beginIndex, 'begin deve vir antes do commit');
  assert.ok(selectIndex > commitIndex, 'select de verificacao deve vir depois do commit');
  assert.match(migration.slice(selectIndex), /to_regclass\('public\.finance_upload_jobs'\)/);
  assert.match(migration.slice(selectIndex), /to_regprocedure\('public\.claim_finance_upload_job\(text,integer\)'\)/);
  assert.match(migration.slice(selectIndex), /to_regprocedure\('public\.finish_finance_upload_job\(uuid,uuid,text,text,text,jsonb\)'\)/);
});

test('migration nao mexe em bets/bet_upload_jobs, nem em RPCs de bet_upload, nem tem drop fora do rollback', () => {
  const forbidden = [
    /alter table public\.(bets|bet_upload_jobs)/i,
    /(claim|finish)_bet_upload/i,
    /\bdrop\s/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(migration, pattern);
});

test('finance_upload_jobs nao herda campos exclusivos de bet_upload_jobs', () => {
  assert.doesNotMatch(migration, /bet_id|purge_claim_token|purge_lease_expires_at|purge_worker_id/);
});

test('finance_upload_jobs tem colunas e checks de S2.5', () => {
  assert.match(migration, /create table if not exists public\.finance_upload_jobs/);
  for (const field of [
    'owner_id', 'ingestion_hash', 'storage_path', 'mime_type', 'note', 'worker_id',
    'claim_token', 'lease_expires_at', 'attempts', 'error_code', 'error_message',
    'result', 'created_at', 'purge_after', 'image_deleted_at', 'updated_at',
    'processing_started_at', 'finished_at',
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`), `campo ausente: ${field}`);
  }
  assert.match(migration, /status in \('queued', 'processing', 'registered', 'rejected', 'error'\)/);
  assert.match(migration, /check \(status <> 'registered' or result is not null\)/);
  assert.match(migration, /check \(status <> 'processing' or \(claim_token is not null and lease_expires_at is not null\)\)/);
  assert.match(migration, /check \(purge_after = created_at \+ interval '336 hours'\)/);
  assert.match(migration, /image_deleted_at >= purge_after/);
});

test('finance_transactions tem colunas e checks de S2.5', () => {
  assert.match(migration, /create table if not exists public\.finance_transactions/);
  for (const field of [
    'job_id', 'source', 'institution', 'account_label', 'occurred_on', 'ref_month',
    'description', 'merchant', 'amount', 'category', 'category_source',
    'ignore_in_totals', 'installment_current', 'installment_total', 'dedup_key',
    'raw', 'notes',
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`), `campo ausente: ${field}`);
  }
  assert.match(migration, /references public\.finance_upload_jobs\(id\) on delete set null/);
  assert.match(migration, /source in \('cartao', 'conta'\)/);
  assert.match(migration, /ref_month ~ '\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/);
  assert.match(migration, /amount numeric\(14, 2\) not null check \(amount <> 0\)/);
  assert.match(migration, /category_source in \('auto', 'manual'\)/);
  assert.match(migration, /dedup_key ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(
    migration,
    /installment_current is null or installment_total is null or installment_current <= installment_total/,
  );
  assert.match(migration, /unique \(owner_id, dedup_key\)/);
});

test('lista de categorias no check bate com FINANCE_CATEGORY_SLUGS na mesma ordem', () => {
  const match = migration.match(/category text not null check \(category in \(([\s\S]*?)\)\)/);
  assert.ok(match, 'check de category nao encontrado');
  const slugs = Array.from(match[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
  assert.deepEqual(slugs, FINANCE_CATEGORY_SLUGS);
});

test('RLS liga e revoga tudo de anon/authenticated nas duas tabelas, sem policy nem grant pra elas', () => {
  assert.match(migration, /alter table public\.finance_upload_jobs enable row level security/);
  assert.match(migration, /revoke all on table public\.finance_upload_jobs from anon, authenticated/);
  assert.match(migration, /alter table public\.finance_transactions enable row level security/);
  assert.match(migration, /revoke all on table public\.finance_transactions from anon, authenticated/);
  assert.doesNotMatch(migration, /create policy/i);
  assert.doesNotMatch(migration, /grant (select|insert|update|delete|all)[^;]*to (anon|authenticated)/i);
});

test('claim usa lock atomico, lease e service_role', () => {
  assert.match(migration, /create or replace function public\.claim_finance_upload_job/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at < now\(\)/);
  assert.match(migration, /claim_token = gen_random_uuid\(\)/);
  assert.match(migration, /attempts = attempts \+ 1/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
});

test('finish nao tem p_bet_id, exige result em registered e repeticao terminal e idempotente pelo result', () => {
  assert.match(
    migration,
    /create or replace function public\.finish_finance_upload_job\(\s*p_job_id uuid,\s*p_claim_token uuid,\s*p_status text,\s*p_error_code text default null,\s*p_error_message text default null,\s*p_result jsonb default null\s*\)/,
  );
  assert.doesNotMatch(migration, /p_bet_id/);
  assert.match(migration, /registered requires result/);
  assert.match(migration, /result is not distinct from p_result/);
  assert.match(migration, /status = 'processing'[\s\S]*claim_token = p_claim_token[\s\S]*lease_expires_at >= now\(\)/);
});

test('grants das RPCs restritos ao service_role', () => {
  assert.match(
    migration,
    /revoke all on function public\.claim_finance_upload_job\(text, integer\) from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function public\.finish_finance_upload_job\(uuid, uuid, text, text, text, jsonb\) from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.claim_finance_upload_job\(text, integer\) to service_role/,
  );
  assert.match(
    migration,
    /grant execute on function public\.finish_finance_upload_job\(uuid, uuid, text, text, text, jsonb\) to service_role/,
  );
  assert.doesNotMatch(migration, /grant execute[^;]*to (public|anon|authenticated)/i);
});

test('bucket finance-uploads privado, limite de 3 MB, 3 mimes, sem policy em storage.objects', () => {
  assert.match(migration, /insert into storage\.buckets/);
  assert.match(migration, /'finance-uploads'/);
  assert.match(migration, /public = false/);
  assert.match(migration, /3145728/);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.match(migration, new RegExp(mime.replace('/', '\\/')));
  }
  assert.match(migration, /on conflict \(id\) do update set/);
  assert.doesNotMatch(migration, /on storage\.objects/i);
});

test('exatamente 2 tabelas novas, 2 funcoes novas e 1 bucket novo', () => {
  const tableMatches = migration.match(/create table if not exists public\.\w+/g) || [];
  const functionMatches = migration.match(/create or replace function public\.\w+/g) || [];
  const bucketMatches = migration.match(/insert into storage\.buckets/g) || [];
  assert.equal(tableMatches.length, 2);
  assert.equal(functionMatches.length, 2);
  assert.equal(bucketMatches.length, 1);
});

test('rollback dropa funcoes e tabelas na ordem certa, limpa o bucket e nao toca em bets', () => {
  assert.match(rollback, /^begin;$/m);
  assert.match(rollback, /^commit;$/m);

  const finishIdx = rollback.indexOf('drop function if exists public.finish_finance_upload_job');
  const claimIdx = rollback.indexOf('drop function if exists public.claim_finance_upload_job');
  const txIdx = rollback.indexOf('drop table if exists public.finance_transactions');
  const jobsIdx = rollback.indexOf('drop table if exists public.finance_upload_jobs');
  const objectsIdx = rollback.indexOf("delete from storage.objects where bucket_id = 'finance-uploads'");
  const bucketIdx = rollback.indexOf("delete from storage.buckets where id = 'finance-uploads'");

  for (const idx of [finishIdx, claimIdx, txIdx, jobsIdx, objectsIdx, bucketIdx]) {
    assert.notEqual(idx, -1);
  }
  assert.ok(finishIdx < claimIdx, 'finish deve ser dropada antes de claim');
  assert.ok(claimIdx < txIdx, 'funcoes devem ser dropadas antes das tabelas');
  assert.ok(txIdx < jobsIdx, 'finance_transactions deve cair antes de finance_upload_jobs (FK)');
  assert.ok(jobsIdx < objectsIdx, 'tabelas antes do storage');
  assert.ok(objectsIdx < bucketIdx, 'objects antes do bucket');

  assert.doesNotMatch(rollback, /bet_/);
});
