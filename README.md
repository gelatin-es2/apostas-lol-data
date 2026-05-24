# apostas-lol-data

Sistema completo de operação de apostas em LoL: captura schedule + odds, analisa resultados, detecta trigger 2-peel Under, registra bets reais via OCR, settla automático, popula dashboard público.

**URL pública (dashboard):** https://apostas-lol-dashboard.vercel.app/

---

## Componentes

### 1. Cron diário (GitHub Actions)

Roda 1x/dia sem PC ligado, sem VPS. Workflow idempotente.

| Cron | UTC | BRT | O que faz |
|------|-----|-----|-----------|
| `0 12 * * *` | 12:00 | 09:00 | Captura fair fórmula (LCK+LPL+LEC+CBLOL), analisa ontem+hoje, rebuilda dashboard stats |

Fair Pinnacle manual é entregue pelo Elvis via `/log-fair` antes dos jogos. Cron 03:30 BRT e Polymarket descontinuados em 2026-05-23.

### 2. Bet Logger (automático via Claude Code)

Print de aposta no chat do Claude → skill `bet-logger-extract` autodispara → subagent `bet-logger` extrai dados → salva no Supabase em `pending`. Hook `UserPromptSubmit` settla a cada msg do CEO (busca livestats, atualiza para `green`/`red`/`cashout` + comp completa + trigger detectado).

Componentes globais em `~/.claude/`:
- `agents/bet-logger.md` — subagent OCR + persistência
- `commands/log-bet.md` — slash command manual
- `skills/bet-logger-extract.md` — autodisparo em print
- `hooks/check-pending-bets.cjs` — settle automático (cache 5min)

### 3. Dashboard (Vercel + GitHub Pages)

HTML estático em `dashboard/index.html`. Stats vêm de:
- **Supabase** (runtime): tracker de bets reais
- **raw.githubusercontent.com** (runtime): JSONs do `cron-data/` (atualiza sem deploy)

Vercel deploya automático em cada push pro `main` (Root Directory = `dashboard/`).

---

## Ligas operadas

| Tier | Ligas | Cobertura |
|------|-------|-----------|
| Majors | LCK · LPL · LEC · CBLOL | ✅ cron diário (Riot API) |
| Tier 2 EU | LFL · LES · LIT | ✅ cron + dashboards específicos (`tier2_dashboard_stats.json`, `lfl_dashboard_stats.json`) |
| Internacionais | EWC qualifier (Korea/EMEA/China) | ⚠️ briefing via Liquipedia (não-Riot), settle manual |

---

## Output (JSONs em `cron-data/`)

| Arquivo | Quem gera | Conteúdo |
|---------|-----------|----------|
| `YYYY-MM-DD-fair-pre.json` | `capture_fair_lines.cjs` | Fair fórmula pré-jogo (cron diário) |
| `YYYY-MM-DD-fair-pinnacle.json` | Elvis via `/log-fair` | Fair Pinnacle manual (fonte primária) |
| `YYYY-MM-DD-results.json` | `analyze_yesterday.cjs` | Análise pós-jogo (kills, supports, trigger) |
| `dashboard_stats.json` | `rebuild_dashboard_stats_cron.cjs` | Backtest 4 majors agregado |
| `team_avg_kills.json` | mesmo | Avg kills por time (calibra fair dinâmica) |
| `ml_picks.json` / `.js` | mesmo | Winrate por champion × posição |
| `tier2_dashboard_stats.json` | `rebuild_tier2_dashboard_stats.cjs` | Backtest 3 ligas tier 2 EU |
| `lfl_dashboard_stats.json` | `rebuild_lfl_dashboard_stats.cjs` | LFL only com breakdown rico |
| `snapshots/bets-YYYY-MM-DD.json` | `export-bets-snapshot.cjs` | Snapshot diário completo de todas as bets (backup) |
| `*-polymarket-lines.json` | (histórico, imutável) | Odds Polymarket — descontinuado 2026-05-23 |

Tudo commitado no próprio repo. Stats puxam via `raw.githubusercontent.com` (URL absoluta — repo precisa ser **público**).

---

## Definição autoritativa do método

`PEEL_PURE` e `FLEX_ENGAGE` em `analyze_yesterday.cjs:20-24`. Manter sincronizado nos demais scripts.

```js
PEEL_PURE   = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio']
FLEX_ENGAGE = ['bard','rakan','alistar','lux','anivia']  // expandido 2026-05-23: Lux + Anivia
```

| Trigger | Condição |
|---------|----------|
| `2peel` | ambos suportes (blue + red) na PEEL_PURE |
| `1peel+flex` | 1 peel + 1 flex_engage entre os 2 times |

Backtest: stake R$100, odd 1.85 (breakeven 54.1%). **Odd real média do CEO: 1.75 (breakeven 57.1%)**.
Fair line: Pinnacle manual (Elvis via `/log-fair`) primária. Fórmula `(blueAvgTotal+redAvgTotal)/2` round `.5` sempre calculada em paralelo (A/B futuro). Fallback `29.5`.
Filtro: `SPLIT2_START = 2026-04-01`.

---

## Tabelas Supabase

- **`bets`** — apostas reais do CEO. Campos críticos: `bet_datetime` (NUNCA null) + `raw_extraction.match_context.lolesports_match_id` (necessário pro settle achar o jogo).
- **`method_reports`** — backtest dos triggers detectados, PK `(game_id, map_number)`.
- **`bets_summary`** — view agregada por dia.

---

## APIs externas

| Endpoint | Uso |
|----------|-----|
| `esports-api.lolesports.com/persisted/gw/getSchedule` | Schedule por liga (key pública) |
| `esports-api.lolesports.com/persisted/gw/getEventDetails` | Games dentro de um match |
| `feed.lolesports.com/livestats/v1/window/{gameId}` | Kills, comps, winner |
| ~~`gamma-api.polymarket.com/events`~~ | Descontinuado 2026-05-23. Histórico em `cron-data/*-polymarket-lines.json`. |
| `liquipedia.net/leagueoflegends/api.php` | EWC qualifiers (gzip + UA identificável obrigatórios) |
| `ddragon.leagueoflegends.com` | Slugs de champions |

---

## Troubleshooting

- **Workflow falha em "lolesports falhou":** API às vezes está fora. Tenta de novo manual via "Run workflow" na aba Actions.
- **Schedule não dispara no horário exato:** GitHub Actions tem ~5-15min de delay. Não contar com precisão de minuto.
- **Falta dados de support pra LEC/CBLOL:** lolesports API live é bloqueada nessas. `analyze_yesterday.cjs` pega só após mapa terminar (deve funcionar quando roda às 03:50 do dia seguinte).
- **Bet ficou pending eterna:** verificar se `bet_datetime` e `raw_extraction.match_context.lolesports_match_id` estão preenchidos. Sem isso, settle não acha o jogo.
- **Site Vercel sem dado novo:** stats vêm de raw.github (runtime). Hard reload `Ctrl+Shift+R`. Se ainda velho, checar se cron rodou hoje.

---

## Bugs conhecidos pendentes

1. **CBLOL leagueId divergente** entre `capture_fair_lines.cjs` (`98767991325878492`) e demais (`98767991332355509`). Investigar antes de tocar CBLOL.
2. **CSV Oracle deprecated** em 2026-05-05 mas `capture_fair_lines.cjs` ainda tem `process.exit(1)` se não acha — dead code, remover.
3. **Tier 2 EU não está no cron** — `rebuild_tier2_dashboard_stats.cjs` e `rebuild_lfl_dashboard_stats.cjs` rodam manual. Adicionar ao workflow se quiser auto-update.
4. **EWC qualifier auto-settle** — sem fonte API (não-Riot), settle manual via input do CEO.
