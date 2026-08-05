-- Captura automática de odds Pinnacle (24/7 via GitHub Actions) — 2026-08-04
-- Rodar UMA VEZ no SQL Editor do painel Supabase (projeto yxhpopkxlupdpqkdaffg).
-- Análise: knowledge/reports/2026-08-04-analise-captura-pinnacle-24-7.md
--
-- 3 tabelas: odds_timeline (timeline crua), closing_lines (closing materializada
-- por série+mapa), capture_runs (heartbeat — sensor do watchdog).
-- RLS ligado SEM policy pública: escrita/leitura só via service role key (server-side).

-- ============================================================================
-- 1. odds_timeline — 1 row por (série, mapa, leitura QUE MUDOU)
--    map_number 0 = série inteira (moneyline da série, spread de mapas)
--    map_number 1..5 = mapa (kills totals + ladder + team totals + ML do mapa)
-- ============================================================================
create table public.odds_timeline (
  id               bigint generated always as identity primary key,
  captured_at      timestamptz not null,
  source           text not null,            -- 'gha-baseline' | 'gha-live' | 'pc-legacy' | 'manual'
  matchup_id       bigint not null,          -- matchup Kills consultado (sub-matchup no live)
  series_id        bigint not null,          -- parentId Pinnacle: chave estável pré+live
  league           text,                     -- nome cru da Pinnacle ('League of Legends - LCK')
  team_home        text not null,            -- nome cru da Pinnacle (canon é join na leitura)
  team_away        text not null,
  start_time       timestamptz,              -- startTime da série
  phase            text not null check (phase in ('pre','live')),
  map_number       smallint not null check (map_number between 0 and 5),
  minutes_to_start integer,                  -- negativo após o início da série
  main_line        numeric(5,1),             -- linha principal de kills do mapa (null p/ map 0)
  over_dec         numeric(6,3),
  under_dec        numeric(6,3),
  juice_pct        numeric(5,2),
  ml_home_us       integer,                  -- moneyline US odds (map 0 = série, map N = mapa)
  ml_away_us       integer,
  ladder           jsonb,                    -- [{p,o,u}] ladder de kills compacto
  team_totals      jsonb,                    -- [{side,points,o_us,u_us}]
  spread_main      jsonb,                    -- {hp,ap,h_us,a_us} kills spread (map N) ou map handicap (map 0)
  market_version   bigint not null,          -- max(version) dos markets do grupo — detector de reprice
  content_hash     text not null,            -- md5 do payload normalizado — motor do delta-gating
  riot_game_id     text,                     -- backfill offline via livestats Riot
  game_clock_s     integer                   -- backfill offline via livestats Riot
);

create index odds_tl_series_map_ts on public.odds_timeline (series_id, map_number, captured_at desc);
create index odds_tl_captured_at   on public.odds_timeline (captured_at desc);
-- Idempotência p/ retries e jobs sobrepostos. content_hash incluso de propósito:
-- mudança de mercado SEM bump de version (ex.: ladder encolheu) não pode ser engolida.
create unique index odds_tl_dedup on public.odds_timeline
  (series_id, map_number, phase, market_version, content_hash);

alter table public.odds_timeline enable row level security;

-- ============================================================================
-- 2. closing_lines — closing materializada, 1 row por (série, mapa)
--    map 1: última leitura pré-jogo (minutes_to_start > 0).
--    map 2+: última leitura do mapa N antes da 1ª leitura LIVE do mapa N.
--    map 0: ML da série na última leitura pré-jogo.
-- ============================================================================
create table public.closing_lines (
  series_id          bigint not null,
  map_number         smallint not null check (map_number between 0 and 5),
  league             text,
  team_home          text,
  team_away          text,
  start_time         timestamptz,
  closing_line       numeric(5,1),           -- null p/ map 0 (só ML)
  over_dec           numeric(6,3),
  under_dec          numeric(6,3),
  ml_home_us         integer,
  ml_away_us         integer,
  ladder             jsonb,
  captured_at        timestamptz not null,   -- ts da leitura que virou closing
  minutes_to_start   integer,
  closing_source     text not null default 'pre_start',  -- 'pre_start' | 'pre_map_live_anchor'
  first_seen_live_at timestamptz,            -- 1ª leitura live do mapa (âncora de início — independe da Riot)
  primary key (series_id, map_number)
);

alter table public.closing_lines enable row level security;

-- ============================================================================
-- 3. capture_runs — heartbeat: 1 row POR EXECUÇÃO, mesmo sem mudança de mercado
--    (o watchdog lê ESTA tabela; odds_timeline não serve — mercado quieto ≈ 0 rows)
-- ============================================================================
create table public.capture_runs (
  id             bigint generated always as identity primary key,
  ran_at         timestamptz not null default now(),
  source         text not null,              -- 'gha-baseline' | 'gha-live' | 'pc-legacy'
  mode           text not null,              -- 'baseline' | 'live-iteration'
  matchups_seen  integer not null default 0,
  live_seen      integer not null default 0,
  rows_written   integer not null default 0,
  closings_upserted integer not null default 0,
  errors         jsonb,                      -- [{step,error,status}] — null se limpo
  duration_ms    integer,
  notes          text
);

create index capture_runs_ran_at on public.capture_runs (ran_at desc);

alter table public.capture_runs enable row level security;
