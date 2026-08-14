-- READ-ONLY. Execute antes de backup/migration. Compativel com psql e Supabase SQL Editor.
-- Nao cria, altera ou bloqueia tabelas alem dos locks normais de catalog/read.

select current_database() as database_name,
       current_user as database_user,
       current_setting('server_version') as server_version,
       now() as checked_at;

with required(table_name, column_name, allowed_udt) as (
  values
    ('bet_upload_jobs', 'id', array['uuid']),
    ('bet_upload_jobs', 'status', array['text','varchar']),
    ('bet_upload_jobs', 'claim_token', array['uuid']),
    ('bet_upload_jobs', 'lease_expires_at', array['timestamptz']),
    ('bet_upload_jobs', 'bet_id', array['uuid']),
    ('bet_upload_jobs', 'result', array['jsonb']),
    ('bet_upload_jobs', 'storage_path', array['text','varchar']),
    ('bet_upload_jobs', 'finished_at', array['timestamptz']),
    ('bet_upload_jobs', 'updated_at', array['timestamptz']),
    ('bet_upload_jobs', 'error_code', array['text','varchar']),
    ('bet_upload_jobs', 'error_message', array['text','varchar']),
    ('bets', 'id', array['uuid']),
    ('bets', 'created_at', array['timestamptz']),
    ('bets', 'bookmaker', array['text','varchar']),
    ('bets', 'league', array['text','varchar']),
    ('bets', 'team_a', array['text','varchar']),
    ('bets', 'team_b', array['text','varchar']),
    ('bets', 'market', array['text','varchar']),
    ('bets', 'pick', array['text','varchar']),
    ('bets', 'odd', array['numeric','float4','float8']),
    ('bets', 'stake', array['numeric','float4','float8']),
    ('bets', 'bet_datetime', array['timestamptz']),
    ('bets', 'is_map_bet', array['bool']),
    ('bets', 'map_number', array['int2','int4','int8']),
    ('bets', 'screenshot_path', array['text','varchar']),
    ('bets', 'notes', array['text','varchar']),
    ('bets', 'raw_extraction', array['jsonb']),
    ('bets', 'pandascore_match_id', array['text','varchar','int4','int8']),
    ('bets', 'pandascore_match_name', array['text','varchar']),
    ('bets', 'fair_pinnacle', array['numeric','float4','float8']),
    ('bets', 'fair_formula', array['numeric','float4','float8']),
    ('bets', 'fair_line_source', array['text','varchar']),
    ('bets', 'is_method_bet', array['bool']),
    ('bets', 'status', array['text','varchar']),
    ('bets', 'profit', array['numeric','float4','float8']),
    ('bets', 'settled_at', array['timestamptz']),
    ('bets', 'settle_source', array['text','varchar'])
), findings as (
  select required.table_name, required.column_name, required.allowed_udt,
         c.udt_name as actual_udt,
         case when c.column_name is null then 'missing' else 'incompatible_type' end as finding
  from required
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = required.table_name
   and c.column_name = required.column_name
  where c.column_name is null or not (c.udt_name = any(required.allowed_udt))
)
select * from findings order by table_name, column_name;

select to_regclass('public.bets') as bets_table,
       to_regclass('public.bet_upload_jobs') as jobs_table,
       to_regprocedure('extensions.digest(bytea,text)') as digest_function,
       to_regprocedure('public.claim_bet_upload_job(text,integer)') as claim_function,
       to_regprocedure('public.finish_bet_upload_job(uuid,uuid,text,uuid,text,text,jsonb)') as finish_function;

select status, count(*) as jobs
from public.bet_upload_jobs
group by status
order by status;

select count(*) as processing_with_invalid_lease
from public.bet_upload_jobs
where status = 'processing'
  and (claim_token is null or lease_expires_at is null or lease_expires_at <= now());

with signatures as (
  select case lower(btrim(bookmaker))
           when 'whale.io' then 'whale'
           when 'whale io' then 'whale'
           else lower(btrim(bookmaker))
         end as bookmaker,
         coalesce(
           nullif(regexp_replace(btrim(raw_extraction #>> '{bookmaker_native,bet_id}'), '^#+\s*', ''), ''),
           nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id_bookmaker'), '^#+\s*', ''), ''),
           nullif(regexp_replace(btrim(raw_extraction ->> 'bet_id'), '^#+\s*', ''), ''),
           nullif(regexp_replace(btrim(raw_extraction ->> 'bookmaker_bet_id'), '^#+\s*', ''), '')
         ) as ticket,
         lower(regexp_replace(btrim(pick), '\s+', ' ', 'g')) as pick,
         stake, map_number, odd, count(*) as rows
  from public.bets
  group by 1,2,3,4,5,6
)
select count(*) as existing_duplicate_signatures
from signatures
where ticket is not null and rows > 1;

do $$
declare
  incompatible_columns text[];
begin
  select array_agg(format('%s.%s:%s', required.table_name, required.column_name, array_to_string(required.allowed_udt, '|')) order by 1)
  into incompatible_columns
  from (values
    ('bet_upload_jobs', 'id', array['uuid']),
    ('bet_upload_jobs', 'status', array['text','varchar']),
    ('bet_upload_jobs', 'claim_token', array['uuid']),
    ('bet_upload_jobs', 'lease_expires_at', array['timestamptz']),
    ('bet_upload_jobs', 'bet_id', array['uuid']),
    ('bet_upload_jobs', 'result', array['jsonb']),
    ('bet_upload_jobs', 'storage_path', array['text','varchar']),
    ('bet_upload_jobs', 'finished_at', array['timestamptz']),
    ('bet_upload_jobs', 'updated_at', array['timestamptz']),
    ('bet_upload_jobs', 'error_code', array['text','varchar']),
    ('bet_upload_jobs', 'error_message', array['text','varchar']),
    ('bets', 'id', array['uuid']),
    ('bets', 'created_at', array['timestamptz']),
    ('bets', 'bookmaker', array['text','varchar']),
    ('bets', 'league', array['text','varchar']),
    ('bets', 'team_a', array['text','varchar']),
    ('bets', 'team_b', array['text','varchar']),
    ('bets', 'market', array['text','varchar']),
    ('bets', 'pick', array['text','varchar']),
    ('bets', 'odd', array['numeric','float4','float8']),
    ('bets', 'stake', array['numeric','float4','float8']),
    ('bets', 'bet_datetime', array['timestamptz']),
    ('bets', 'is_map_bet', array['bool']),
    ('bets', 'map_number', array['int2','int4','int8']),
    ('bets', 'screenshot_path', array['text','varchar']),
    ('bets', 'notes', array['text','varchar']),
    ('bets', 'raw_extraction', array['jsonb']),
    ('bets', 'pandascore_match_id', array['text','varchar','int4','int8']),
    ('bets', 'pandascore_match_name', array['text','varchar']),
    ('bets', 'fair_pinnacle', array['numeric','float4','float8']),
    ('bets', 'fair_formula', array['numeric','float4','float8']),
    ('bets', 'fair_line_source', array['text','varchar']),
    ('bets', 'is_method_bet', array['bool']),
    ('bets', 'status', array['text','varchar']),
    ('bets', 'profit', array['numeric','float4','float8']),
    ('bets', 'settled_at', array['timestamptz']),
    ('bets', 'settle_source', array['text','varchar'])
  ) as required(table_name, column_name, allowed_udt)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = required.table_name
      and c.column_name = required.column_name
      and c.udt_name = any(required.allowed_udt)
  );
  if cardinality(incompatible_columns) > 0 then
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: colunas ausentes/tipos incompativeis: %', incompatible_columns;
  end if;
  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: extensions.digest ausente';
  end if;
end
$$;

select 'BET_UPLOAD_BATCH_PREFLIGHT_READ_ONLY_OK' as result;
