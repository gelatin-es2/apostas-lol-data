-- Incremental: registra 1..10 cards de um screenshot em uma unica transacao.
-- Nao aplicar sem backup/preflight. Nao altera public.bets; apenas referencia/insere.

begin;

do $$
declare
  incompatible_columns text[];
begin
  if to_regclass('public.bet_upload_jobs') is null then
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: bet_upload_jobs ausente; nenhum DDL aplicado';
  end if;

  if to_regclass('public.bets') is null then
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: public.bets ausente; nenhum DDL aplicado';
  end if;

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
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: colunas ausentes/tipos incompativeis: %; nenhum DDL aplicado', incompatible_columns;
  end if;

  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception 'BET_UPLOAD_BATCH_PREFLIGHT_FAILED: extensions.digest(bytea,text) ausente; nenhum DDL aplicado';
  end if;
end
$$;

create table if not exists public.bet_upload_job_items (
  job_id uuid not null references public.bet_upload_jobs(id) on delete restrict,
  item_index smallint not null check (item_index between 1 and 10),
  item_hash text not null check (item_hash ~ '^[a-f0-9]{64}$'),
  dedup_key text,
  bet_id uuid not null references public.bets(id) on delete restrict,
  was_inserted boolean not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (job_id, item_index)
);

create index if not exists bet_upload_job_items_bet_idx
  on public.bet_upload_job_items (bet_id);
create index if not exists bet_upload_job_items_dedup_idx
  on public.bet_upload_job_items (dedup_key)
  where dedup_key is not null;

alter table public.bet_upload_job_items enable row level security;
revoke all on table public.bet_upload_job_items from public, anon, authenticated;
grant select, insert on table public.bet_upload_job_items to service_role;

-- Os quatro paths e a prioridade sao os mesmos do ticketOf canonico.
create or replace function public.bet_upload_ticket_of(p_bet jsonb)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select coalesce(
    nullif(regexp_replace(btrim(p_bet #>> '{raw_extraction,bookmaker_native,bet_id}'), '^#+\s*', ''), ''),
    nullif(regexp_replace(btrim(p_bet #>> '{raw_extraction,bet_id_bookmaker}'), '^#+\s*', ''), ''),
    nullif(regexp_replace(btrim(p_bet #>> '{raw_extraction,bet_id}'), '^#+\s*', ''), ''),
    nullif(regexp_replace(btrim(p_bet #>> '{raw_extraction,bookmaker_bet_id}'), '^#+\s*', ''), '')
  )
$$;

-- Mesmo formato de stableStringify no worker: objetos com chaves em ordem C,
-- arrays em ordem original, sem espacos e escalares no formato JSON canonico.
create or replace function public.bet_upload_canonical_json(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case jsonb_typeof(p_value)
    when 'object' then coalesce((
      select '{' || string_agg(to_jsonb(entry.key)::text || ':' || public.bet_upload_canonical_json(entry.value), ',' order by entry.key collate "C") || '}'
      from jsonb_each(p_value) as entry
    ), '{}')
    when 'array' then coalesce((
      select '[' || string_agg(public.bet_upload_canonical_json(element.value), ',' order by element.ordinality) || ']'
      from jsonb_array_elements(p_value) with ordinality as element(value, ordinality)
    ), '[]')
    else p_value::text
  end
$$;

-- Duplicata confirmada = casa+ticket+pick+stake+mapa+odd. Sem ticket retorna NULL
-- e nunca e colapsado entre jobs. Ladders divergem em pick/stake/mapa/odd.
create or replace function public.bet_upload_dedup_key(p_bet jsonb)
returns text
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  ticket text;
begin
  ticket := public.bet_upload_ticket_of(p_bet);
  if ticket is null then return null; end if;

  return concat_ws(chr(31),
    case lower(btrim(p_bet ->> 'bookmaker'))
      when 'whale.io' then 'whale'
      when 'whale io' then 'whale'
      else lower(btrim(p_bet ->> 'bookmaker'))
    end,
    ticket,
    lower(regexp_replace(btrim(p_bet ->> 'pick'), '\s+', ' ', 'g')),
    ((p_bet ->> 'stake')::numeric)::text,
    coalesce(((p_bet ->> 'map_number')::integer)::text, ''),
    ((p_bet ->> 'odd')::numeric)::text
  );
end
$$;

-- Fronteira de concorrencia compartilhada pelo batch e pelo save legado canonico.
-- Somente service_role chama esta RPC. Finder/getEventDetails/match_context sao
-- validados no JS antes dela; aqui ficam invariantes estruturais/financeiras e dedup.
create or replace function public.register_canonical_bet(
  p_bet jsonb,
  p_screenshot_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dedup_key_value text;
  resolved_bet_id uuid;
  inserted_here boolean := false;
  typed_bet public.bets%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  if jsonb_typeof(p_bet) is distinct from 'object' then raise exception 'bet must be an object'; end if;
  if nullif(btrim(p_bet ->> 'bookmaker'), '') is null
     or nullif(btrim(p_bet ->> 'team_a'), '') is null
     or nullif(btrim(p_bet ->> 'team_b'), '') is null
     or nullif(btrim(p_bet ->> 'market'), '') is null
     or nullif(btrim(p_bet ->> 'pick'), '') is null
     or nullif(btrim(p_bet ->> 'bet_datetime'), '') is null then
    raise exception 'required bet fields missing';
  end if;
  if jsonb_typeof(p_bet -> 'odd') is distinct from 'number'
     or (p_bet ->> 'odd')::numeric <= 1
     or jsonb_typeof(p_bet -> 'stake') is distinct from 'number'
     or (p_bet ->> 'stake')::numeric <= 0 then
    raise exception 'odd/stake must be positive numbers and odd > 1';
  end if;
  perform (p_bet ->> 'bet_datetime')::timestamptz;
  select * into typed_bet from jsonb_populate_record(null::public.bets, p_bet);

  dedup_key_value := public.bet_upload_dedup_key(p_bet);
  if dedup_key_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(dedup_key_value, 0));
    select b.id into resolved_bet_id
    from public.bets b
    where public.bet_upload_dedup_key(to_jsonb(b)) = dedup_key_value
    order by b.created_at, b.id
    limit 1;
  end if;

  if resolved_bet_id is null then
    insert into public.bets (
      bookmaker, league, team_a, team_b, market, pick, odd, stake,
      bet_datetime, is_map_bet, map_number, screenshot_path, notes,
      raw_extraction, pandascore_match_id, pandascore_match_name,
      fair_pinnacle, fair_formula, fair_line_source, is_method_bet,
      status, profit, settled_at, settle_source
    ) values (
      lower(btrim(typed_bet.bookmaker)),
      nullif(btrim(typed_bet.league), ''),
      btrim(typed_bet.team_a), btrim(typed_bet.team_b),
      btrim(typed_bet.market), btrim(typed_bet.pick),
      typed_bet.odd, typed_bet.stake,
      typed_bet.bet_datetime,
      coalesce(typed_bet.is_map_bet, false),
      typed_bet.map_number,
      coalesce(p_screenshot_path, nullif(typed_bet.screenshot_path, '')),
      nullif(typed_bet.notes, ''),
      typed_bet.raw_extraction,
      typed_bet.pandascore_match_id,
      nullif(typed_bet.pandascore_match_name, ''),
      typed_bet.fair_pinnacle,
      typed_bet.fair_formula,
      nullif(typed_bet.fair_line_source, ''),
      coalesce(typed_bet.is_method_bet, false),
      'pending', null, null, null
    ) returning id into resolved_bet_id;
    inserted_here := true;
  end if;

  return jsonb_build_object(
    'bet_id', resolved_bet_id,
    'inserted', inserted_here,
    'dedup_key', dedup_key_value
  );
end
$$;

create or replace function public.register_bet_upload_batch(
  p_job_id uuid,
  p_claim_token uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.bet_upload_jobs%rowtype;
  item jsonb;
  bet_doc jsonb;
  item_no integer;
  total_count integer;
  dedup_key_value text;
  resolved_bet_id uuid;
  inserted_here boolean;
  inserted_count integer := 0;
  reused_count integer := 0;
  bet_ids uuid[] := array[]::uuid[];
  item_results jsonb := '[]'::jsonb;
  summary jsonb;
  insert_result jsonb;
  computed_item_hash text;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;

  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'items must be an array'; end if;
  total_count := jsonb_array_length(p_items);
  if total_count < 1 or total_count > 10 then raise exception 'batch size must be 1..10'; end if;

  select * into job_row
  from public.bet_upload_jobs
  where id = p_job_id
  for update;

  if not found then raise exception 'job not found'; end if;
  if job_row.status = 'registered' then
    if job_row.claim_token is distinct from p_claim_token then raise exception 'invalid claim token'; end if;
    if job_row.result is null then raise exception 'registered job missing result'; end if;
    if (select count(*) from public.bet_upload_job_items where job_id = p_job_id) <> total_count then
      raise exception 'registered job item count mismatch';
    end if;

    -- Retry seguro apos resposta HTTP perdida: aceita somente o MESMO lote assinado.
    for item, item_no in
      select value, ordinality::integer
      from jsonb_array_elements(p_items) with ordinality
    loop
      bet_doc := item -> 'bet';
      if jsonb_typeof(item) is distinct from 'object'
         or nullif(item ->> 'item_index', '') is null
         or (item ->> 'item_index')::integer <> item_no
         or jsonb_typeof(bet_doc) is distinct from 'object' then
        raise exception 'registered job retry payload invalid at item %', item_no;
      end if;
      computed_item_hash := encode(extensions.digest(convert_to(public.bet_upload_canonical_json(bet_doc), 'UTF8'), 'sha256'), 'hex');
      if item ->> 'item_hash' is distinct from computed_item_hash
         or not exists (
           select 1 from public.bet_upload_job_items audit
           where audit.job_id = p_job_id
             and audit.item_index = item_no
             and audit.item_hash = computed_item_hash
         ) then
        raise exception 'Aposta %: registered job retry hash mismatch', item_no;
      end if;
    end loop;
    return job_row.result;
  end if;
  if job_row.status <> 'processing' then raise exception 'job must be processing and non-terminal'; end if;
  if job_row.claim_token is distinct from p_claim_token then raise exception 'invalid claim token'; end if;
  if job_row.lease_expires_at is null or job_row.lease_expires_at <= now() then raise exception 'expired lease'; end if;
  if job_row.finished_at is not null or job_row.bet_id is not null then raise exception 'job has terminal metadata'; end if;

  -- Primeira passada: valida o lote inteiro antes de qualquer INSERT.
  for item, item_no in
    select value, ordinality::integer
    from jsonb_array_elements(p_items) with ordinality
  loop
    begin
      if jsonb_typeof(item) is distinct from 'object' then raise exception 'item must be an object'; end if;
      if nullif(item ->> 'item_index', '') is null
         or (item ->> 'item_index')::integer <> item_no then
        raise exception 'item_index must be contiguous and match visual order';
      end if;
      bet_doc := item -> 'bet';
      if jsonb_typeof(bet_doc) is distinct from 'object' then raise exception 'bet must be an object'; end if;
      if bet_doc ? 'id' then raise exception 'bet id is server-generated'; end if;
      perform jsonb_populate_record(null::public.bets, bet_doc);
      computed_item_hash := encode(extensions.digest(convert_to(public.bet_upload_canonical_json(bet_doc), 'UTF8'), 'sha256'), 'hex');
      if nullif(item ->> 'item_hash', '') is null
         or item ->> 'item_hash' !~ '^[a-f0-9]{64}$'
         or item ->> 'item_hash' is distinct from computed_item_hash then
        raise exception 'item_hash mismatch';
      end if;
      if nullif(btrim(bet_doc ->> 'bookmaker'), '') is null
         or lower(btrim(bet_doc ->> 'bookmaker')) not in ('estrelabet', 'pinnacle', 'parimatch', 'betano', 'whale', 'polymarket')
         or nullif(btrim(bet_doc ->> 'league'), '') is null
         or nullif(btrim(bet_doc ->> 'team_a'), '') is null
         or nullif(btrim(bet_doc ->> 'team_b'), '') is null
         or nullif(btrim(bet_doc ->> 'market'), '') is null
         or nullif(btrim(bet_doc ->> 'pick'), '') is null
         or nullif(btrim(bet_doc ->> 'bet_datetime'), '') is null then
        raise exception 'required bet text missing';
      end if;
      if jsonb_typeof(bet_doc -> 'odd') is distinct from 'number'
         or (bet_doc ->> 'odd')::numeric <= 1 then raise exception 'odd must be numeric and > 1'; end if;
      if jsonb_typeof(bet_doc -> 'stake') is distinct from 'number'
         or (bet_doc ->> 'stake')::numeric <= 0 then raise exception 'stake must be numeric and > 0'; end if;
      perform (bet_doc ->> 'bet_datetime')::timestamptz;
      if jsonb_typeof(bet_doc -> 'raw_extraction') is distinct from 'object' then raise exception 'raw_extraction missing'; end if;
      if jsonb_typeof(bet_doc #> '{raw_extraction,match_context}') is distinct from 'object'
         or bet_doc #>> '{raw_extraction,match_context,schema_version}' <> '1' then
        raise exception 'match_context v1 missing';
      end if;
      if nullif(btrim(bet_doc #>> '{raw_extraction,match_context,lolesports_match_id}'), '') is null
         and not (
           bet_doc #>> '{raw_extraction,match_id_exception,case}' = 'ewc_qualifier'
           and nullif(btrim(bet_doc #>> '{raw_extraction,match_id_exception,reason}'), '') is not null
         ) then
        raise exception 'lolesports_match_id or approved exception required';
      end if;
      if nullif(btrim(bet_doc #>> '{raw_extraction,match_context,lolesports_match_id}'), '') is not null then
        if nullif(btrim(bet_doc #>> '{raw_extraction,match_context,start_time}'), '') is null then
          raise exception 'match_context.start_time required';
        end if;
        perform (bet_doc #>> '{raw_extraction,match_context,start_time}')::timestamptz;
        if extract(epoch from (
             (bet_doc ->> 'bet_datetime')::timestamptz
             - (bet_doc #>> '{raw_extraction,match_context,start_time}')::timestamptz
           )) / 3600.0 not between -24 and 12 then
          raise exception 'bet_datetime outside match window';
        end if;
      end if;
      if coalesce((bet_doc #>> '{raw_extraction,match_context,ambiguous}')::boolean, false)
         and not (
           bet_doc #>> '{raw_extraction,match_context,ambiguity_resolution,chosen_by}' = 'user'
           and bet_doc #>> '{raw_extraction,match_context,ambiguity_resolution,chosen_match_id}'
             = bet_doc #>> '{raw_extraction,match_context,lolesports_match_id}'
         ) then
        raise exception 'unresolved match ambiguity';
      end if;
      if lower(btrim(bet_doc ->> 'bookmaker')) <> 'polymarket'
         and public.bet_upload_ticket_of(bet_doc) is null then
        raise exception 'bookmaker ticket is required';
      end if;
      if lower(btrim(bet_doc ->> 'bookmaker')) = 'polymarket' then
        if bet_doc #>> '{raw_extraction,original_currency}' <> 'USD'
           or jsonb_typeof(bet_doc #> '{raw_extraction,original_stake_usd}') is distinct from 'number'
           or jsonb_typeof(bet_doc #> '{raw_extraction,fx_usd_brl}') is distinct from 'number'
           or nullif(btrim(bet_doc #>> '{raw_extraction,fx_source}'), '') is null
           or bet_doc #>> '{raw_extraction,fx_source}' !~ '[0-9]{4}-[0-9]{2}-[0-9]{2}'
           or jsonb_typeof(bet_doc #> '{raw_extraction,execution_totals,cost_usd}') is distinct from 'number'
           or jsonb_typeof(bet_doc #> '{raw_extraction,execution_totals,shares}') is distinct from 'number'
           or jsonb_typeof(bet_doc #> '{raw_extraction,execution_totals,payout_usd}') is distinct from 'number'
           or jsonb_typeof(bet_doc #> '{raw_extraction,execution_totals,odd_display}') is distinct from 'number'
           or jsonb_typeof(bet_doc #> '{raw_extraction,execution_totals,odd_exact}') is distinct from 'number' then
          raise exception 'polymarket execution totals incomplete';
        end if;
        if (bet_doc #>> '{raw_extraction,original_stake_usd}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,fx_usd_brl}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,execution_totals,cost_usd}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,execution_totals,shares}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,execution_totals,payout_usd}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,execution_totals,odd_display}')::numeric <= 0
           or (bet_doc #>> '{raw_extraction,execution_totals,odd_exact}')::numeric <= 0 then
          raise exception 'polymarket execution totals must be positive';
        end if;
        if abs((bet_doc #>> '{raw_extraction,original_stake_usd}')::numeric
             - (bet_doc #>> '{raw_extraction,execution_totals,cost_usd}')::numeric) > 0.01
           or abs((bet_doc #>> '{raw_extraction,execution_totals,payout_usd}')::numeric
             - (bet_doc #>> '{raw_extraction,execution_totals,shares}')::numeric) > 0.01
           or abs((bet_doc #>> '{raw_extraction,execution_totals,odd_exact}')::numeric
             - ((bet_doc #>> '{raw_extraction,execution_totals,payout_usd}')::numeric
                / (bet_doc #>> '{raw_extraction,execution_totals,cost_usd}')::numeric)) > 0.000001
           or abs((bet_doc ->> 'odd')::numeric
             - (bet_doc #>> '{raw_extraction,execution_totals,odd_display}')::numeric) > 0.001
           or abs((bet_doc ->> 'stake')::numeric
             - round((bet_doc #>> '{raw_extraction,execution_totals,cost_usd}')::numeric
                   * (bet_doc #>> '{raw_extraction,fx_usd_brl}')::numeric, 2)) > 0.01 then
          raise exception 'polymarket execution totals inconsistent';
        end if;
      end if;
      if jsonb_typeof(bet_doc -> 'is_map_bet') is distinct from 'boolean' then
        raise exception 'is_map_bet must be boolean';
      end if;
      if coalesce((bet_doc ->> 'is_map_bet')::boolean, false)
         and coalesce((bet_doc ->> 'map_number')::integer, 0) not between 1 and 5 then
        raise exception 'map_number must be 1..5';
      end if;
      if not (bet_doc ? 'status') or bet_doc ->> 'status' <> 'pending' then raise exception 'status must be pending'; end if;
      if not (bet_doc ? 'profit') or not (bet_doc ? 'settled_at') or not (bet_doc ? 'settle_source')
         or bet_doc -> 'profit' <> 'null'::jsonb
         or bet_doc -> 'settled_at' <> 'null'::jsonb
         or bet_doc -> 'settle_source' <> 'null'::jsonb then
        raise exception 'settlement fields must be null';
      end if;
      dedup_key_value := public.bet_upload_dedup_key(bet_doc);
      if not (item ? 'dedup_key') or item ->> 'dedup_key' is distinct from dedup_key_value then
        raise exception 'dedup_key mismatch';
      end if;
    exception when others then
      raise exception 'Aposta %: %', item_no, left(sqlerrm, 300);
    end;
  end loop;

  -- Segunda passada: a funcao inteira e uma transacao; qualquer erro reverte tudo.
  for item, item_no in
    select value, ordinality::integer
    from jsonb_array_elements(p_items) with ordinality
  loop
    begin
      bet_doc := item -> 'bet';
      insert_result := public.register_canonical_bet(bet_doc, job_row.storage_path);
      resolved_bet_id := (insert_result ->> 'bet_id')::uuid;
      inserted_here := (insert_result ->> 'inserted')::boolean;
      dedup_key_value := insert_result ->> 'dedup_key';
      computed_item_hash := encode(extensions.digest(convert_to(public.bet_upload_canonical_json(bet_doc), 'UTF8'), 'sha256'), 'hex');

      if inserted_here then
        inserted_count := inserted_count + 1;
      else
        reused_count := reused_count + 1;
      end if;

      insert into public.bet_upload_job_items (
        job_id, item_index, item_hash, dedup_key, bet_id, was_inserted, result
      ) values (
        p_job_id, item_no, computed_item_hash, dedup_key_value,
        resolved_bet_id, inserted_here, coalesce(item -> 'result', '{}'::jsonb)
      );

      bet_ids := array_append(bet_ids, resolved_bet_id);
      item_results := item_results || jsonb_build_array(
        coalesce(item -> 'result', '{}'::jsonb) || jsonb_build_object(
          'item_index', item_no,
          'bet_id', resolved_bet_id,
          'inserted', inserted_here
        )
      );
    exception when others then
      raise exception 'Aposta %: %', item_no, left(sqlerrm, 300);
    end;
  end loop;

  summary := jsonb_build_object(
    'version', 2,
    'total', total_count,
    'inserted', inserted_count,
    'reused', reused_count,
    'bet_ids', to_jsonb(bet_ids),
    'items', item_results
  );

  update public.bet_upload_jobs
  set status = 'registered',
      bet_id = bet_ids[1], -- compatibilidade legada: primeiro card em ordem visual
      error_code = null,
      error_message = null,
      result = summary,
      finished_at = now(),
      updated_at = now(),
      lease_expires_at = null
  where id = p_job_id;

  return summary;
end
$$;

revoke all on function public.bet_upload_ticket_of(jsonb) from public, anon, authenticated;
revoke all on function public.bet_upload_canonical_json(jsonb) from public, anon, authenticated;
revoke all on function public.bet_upload_dedup_key(jsonb) from public, anon, authenticated;
revoke all on function public.register_canonical_bet(jsonb, text) from public, anon, authenticated;
revoke all on function public.register_bet_upload_batch(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.bet_upload_ticket_of(jsonb) to service_role;
grant execute on function public.bet_upload_canonical_json(jsonb) to service_role;
grant execute on function public.bet_upload_dedup_key(jsonb) to service_role;
grant execute on function public.register_canonical_bet(jsonb, text) to service_role;
grant execute on function public.register_bet_upload_batch(uuid, uuid, jsonb) to service_role;

select 'bet upload batch ready: 1..10, atomic, service_role only';

commit;
