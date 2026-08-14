-- Rollback do hotfix1: restaura a funcao original da migration de 14/08

begin;

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

commit;
