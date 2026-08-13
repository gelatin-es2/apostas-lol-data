-- Rollback incremental. Execute somente se nenhum job possuir description.
do $$
begin
  if exists (
    select 1 from public.bet_upload_jobs
    where description is not null
  ) then
    raise exception 'ROLLBACK_ABORTED: existem jobs com description; preserve a auditoria';
  end if;
end
$$;

alter table public.bet_upload_jobs
  drop constraint if exists bet_upload_jobs_description_length_check;

alter table public.bet_upload_jobs
  drop column if exists description;
