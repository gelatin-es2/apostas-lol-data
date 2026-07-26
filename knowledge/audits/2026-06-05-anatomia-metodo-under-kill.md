# Anatomia do Método UNDER Kills — base pra espelho Over

**Data:** 2026-06-05
**Objetivo:** documentar COMO o método Under foi identificado, validado e refinado — não só a definição final — pra servir de molde ao estudo do método Over kills (fase 2).
**Fonte:** auditoria de 3 frentes paralelas (motor estatístico / história de descoberta / catálogo de sinais) sobre `apostas-lol-data` + memórias.

---

## 0. TL;DR

- **Tese:** supports de peel puro → jogo passivo → menos teamfights → **menos kills** → apostar **Under** na linha de kills do mapa.
- **Como dispara:** classificação dos 2 supports do draft em `2peel` (ambos peel) ou `1peel+flex` (1 peel + 1 flex engage).
- **Linha de referência (fair):** Pinnacle manual > fórmula `(blueAvgTotal+redAvgTotal)/2` round `.5` > fallback 29.5.
- **Hit (backtest):** `total_kills < fair_line` (estrito). **Hardcoded Under — único ponto a inverter pro Over.**
- **Edge medido:** a casa põe a linha ~+2,6 kills acima do que o jogo entrega quando há trigger válido.
- **Performance backtest (odd 1.85, BE 54,1%):** 2peel n=245 → **64,1% hit / +18,6% ROI**; 1peel+flex n=193 → 60,6% / +12,2%; all n=438 → 62,6% / +15,7%.
- **Refinamento que mais move ROI:** filtrar `2peel + ambos times ≥60% winrate` → ROI ~14% sobe pra ~30-35% (corta volume, sobe hit).

---

## 1. Hipótese original (a tese mecânica)

Conhecimento de jogo do CEO, não de paper. O método já existia como operação manual antes do sistema. Mecânica: **supports peel puro (escudo/heal/proteção) esfriam skirmishes → menos lutas → menos kills.**

**Validação causal (auditoria Milio 2026-05-31):** jogos com trigger têm fair quase igual aos sem trigger (27,9 vs 28,1) MAS menos kills reais (24,7 com trigger vs 27,0 sem). O ganho não vem de linha mais alta — vem de **menos kills de fato**. Confirma que a mecânica é real, não artefato de linha.

**Tese-espelho já documentada (vale ouro pra fase 2):** support adversário **engage-tank/hook** (Nautilus, Alistar, Renata) → teamfights → **Over fura/acerta**. Ex: Nautilus vs Milio acerta Over 66,7% (n=9), kills 30,7 > fair 28,3.

---

## 2. Detecção de trigger (o gatilho)

Duas listas (versão canônica normalizada, lowercase):

```js
PEEL_PURE   = [soraka, sona, janna, lulu, yuumi, karma, seraphine, renata/renataglasc, nami, milio]
FLEX_ENGAGE = [bard, rakan, lux, anivia]   // 2026-05-23 +Lux +Anivia · 2026-05-29 −Alistar (−26,8% ROI n=21)
```

| Trigger | Condição |
|---------|----------|
| `2peel` | AMBOS supports (blue+red) em PEEL_PURE |
| `1peel+flex` | exatamente 1 lado PEEL + 1 lado FLEX (mutuamente exclusivo com 2peel) |

- Backtest: `rebuild_dashboard_stats_cron.cjs:29,323,325-332` (case-sensitive, nomes da API).
- Replay real: `compute_real_bets_method.cjs:21-65` (normalizado + regra `BARD_ONLY_IN=['LEC']`).
- Bets reais NÃO reclassificam — leem `trigger_type` salvo em `raw_extraction.match_context` no momento do registro.

---

## 3. Fair line (a régua)

Função `fairForGame()` em `rebuild_dashboard_stats_cron.cjs:275-309`. Hierarquia:

0. **Bet do Elvis** indexada: `line = odd<1.72 ? pickLine−1 : pickLine`.
1. **Pinnacle manual** (`cron-data/YYYY-MM-DD-fair-pinnacle.json` via `/log-fair`).
2. **Fórmula:** `Math.round((blueAvg+redAvg)/2 − 0.5) + 0.5` → força terminar em `.5`.
   - `blueAvg`/`redAvg` = média rolling 21d do **total de kills do mapa** dos jogos daquele time, **leave-one-out** (exclui o próprio jogo, anti data-leak).
   - `MIN_SAMPLE_TEAM=5`; abaixo disso usa `leagueAvg×2`.
   - `FAIR_ADJUSTMENT=0` — o antigo `−1` foi removido 2026-05-17 (era compensação de bug, não calibração).
3. **Fallback** `FALLBACK_LINE=29.5`.

**A fair é SIMÉTRICA por construção** (estimativa não-enviesada do total esperado). → reutilizável 100% pro Over sem mudar nada.

---

## 4. Cálculo de hit + agregação

- **Backtest (Under hardcoded):** `if (g.kills < g.line) green++` — `rebuild_dashboard_stats_cron.cjs:339` (+ repetido em :354,:365,:377,:393,:412). Empate impossível (linha sempre `.5`).
- **Bets reais (respeita direção):** `analiseStats.cjs:106` → `won = isOver ? kills > simLine : kills < simLine`.
- **Map-dedup (anti-ladder):** `aggBy()` em 2 passadas — agrupa por `game_id`, **1 stake por mapa** (skip bets extras do mesmo mapa), profit sempre teórico com odd fixa (nunca `b.profit`/`b.odd` reais). Mata inflação de até 5,02× stake (bug 2026-05-28).
- **Invariante de proteção:** hit > breakeven ↔ profit ≥ 0 (validado por `validate-sim-profit.cjs`).

**ATENÇÃO odd/breakeven divergem entre motores:**
| Motor | Odd | Breakeven |
|---|---|---|
| Backtest sintético (`rebuild`) | 1.85 | 54,1% |
| Replay real (`analiseStats`) | 1.72 | 58,1% |
| Odd real média do CEO | ~1.75 | 57,1% |

→ **O backtest é 3pp mais otimista que a realidade do entry.** Validar sempre contra performance real.

---

## 5. Constantes do backtest

`SPLIT2_START='2026-04-01'` · `STAKE=1000` · `ODD=1.85` · `FALLBACK_LINE=29.5` · `MIN_SAMPLE_TEAM=5` · `FAIR_ADJUSTMENT=0` · filtros: champ n≥8, support n≥3, team n≥1 (small_sample <4).

---

## 6. Números reais do backtest (`dashboard_stats.json`, 2026-05-31)

810 jogos via fórmula + 17 Pinnacle.

**Por trigger (Under, odd 1.85):**
| Trigger | n | hit% | ROI% |
|---|---|---|---|
| 2peel | 245 | 64,1% | +18,6% |
| 1peel+flex | 193 | 60,6% | +12,2% |
| all | 438 | 62,6% | +15,7% |

**Por liga (all):** LFL 68,4% (n=38) · LCK 63,7% (n=91) · LES 63,6% (n=33) · LEC 63,2% (n=68) · LPL 62,0% (n=121) · CBLOL 61,4% (n=44) · **LCS 55,8% (n=43)**.

> Cobertura operacional (CLAUDE.md): LCK/LEC/CBLOL/LFL ✅ · LPL/LIT 🟡 marginal @1.75 · **LES ❌ skip (sangra)**.

---

## 7. Catálogo de sinais (edge components) + espelhabilidade pro Over

| # | Sinal | Regra | Edge | Evidência | Espelho Over |
|---|---|---|---|---|---|
| 1 | **PEEL_PURE (2peel)** | ambos supports peel | ↑ Under | avg 24,1 vs 27,4 kills c/ vs s/ trigger | Bom **por ausência**: 0 peel = candidato Over; precisa lista de engage supports |
| 2 | **1peel+flex** | 1 peel + 1 flex | ↑ Under fraco | +4,4% ROI cru (n=241) → +14,7% c/ skips (n=160) | Fraca (marginal já no Under) |
| 3 | **Winrate dos times (≥60/≥75%)** | ambos verdes | ↑ Under | "2peel + ambos ≥60%" → ROI 14%→~35% | **Excelente, inverte:** vermelho do Under = verde do Over |
| 4 | **Time vermelho freia stack** | qualquer time <50% hit → SKIP | vermelho ↓ Under | qualitativo (LOUD🟢87% + LOS🔴33% = SKIP) | **Forte:** time que quebra Under = motor do Over; testar se basta 1 time quente |
| 5 | **Exclusão champion** | Bard vs Lulu/Karma · Alistar · Bard/CBLOL = SKIP | ↓ Under | Bard×Lulu −17,1% (n=20), ×Karma −19,8% (n=26), Alistar −26,8% (n=21) | **Muito boa:** ROI Under fortemente negativo = pace quente = melhores candidatos Over |
| 6 | **Milio (outlier)** | Milio support em trigger válido | ↑ Under forte | 71,6% (n=88); +2,6 kills < fair; vs Bard 83%, vs Lulu 80%; **vs Nautilus 33%** | Direto ruim; via **anti-Milio** (Nautilus/engage/NIP/LCS) = gatilho Over |
| 7 | **Map5 underkill** | toda Under em Map5 BO5 | ↑ Under (hipótese) | +R$856 4G/2R **n=6 não validado** | Especulativa (própria variante não validada) |
| 8 | **Stake-tier (Milio×verdes×linha)** | exposição por força do edge | dimensionamento | Milio sozinho 72% +22% (n=132); +2 verdes ≥75% 100% +68,5% (n=8) | Esqueleto reutilizável, **pesos NÃO** (refazer pro Over) |
| 9 | **Fair line** | `(blueAvg+redAvg)/2` round .5 | neutra (régua) | 269/269 SIMULATED batem 100% | **Total — mesma fair** |

---

## 8. Refinamentos descobertos (com a evidência de cada um)

| Refinamento | Data | Número que mudou |
|---|---|---|
| Fair fixa 29.5 → dinâmica por jogo | 2026-05-06 | fixa superestimava LPL +1,6 / LEC +1,5 / CBLOL +0,8; CBLOL c/ fixa = −66,4% ROI |
| Remover `−1` da fórmula | 2026-05-17 | corrigiu bug own-side; hit 2peel caiu de ~89% irreal → 64,9% real |
| Bard é o sangrador (não Rakan/Alistar) | 2026-05-05 | breakdown flex inverteu hipótese: Bard ROI −56,7% (n=9) |
| +Lux +Anivia ao FLEX | 2026-05-23 | +20 games classificados |
| −Alistar do FLEX | 2026-05-29 | −26,8% ROI (n=21) |
| Filtro ambos times ≥60% | memória | ROI ~14% → ~30% |
| Briefing agrega todos buckets + PnL real | 2026-05-23 | custou R$2.000 (NRF saía 🟡 sendo 🔴 −R$7.400) |
| Polymarket → Pinnacle manual | 2026-05-23 | Polymarket geo-bloqueado no BR |

---

## 9. Armadilhas de método (o que NÃO repetir no Over)

1. **Backtest mente com odd pior.** 1peel+flex: +22,5% backtest → −24,6% real. Sempre cruzar com real.
2. **N pequeno disfarçado de sinal.** Regra do quant-analyst: N<10 = alta variância, não declara edge. Filtros premium (n=8-11) e Map5 (n=6) ainda não confiáveis.
3. **Número bonito demais = bug, não edge.** O ~89% hit era bug own-side + `−1` compensatório.
4. **Decisão deve agregar TODOS os buckets + override por PnL real** (lição R$2.000).
5. **Ladder amplification** — sempre dedup por mapa (`game_id`), nunca contar N bets do mesmo mapa como N stakes.
6. **🔴 BUG ABERTO — Over invertido na simulação.** `getBetSimulation`/`getBetSim` no `dashboard/index.html` (~:1488, :1642) assumem Under sempre. **Tem que ser corrigido ANTES de qualquer backtest Over**, senão todos os resultados Over vêm invertidos. Fix: `won = isOver ? kills>simLine : kills<simLine`.
7. **Não ajustar fair por match em curso** — sample de 2-4 mapas é overfitting; fair pré-match é imutável.
8. **Drift de fair (~0,40 kills) é feature**, não bug (janela rolling 21d).
9. **Regra de matchup não generaliza** — Bard vs Lulu = SKIP, mas Milio vs Lulu = STACK.

---

## 10. Ponte pra fase 2 (método Over) — NÃO iniciar até nova instrução

Os 4 pontos de partida quando a fase 2 começar:

1. **Ponto único de inversão no backtest:** trocar `g.kills < g.line` por `g.kills > g.line` nas 6 ocorrências do `rebuild_dashboard_stats_cron.cjs` (:339,354,365,377,393,412). A fair é a mesma.
2. **Pré-requisito bloqueante:** corrigir bug #6 (Over invertido) antes de qualquer número Over.
3. **Melhores candidatos a edge Over** (por ordem): time "vermelho" do Under → exclusões de champion (Bard×Lulu/Karma, Alistar) → support engage-tank (Nautilus/Renata/Leona/Rell/Pyke) → anti-Milio (NIP, LCS).
4. **Engine já pronta:** `quant-query.cjs` tem `--market over` + breakdowns por sup_blue/sup_red/sup_pair — dá pra rodar backtest Over sem reescrever motor. Mas mantém 2 motores sincronizados (`dashboard/index.html` HTML + `lib/analiseStats.cjs`).

**Aviso:** todos os números são snapshots de 2026-05. Reconfirmar contra Supabase atual antes de tratar como verdade — principalmente filtros de n baixo.
