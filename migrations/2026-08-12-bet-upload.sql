-- NÃO aplicar sem backup e revisão do estado atual de policies/duplicatas.
-- API server-side usa service role; browser autenticado não recebe escrita.
--
-- Ticket canônico, na mesma prioridade de _dedup-lib.cjs::ticketOf:
-- bookmaker_native.bet_id -> bet_id_bookmaker -> bet_id -> bookmaker_bet_id.
-- Duplicata confirmada exige casa+ticket+pick+stake+map_number+odd idênticos.

-- PRE-FLIGHT antes de qualquer DDL. Ticket repetido com aposta divergente é
-- ladder/caso legítimo e não bloqueia; só a assinatura completa repetida aborta.
do $$
declare
  duplicate_groups bigint;
begin
  select count(*) into duplicate_groups
  from (
    select
      lower(btrim(bookmaker)),
      coalesce(
        nullif(regexp_replace(btrim(raw_extraction #>> '{bookmaker_native,bet_id}'), '^#+\s*', ''), ''),
        nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id_bookmaker'), '^#+\s*', ''), ''),
        nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id'), '^#+\s*', ''), ''),
        nullif(regexp_replace(btrim(raw_extraction ->> 'bookmaker_bet_id'), '^#+\s*', ''), '')
      ),
      lower(regexp_replace(btrim(pick), '\s+', ' ', 'g')),
      stake,
      coalesce(map_number, 0),
      odd
    from public.bets
    where coalesce(
      nullif(regexp_replace(btrim(raw_extraction #>> '{bookmaker_native,bet_id}'), '^#+\s*', ''), ''),
      nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id_bookmaker'), '^#+\s*', ''), ''),
      nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id'), '^#+\s*', ''), ''),
      nullif(regexp_replace(btrim(raw_extraction ->> 'bookmaker_bet_id'), '^#+\s*', ''), '')
    ) is not null
    group by 1, 2, 3, 4, 5, 6
    having count(*) > 1
  ) duplicates;

  if duplicate_groups > 0 then
    raise exception
      'BET_UPLOAD_PREFLIGHT_FAILED: % assinatura(s) canônica(s) duplicada(s) (casa+ticket+pick+stake+mapa+odd). Rode a auditoria de dedup antes desta migration; nenhum DDL foi aplicado.',
      duplicate_groups;
  end if;
end
$$;

-- Só executa após o pre-flight passar. Substitui a chave antiga, que confundia
-- apostas reais distintas com duplicatas mesmo quando tinham tickets próprios.
-- A migration e aditiva: public.bets permanece intocada, salvo a FK abaixo.
create table if not exists public.bet_upload_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'registered', 'rejected', 'error')),
  ingestion_hash text not null unique check (ingestion_hash ~ '^[a-f0-9]{64}$'),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  worker_id text,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  bet_id uuid references public.bets(id),
  error_code text,
  error_message text,
  result jsonb,
  created_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '336 hours'),
  screenshot_deleted_at timestamptz,
  purge_worker_id text,
  purge_claim_token uuid,
  purge_lease_expires_at timestamptz,
  purge_attempts integer not null default 0 check (purge_attempts >= 0),
  updated_at timestamptz not null default now(),
  processing_started_at timestamptz,
  finished_at timestamptz,
  check (status <> 'registered' or bet_id is not null),
  check (status <> 'processing' or (claim_token is not null and lease_expires_at is not null)),
  check (purge_after = created_at + interval '336 hours'),
  check (screenshot_deleted_at is null or (
    screenshot_deleted_at >= purge_after
    and status in ('registered', 'rejected', 'error')
  ))
);

create index if not exists bet_upload_jobs_claim_idx
  on public.bet_upload_jobs (status, lease_expires_at, created_at);

create index if not exists bet_upload_jobs_purge_idx
  on public.bet_upload_jobs (purge_after, purge_lease_expires_at)
  where screenshot_deleted_at is null;

alter table public.bet_upload_jobs enable row level security;
revoke all on table public.bet_upload_jobs from anon, authenticated;
grant select on table public.bet_upload_jobs to authenticated;

drop policy if exists "bet upload owner read" on public.bet_upload_jobs;
create policy "bet upload owner read"
on public.bet_upload_jobs for select
to authenticated
using (owner_id = auth.uid());

create or replace function public.claim_bet_upload_job(
  p_worker_id text,
  p_lease_seconds integer default 600
)
returns setof public.bet_upload_jobs
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
  from public.bet_upload_jobs
  where status = 'queued'
     or (status = 'processing' and lease_expires_at < now())
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.bet_upload_jobs
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

create or replace function public.finish_bet_upload_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_bet_id uuid default null,
  p_error_code text default null,
  p_error_message text default null,
  p_result jsonb default null
)
returns setof public.bet_upload_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  if p_status not in ('registered', 'rejected', 'error') then raise exception 'invalid terminal status'; end if;
  if p_status = 'registered' and p_bet_id is null then raise exception 'registered requires bet_id'; end if;

  -- Um worker pode perder a resposta HTTP depois do commit. A repetição com o
  -- mesmo claim e o mesmo resultado terminal devolve o registro já finalizado.
  if exists (
    select 1
    from public.bet_upload_jobs
    where id = p_job_id
      and claim_token = p_claim_token
      and status = p_status
      and bet_id is not distinct from case when p_status = 'registered' then p_bet_id else null end
      and error_code is not distinct from case when p_status = 'registered' then null else left(p_error_code, 100) end
      and error_message is not distinct from case when p_status = 'registered' then null else left(p_error_message, 1000) end
      and result is not distinct from p_result
  ) then
    return query
    select * from public.bet_upload_jobs where id = p_job_id;
    return;
  end if;

  return query
  update public.bet_upload_jobs
  set status = p_status,
      bet_id = case when p_status = 'registered' then p_bet_id else null end,
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

create or replace function public.claim_bet_upload_purge(
  p_worker_id text,
  p_lease_seconds integer default 600
)
returns setof public.bet_upload_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  if nullif(btrim(p_worker_id), '') is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'invalid worker/lease';
  end if;

  select id into claimed_id
  from public.bet_upload_jobs
  where screenshot_deleted_at is null
    and purge_after <= now()
    and status in ('registered', 'rejected', 'error')
    and (purge_claim_token is null or purge_lease_expires_at < now())
  order by purge_after, created_at
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.bet_upload_jobs
  set purge_worker_id = btrim(p_worker_id),
      purge_claim_token = gen_random_uuid(),
      purge_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      purge_attempts = purge_attempts + 1,
      updated_at = now()
  where id = claimed_id
  returning *;
end
$$;

create or replace function public.finish_bet_upload_purge(
  p_job_id uuid,
  p_purge_claim_token uuid
)
returns setof public.bet_upload_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;

  if exists (
    select 1 from public.bet_upload_jobs
    where id = p_job_id
      and purge_claim_token = p_purge_claim_token
      and screenshot_deleted_at is not null
  ) then
    return query select * from public.bet_upload_jobs where id = p_job_id;
    return;
  end if;

  return query
  update public.bet_upload_jobs
  set screenshot_deleted_at = now(),
      purge_lease_expires_at = null,
      updated_at = now()
  where id = p_job_id
    and screenshot_deleted_at is null
    and purge_after <= now()
    and status in ('registered', 'rejected', 'error')
    and purge_claim_token = p_purge_claim_token
    and purge_lease_expires_at >= now()
  returning *;
end
$$;

revoke all on function public.claim_bet_upload_job(text, integer) from public, anon, authenticated;
revoke all on function public.finish_bet_upload_job(uuid, uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_bet_upload_purge(text, integer) from public, anon, authenticated;
revoke all on function public.finish_bet_upload_purge(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_bet_upload_job(text, integer) to service_role;
grant execute on function public.finish_bet_upload_job(uuid, uuid, text, uuid, text, text, jsonb) to service_role;
grant execute on function public.claim_bet_upload_purge(text, integer) to service_role;
grant execute on function public.finish_bet_upload_purge(uuid, uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bet-screenshots',
  'bet-screenshots',
  false,
  3145728,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "bet screenshots owner read" on storage.objects;
create policy "bet screenshots owner read"
on storage.objects for select
to authenticated
using (
  bucket_id = 'bet-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Upload/delete são exclusivos do backend service role (bypass de RLS).
select
  'SHA-256 do arquivo original usado para idempotência do registro automático.';
