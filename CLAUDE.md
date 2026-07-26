# apostas-lol-data — Constituição do projeto

> Tom, response discipline, regras invioláveis e segurança vivem em `~/.claude/CLAUDE.md` (global). Este arquivo é só técnico/projeto — anti-pattern #8 do guia.

---

## Visão geral

Sistema completo de apostas LoL: captura schedule + odds, analisa resultados, detecta trigger 2-peel Under, registra bets reais via OCR, settla automático, popula dashboard público.

Roda em GitHub Actions 2x/dia (cron) + Hook Claude Code a cada msg do CEO (settle pending).

---

## Stack atualizada

| Camada | Tecnologia |
|--------|------------|
| Runtime | Node.js 20+, `package.json` com `engines.node>=20` (private). Scripts usam só built-ins (`fs`, `path`, `https`, `zlib`). |
| Orquestração cron | GitHub Actions (`.github/workflows/daily-cron.yml`), 1x/dia desde 2026-05-23 |
| Cron horários | **`12:00 UTC = 09:00 BRT`** (único cron diário; slot 06:30 UTC descontinuado junto com Polymarket) |
| Persistência | Supabase 2 tabelas: `bets` (apostas reais do CEO, ~120+ rows) + `method_reports` (backtest method, PK `(game_id, map_number)`) |
| Frontend | **HTML estático** (não Next.js!) em `dashboard/index.html`, deployado no **Vercel** (`apostas-lol-dashboard.vercel.app`). Vercel conectado a este repo desde 2026-05-07, Root=`dashboard/`, push=auto-deploy. |
| Dados externos | lolesports key pública + Liquipedia (gzip + UA). **Polymarket REATIVADA 2026-07-25** como coletor de curvas de odds (`scripts/polymarket-history.cjs` + `polymarket-chart.cjs`, dados em `cron-data/polymarket-history/`, manutenção diária `--days=2`). |
| Fair line | Pinnacle manual (Elvis via `/log-fair`) como primária + fórmula `(blueAvg+redAvg)/2` sempre calculada em paralelo. Arquivos `cron-data/YYYY-MM-DD-fair-pinnacle.json`. |

---

## Definição autoritativa do método

`PEEL_PURE` e `FLEX_ENGAGE` em `analyze_yesterday.cjs:20-24` (e duplicado em `rebuild_dashboard_stats_cron.cjs`, `settle-pending-bets.cjs`, `quant-query.cjs`). **Manter sincronizado** quando alterar.

```js
PEEL_PURE   = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio']
FLEX_ENGAGE = ['bard','rakan','lux','anivia']  // 2026-05-23 +Lux+Anivia · 2026-05-29 -Alistar (-26.8% ROI n=21)
```

| Trigger | Condição |
|---------|----------|
| `2peel` | AMBOS suportes (blue + red) na lista PEEL_PURE |
| `1peel+flex` | 1 suporte PEEL_PURE + 1 FLEX_ENGAGE entre os 2 times |

**Constantes do backtest** (`rebuild_dashboard_stats_cron.cjs`):
- Linha fallback: `29.5` quando não há fair dinâmica
- Stake: `R$100`
- Odd assumida no backtest: `1.85` (breakeven 54.1%)
- **Odd real média do CEO: `1.75` (breakeven 57.1%)** — diferença importante: backtest superestima a margem em 3pp.
- Filtro: `SPLIT2_START = 2026-04-01`
- Fair line: Pinnacle manual (primário, `cron-data/YYYY-MM-DD-fair-pinnacle.json` via `/log-fair`) > fórmula `(blueAvgTotal+redAvgTotal)/2` round `.5` (sempre calculada em paralelo) > fallback 29.5. Polymarket descontinuado 2026-05-23.

---

## Estrutura de diretórios

```
apostas-lol-data/
├── lib/                             # helpers compartilhados
│   └── loadFairPinnacle.cjs         # carrega fair-pinnacle.json → Map<matchId, line>
├── dashboard/                       # ← FRONTEND. NÃO É REPO SEPARADO.
│   └── index.html                   # HTML estático, deploya pro Vercel via push
├── cron-data/                       # JSONs gerados pelo cron — NUNCA editar manual
│   ├── dashboard_stats.json         # backtest 4 majors (LCK/LPL/LEC/CBLOL)
│   ├── tier2_dashboard_stats.json   # backtest 3 ligas tier 2 EU (LFL/LES/LIT)
│   ├── lfl_dashboard_stats.json     # LFL only com breakdown rico
│   ├── team_avg_kills.json          # avg de kills por time (pra fair dinâmica EWC)
│   ├── ml_picks.json/.js            # winrate por champion x posição
│   ├── YYYY-MM-DD-fair-pre.json     # fair fórmula pré-jogo do dia (cron)
│   ├── YYYY-MM-DD-fair-pinnacle.json # fair Pinnacle manual (Elvis via /log-fair)
│   ├── YYYY-MM-DD-results.json      # análise pós-jogo (kills + supports + trigger)
│   └── *-polymarket-lines.json      # histórico Polymarket (imutável, descontinuado 2026-05-23)
├── .claude/
│   ├── agents/bet-logger.md         # subagent que registra bet de print
│   ├── commands/log-bet.md          # slash command /log-bet
│   ├── commands/log-fair.md         # slash command /log-fair (Pinnacle manual)
│   └── scripts/                     # scripts standalone usados por agent/hook
│       ├── _load-config.cjs         # carrega .env (Supabase creds)
│       ├── lolesports-find-match.cjs   # linka teams+data → match_id
│       ├── supabase-save-bet.cjs    # POST /rest/v1/bets
│       ├── settle-pending-bets.cjs  # busca livestats, atualiza pending → green/red
│       ├── enrich-match-context.cjs # preenche comp completa em bets já settled
│       ├── quant-query.cjs          # agregações ad-hoc das bets
│       └── daily_briefing.cjs       # tabela markdown dos jogos do dia
├── analyze_yesterday.cjs            # 2: detecta trigger por jogo
├── analyze_range.cjs                # variação que aceita --from/--to
├── capture_fair_lines.cjs           # 1: schedule + fair fórmula
├── save_report_to_db.cjs            # 3: upsert method_reports
├── rebuild_dashboard_stats_cron.cjs # 4: regenera dashboard_stats.json + team_avg_kills.json + ml_picks.json
├── rebuild_tier2_dashboard_stats.cjs    # adicional: tier 2 EU
├── rebuild_lfl_dashboard_stats.cjs      # adicional: LFL only
├── .env                             # SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (gitignored)
├── package.json                     # scripts npm
└── .github/workflows/daily-cron.yml # cron 2x/dia
```

Globais (`~/.claude/`) que servem este projeto:
- `agents/bet-logger.md` (versão global do subagent — checklist obrigatório com bet_datetime + lolesports_match_id, mapping team_id→nome, tratamento de cash/hedge)
- `commands/log-bet.md` (slash command global)
- `skills/bet-logger-extract.md` (autodispara em print de bet)
- `hooks/check-pending-bets.cjs` (UserPromptSubmit, roda settle a cada msg, cache 5min)

---

## Dashboard — deploy e arquitetura

**URL:** `https://apostas-lol-dashboard.vercel.app/`

**Como atualiza:**
1. Editar `dashboard/index.html` (adicionar tab, mudar layout, etc).
2. `git push origin main` → Vercel webhook detecta → deploy automático em ~1 min.

**Configuração Vercel** (definida em 2026-05-07):
- Project: `apostas-lol-dashboard`
- Connected Git Repository: `gelatin-es2/apostas-lol-data`
- Root Directory: `dashboard/` (crítico — sem isso Vercel tenta buildar raiz)
- Build Command / Output Dir / Install Command: vazios
- Framework Preset: Other
- Include files outside root directory: Enabled (não usado na prática — fetch é via raw.github)

**3 fontes de dado runtime no HTML (não dependem de redeploy):**
1. **Supabase** (tracker/bets) — JS no browser fetcha direto via `createClient`. Bet nova no banco aparece no F5 do site.
2. **raw.githubusercontent.com/gelatin-es2/apostas-lol-data/main/cron-data/*.json** (tabs Método/LFL/ML) — JS fetcha URL **absoluta** (não relativa `../cron-data/`, que dá 404 no Vercel porque root=dashboard).
3. Cron diário commita JSONs novos → próximo F5 do navegador pega versão nova.

**Adicionar nova tab no dashboard:** ver `~/.claude/projects/c--Users-Elvis-projects/memory/project_dashboard_deploy.md` pro passo a passo.

---

## APIs externas

| Endpoint | Pra quê | Detalhe |
|----------|---------|---------|
| `esports-api.lolesports.com/persisted/gw/getSchedule?leagueId=X` | Schedule por liga | Key pública `0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z`. Pagina via `pages.older` |
| `esports-api.lolesports.com/persisted/gw/getEventDetails?id=X` | Games de um match | Mesma key |
| `esports-api.lolesports.com/persisted/gw/getTeams?hl=en-US` | esportsTeamId → nome canônico | Sempre fazer mapping antes de exibir, NUNCA assumir blue=team_a |
| `feed.lolesports.com/livestats/v1/window/{gameId}?startingTime=X` | kills + comps + winner | TS múltiplo de 10s. Body pode vir vazio se TS muito recente. **Riot às vezes nunca publica frame `gameState='finished'` mesmo após eventDetails dar `state='completed'`** — settle confia no eventDetails (`trustCompleted=true`). |
| ~~`gamma-api.polymarket.com/events`~~ | ~~Odds Polymarket~~ | **Descontinuado 2026-05-23. Histórico em `cron-data/*-polymarket-lines.json` (imutável).** |
| `liquipedia.net/leagueoflegends/api.php` | EWC qualifiers (Korea/EMEA/China — fora da Riot API) | **Requer `Accept-Encoding: gzip` + User-Agent identificável** (api-terms-of-use). Rate limit 1 req/2s. |
| `ddragon.leagueoflegends.com` | Slugs de champions | Riot oficial, sem auth |

**LEAGUE_IDS canônicos** (em `lolesports-find-match.cjs`):
- LCK: `98767991310872058`
- LPL: `98767991314006698`
- LEC: `98767991302996019`
- CBLOL: `98767991332355509`
- LCS: `98767991299243165`
- LFL: `105266103462388553`
- LES: `105266074488398661`
- LIT: `105266094998946936`

**EWC NÃO está na Riot API** (é torneio ESL/Saudi). Usa Liquipedia. Pra LCK/LEC/LPL qualifier do EWC, `daily_briefing.cjs` parseia wikitext templates `{{Match}}`.

---

## Tabelas Supabase

### `bets` (apostas reais do CEO)
Schema: `id, created_at, bookmaker, league, team_a, team_b, market, pick, odd, stake, bet_datetime, pandascore_match_id, is_map_bet, map_number, status (pending/green/red/cashout), profit, settled_at, settle_source, screenshot_path, raw_extraction (jsonb), notes`

**OBRIGATÓRIOS pro settle automático funcionar** (lição 2026-05-07):
- `bet_datetime` (= startTime do match, ISO 8601). NUNCA null — settle calcula janela errada (epoch 1970) e quebra.
- `raw_extraction.match_context.lolesports_match_id` — chave que settle procura. Sem isso, bet fica pending eterna.

### `method_reports` (backtest method)
Schema: `match_date, league, match_id, game_id, map_number, team_blue, team_red, sup_blue, sup_red, trigger_type, flex_engages, total_kills, fair_line, fair_source, under_hit`. PK `(game_id, map_number)`.

---

## Ligas operadas

**Fonte canônica: `knowledge/reports/2026-07-26-set-ligas-definitivo.md`** (set aprovado pelo CEO). Resumo: OPERA = LCK/LPL/LEC/CBLOL/LCS/LFL · TESTE 1u = Prime/KCL/LES · TESTE recorte = LCP (só Milio vs peel/flex + janela Camille) · FORA = LIT/LRS/NACL. Stake: **1u tudo, 2u Milio/Camille** (playbook `knowledge/decisions/2026-07-21-metodo-under-split3.md`, bloco do topo).
⚠️ O "LES 43.5% skip — sangra" que viveu aqui foi **REVOGADO 2026-07-26** (media all-games, não o método; trigger-only = 69.4% n=36).

---

## Operação automatizada (hook + agent)

A cada msg do CEO no chat Claude Code:
1. Hook `UserPromptSubmit` (`~/.claude/hooks/check-pending-bets.cjs`) roda silencioso, com cache 5min
2. Se houver bets `pending`, busca livestats, atualiza status/profit/raw_extraction.match_context (kills, picks, trigger)
3. Output reportado em 1 linha no início da resposta do agente principal

Print de bet do CEO no chat:
1. Skill `bet-logger-extract` autodispara
2. Subagent `bet-logger` extrai dados do print, identifica bookmaker, valida campos
3. Roda `lolesports-find-match.cjs` pra linkar match (filtra por DATA EXATA, prioriza state LIVE/UNSTARTED próx 60min — bug 2026-05-07 era janela ±1d que pegava match antigo)
4. Salva via `supabase-save-bet.cjs` com `bet_datetime` + `raw_extraction.match_context.lolesports_match_id`
5. Reporta resumo curto

---

## Pendências técnicas vivas

1. **`getEventDetails` serve estado velho com frequência** (6+ casos só em 25/07) — settle automático trava; fallback proposto no lote B da auditoria `knowledge/audits/2026-07-25-auditoria-sistema.md`. Até lá: settle manual com feed livestats como evidência (2 sinais).
2. **Fixes de método de 21/07 não commitados** — cron do GitHub regenera stats com definição velha (lote A da auditoria, aguardando OK do CEO).
3. Tier 2 EU fora do cron (rebuild_tier2/lfl manuais) · README com horário cron velho · dead code CSV Oracle em capture_fair_lines · EWC sem auto-settle (fonte manual).
4. Histórico de bugs resolvidos: git log + `knowledge/audits/`.

---

## Convenções operacionais

- **NÃO mexer manualmente em `cron-data/*.json`** — gerados por scripts, edição quebra idempotência.
- **Scripts são idempotentes** — pode re-rodar via `workflow_dispatch` no GitHub Actions sem efeito colateral.
- **Champions sempre por TIME no display, não por blue/red side** — fazer mapping `esportsTeamId → name` via `getTeams`. NUNCA assumir blue=team_a (times alternam side por mapa).
- **"Cash"/"cashout"/"trava" no jargão do CEO = hedge sintético** (bet oposta em outra casa), não cashout do botão. Status fica green/red natural por bet, não `cashout`.
- **Antes de qualquer ação no contexto bet:** confirmar data atual (system reminder `currentDate`) E `bet_datetime` do print. Erros de data viram bug em cascata no settle.
- **Fontes de truth:**
  - Schedule + games + livestats: lolesports API (não-oficial, key pública)
  - Resultado real do CEO: tabela `bets` no Supabase
  - Backtest do método: `dashboard_stats.json` + `tier2_dashboard_stats.json` + `lfl_dashboard_stats.json`
  - Ranking de times/champions/supports: backtest acima — NÃO inventar números, sempre ler do JSON
- **Quando questionado sobre dado** ("de onde tirou esse X?"): mostrar URL completa + response cru + caminho de derivação + cross-check com 2ª fonte (Liquipedia, getEventDetails). NUNCA "vem da API" sem URL.
- **Se CEO falar 2x que algo está errado**: PARO de re-explicar, mostro fonte cru, valido com 2ª API. Se chegar a 3x = falha grave de método.
