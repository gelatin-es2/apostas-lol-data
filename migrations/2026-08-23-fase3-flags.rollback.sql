-- ROLLBACK de migrations/2026-08-23-fase3-flags.sql — 2026-08-23
-- Rodar no SQL Editor do painel Supabase.
--
-- Não desfaz o backfill gravado em raw_extraction.bet_phase (isso é reversível pelo
-- script: node .claude/scripts/backfill-bet-phase.cjs --undo, ou pelo snapshot
-- cron-data/snapshots/bets-2026-08-23.json).

-- 1. bets_summary: se você aplicou o passo 4b, recrie a versão original a partir do
--    pg_get_viewdef que salvou ANTES. Sem essa cópia, não há rollback automático —
--    por isso o passo 4a manda salvar a definição antes de trocar.

-- 2. view nova
drop view if exists public.bets_real;

-- 3. colunas novas (a is_simulated é gerada: derruba sem tocar em bookmaker)
drop index if exists public.bets_bet_phase_idx;
alter table public.bets drop column if exists bet_phase;

drop index if exists public.bets_is_simulated_idx;
alter table public.bets drop column if exists is_simulated;

-- 4. comentários voltam a vazio
comment on column public.odds_timeline.phase is null;
comment on column public.odds_timeline.riot_game_id is null;
