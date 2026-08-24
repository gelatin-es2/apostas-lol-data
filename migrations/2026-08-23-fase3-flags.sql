-- FASE 3 — higiene do banco — 2026-08-23
-- Rodar UMA VEZ no SQL Editor do painel Supabase (aba "New Query", nunca reaproveitar aba antiga).
-- Rollback: migrations/2026-08-23-fase3-flags.rollback.sql
-- Relatório: knowledge/reports/2026-08-23-execucao-fase3.md
--
-- POR QUE ISTO NÃO FOI APLICADO PELO AGENTE: este projeto não tem caminho de DDL
-- automatizado — sem psql, sem Supabase CLI, sem RPC exec_sql (checado 23/08: os
-- únicos RPCs expostos são os 9 do bet_upload). Toda DDL aqui é aplicada à mão pelo
-- Elvis no painel, igual às migrations anteriores. O que dava pra fazer por PostgREST
-- (marcação em jsonb, backfill de riot_game_id) já foi feito — ver relatório.
--
-- NADA AQUI APAGA DADO. São 3 colunas/visões novas + 2 comentários de documentação.

-- ============================================================================
-- 1. bets.is_simulated — coluna GERADA (impossível dessincronizar do bookmaker)
-- ============================================================================
-- Problema medido em 23/08: 439 das 1.309 bets têm bookmaker='SIMULATED' e somam
-- R$51.230,00 de lucro que NÃO É DINHEIRO. Elas já estão marcadas 3x no dado
-- (bookmaker, notes começando com "SIMULATED", raw_extraction.simulated=true —
-- 439/439 nas três, zero falso positivo nas 870 reais). O buraco nunca foi o dado:
-- é a query que esquece de filtrar. Uma coluna booleana GERADA dá um alvo curto e
-- óbvio (`is_simulated=is.false`) e, por ser `generated always`, não tem como ficar
-- mentindo depois — o Postgres recalcula a cada escrita.
alter table public.bets
  add column if not exists is_simulated boolean
  generated always as (bookmaker = 'SIMULATED') stored;

comment on column public.bets.is_simulated is
  'TRUE = linha de backtest, NÃO é dinheiro real. Coluna gerada de bookmaker=''SIMULATED''. '
  'Toda query de PnL/banca DEVE filtrar is_simulated = false (ou usar a view bets_real). '
  'Em 2026-08-23 eram 439 linhas somando R$51.230,00 de lucro simulado.';

create index if not exists bets_is_simulated_idx on public.bets (is_simulated);

-- ============================================================================
-- 2. bets.bet_phase — PRÉ vs LIVE (do MAPA apostado, não da série)
-- ============================================================================
-- Não existia nenhum campo dizendo se a aposta entrou antes do mapa começar ou com
-- o mapa rolando. As bets ao vivo só eram achadas por grep em `notes`. Sem isso, a
-- análise de régua linha×fair MENTE: o artefato "linha abaixo da fair acerta 80%"
-- era bet live em jogo lento.
--
-- CUIDADO: raw_extraction.match_context.state ('inProgress'/'completed') NÃO serve
-- pra isto. Aquilo é o estado da SÉRIE no schedule no momento do registro. Uma bet
-- de mapa 2 feita pós-draft do mapa 2 aparece com a série 'inProgress' e é PRÉ.
-- É a mesma armadilha do odds_timeline.phase (ver item 4 abaixo).
alter table public.bets
  add column if not exists bet_phase text
  check (bet_phase is null or bet_phase in ('pre', 'live'));

comment on column public.bets.bet_phase is
  '''pre'' = aposta entrou antes do primeiro frame do MAPA apostado (inclui pós-draft). '
  '''live'' = mapa já estava rolando. NULL = não deu pra provar — NULL é resposta legítima, '
  'não preencher no chute. Fase do MAPA, nunca da série. '
  'Backfill 23/08 por evidência explícita em notes/raw_extraction (backfill-bet-phase.cjs).';

create index if not exists bets_bet_phase_idx on public.bets (bet_phase);

-- Promove o backfill que já está gravado em raw_extraction.bet_phase pelo
-- .claude/scripts/backfill-bet-phase.cjs (rodado 23/08 via PostgREST).
-- Idempotente: só escreve onde a coluna ainda está null e o jsonb tem valor válido.
update public.bets
   set bet_phase = raw_extraction ->> 'bet_phase'
 where bet_phase is null
   and raw_extraction ->> 'bet_phase' in ('pre', 'live');

-- ============================================================================
-- 3. view bets_real — o caminho seguro por padrão
-- ============================================================================
create or replace view public.bets_real as
  select * from public.bets where bookmaker <> 'SIMULATED';

comment on view public.bets_real is
  'bets SEM as linhas de backtest (bookmaker=''SIMULATED''). Use esta view em qualquer '
  'cálculo de PnL/banca/ROI real. A tabela bets crua inclui backtest.';

-- ============================================================================
-- 4. CONFERIR E CORRIGIR: a view bets_summary hoje SOMA as SIMULATED
-- ============================================================================
-- Medido 23/08: bets_summary do dia 2026-04-01 devolve total=2, profit=-170,00 —
-- e as DUAS bets daquele dia são SIMULATED. Ou seja, a view mistura backtest com
-- dinheiro real.
--
-- PASSO 4a — ver a definição REAL antes de mexer (não aplicar 4b de memória):
--   select pg_get_viewdef('public.bets_summary'::regclass, true);
--
-- PASSO 4b — recriar trocando `from bets` por `from bets_real` (ou acrescentando
-- `where bookmaker <> 'SIMULATED'`). O template abaixo bate com as colunas
-- observadas (day, total, wins, losses, pending, turnover, profit), mas a
-- definição real manda: se 4a divergir, adapte em vez de colar isto.
--
-- create or replace view public.bets_summary as
--   select (bet_datetime at time zone 'UTC')::date          as day,
--          count(*)                                          as total,
--          count(*) filter (where status = 'green')          as wins,
--          count(*) filter (where status = 'red')            as losses,
--          count(*) filter (where status = 'pending')        as pending,
--          sum(stake)                                        as turnover,
--          sum(profit)                                       as profit
--     from public.bets_real
--    group by 1
--    order by 1 desc;

-- ============================================================================
-- 5. Documentar o phase enganoso de odds_timeline (item 3.4 do plano)
-- ============================================================================
-- odds_timeline.phase é a fase da SÉRIE na leitura da Pinnacle, NÃO a fase do mapa
-- daquela linha. Uma leitura da linha do mapa 3 tirada enquanto o mapa 2 rola vem
-- com phase='live' e é, pro mapa 3, uma leitura PRÉ-JOGO. Gravado em
-- capture_pinnacle_to_supabase.cjs:265.
-- Consequência: filtrar phase='live' pra estudar mercado ao vivo mistura leitura
-- pré-mapa com leitura in-play. Pra fase POR MAPA use lib/mapPhase.cjs.
comment on column public.odds_timeline.phase is
  'Fase da SÉRIE na leitura da Pinnacle — NÃO é a fase do mapa desta linha. '
  'Leitura do mapa 3 tirada durante o mapa 2 vem phase=''live'' mas é PRÉ pro mapa 3. '
  'Pra fase real por mapa, derive com lib/mapPhase.cjs '
  '(game_drafts.first_frame_utc, com closing_lines.first_seen_live_at de fallback).';

comment on column public.odds_timeline.riot_game_id is
  'game_id da Riot do MAPA desta linha. Backfill por .claude/scripts/link-odds-to-riot.cjs '
  '(agendado no workflow daily-cron.yml desde 23/08). NULL = série não resolvida com '
  'segurança (ambiguidade/liga fora do lolesports) — o linker pula em vez de chutar.';

-- ============================================================================
-- Verificação (rodar depois de aplicar)
-- ============================================================================
-- select count(*) filter (where is_simulated)       as simuladas,
--        count(*) filter (where not is_simulated)   as reais,
--        sum(profit) filter (where is_simulated)    as profit_fake,
--        sum(profit) filter (where not is_simulated) as profit_real,
--        count(*) filter (where bet_phase = 'live') as live,
--        count(*) filter (where bet_phase = 'pre')  as pre,
--        count(*) filter (where bet_phase is null)  as sem_fase
--   from public.bets;
-- Medido em 23/08 logo após o backfill: simuladas=439, profit_fake=51230.00,
--   reais=870, profit_real=151641.05, live=41, pre=461 (439 SIMULATED + 22 reais),
--   sem_fase=807.
-- profit_real anda sozinho conforme o settle roda — o que tem que bater exato é
-- simuladas=439 / profit_fake=51230.00 e a soma live+pre+sem_fase = total de bets.
