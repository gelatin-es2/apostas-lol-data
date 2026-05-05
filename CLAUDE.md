# apostas-lol-data — Constituição do projeto

> **Tom, response discipline, regras invioláveis e segurança vivem em `~/.claude/CLAUDE.md` (global). Este arquivo é só técnico/projeto — anti-pattern #8 do guia.**

---

## Visão geral

Sistema de captura, análise e persistência de dados de apostas em LoL. Detecta o trigger **2-peel Under** automaticamente, calcula fair lines, faz backtest contínuo, e popula dashboard separado.

Roda em GitHub Actions (sem servidor) 2x/dia. Output: JSONs commitados no próprio repo + upserts no Supabase.

---

## Stack

| Camada | Tecnologia |
|--------|------------|
| Runtime | Node.js 20, **sem `package.json`** — usa só built-ins (`fs`, `path`, `https`) |
| Orquestração | GitHub Actions (`.github/workflows/daily-cron.yml`) |
| Cron real | `06:30 UTC (03:30 BRT)` + `14:00 UTC (11:00 BRT)` todo dia |
| Persistência | Supabase tabela `method_reports`, PK composta `(game_id, map_number)` |
| Frontend | Next.js em Vercel (`apostas-lol-dashboard.vercel.app`) — **repo separado** |
| Dados externos | Oracle's Elixir CSV (em `../year_backtest/datasets/2026_oracle.csv` — FORA desse repo) |

---

## Definição autoritativa do método

Está em `analyze_yesterday.cjs:20-24`. **Não duplicar** — qualquer agente que detecte trigger lê dali.

```js
PEEL_PURE   = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio']
FLEX_ENGAGE = ['bard','rakan','alistar']
```

| Trigger | Condição |
|---------|----------|
| `2peel` | AMBOS os suportes (blue + red) na lista PEEL_PURE |
| `1peel+flex` | 1 suporte PEEL_PURE + 1 dos 3 (Bard/Rakan/Alistar) entre os 2 times |
| (sem trigger) | Demais casos — ignorado |

Constantes do backtest (`rebuild_dashboard_stats_cron.cjs`): linha **29.5**, stake **R$100**, odd **1.85**, breakeven **54,1%**, filtro `SPLIT2_START = 2026-04-01`.

---

## Scripts (ordem de execução do cron)

| # | Script | Função | Saída |
|---|--------|--------|-------|
| 1 | `capture_fair_lines.cjs <ligas>` | Schedule lolesports + odds Polymarket; fair = avg(A) + avg(B) do Oracle | `cron-data/YYYY-MM-DD-fair-pre.json` |
| 2 | `analyze_yesterday.cjs [data]` | Game completed → kills + sup → detecta trigger | `cron-data/YYYY-MM-DD-results.json` |
| 3 | `save_report_to_db.cjs [data]` | Upsert linhas com trigger | Supabase `method_reports` |
| 4 | `rebuild_dashboard_stats_cron.cjs` | Reanalisa Split 2 inteiro; agrega por liga/sup/time/champ-lane + ML picks | `cron-data/dashboard_stats.json` + `ml_picks.json/.js` |

Workflow é **idempotente**: scripts 1 e 4 podem rodar várias vezes no mesmo dia, se mantém safe (mescla com existente).

---

## APIs externas usadas

| Endpoint | Pra quê | Detalhe |
|----------|---------|---------|
| `esports-api.lolesports.com/persisted/gw/getSchedule` | Schedule por liga | Key pública hardcoded |
| `esports-api.lolesports.com/persisted/gw/getEventDetails` | Games dentro de match | Mesma key |
| `feed.lolesports.com/livestats/v1/window/{gameId}` | Kills + composições + winner | `startingTime` precisa ser múltiplo de 10s |
| `gamma-api.polymarket.com/events` | Odds reais "Total Kills Over/Under" | **Acesso via DoH bypass** (Cloudflare 1.1.1.1) — ISP BR bloqueia DNS direto |
| `ddragon.leagueoflegends.com` | Slugs de champions | Riot oficial, sem auth |

---

## Tabela `method_reports` (Supabase)

Campos salvos em cada upsert (de `save_report_to_db.cjs`):

`match_date, league, match_id, game_id, map_number, team_blue, team_red, sup_blue, sup_red, trigger_type, flex_engages, total_kills, fair_line, fair_source, under_hit`

Conflict key: `(game_id, map_number)`. Mesmo jogo rodado 2x no cron sobrescreve sem duplicar.

---

## Bugs / inconsistências conhecidos

1. **CBLOL leagueId difere entre scripts.** `capture_fair_lines.cjs` usa `98767991325878492`, `rebuild_dashboard_stats_cron.cjs` usa `98767991332355509`. Um dos dois está errado — investigar antes de tocar em CBLOL.
2. **README com horário desatualizado.** Diz `06:50 + 15:00 UTC`, workflow real é `06:30 + 14:00 UTC`. Atualizar.
3. **CSV Oracle ausente no Actions.** `capture_fair_lines.cjs` faz `process.exit(1)` se não acha o CSV. No workflow não há env `ORACLE_CSV` injetada, e o caminho `../year_backtest/...` não existe no checkout. Provavelmente vem falhando silenciosamente (mascarado por `continue-on-error: true`). Resultado: fair lines reais quase nunca calculadas em prod, cai sempre no default `29.5` em `analyze_yesterday.cjs`.
4. **Dashboard só conta 2peel puro.** `rebuild_dashboard_stats_cron.cjs:158` filtra `peel2 = ambos PEEL`. Subset `1peel+flex` salvo no banco é IGNORADO no dashboard. Decidir: incluir ou manter excluído conscientemente.

---

## O que NÃO está aqui

| Faltando | Onde provavelmente está | Próximo agente |
|----------|------------------------|----------------|
| Apostas reais (datas, casas, odds, stakes variáveis) | Outra tabela Supabase ou outro sistema — confirmar com CEO | Quant Analyst |
| CLV real (closing line das casas) | Não existe — só fair calculada do Oracle baseline | Quant Analyst |
| Alerta pré-jogo (draft fechou, vai bater?) | Não existe | Draft Watcher |
| Odds shopping entre 5 casas | Não existe | Odds Shopper |
| Relatórios diários/semanais consolidados | Dashboard já tem dados, mas não tem export/notification | Reporter |

---

## Convenções operacionais

- **Não mexer** em `cron-data/*.json` na mão — são gerados pelos scripts. Editar = quebrar idempotência.
- Adicionar `.gitignore` é prioridade próxima (proteção anti-secret).
- Adicionar `package.json` mínimo é higiene (mesmo que sem deps externas) — facilita ferramentas de análise.
- Scripts são idempotentes — pode re-rodar manualmente via `workflow_dispatch` no GitHub Actions.
- Time mapping `TEAM_CODE_TO_ORACLE` é hardcoded em `capture_fair_lines.cjs` E `analyze_yesterday.cjs` — duplicação. Refatorar pra arquivo compartilhado se for tocar.
