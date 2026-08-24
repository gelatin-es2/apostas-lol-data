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
| `link-odds-to-riot.cjs` | ATIVO | Preenche `odds_timeline.riot_game_id` + `game_clock_s` casando série Pinnacle → match Riot. Ambiguidade = skip, nunca chuta | Cron diário (janela de 4 dias) — **entrou na agenda em 2026-08-23**; antes rodava só à mão e tinha parado em 15/08 |
| `backfill-bet-phase.cjs` | MANUAL | Marca `raw_extraction.bet_phase` = `pre`/`live` (fase do MAPA apostado) por evidência explícita. Sem evidência = deixa NULL | Manual / após lote grande de bets novas |
| `_load-config.cjs` | HELPER | Carrega config do `.env` local — fallback pra quando não há env vars | Importado por outros scripts |

## Armadilhas de consulta — ler antes de escrever query

**1. `bets` inclui backtest.** 439 linhas têm `bookmaker='SIMULATED'` e somam
R$51.230,00 de lucro que não é dinheiro. Toda query de PnL/banca/ROI precisa excluí-las
(`bookmaker <> 'SIMULATED'`, ou a view `bets_real`, ou a coluna `is_simulated` depois da
migration `2026-08-23-fase3-flags.sql`). `quant-query.cjs` exclui por padrão desde 23/08
— antes reportava R$203.810 onde o real era R$152.580. A view `bets_summary` **ainda
soma** as simuladas (corrigir junto com a migration).

**2. `odds_timeline.phase` é a fase da SÉRIE, não do MAPA.** Filtrar `phase='live'` pra
estudar mercado ao vivo pega 31,6% de linha que ainda era pré-jogo do mapa (705 de 2.228
linhas com âncora, medido 23/08). Use `lib/mapPhase.cjs`. Detalhe em
`.claude/scripts/sql/2026-08-04-odds-capture.sql`.

**3. `raw_extraction.match_context.state` (`inProgress`/`completed`) não diz se a APOSTA
foi ao vivo.** É o estado da série no schedule no momento do registro — bet de mapa 2
feita pós-draft aparece com a série `inProgress` e é PRÉ. Pra isso existe
`raw_extraction.bet_phase` (e a coluna `bet_phase` depois da migration).

**4. `bet_datetime` NÃO é a hora da aposta** — é o `startTime` do match. Não dá pra
inferir pré/live comparando com o relógio do jogo.

## Path convention

Todos os scripts desta pasta usam:
```js
const ROOT = path.resolve(__dirname, '../..');
```
para referenciar a raiz do repositório. **Nunca use `__dirname` diretamente** para acessar `cron-data/` ou `lib/`.

## Arquivados

Scripts sem uso ativo estão em `_archive/scripts/`. `analyze_yesterday.cjs` ainda depende de `_archive/scripts/analyze_range.cjs`.
