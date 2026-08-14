-- NAO EXECUTAR automaticamente. Rollback seguro somente antes do primeiro batch.
begin;

do $$
begin
  if to_regclass('public.bet_upload_job_items') is not null
     and exists (select 1 from public.bet_upload_job_items) then
    raise exception 'ROLLBACK_ABORTED: bet_upload_job_items contem auditoria; preserve dados e faca rollback manual';
  end if;
end
$$;

drop function if exists public.register_bet_upload_batch(uuid, uuid, jsonb);
drop function if exists public.register_canonical_bet(jsonb, text);
drop function if exists public.bet_upload_dedup_key(jsonb);
drop function if exists public.bet_upload_canonical_json(jsonb);
drop function if exists public.bet_upload_ticket_of(jsonb);
drop table if exists public.bet_upload_job_items;

commit;
