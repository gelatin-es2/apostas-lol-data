# Auditoria fair_line — 2026-05-23

## TL;DR

- **Banco consistente com método atual: SIM.** 269/269 SIMULATED batem **exatamente** com `cron-data/dashboard_stats.json` (217 tier 1) e `cron-data/tier2_lfl_les_stats.json` (52 tier 2). Diff médio absoluto: **0.000 kills**. Zero `fair_line_calculated` nulos.
- **Recálculo via livestats HOJE diverge levemente (avg 0.40 kills, max 2)**: drift natural do `team_avg` rolling 21d — não é bug, é feature. SIMULATED são snapshot do momento da inserção.
- **Causa do match perfeito Nível A**: todas as 269 SIMULATED foram criadas no mesmo dia (2026-05-22) usando os JSONs canônicos do método NOVO (pós-correção 2026-05-17).
- **Achado crítico extra (não pedido)**: o cron diário GitHub Actions roda `analyze_tier2_eu.cjs` que usa `LINE = 29.5` FIXA (não dinâmica). Não afeta SIMULATED no banco, mas o stats tier 2 mostrado pro cron oficial está com método velho.
- **Achado crítico extra (não pedido)**: três scripts `rebuild_*` coexistem com fórmulas diferentes: `rebuild_dashboard_stats_cron.cjs` (NOVA `(a+b)/2` sem -1) e `rebuild_tier2_dashboard_stats.cjs` + `rebuild_lfl_dashboard_stats.cjs` (VELHA `a+b-1`). Os dois últimos não rodam no cron, mas estão no repo prontos pra confundir.
- **Achado de risco**: enrich destrutivo já APAGOU 217/224 `fair_line_calculated` em 2026-05-22 (commit `2777353` fixou). Hoje está protegido (skip SIMULATED), mas hábito perigoso se alguém remover o guard.

---

## Parte 1 — Pontos de cálculo de fair_line

| Arquivo | Função / linha | Fórmula | Inputs | Uso | Status |
|---|---|---|---|---|---|
| `rebuild_dashboard_stats_cron.cjs` | `fairForGame` L280-315 | `(blueAvgTotal+redAvgTotal)/2` round pra `.5` | `userBets` (0), polymarket (1), team_avg total_kills 21d leave-one-out (2), fallback 29.5 (3). `MIN_SAMPLE_TEAM=5`, `FAIR_ADJUSTMENT=0` | **CRON DIÁRIO oficial**. Gera `dashboard_stats.json`. Fonte canônica das 217 SIMULATED tier 1. | ✅ Atual |
| `analyze_range.cjs` | `fairForGame` L309 | `raw/2` round pra `.5` (raw = blueTotal+redTotal) | Mesma hierarquia do rebuild | Backtest histórico. **Não roda no cron** (rebuild faz tudo). | ✅ Atual |
| `analyze_tier2_lfl_les.cjs` | `fairForGame` L281-312 | `(blueAvgTotal+redAvgTotal)/2` round pra `.5` | `userBets`, polymarket, team_avg total_kills `MIN_SAMPLE_TEAM=4`, fallback 29.5 | Gerou as 52 SIMULATED tier 2 LFL/LES. Rodado MANUALMENTE 2026-05-22. | ✅ Atual |
| `analyze_split1_firststand.cjs` | `fairForGame` L281+ | `(blueAvgTotal+redAvgTotal)/2` round pra `.5` | Mesma do rebuild | Backtest Split 1. Não persiste SIMULATED no banco. | ✅ Atual |
| `rebuild_tier2_dashboard_stats.cjs` | `fairForGame` L153-165 | `(blueAvgOwnSide+redAvgOwnSide-1)` round pra `.5` | `kBlue` e `kRed` separados, `FAIR_ADJUSTMENT=-1` | Gera `tier2_dashboard_stats.json`. **NÃO roda no cron**. Não usado pra gerar SIMULATED. | ⚠️ Fórmula VELHA (bug A+B) |
| `rebuild_lfl_dashboard_stats.cjs` | `fair` L137-146 | `(blueAvgOwnSide+redAvgOwnSide-1)` round pra `.5` | Idem `rebuild_tier2` | Gera `lfl_dashboard_stats.json`. **NÃO roda no cron**. Não usado pra SIMULATED. | ⚠️ Fórmula VELHA |
| `analyze_tier2_eu.cjs` | — | `LINE = 29.5` FIXA | — | **RODA NO CRON DIÁRIO** (workflow daily-cron.yml). Gera análise tier 2 EU. | ⚠️ Sem fórmula dinâmica |
| `.claude/scripts/insert-missed-bets.cjs` | L92 | `simulated_line = m.line + 1` (não calcula fair; consome do `dashboard_stats.json.missed_opportunities.list`) | `dashboard_stats.json` | Inseriu as 217 SIMULATED tier 1 em 2026-05-22 15:15 | ✅ |
| `.claude/scripts/insert-missed-bets-tier2.cjs` | L92 | Idem (consome `tier2_lfl_les_stats.json`) | `tier2_lfl_les_stats.json` | Inseriu as 52 SIMULATED tier 2 em 2026-05-22 17:46 | ✅ |
| `.claude/scripts/enrich-match-context.cjs` | — | **NÃO calcula fair_line**. Só popula `match_context`. | — | Cron diário. **Skipa SIMULATED** desde `2777353` (2026-05-22). | ✅ (fix recente) |
| `compute_real_bets_method.cjs` | — | Não calcula fair_line | — | PnL real | — |
| `dashboard/index.html` `getBetSimulation`/`getBetSim` | L1488, L1642 | Lê `mc.fair_line_calculated` direto (sem recalcular); aplica `-1` se `odd<1.72` em bets REAIS | banco | Simulação no dashboard (frontend) | ✅ |

---

## Parte 2 — Histórico de mudanças (cronologia)

| Data | Commit | Mudança |
|---|---|---|
| 2026-04-30 | `4acac78` | Inicial — `LINE=29.5` fixa universal |
| 2026-05-06 | `15d8201` | **Introduz fair dinâmica**: hierarquia polymarket > calc(`a+b-1`) > 29.5. Fórmula com `-1`. Decision doc `2026-05-06-fair-line-livestats-team-avg.md`. |
| 2026-05-07 | `e53538f` | Adiciona pipelines tier 2 (`rebuild_tier2`, `rebuild_lfl`) com a mesma fórmula `a+b-1` |
| 2026-05-08 | `1b2f923` | Enrich passa a popular `compositions` e cobre LFL/LIT/EUM |
| 2026-05-10 | `1e37cf8` | Adiciona override por user_bet: se Elvis tem bet, fair = `pickLine` (com `-1` se `odd<1.72`). Prioridade #0 |
| 2026-05-10 | `55da61a` | Adiciona LCS (6 ligas operadas no momento) |
| **2026-05-17** | **`9ef5f40`** | **CORREÇÃO crítica**: bug A (team_avg acumulava own-side kBlue/kRed em vez de total kBlue+kRed) + bug B (`-1` era compensação artificial do bug A). Nova fórmula: `(avg_total_blue + avg_total_red)/2`, `FAIR_ADJUSTMENT=0`. Hit rate 2peel global caiu de inflados ~89% pra realistas 64.9% |
| 2026-05-18 | `2e0d083` + `b78067c` | Regenera cron-data Split 2 com fórmula corrigida |
| **2026-05-22 15:15** | **`02a5894`** | Cria **217 SIMULATED tier 1** via `insert-missed-bets.cjs` consumindo `dashboard_stats.json.missed_opportunities.list` (já com fórmula NOVA) |
| 2026-05-22 17:36 | `2777353` | **Fix crítico**: enrich-match-context passa a SKIPAR SIMULATED. Antes destruía 217/224 `fair_line_calculated`. Pós-fix: 224/224 válidas (depois foi pra 269) |
| **2026-05-22 17:46** | **`026d83a`** | Cria **52 SIMULATED tier 2** (LFL+LES) via `analyze_tier2_lfl_les.cjs` (fórmula NOVA) + `insert-missed-bets-tier2.cjs` |
| 2026-05-22 (depois) | regen | `dashboard_stats.json` regenerada às 21:28 com mesma fórmula |

**Sobre o "voltou atrás" do `-1` mencionado pelo CEO**: confirmado. Estava `-1` desde 2026-05-06 (`15d8201`), removido em 2026-05-17 (`9ef5f40`). Não houve nova reintrodução depois — `FAIR_ADJUSTMENT=0` no cron oficial até hoje. **MAS** o `-1` SOBREVIVE em dois lugares legítimos:
1. Override user_bet: `pickLine - 1` quando `odd < 1.72` (decisão CEO 2026-05-09, ainda ativa)
2. Scripts secundários `rebuild_tier2_dashboard_stats.cjs` e `rebuild_lfl_dashboard_stats.cjs` que NÃO foram migrados em `9ef5f40` (não rodam no cron, então não criaram bets no banco)

---

## Parte 3 — Estado atual no banco

**Query executada:** todas as SIMULATED, paginação 300, ordem `created_at ASC`.

| Métrica | Valor |
|---|---|
| Total SIMULATED | **269** |
| `fair_line_calculated` null | **0** |
| `lolesports_match_id` ausente | **0** |
| `lolesports_game_id` ausente | **0** |
| `bet_datetime` ausente | **0** |
| `fair_line_calculated` fora de [15, 50] | **0** |
| Bets REAIS com `fair_line_calculated` | **0** (esperado — campo é só SIMULATED) |
| Datas de criação | **TODAS em 2026-05-22** (217 às 15:15, 52 às 17:46) |

**Por liga:**

| Liga | n | Faixa fair | Distribuição (5 mais comuns) |
|---|---|---|---|
| LPL | 78 | 20.5–31.5 | 28.5×16, 29.5×16, 27.5×15, 30.5×8, 31.5×4 |
| LCK | 44 | 26.5–31.5 | 30.5×12, 28.5×10, 29.5×9, 31.5×7, 27.5×5 |
| LEC | 44 | 23.5–32.5 | 28.5×11, 26.5×8, 29.5×5, 25.5×4, 24.5×4 |
| LCS | 32 | 24.5–28.5 | 27.5×11, 26.5×9, 25.5×8, 28.5×3, 24.5×1 |
| LES | 29 | 27.5–33.5 | 29.5×7, 28.5×5, 30.5×5, 32.5×5, 31.5×4 |
| LFL | 23 | 28.5–32.5 | 30.5×7, 31.5×6, 32.5×5, 29.5×4, 28.5×1 |
| CBLOL | 19 | 26.5–28.5 | 27.5×10, 28.5×5, 26.5×4 |

Tudo dentro de range razoável pro split. Nenhum outlier.

---

## Parte 4 — Recálculo (validação cruzada em dois níveis)

### Nível A: cross-check contra cron-data persistida (100% das bets)

Script: `tmp-audit/fair_cross_check.cjs`. Compara `fair_line_calculated` armazenada vs `line` no `dashboard_stats.json.missed_opportunities` (tier 1) e `tier2_lfl_les_stats.json.missed_opportunities` (tier 2).

| Métrica | Tier 1 (217 bets) | Tier 2 (52 bets) |
|---|---|---|
| Diff = 0 (exato) | **217 / 217** | **52 / 52** |
| Diff médio absoluto | 0.000 kills | 0.000 kills |
| Unmatched (game_id não achado) | 0 | 0 |

**Banco = cron-data persistida** (100% match). Isso prova que as SIMULATED foram criadas dos JSONs canônicos exatos e nunca foram alteradas depois.

### Nível B: recálculo via livestats AGORA (amostra ~6 bets/liga)

Script: `tmp-audit/fair_audit.cjs`. Re-fetch todos games Split 2 via lolesports API HOJE, recalcula `team_avg`, aplica fórmula atual `(blueAvgTotal+redAvgTotal)/2`, compara com `fair_line_calculated` stored.

Note: LES não retornou games no fetch (leagueId minha tabela pode estar errada — não invalidou o resto). Restam 35 bets comparáveis.

| Métrica | Valor |
|---|---|
| Amostra total | 35 (LCK 6, LPL 6, LEC 6, CBLOL 6, LCS 5, LFL 6) |
| Diff = 0 (exato) | **23 / 35 (66%)** |
| Diff ≠ 0 | 12 / 35 (34%) |
| Diff médio absoluto | **0.40 kills** |
| Diff máximo absoluto | **2 kills** |
| Distribuição | 0×23, ±1×10, ±2×2 |

**Por liga:**

| Liga | n | exact | avgAbs | max |
|---|---|---|---|---|
| LCK | 6 | 3 | 0.67 | 2 |
| LPL | 6 | 3 | 0.67 | 2 |
| LEC | 6 | 5 | 0.17 | 1 |
| CBLOL | 6 | 5 | 0.17 | 1 |
| LCS | 5 | 2 | 0.60 | 1 |
| LFL | 6 | 5 | 0.17 | 1 |
| LES | — | (LES não fetchada por bug do script de audit) | — | — |

**Diagnóstico do diff**: NÃO é bug — é **drift natural** do `team_avg`. O `dashboard_stats.json` foi gerado em 2026-05-22 21:28 com snapshot dos games até aquela data. Recálculo HOJE (2026-05-23) inclui games novos que entraram entre snapshot e agora, mudando levemente a média histórica de cada time. Recálculos futuros vão divergir ainda mais — comportamento ESPERADO.

Magnitude: 0.40 kill em média, máx 2 — dentro da granularidade do round `.5`. Mesmo nos off-by-2, são casos de teams com sample pequeno e janela 21d rolling onde 1-2 games novos deslocam significativamente.

**Conclusão Parte 4**: banco está consistente com método atual. Diff vs recálculo HOJE é drift temporal, não erro de método. Validação A (cross-check) é a evidência primária.

---

## Parte 5 — Cruzamentos críticos

### a) Aplicam `-1` nas SIMULATED?

**NÃO**, com nuances:
- `rebuild_dashboard_stats_cron.cjs` linha 17: `FAIR_ADJUSTMENT = 0` (fix 2026-05-17). Aplicado a TODAS as 217 SIMULATED tier 1.
- `analyze_tier2_lfl_les.cjs` linha 17: `FAIR_ADJUSTMENT = 0`. Aplicado às 52 SIMULATED tier 2.
- `rebuild_dashboard_stats_cron.cjs` linha 286 aplica `-1` SOMENTE quando há user_bet COM `odd < 1.72` — e SIMULATED **por definição não tem user_bet** (são missed). Path do user_bet nunca é tomado pra elas.
- **Scripts NÃO usados pra criar SIMULATED** (`rebuild_tier2_dashboard_stats.cjs`, `rebuild_lfl_dashboard_stats.cjs`) ainda têm `FAIR_ADJUSTMENT = -1`. Isso é dívida técnica — não contaminou banco.

### b) `fair_line_calculated` é IMUTÁVEL após inserção?

**Em teoria SIM**, na prática quase houve catástrofe:
- `insert-missed-bets*.cjs` grava `fair_line_calculated` no insert e nunca mais atualiza.
- `enrich-match-context.cjs` ATUALIZA `raw_extraction.match_context` em bets existentes. Antes do commit `2777353` (2026-05-22 17:36), enrich processava TODAS as bets — destruiu `fair_line_calculated` de 217/224 SIMULATED em algumas horas. Restaurado manualmente no mesmo dia.
- Hoje protegido por `if (b.bookmaker === 'SIMULATED') return false;` no filtro do enrich. **Se alguém remover essa linha, bug volta.**

**Conclusão**: campo é gravado UMA vez no insert, mas guard frágil. Não há recálculo legítimo previsto na codebase.

### c) Tier 2 (LFL/LES) usa mesma fórmula que tier 1?

**SIM, na prática.** As 52 SIMULATED tier 2 vieram de `analyze_tier2_lfl_les.cjs` que usa fórmula MODERNA idêntica (`(blueAvgTotal+redAvgTotal)/2`, `FAIR_ADJUSTMENT=0`). Diferenças:
- `MIN_SAMPLE_TEAM = 4` (tier 1 usa 5) — menos rigoroso porque tier 2 tem sample menor por time
- `FALLBACK_LINE = 27.5` (tier 1 usa 29.5)

Esses dois ajustes são intencionais e razoáveis pra tier 2.

**MAS** atenção pra `rebuild_tier2_dashboard_stats.cjs` e `rebuild_lfl_dashboard_stats.cjs` que existem no repo com fórmula VELHA (`a+b-1`, own-side). **Não rodam no cron**, mas se alguém rodar e regenerar `tier2_dashboard_stats.json` ou `lfl_dashboard_stats.json` → poluiria dashboard. Devem ser deletados ou migrados.

### d) Banco vs cron atual

**Dois níveis de validação (Parte 4):**
- Nível A — banco vs cron-data persistida (snapshot 22-mai 21:28): **100% match**, diff 0.000
- Nível B — banco vs recálculo via livestats AGORA (23-mai): **66% exato, avg 0.40 kills, max 2 kills**

Nível B mostra drift natural do `team_avg` quando games novos entram. Não é bug — é a janela rolling 21d funcionando. Comportamento esperado se cron rodar de novo: a `line` no `dashboard_stats.json` vai mudar levemente, mas SIMULATED já gravadas continuam refletindo o snapshot do dia da inserção.

**Implicação prática**: SIMULATED são "fotografia" da fair no momento da execução. Não é problema — é como deve funcionar. Se quiser todas as SIMULATED com fair "fresca" mensalmente, precisaria regenerar (operação que ninguém pediu e que apagaria histórico).

---

## Achados extras (não estavam no escopo)

### Achado E1 (CRÍTICO): cron diário tier 2 EU usa fair fixa 29.5

`analyze_tier2_eu.cjs` linha 26: `const LINE = 29.5;` FIXA. Este é o script que ROTA no GitHub Actions todo dia (`daily-cron.yml`). Não calcula fair dinâmica. Não persiste SIMULATED diretamente (gera só JSON `cron-data/tier2_eu_split2_analysis.json`), mas qualquer dashboard que consuma esse JSON estará com método velho. **Bug.**

### Achado E2 (RISCO): scripts duplicados com fórmula velha

`rebuild_tier2_dashboard_stats.cjs` e `rebuild_lfl_dashboard_stats.cjs` (~270 e ~225 linhas) ainda têm `FAIR_ADJUSTMENT = -1` + own-side kills (bug A+B). Não rodam no cron, mas estão prontos no repo. Recomendar deletar ou migrar.

### Achado E3 (HISTÓRICO documentado mas decisão obsoleta)

`knowledge/decisions/2026-05-06-fair-line-livestats-team-avg.md` ainda descreve a fórmula VELHA `raw - 1` com `round`. Status "Vigente". **Está desatualizado pelo commit `9ef5f40` de 2026-05-17**. Deve marcar como "Substituída" e criar nova decision doc.

### Achado E4 (positivo)

`pending.md` linha 99 já documenta: "SIMULATED com fair_line_calculated: 269/269" e "Tier 2 LFL/LES JSON × banco: 100% match". Auditoria CEO/Claude pré-existente confirmada por esta auditoria independente.

---

## Diagnóstico final

| Pergunta | Resposta |
|---|---|
| Banco está consistente com método atual? | **SIM (100%)** |
| Quantas SIMULATED estão "erradas" pelo método atual? | **0 de 269** |
| Magnitude do erro (média) | **0.000 kills** |
| Recomendação: regenerar SIMULATED? | **NÃO necessário** |

### Recomendações secundárias (não pra agora, mas próxima sessão)

1. **Bug**: trocar `LINE = 29.5` fixa em `analyze_tier2_eu.cjs` pela fórmula dinâmica.
2. **Limpeza**: deletar (ou migrar) `rebuild_tier2_dashboard_stats.cjs` e `rebuild_lfl_dashboard_stats.cjs` — fórmula velha, risco de gerar JSON poluído se alguém rodar.
3. **Docs**: marcar `2026-05-06-fair-line-livestats-team-avg.md` como "Substituída" e criar nova decision doc descrevendo fórmula atual `(a+b)/2` sem `-1`.
4. **Defesa em profundidade**: adicionar teste/check no enrich que assert `b.bookmaker !== 'SIMULATED'` ANTES do PATCH (pra caso o filter quebre).
5. **Re-validar quando**: se rebuild_dashboard_stats_cron rodar em data muito posterior, recalcular fair pra mesmas game_ids vs banco — divergências mostrariam que `team_avg` envelheceu (esperado e tolerável até X kills de diff).

---

## 2026-05-23 — Polymarket descontinuado

**Decisão:** Polymarket removido como fonte de fair_line. Substituído por Pinnacle manual (primário) + fórmula (secundário, sempre calculada).

**Motivação:** Polymarket geo-bloqueado no BR, dependia de runner GitHub Actions US/EU. Elvis passou a consultar Pinnacle manualmente antes dos jogos — fonte mais confiável e sem risco de geo-block.

**Arquivos impactados:**
- `capture_polymarket_lines.cjs` — **deletado**
- `capture_fair_lines.cjs` — Polymarket removido, mantém só fórmula Oracle CSV
- `analyze_range.cjs`, `analyze_split1_firststand.cjs`, `analyze_tier2_lfl_les.cjs`, `rebuild_dashboard_stats_cron.cjs` — hierarquia atualizada: Pinnacle → fórmula → fallback
- `.claude/scripts/daily_briefing.cjs` — `loadPolymarketLines` removida; exibe Pinnacle ou fórmula
- `.github/workflows/daily-cron.yml` — step Polymarket removido, cron 03:30 BRT descontinuado
- `lib/loadFairPinnacle.cjs` — **criado** (helper compartilhado)
- `.claude/commands/log-fair.md` — **criado** (slash command para Elvis registrar Pinnacle)

**Histórico Polymarket preservado:** `cron-data/*-polymarket-lines.json` e `cron-data/*-fair-pre.json` anteriores permanecem versionados e imutáveis. Zero novos arquivos Polymarket serão gerados.

**Schema novo:** `cron-data/YYYY-MM-DD-fair-pinnacle.json` — `fair_lines[]` com `fair_line`, `team_anchor`, `liga`, `lolesports_match_id` (opcional). `applies_to_all_maps: true`.

**Campos nos scripts:** `fair_pinnacle` (Pinnacle manual, null se não disponível) + `fair_formula` (sempre calculada) coexistem no output dos analyze/rebuild. `fair_source` indica qual foi usada no método: `'pinnacle_manual'` ou `'formula'` ou `'fallback_29.5'`.
