-- Incremental: production already has bet_upload_jobs from 2026-08-12.
-- Keep user-provided context separate from extraction/result fields.
alter table public.bet_upload_jobs
  add column if not exists description text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bet_upload_jobs'::regclass
      and conname = 'bet_upload_jobs_description_length_check'
  ) then
    alter table public.bet_upload_jobs
      add constraint bet_upload_jobs_description_length_check
      check (description is null or char_length(description) between 1 and 500);
  end if;
end
$$;
