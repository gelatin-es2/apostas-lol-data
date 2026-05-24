# Scripts

Scripts Node.js do projeto `apostas-lol-data`.

## Ativos (chamados pelo cron ou comandos do bet-logger)

| Script | Status | O que faz | Quando roda |
|--------|--------|-----------|-------------|
| `capture_fair_lines.cjs` | ATIVO | Captura fair lines pré-jogo via fórmula (blueAvg+redAvg)/2, grava `cron-data/YYYY-MM-DD-fair-pre.json` | Cron diário — 2× (LCK+LPL, LEC+CBLOL) |
| `analyze_yesterday.cjs` | ATIVO | Wrapper que delega pra `_archive/scripts/analyze_range.cjs` com data de ontem/hoje | Cron diário — 2× (ontem + hoje best-effort) |
| `save_report_to_db.cjs` | ATIVO | Lê `cron-data/YYYY-MM-DD-results.json` e faz upsert em `method_reports` no Supabase | Cron diário — 2× (ontem + hoje) |
| `rebuild_dashboard_stats_cron.cjs` | ATIVO | Rebuild completo do `cron-data/dashboard_stats.json` — fetch API Riot + fair + stats Split 2 | Cron diário |
| `compute_real_bets_method.cjs` | ATIVO | Lê bets reais do Supabase e grava `cron-data/real_bets_method.json` com stats do método | Cron diário |
| `analyze_tier2_eu.cjs` | ATIVO | Análise standalone tier 2 EU (LFL/LES/LIT/etc), grava `cron-data/tier2_eu_split2_analysis.json` | Cron diário |
| `export-bets-snapshot.cjs` | ATIVO | Exporta todas as bets do Supabase pra `cron-data/snapshots/bets-YYYY-MM-DD.json` | Cron diário — backup |
| `rebuild_lfl_dashboard_stats.cjs` | MANUAL | Rebuild do `cron-data/lfl_dashboard_stats.json` focado só na LFL | Manual quando necessário |
| `rebuild_tier2_dashboard_stats.cjs` | MANUAL | Rebuild do `cron-data/tier2_dashboard_stats.json` (LFL+LES+LIT) | Manual quando necessário |
| `daily_briefing.cjs` | HELPER | Gera briefing diário com jogos do dia + fair lines + flags | Invocado pelo bet-logger skill |
| `supabase-save-bet.cjs` | HELPER | Salva/atualiza bet individual no Supabase | Invocado pelo bet-logger skill |
| `settle-pending-bets.cjs` | HELPER | Settla bets pendentes consultando resultados | Invocado pelo bet-logger skill |
| `enrich-match-context.cjs` | HELPER | Enriquece bet com contexto do match (picks, gameId) | Invocado pelo bet-logger skill |
| `_load-config.cjs` | HELPER | Carrega config do `.env` local — fallback pra quando não há env vars | Importado por outros scripts |

## Path convention

Todos os scripts desta pasta usam:
```js
const ROOT = path.resolve(__dirname, '../..');
```
para referenciar a raiz do repositório. **Nunca use `__dirname` diretamente** para acessar `cron-data/` ou `lib/`.

## Arquivados

Scripts sem uso ativo estão em `_archive/scripts/`. `analyze_yesterday.cjs` ainda depende de `_archive/scripts/analyze_range.cjs`.
