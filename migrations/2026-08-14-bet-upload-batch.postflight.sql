-- Validacao read-only apos aplicar 2026-08-14-bet-upload-batch.sql.
-- Nao invoca RPC nem altera jobs/apostas.

select
  to_regclass('public.bet_upload_job_items')::text as item_table,
  to_regprocedure('public.bet_upload_ticket_of(jsonb)')::text as ticket_fn,
  to_regprocedure('public.bet_upload_canonical_json(jsonb)')::text as canonical_fn,
  to_regprocedure('public.bet_upload_dedup_key(jsonb)')::text as dedup_fn,
  to_regprocedure('public.register_canonical_bet(jsonb,text)')::text as canonical_register_fn,
  to_regprocedure('public.register_bet_upload_batch(uuid,uuid,jsonb)')::text as batch_fn,
  (select relrowsecurity
     from pg_class
    where oid = 'public.bet_upload_job_items'::regclass) as rls_enabled,
  (select count(*) from public.bet_upload_job_items) as item_count,
  (select count(*) from public.bets) as bet_count,
  (select count(*) from public.bet_upload_jobs) as job_count;

select status, count(*)
from public.bet_upload_jobs
group by status
order by status;

select
  p.proname,
  has_function_privilege('anon', p.oid, 'execute') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
  has_function_privilege('service_role', p.oid, 'execute') as service_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'bet_upload_ticket_of',
    'bet_upload_canonical_json',
    'bet_upload_dedup_key',
    'register_canonical_bet',
    'register_bet_upload_batch'
  )
order by p.proname;

select
  has_table_privilege('anon', 'public.bet_upload_job_items', 'select') as anon_select,
  has_table_privilege('authenticated', 'public.bet_upload_job_items', 'select') as authenticated_select,
  has_table_privilege('service_role', 'public.bet_upload_job_items', 'select') as service_select,
  has_table_privilege('service_role', 'public.bet_upload_job_items', 'insert') as service_insert;
