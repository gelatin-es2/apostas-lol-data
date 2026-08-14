-- Resumo read-only em uma unica grade para o SQL Editor.
-- Nao invoca RPC nem altera jobs/apostas.

with target_functions(label, signature) as (
  values
    ('bet_upload_ticket_of', 'public.bet_upload_ticket_of(jsonb)'),
    ('bet_upload_canonical_json', 'public.bet_upload_canonical_json(jsonb)'),
    ('bet_upload_dedup_key', 'public.bet_upload_dedup_key(jsonb)'),
    ('register_canonical_bet', 'public.register_canonical_bet(jsonb,text)'),
    ('register_bet_upload_batch', 'public.register_bet_upload_batch(uuid,uuid,jsonb)')
), function_grants as (
  select jsonb_object_agg(
    target.label,
    jsonb_build_object(
      'present', target.function_oid is not null,
      'anon_execute', has_function_privilege('anon', target.function_oid, 'execute'),
      'authenticated_execute', has_function_privilege('authenticated', target.function_oid, 'execute'),
      'service_execute', has_function_privilege('service_role', target.function_oid, 'execute')
    )
    order by target.label
  ) as value
  from (
    select label, to_regprocedure(signature) as function_oid
    from target_functions
  ) target
)
select
  to_regclass('public.bet_upload_job_items') is not null as item_table_present,
  coalesce(
    (select relrowsecurity
       from pg_class
      where oid = to_regclass('public.bet_upload_job_items')),
    false
  ) as rls_enabled,
  (select count(*) from public.bet_upload_job_items) as item_count,
  (select count(*) from public.bets) as bet_count,
  (select count(*) from public.bet_upload_jobs) as job_count,
  jsonb_build_object(
    'queued', (select count(*) from public.bet_upload_jobs where status = 'queued'),
    'processing', (select count(*) from public.bet_upload_jobs where status = 'processing'),
    'registered', (select count(*) from public.bet_upload_jobs where status = 'registered'),
    'rejected', (select count(*) from public.bet_upload_jobs where status = 'rejected'),
    'error', (select count(*) from public.bet_upload_jobs where status = 'error')
  ) as jobs_by_status,
  (select value from function_grants) as function_grants,
  jsonb_build_object(
    'anon_select', has_table_privilege('anon', 'public.bet_upload_job_items', 'select'),
    'authenticated_select', has_table_privilege('authenticated', 'public.bet_upload_job_items', 'select'),
    'service_select', has_table_privilege('service_role', 'public.bet_upload_job_items', 'select'),
    'service_insert', has_table_privilege('service_role', 'public.bet_upload_job_items', 'insert')
  ) as table_grants;
