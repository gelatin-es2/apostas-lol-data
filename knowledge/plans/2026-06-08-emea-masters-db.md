# Plano: Banco de dados EMEA Masters tier-2

**Data:** 2026-06-08
**Objetivo:** DB standalone com **fair calculada** + classificação **liga boa/ruim** e **time bom/ruim**, cobrindo as 13 ligas do ecossistema EMEA Masters, espelhando a metodologia da "planilha 1" (método principal tier-1).

---

## Achados da investigação (base do plano)

- Infra tier-2 já existe ~70%. `analyze_tier2_eu.cjs` cobre 9 ligas EMEA mas usa **LINE fixa 29.5** (sem fair) e **sem ranking de time** → não serve.
- `rebuild_tier2_dashboard_stats.cjs` cobre só 3 ligas (LFL/LES/LIT) mas **JÁ tem fair calculada + ranking de time no formato dashboard** → é a base ideal pra clonar.
- **Todas as 13 ligas EMEA têm league_id Riot** (nenhuma precisa Liquipedia). 4 faltam no projeto: Esports Balkan, Hellenic Legends, Arabian League, Road of Legends.
- Volume: ~750-850 games (Split 2), ~1.300 chamadas API, ~3-5 min por rebuild. Escala bem.
- **EMEA Masters (torneio) está LIVE agora** (Play-In 08-15/06); as ligas regionais já fecharam o split (abr→início jun) — dado pronto pra backtest.

## As 13 ligas + league_id Riot

| Liga | league_id | No projeto? |
|---|---|---|
| EMEA Masters (torneio) | 100695891328981122 | ✅ |
| LFL (França) | 105266103462388553 | ✅ |
| NLC (Nordic/UK) | 105266098308571975 | ✅ |
| Prime League (DACH) | 105266091639104326 | ✅ |
| LES / Superliga (Espanha) | 105266074488398661 | ✅ |
| Hitpoint Masters (CZ/SK) | 105266106309666619 | ✅ |
| LIT (Itália) | 105266094998946936 | ✅ |
| Liga Portuguesa | 105266101075764040 | ✅ |
| Rift Legends (Polônia) | 113673877956508505 | ✅ |
| Esports Balkan League | 105266111679554379 | ❌ adicionar |
| Hellenic Legends League | 105266108767593290 | ❌ adicionar |
| Arabian League | 109545772895506419 | ❌ adicionar |
| Road of Legends (Benelux) | 107407335299756365 | ❌ adicionar |

## Metodologia a replicar (da planilha 1)

- **Fair** (tier-1 canônica, `rebuild_dashboard_stats_cron.cjs:288-302`): `round((blueAvgTotal + redAvgTotal)/2)` no `.5`, `FAIR_ADJUSTMENT=0`, **leave-one-out** (exclui o próprio game), fallback liga×2 se time tem <5 games, fallback final 29.5. Avgs vêm de **livestats** (totalKills do match por time).
- **Trigger:** `2peel` (2 supports PEEL) / `1peel+flex` (1 PEEL + 1 FLEX). PEEL e FLEX = listas vigentes (Alistar fora).
- **Liga boa/ruim:** n≥10 pra colorir · 🟢≥60% · ⚪50-59% · 🔴<50%.
- **Time bom/ruim:** n≥4 pra colorir · 🟢≥60% · ⚪50-59% · 🔴<50% · marca `small_sample` se n<4.

## Plano de execução (fases)

**Fase 1 — Script novo `rebuild_emea_dashboard_stats.cjs`** (clonar `rebuild_tier2_dashboard_stats.cjs`):
- Trocar lista de 3 ligas pelas 13 (incl. os 4 league_ids novos).
- **Padronizar a fórmula de fair pra tier-1** (hoje o tier-2 usa kills por time + FAIR_ADJUSTMENT=-1, divergente — corrigir).
- Output separado: `cron-data/emea_dashboard_stats.json` (mesma estrutura do dashboard_stats: por trigger → backtest{n,hit,roi}, ligas[], teams[] com small_sample, supports[], champs[]).

**Fase 2 — Validação:** rodar 1 liga (LFL) e bater contra o output atual; depois rodar as 13 e conferir se hit%/fair fazem sentido.

**Fase 3 — Cron:** adicionar ao `daily-cron.yml` (idempotente, ~5min). Relevante já essa semana com EMEA Masters live.

**Fase 4 (opcional, depois):** aba "EMEA" no dashboard HTML + expandir `normalizeLeague` pras 13 ligas.

## Decisões pendentes (CEO)

1. **Fórmula fair** = padronizar na tier-1 (round da média de total_kills, sem -1)? [recomendo SIM]
2. **DB separado** `emea_dashboard_stats.json`, sem misturar com método principal nem `method_reports`? [recomendo SIM]
3. **EMEA Masters (o torneio)** entra como liga própria no DB? [recomendo SIM — é o produto final do ecossistema]
4. **Dashboard:** quer a aba visual agora (Fase 4) ou só montar o banco/JSON primeiro e ver os números?

## Riscos

- Ligas pequenas (Hellenic/Balkan/Road of Legends) terão n baixo pós-trigger → classificação de time fraca; mitiga com threshold n + flag small_sample.
- EMEA Masters live: rodar diário esta semana pra capturar o torneio conforme completa.
- Se integrar no dashboard, falta `normalizeLeague` de 10 ligas (não bloqueia o JSON standalone).
