# Auditoria de sistema — dados split 3 + pipeline + configuração Claude

**Data da execução:** 2026-07-26 (madrugada) · **Escopo:** split 3 (21/07→25/07), pipeline settle/registro, consistência do método, config `~/.claude` + `.claude/`, dashboard. **100% read-only** — nenhum fix aplicado; propostas por lote no final.
**Fora de escopo:** split 2 (auditado 2026-07-20), performance/regras do método (revisão semanal paralela).

**Artefatos gerados (read-only):**
- `audit-output/30-split3-bets.json` — snapshot das 60 bets do período (via `scripts/audit/split3-fetch.cjs`)
- `audit-output/31-split3-integrity.json` — checks offline (via `scripts/audit/split3-integrity.cjs`)
- `audit-output/32-split3-recompute.json` — re-settle frio contra API (via `scripts/audit/split3-recompute.cjs`)

---

## Veredito

**Sistema saudável COM RESSALVAS.**

- **Dados do split 3: bons.** 53 bets reais, 0 pending órfã, 0 sem `bet_datetime`, 0 sem `lolesports_match_id`, 0 profit incoerente com status/odd/stake. Re-settle frio: **45/53 MATCH direto contra a API**; os 8 restantes verificados um a um (7 confirmados, 1 com ressalva de fonte). **Os ~13 settles manuais do COO de 24-25/07 estão todos corretos.**
- **Pipeline: 2 bombas armadas.** (1) Bug HIGH no settle pra mercado "total de mapas" que só não disparou porque a API estava fora no dia; (2) o cron do GitHub roda há ~5 dias **versões commitadas com a definição ERRADA do método** (Alistar no FLEX; LFL/tier2 sem Lux/Anivia) — os fixes de 21/07 nunca foram commitados.
- **Config Claude: funcional mas defasada.** Agent/skill/command do bet-logger documentam 4 bookmakers; o split 3 operou 6 (thunderpick e clutch são a 2ª e 3ª casas mais usadas e não têm assinatura visual documentada; Clutch USD não está no agent).

---

## Sumário executivo (severidade × achado × impacto)

| # | Sev | Achado | Impacto |
|---|-----|--------|---------|
| 1 | **HIGH** | `settle-pending-bets.cjs` settla mercado "Total de mapas Mais de X.5" comparando **kills** vs 2.5 (`parsePick` não distingue mapas de kills) | Falso green automático. `c6eeceb6` (FUR×LOS, Over 2.5 mapas, RED real) teria sido settlada GREEN +R$1.153 se o eventDetails não estivesse fora naquele dia |
| 2 | **HIGH** | Versões **commitadas** de `rebuild_dashboard_stats_cron/lfl/tier2`, `quant-query`, `compute_real_bets_method`, `analyze_tier2_eu`, `enrich-match-context`, `backfill-missing-tier1`, `settle-pending-bets` ainda têm **Alistar no FLEX_ENGAGE**; `rebuild_lfl`/`rebuild_tier2` commitados **nem têm Lux/Anivia**. Fixes existem só no working tree local (não commitados desde 21/07) | O cron diário do GitHub regenera `dashboard_stats.json`/`lfl`/`tier2` com definição errada do método → tabs Método/LFL do dashboard públicas com stats contaminadas; risco de perder os fixes locais |
| 3 | **HIGH** | 3 bets DE MÉTODO settladas manualmente estão `is_method_bet=false` + sem `trigger_type`: `e9ceb50e` (2peel Karma/Milio, green +1.580), `d055e307` (+800) e `b470d693` (+793) (1peel+flex Milio/Bard) — o próprio settle_source diz "metodo" | Stats do método subcontam 3 greens (~+R$3.17k); tab Under do dashboard idem. Método real no split 3 = 9 bets (8G/1R), não 6 |
| 4 | **MED** | `e7f68f60` (Over 28.5 Camille/Rell, LEC 24/07) está `is_method_bet=TRUE` | Polui a tab/stats do método Under com bet Over experimental (green +1.440 inflando o Under) |
| 5 | **MED** | Riot **removeu retroativamente** o match TES×TT de 25/07 da API (eventDetails vazio, game 404, sumiu do schedule) — `f5611bc9` green +757 não re-verificável via Riot | Settle em si é seguro (46 kills > 32.5, kills são monotônicos; cron capturou o match antes da remoção). Mas expõe: **fonte primária é volátil**, evidência tem que ser persistida no settle |
| 6 | **MED** | eventDetails mentiu/serviu estado velho 6+ vezes em 25/07 (documentado nos settle_source: "stale inProgress 5h", "stale unstarted") e o settle não tem 2º sinal — trava e depende de settle manual | 13 settles manuais em 2 dias; risco de erro humano a cada rodada (dessa vez, zero erro) |
| 7 | **MED** | `daily_briefing.cjs` **não tem LCP** no LEAGUE_IDS (find-match tem) | Jogos do teste LCP (regra Elvis 25/07) não aparecem no briefing nem entram na trava de fair |
| 8 | **MED** | `supabase-save-bet.cjs` L91: `VALID_BOOKMAKERS` **sem 'clutch'** (4 bets Clutch entraram via bypass `ALLOW_UNKNOWN_BOOKMAKER=1`) | Validação de casa nova morta pro 3º bookmaker mais usado |
| 9 | **MED** | `4be561c8` (Clutch 23/07, BLG×TT, green +169.15) **sem `original_currency`/conversão FX** — as outras 3 Clutch têm `fx_usd_brl` | Se o stake era US$199 (memória: Clutch = USD), lucro real ≈ R$858, banco registra R$169 → PnL subdeclarado ~R$689. **Precisa confirmação Elvis** |
| 10 | **MED** | Agent `bet-logger` (global+projeto), skill `bet-logger-extract` e descrição só cobrem **4 bookmakers** (EstrelaBet/Pinnacle/Parimatch/Betano). Split 3 real: pinnacle 29, thunderpick 13, clutch 4, estrelabet 3, parimatch 3, novibet 1. Clutch-USD não documentado no agent | Identificação de casa vira chute a cada print de Thunderpick/Clutch (o erro de moeda #9 é consequência direta) |
| 11 | **MED** | 15 bets settladas manualmente **sem `match_context.total_kills`** persistido (kills só em texto no settle_source) | Essas bets somem das análises por kills (`analiseStats`, quant-query fromKills) — fallback fromStatus cobre parcialmente |
| 12 | **MED** | `ladder_group_id` gravado em **3 paths diferentes**: `raiz` (WE×JDG), `ladder_info.*` e `match_context.*` — 16 bets do split 3 com path duplo, combos inconsistentes | Memória já flagava; qualquer agregação por ladder vai rachar. Piorou (3 paths agora) |
| 13 | **LOW/MED** | Repo local **2 commits atrás do origin** (cron 24-25/07 não puxados) + 18 arquivos modificados não commitados | `settle` local calcula `fair_formula` sem os results de 24-25/07; ambiente local ≠ ambiente cron (drift bidirecional do achado #2) |
| 14 | **LOW** | Over avulsos sem `method_variant` (`a51a6504`, `3e0765b2`) e ML/handicap/hedge com variants próprios não aparecem em NENHUMA tab por método do dashboard (só na Planilha) | KPI "Over Kill" do dashboard incompleto |
| 15 | **LOW** | `screenshot_path` = null em **53/53** bets do split 3 (fluxo "Caso B" — só transcrição) | Zero trilha de auditoria de prints; irreversível pro passado, corrigível pro futuro |
| 16 | **LOW** | `lookupByName` substring de `lib/loadFairPinnacle.cjs` (bug 'al'⊂'galions') ainda é consumido por **1 código ativo**: `daily_briefing.cjs:618` (display). Tracker já migrou pra byMatchId-only; settle/save usam byMatchId | Pior caso: fair errada EXIBIDA no briefing (não afeta settle nem save) |
| 17 | **LOW** | Doc drift: CLAUDE.md aponta "definição autoritativa" pra `analyze_yesterday.cjs:20-24` (hoje é wrapper → `_archive/scripts/analyze_range.cjs:37-39`); estrutura de diretórios desatualizada; README com horário de cron velho | Confunde futuras sessões/agentes |
| 18 | **INFO** | SIMULATED do rastreador: **7 bets** (6 backfill + 1 nova 25/07), schema ok, `is_method_bet=false` ✓, dedup ✓, `bookmaker='SIMULATED'` ✓ (dashboard filtra) | Saudável. Detalhe: save-bet normaliza bookmaker pra lowercase — se alguém salvar SIMULATED via save-bet, o filtro `neq('SIMULATED')` do dashboard não pega (latente) |
| 19 | **INFO** | `10774345` cashout acidental (Elvis apertou botão): -180 registrado; jogo terminou 48k → teria sido green +850 | Registro correto do que aconteceu; sem ação |

---

## Frente 1 — Dados split 3 (21/07→25/07)

**Universo:** 60 rows (53 reais + 7 SIMULATED). Status: 42 green / 17 red / 1 cashout / **0 pending**. PnL real do período: **+R$16.800,33** (21/07 +1.240 · 22/07 +2.878 · 23/07 +5.121 · 24/07 +2.065 · 25/07 +5.497).

### Re-settle frio (recompute vs API, `32-split3-recompute.json`)

45/53 MATCH automático (status, profit E kills batem com recomputo independente). Os 8 não-automáticos, verificados um a um:

| Bet | Caso | Veredito |
|---|---|---|
| `7cdade0b` WE×JDG map2, JDG -9.5 kills | handicap (fora do parser) | ✅ CORRETO — recomputo: JDG(blue) 20 × 9 WE, diff 11 > 9.5; profit 499.99×0.8=399.99 ✓ |
| `742d6b48`/`f017d0ab` KOI×G2 map1 Over 29.5 red @28k | feed travou em frame `in_game` 22x6 pra sempre | ✅ CORRETO — **Leaguepedia confirma: KOI 22 × 6 G2 = 28 kills** (LEC 2026 Summer, 24/07 14:46 UTC) |
| `b79d9056`/`894ed74f` G2×KOI map1 Under 35.5 green | idem (28k < 35.5) | ✅ CORRETO — mesma fonte |
| `f1aa6dc7` LOUD×paiN, paiN +1.5 mapas green | handicap de série | ✅ CORRETO — paiN venceu map1 (14×3, livestats finished) → +1.5 matematicamente garantido em BO3 |
| `f5611bc9` TES×TT map2 Over 32.5 green 46k | **Riot removeu o match da API** (achado #5) | ✅ com ressalva — settle foi automático às 14:17Z de 25/07 lendo a API viva (settle-history.log); 46 > 32.5 e kills são monotônicos → green garantido mesmo se frame parcial; cron de 25/07 capturou o match (map1 TES×TT 42k) antes da remoção. Única bet sem 2ª fonte EXTERNA (gol.gg inacessível via script; Leaguepedia rate-limited) |
| `10774345` FLY×LYON map2 cashout -180 | cashout acidental | ✅ registro fiel (achado #19) |

### Settles manuais (17 no período) — TODOS corretos

Incluindo os 3 da manhã de 26/07: `e9ceb50e` green +1.580 (**map3 LOUD×paiN = 14 kills confirmado pelo recomputo**, 13×1), `d055e307` +800 e `b470d693` +793 (**map2 DIG×SEN = 21 kills confirmado**, 4×17). E os 10 de 24-25/07 (`742d6b48`, `f017d0ab`, `cd81ea30` KC 2-0 VIT ✓, `628daaa6` 34k ✓, `c6eeceb6` FUR 2-0 ✓, `f1aa6dc7` ✓, `a51a6504` 30k ✓, `1f6e1b8b` ✓, `ab75218d`/`3e0765b2` 26k ✓) + 2 ML WE×JDG de 24/07 (`92a369f0`/`4ba7cab0` — WE venceu map1, winner via inibidores ✓).

**Problema não é o resultado, é a metadata:** 15 desses settles não persistiram `total_kills` no match_context (#11) e 3 deles são bets de método sem flag (#3).

### Campos obrigatórios, moedas, bookmakers

- `bet_datetime`: 60/60 ✓ · `lolesports_match_id`: 60/60 ✓ · profit×status×odd×stake: 53/53 coerentes ✓
- Fair columns: 33 pinnacle + 18 formula + 2 sem (as 2 são mercados de série, fair de kills não se aplica) ✓
- Clutch USD: 3/4 com `fx_usd_brl` + `original_currency` ✓; `4be561c8` sem (#9)
- novibet: 1 bet (`1f6e1b8b`, ML punt @7.13) — **hipótese não confirmada**, notes dizem "BOOKMAKER INCERTO — melhor hipótese novibet". Fica flagrado pra Elvis confirmar na casa
- SIMULATED: 7 bets, tudo conforme (#18)

---

## Frente 2 — Pipeline settle/registro

### Onde `settle-pending-bets.cjs` quebra quando o eventDetails mente

Mapeamento dos pontos de falha (arquivo `.claude/scripts/settle-pending-bets.cjs`):

1. **L351-352** — eventDetails vazio (`no_games_in_match`): caso TES×TT hoje. Bet ficaria pending eterna.
2. **L362** — `game.state !== 'completed'` (`game_state_inProgress`/`unstarted` STALE): o modo de falha de 25/07 ("stale inProgress 5h", "stale unstarted" nos settle_source). Sem 2º sinal, trava até um humano settlar.
3. **L232 + L216-222** — `trustCompleted` + frame suspeito (gameTime null/`<600s` ou kills<5): caso KOI×G2 map1 — Riot nunca publicou frame `finished` e o último frame não tem `gameTime` → suspeito → skip eterno.
4. **L358-359** — bet match-level cai em "primeiro game completed" e **L315-325 `decideOutcome` trata "Total mapas Mais de 2.5" como Over de KILLS** → falso green (#1, bug independente do eventDetails).

**Fix proposto (SEM implementar) — codifica o que o COO fez manualmente:**

```
a) decideOutcome: if (/mapas|maps/i.test(market+pick)) → rota própria:
   conta games state==='completed' no eventDetails/schedule e compara com a linha;
   se eventDetails suspeito → skip manual_check (nunca cair no parser de kills).
b) 2º sinal quando game.state stale ou eventDetails vazio:
   getSchedule da liga → event.state==='completed' → destrava.
c) 3º sinal (frame): se window.frames último frame gameState==='finished' e
   não-suspeito → settla MESMO com eventDetails dizendo inProgress/unstarted
   (guard: agora > bet_datetime + 2h). É exatamente o critério usado nos manuais.
d) Settle parcial monotônico: kills nunca diminuem → com frame in_game válido:
   - kills_atuais > linha ⇒ Over GREEN / Under RED settláveis com segurança
   - kills_atuais < linha ⇒ NUNCA settlar (aguarda frame final/manual)
e) Todo settle manual deve escrever match_context.total_kills (padronizar via
   flag --manual-kills N no próprio script, em vez de PATCH ad-hoc).
```

### Demais componentes

- `supabase-save-bet.cjs`: validações boas (janela bet_datetime ±, match_id obrigatório, auto-settle print nativo). Gaps: 'clutch' fora da lista (#8); sem verificação de moeda pra Clutch (#9).
- `lolesports-find-match.cjs`: LCP adicionada 25/07 com ID **validado nesta auditoria via getLeagues: `113476371197627891` = "LCP" (PACIFIC)** ✓. Mas o fix é local não-commitado (#13).
- `daily_briefing.cjs`: cobre LCK/LPL/LEC/CBLOL/LFL/LCS + MSI/First Stand/Worlds + Prime/KCL/EUM/LES. **Falta LCP** (#7). Nota: **LES está no briefing** mas CLAUDE.md marca LES "❌ SKIP — sangra" e a memória de ligas operadas não a inclui → decidir (briefing como observação é ok, mas documentar).
- Hooks: `check-pending-bets.cjs` ✓ (cache 60s só com 0 pending, log persistente, fail-open com WARN após 2 falhas), `check-fair-logged.cjs` ✓ (trava fair operante; 25/07 tem fair-pinnacle.json ✓), `weekly-review-check.cjs` ✓ (domingo + arquivo-sentinela).
- GitHub Actions `daily-cron.yml`: **rodando e verde** (25/07 13:00Z success, 8/8 últimos runs success). Cron NÃO roda settle (só análise/rebuild) — settle é 100% local via hook. Porém roda os rebuilds **da versão commitada** (#2).

---

## Frente 3 — Consistência do método

### PEEL_PURE / FLEX_ENGAGE

- **Working tree local: 100% sincronizado.** 13 cópias ativas conferidas (settle, enrich, compute_real, backfill, quant-query, analyze_tier2_eu, rebuild×4, audit-common, _archive/analyze_range via wrapper analyze_yesterday, track-observation via audit-common): todas `PEEL_PURE` = soraka/sona/janna/lulu/yuumi/karma/seraphine/renata(glasc)/nami/milio e `FLEX` = bard/rakan/lux/anivia. Zero Alistar ativo.
- **Origin/HEAD (o que o cron roda): DESSINCRONIZADO** (#2). Diff exato do commitado:
  - `rebuild_dashboard_stats_cron.cjs:323` → `['Bard','Rakan','Alistar','Lux','Anivia']`
  - `rebuild_lfl_dashboard_stats.cjs:15` e `rebuild_tier2_dashboard_stats.cjs:16` → `['Bard','Rakan','Alistar']` (sem Lux/Anivia!)
  - `settle-pending-bets.cjs:104`, `quant-query.cjs:34`, `compute_real_bets_method.cjs:23`, `analyze_tier2_eu.cjs:47`, `enrich-match-context.cjs:20`, `backfill-missing-tier1.cjs:27` → alistar presente
  - `_archive/analyze_range.cjs` foi o único commitado com fix (f7a3374) — então os `*-results.json` do cron estão CORRETOS; o problema é nos `dashboard_stats*.json`.

### Playbook (2026-07-21-metodo-under-split3.md) vs memórias vs código

- Stake tiers (1k base / 500 flex-com-sinal / 2k Milio / 4k aposentado): playbook = memória ✓; bets reais do split 3 aderentes (Milio 2k em `e9ceb50e`, ladder 2×1k nas DIG×SEN com Milio) ✓
- Janela Camille: consistente (bets over_experimental com notes citando teto fair+1; `4be561c8` fair+2 devidamente flagrada como fora do teto nos notes) ✓
- Regra LCP 25/07 (só Milio vs peel/flex R$1k + Camille): playbook atualizado ✓ = memória ✓; 4 bets LCP de 25/07 são Camille Over ✓
- **SKIP Over LEC (diretriz Elvis 24/07): AMBÍGUA — não está no playbook** (que trata a janela Camille como global). Registro só na memória `project_metodo_over_reprovado`. E existe bet Over LEC **de 25/07** (`628daaa6`, Shen/Camille, green +862) DEPOIS da diretriz. → **decisão Elvis** (item D3 abaixo).
- `cc0c252a` (Under com Nautilus sup — skip absoluto do playbook): corretamente marcada `off_method_discretionary` ✓ (punt consciente, não contaminou método).

### lookupByName (bug substring al⊂galions)

Consumidores de `lib/loadFairPinnacle.cjs` auditados: settle (byMatchId ✓), save-bet (byMatchId ✓), tracker (byMatchId-only com comentário explícito ✓), phase2/insert-missed/rebuild/analyze_over (byMatchId+cache ✓). **Único uso ativo de `lookupByName`/`byAnchor` fuzzy: `daily_briefing.cjs:614-618`** (display da coluna fair). Fix barato: aplicar o mesmo "byMatchId-only + anchor exato" ali, ou exigir candidato único ≥4 chars no `findEntryByName`.

---

## Frente 4 — Config Claude

| Item | Estado |
|---|---|
| `~/.claude/agents/bet-logger.md` + `.claude/agents/bet-logger.md` | Existem, consistentes entre si, MAS tabela de ID visual só com 4 casas (#10). Checklist bet_datetime+match_id presente ✓ |
| `~/.claude/skills/bet-logger-extract.md` | Existe; triggers ok; mesmos 4 bookmakers (#10) |
| `/log-bet` (global+projeto) e `/log-fair` (projeto) | Existem; log-fair coerente com a trava; log-bet manda salvar print em `cron-data/bet-screenshots/` — **na prática 0/53 bets têm screenshot_path** (#15) |
| Hooks em `~/.claude/settings.json` | 3 hooks UserPromptSubmit corretos (pending → fair → weekly), paths válidos, todos fail-open ✓ |
| Memórias vs playbook | Sem contradição ativa grave: tiers velhos e flags de time já marcados SUPERADA ✓. Gaps: memória `feedback_bookmaker_visual_id` não cobre Clutch/Thunderpick/novibet; "Ligas operadas" não menciona LES-no-briefing; SKIP Over LEC só em memória (não no playbook) |

---

## Frente 5 — Dashboard

- Runtime Supabase direto (`dashboard/index.html:1070`) → bet nova aparece no F5 ✓
- Tabs por método: Under = `is_method_bet=true` · Over Kill = `method_variant` `over_experimental*`/`off_method*` · Planilha = união; SIMULATED excluído em todas (`neq('SIMULATED')` + dedup defensiva por gameId) ✓
- Filtro default **Split 3 (21/07+)** selecionado nas 3 instâncias (`index.html:547/608/632`, `globalPeriodFilter='split3'`) ✓
- Ressalvas: tab Under subconta 3 bets e tem 1 intrusa (#3/#4); Over Kill perde os avulsos sem variant (#14); `ml_experimental`/`handicap`/`live_hedge`/`boost_series` não têm tab (aparecem só na Planilha — design aceitável, registrar)

---

## O que exige DECISÃO do Elvis

1. **D1 — Clutch `4be561c8`:** o stake de 23/07 (BLG×TT, 199.00) era US$ ou R$? Se USD → corrigir stake/profit com câmbio do dia (~R$1.009 stake / +R$858 profit) e ajustar PnL declarado (+~R$689).
2. **D2 — novibet:** confirmar na casa se a bet `1f6e1b8b` (ML paiN @7.13, 25/07) é mesmo novibet; se não, corrigir bookmaker.
3. **D3 — SKIP Over LEC:** formalizar no playbook (e definir se a janela Camille fica exceção ou não). Hoje a diretriz vive só em memória e já foi "violada" (ou tacitamente revogada?) pela `628daaa6` de 25/07 (green).
4. **D4 — LES no briefing:** manter como observação (documentar no CLAUDE.md) ou remover (CLAUDE.md diz SKIP)?
5. **D5 — path canônico do `ladder_group_id`:** escolher (proposta: raiz de `raw_extraction`) pra destravar a migração dos 3 paths.

---

## Fixes propostos por lote (NENHUM aplicado)

**Lote A — estancar (commit/push, ~15min, risco baixo):**
1. Revisar + commitar os 18 arquivos locais modificados (contêm: remoção do Alistar em 9 scripts, Lux/Anivia nos rebuilds LFL/tier2, LCP no find-match, internacionais no briefing, paginação supabaseQuery). Isso corrige o #2 na origem.
2. `git pull` (2 commits de cron) antes do push.
3. Re-rodar os 3 rebuilds e commitar os `dashboard_stats*.json` regenerados com as listas certas.

**Lote B — settle robusto (o fix concreto do incidente 25/07):**
4. `decideOutcome`: rota de mercado por MAPAS antes do parser de kills (#1).
5. Cadeia de sinais schedule→window-finished→parcial-monotônico (spec na Frente 2) (#6).
6. Flag `--manual-kills` pra settles manuais persistirem `total_kills` (#11) + backfill dos 15 via `enrich-match-context.cjs`.

**Lote C — classificação (3 PATCHes pontuais, precisa OK do Elvis):**
7. `e9ceb50e`, `d055e307`, `b470d693` → `is_method_bet=true` + `trigger_type` (2peel / 1peel+flex / 1peel+flex) (#3).
8. `e7f68f60` → `is_method_bet=false` + `method_variant='over_experimental_elvis'` (#4).
9. `a51a6504`, `3e0765b2` → `method_variant='over_experimental_elvis'` (#14).

**Lote D — registro (config, sem código):**
10. Adicionar Thunderpick/Clutch/novibet à tabela visual do agent/skill (com "Clutch = USD, converter câmbio real + salvar fx_usd_brl/original_currency"); atualizar descrições "4 bookmakers" (#10).
11. `VALID_BOOKMAKERS` += 'clutch' (#8).
12. Reativar persistência de screenshot no fluxo /log-bet ou aceitar formalmente o Caso B como default (#15).

**Lote E — housekeeping:**
13. LCP no `daily_briefing.cjs` LEAGUE_IDS (#7).
14. `daily_briefing.cjs:618`: matar fallback fuzzy `lookupByName` (#16).
15. Migração `ladder_group_id` → path canônico após D5 (#12).
16. CLAUDE.md: corrigir ponteiro da definição autoritativa, estrutura de diretórios, tabela de cobertura (LES/LCP), README horário cron (#17).

---

*Auditoria: COO via subagent (Claude) · 2026-07-26 · Nenhuma escrita em Supabase; artefatos só em `scripts/audit/` e `audit-output/`; este relatório.*
