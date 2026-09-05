-- Financas pessoais — tabelas, RPCs e bucket — 2026-09-04
-- Rodar UMA VEZ no SQL Editor do painel Supabase (aba "New Query", nunca reaproveitar aba antiga).
-- Rollback: migrations/2026-09-04-finance.rollback.sql
--
-- POR QUE ISTO NAO FOI APLICADO PELO AGENTE: este projeto nao tem caminho de DDL
-- automatizado — sem psql, sem Supabase CLI, sem RPC exec_sql exposta pra DDL. Toda
-- DDL aqui e aplicada a mao pelo Elvis no painel, igual as migrations anteriores.
--
-- E SEGURO: so cria objetos novos finance_* (finance_upload_jobs, finance_transactions,
-- claim_finance_upload_job, finish_finance_upload_job) e o bucket finance-uploads. Nao
-- encosta em bets, bet_upload_jobs nem em nenhuma RPC existente. Idempotente (create
-- table/index if not exists, create or replace function, insert ... on conflict do
-- update) — pode rodar de novo sem quebrar nada.
--
-- Espelha migrations/2026-08-12-bet-upload.sql sem o vinculo com o registro final
-- (financas nao referencia public.bets: e um pipeline paralelo, nunca junta as
-- duas tabelas — o campo que la apontava pra aposta registrada aqui nao existe).
--
-- Sem policy em nenhuma das duas tabelas nem no bucket: RLS liga e revoga tudo de
-- anon/authenticated, e so o service_role (que ignora RLS) le e escreve. E a mesma
-- exigencia de privacidade do bet_upload_jobs, so que sem a leitura do dono via
-- authenticated — o dashboard de financas so fala com o Supabase por trás da funcao
-- Vercel com a chave secreta, nunca pelo client publico.

begin;

create table if not exists public.finance_upload_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'registered', 'rejected', 'error')),
  ingestion_hash text not null unique check (ingestion_hash ~ '^[a-f0-9]{64}$'),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  note text check (note is null or char_length(note) between 1 and 500),
  worker_id text,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  error_code text,
  error_message text,
  result jsonb,
  created_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '336 hours'),
  image_deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  processing_started_at timestamptz,
  finished_at timestamptz,
  check (status <> 'registered' or result is not null),
  check (status <> 'processing' or (claim_token is not null and lease_expires_at is not null)),
  check (purge_after = created_at + interval '336 hours'),
  check (image_deleted_at is null or (
    image_deleted_at >= purge_after
    and status in ('registered', 'rejected', 'error')
  ))
);

create index if not exists finance_upload_jobs_claim_idx
  on public.finance_upload_jobs (status, lease_expires_at, created_at);

create index if not exists finance_upload_jobs_purge_idx
  on public.finance_upload_jobs (purge_after)
  where image_deleted_at is null;

create index if not exists finance_upload_jobs_owner_idx
  on public.finance_upload_jobs (owner_id, created_at desc);

-- listDocuments (api/lib/finance-gateway.cjs) filtra por `result->>'ref_month' = month`
-- pra achar a fatura/extrato registrada do mes — sem indice isso e um scan sequencial
-- inteiro da tabela a cada GET /api/finance/summary.
create index if not exists finance_upload_jobs_ref_month_idx
  on public.finance_upload_jobs ((result->>'ref_month'));

-- Sem policy de proposito: o dono nunca le esta tabela direto do client publico,
-- so via /api/finance/* (service_role). Diferente de bet_upload_jobs, que tem
-- policy de leitura pro authenticated — aqui nao existe esse caminho.
alter table public.finance_upload_jobs enable row level security;
revoke all on table public.finance_upload_jobs from anon, authenticated;

create table if not exists public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.finance_upload_jobs(id) on delete set null,
  source text not null check (source in ('cartao', 'conta')),
  institution text not null check (char_length(institution) between 1 and 80),
  account_label text check (account_label is null or char_length(account_label) <= 80),
  occurred_on date not null,
  ref_month text not null check (ref_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  description text not null check (char_length(description) between 1 and 300),
  merchant text check (merchant is null or char_length(merchant) <= 120),
  amount numeric(14, 2) not null check (amount <> 0),
  category text not null check (category in (
    'alimentacao', 'mercado', 'transporte', 'moradia', 'contas', 'saude', 'lazer',
    'assinaturas', 'compras', 'educacao', 'apostas', 'cripto', 'transferencia',
    'pagamento_fatura', 'renda', 'investimento', 'taxas_juros', 'outros'
  )),
  category_source text not null default 'auto' check (category_source in ('auto', 'manual')),
  ignore_in_totals boolean not null default false,
  installment_current smallint check (installment_current is null or installment_current >= 1),
  installment_total smallint check (installment_total is null or installment_total >= 1),
  dedup_key text not null check (dedup_key ~ '^[a-f0-9]{64}$'),
  raw jsonb,
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (installment_current is null or installment_total is null or installment_current <= installment_total),
  unique (owner_id, dedup_key)
);

-- occurred_on desc, created_at desc cobre a ordenacao de GET /api/finance/transactions
-- (order=occurred_on.desc,created_at.desc) direto pelo indice, sem sort extra.
create index if not exists finance_transactions_owner_month_idx
  on public.finance_transactions (owner_id, ref_month, occurred_on desc, created_at desc);

create index if not exists finance_transactions_job_idx
  on public.finance_transactions (job_id);

-- Idem: sem policy. Leitura/escrita so pelo service_role atras de /api/finance/*.
alter table public.finance_transactions enable row level security;
revoke all on table public.finance_transactions from anon, authenticated;

create or replace function public.claim_finance_upload_job(
  p_worker_id text,
  p_lease_seconds integer default 600
)
returns setof public.finance_upload_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if nullif(btrim(p_worker_id), '') is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'invalid worker/lease';
  end if;

  select id into claimed_id
  from public.finance_upload_jobs
  where status = 'queued'
     or (status = 'processing' and lease_expires_at < now())
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.finance_upload_jobs
  set status = 'processing',
      worker_id = btrim(p_worker_id),
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      processing_started_at = coalesce(processing_started_at, now()),
      attempts = attempts + 1,
      updated_at = now(),
      error_code = null,
      error_message = null
  where id = claimed_id
  returning *;
end
$$;

create or replace function public.finish_finance_upload_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_result jsonb default null
)
returns setof public.finance_upload_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  if p_status not in ('registered', 'rejected', 'error') then raise exception 'invalid terminal status'; end if;
  if p_status = 'registered' and p_result is null then raise exception 'registered requires result'; end if;

  -- Um worker pode perder a resposta HTTP depois do commit. A repeticao com o
  -- mesmo claim e o mesmo resultado terminal devolve o registro ja finalizado.
  if exists (
    select 1
    from public.finance_upload_jobs
    where id = p_job_id
      and claim_token = p_claim_token
      and status = p_status
      and error_code is not distinct from case when p_status = 'registered' then null else left(p_error_code, 100) end
      and error_message is not distinct from case when p_status = 'registered' then null else left(p_error_message, 1000) end
      and result is not distinct from p_result
  ) then
    return query
    select * from public.finance_upload_jobs where id = p_job_id;
    return;
  end if;

  return query
  update public.finance_upload_jobs
  set status = p_status,
      error_code = case when p_status = 'registered' then null else left(p_error_code, 100) end,
      error_message = case when p_status = 'registered' then null else left(p_error_message, 1000) end,
      result = p_result,
      finished_at = now(),
      updated_at = now(),
      lease_expires_at = null
  where id = p_job_id
    and status = 'processing'
    and claim_token = p_claim_token
    and lease_expires_at >= now()
  returning *;
end
$$;

revoke all on function public.claim_finance_upload_job(text, integer) from public, anon, authenticated;
revoke all on function public.finish_finance_upload_job(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_finance_upload_job(text, integer) to service_role;
grant execute on function public.finish_finance_upload_job(uuid, uuid, text, text, text, jsonb) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-uploads',
  'finance-uploads',
  false,
  3145728,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Sem policy em storage.objects de proposito: upload/download/delete das fotos de
-- financas sao exclusivos do backend (service_role bypassa RLS/policy de storage).

commit;

-- Verificacao (rodar depois de aplicar; todas as colunas devem vir preenchidas,
-- bucket_privado=1, rls_tx=true, anon_le_tx=false, auth_le_tx=false, anon_finish=false).
select
  'ok' as status,
  to_regclass('public.finance_upload_jobs')::text as jobs_table,
  to_regclass('public.finance_transactions')::text as tx_table,
  to_regprocedure('public.claim_finance_upload_job(text,integer)')::text as claim_fn,
  to_regprocedure('public.finish_finance_upload_job(uuid,uuid,text,text,text,jsonb)')::text as finish_fn,
  (select count(*) from storage.buckets where id = 'finance-uploads' and public = false) as bucket_privado,
  (select relrowsecurity from pg_class where oid = 'public.finance_transactions'::regclass) as rls_tx,
  has_table_privilege('anon', 'public.finance_transactions', 'select') as anon_le_tx,
  has_table_privilege('authenticated', 'public.finance_transactions', 'select') as auth_le_tx,
  has_function_privilege('anon', 'public.finish_finance_upload_job(uuid,uuid,text,text,text,jsonb)', 'execute') as anon_finish;
