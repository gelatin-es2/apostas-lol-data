# Mineração 30 ligas — expansão do Under + alerta do meta de julho

**Data:** 2026-07-21 · **Fonte:** `scripts/analysis/multi-league-mining.cjs` → `audit-output/18-multi-league-mining.json` (dataset: 2.966 games válidos, 30 ligas, 2026-04-01→07-21, fair leave-one-out por liga).

## 1. Expansão do Under — 5 ligas novas passam o critério estatístico

Critério: hit ≥ BE 58.1% (Under fair+1 @ 1.72), n≥25, CI inferior ≥ 50%.

| Liga | n | Hit | CI95% | ROI |
|---|---|---|---|---|
| **EMEA Masters** | 41 | 80.5% | [66.0–89.8] | **+38.4%** |
| **LRS** (LATAM Sul) | 31 | 77.4% | [60.2–88.6] | +33.2% |
| **NACL** (NA Challengers) | 49 | 69.4% | [55.5–80.5] | +19.3% |
| **LCK Challengers** | 84 | 69.0% | [58.5–77.9] | +18.8% |
| **Prime League** (DE) | 54 | 68.5% | [55.3–79.3] | +17.9% |

Benchmark das 6 atuais no mesmo período/método: LCK 68.1 · LPL 67.9 · LEC 68.6 · LFL 69.4 · LCS 65.2 · CBLOL 63.4 (única abaixo do critério).

**Pré-requisitos antes de operar:** (1) casa oferece linha de total kills nessas ligas? (verificar Thunderpick/Pinnacle por liga); (2) fair = fórmula (sem Pinnacle, padrão EMEA); (3) adicionar leagueIds ao briefing/cron; (4) começar stake 1k padrão, sem premium, 2 semanas de validação ao vivo.

## 2. ⚠️ Meta de julho — volume do Under vai CAIR no split 3

| Métrica | Abr–Jun | Julho | Delta |
|---|---|---|---|
| Kills médio/jogo | 32.0 | 35.9 | **+3.9** |
| Taxa de trigger peel | 43.6% | **17.3%** | **−26pp (metade!)** |
| Under hit quando dispara | — | 65.6% (n=61) | segue acima do BE ✅ |

O patch tirou o suporte de peel do meta (Camille/engage no lugar). O método continua bom QUANDO dispara — mas dispara 2.5× menos. Implicação direta: **as 5 ligas de expansão não são luxo, são reposição de volume.**

## 3. Champions do patch de julho (controle por time aplicado)

- **Over:** Sylas +3.5 (n=35, robusto), Leblanc +2.6 (n=11), Pyke/Nocturne +1.2–1.5 (maioria era efeito de time)
- **Under:** Lulu segue −3.3 (peel resistindo no meta novo)
- **Camille sup:** ver relatório do método Over (única que passa corte estrito)
- "Locke" (champion novo): n=7, sem leitura ainda

## 1b. Stress de linha (update mesmo dia — `19-under-stress-line.json`)

Critério do Elvis: entra pro método quem mantém ROI positivo com **1 linha PIOR** (Under na fair, não fair+1), n≥25. Testado no piso conservador (odd 1.72 travada) e na escada real (fair @ 1.83).

**BLINDADAS** (positivas até na fair−1, podem operar mesmo com linha ruim): **LRS, EMEA Masters, Prime League, LCK Challengers, LES, Hellenic Legends, TCL** (+ benchmark LEC/LFL/LCK/LCS).

> **Decisão Elvis 2026-07-21:** operar o top da lista MENOS a LRS — casas não abrem linha de kills nela (sem mercado/liquidez; estatística boa, inoperável). **Lista de operação: EMEA Masters + Prime League + LCK Challengers**, condicionada à verificação externa dos dados (spot-check gol.gg em andamento).

**APROVADAS** (positivas na fair): **NACL, Road of Legends, Rift Legends, Circuito Desafiante** (⚠️ Circuito fica negativa na fair−1 com odd real — não aceitar linha 2 abaixo lá).

**Watchlist** (perfil bom, n<25): NLC (73.9%), VCS (73.3%), LIT (83.3% fair+1), Liga Portuguesa.

**Reprovadas no stress:** PCS, Esports Balkan League, EWC — quebram já na primeira linha pior.

⚠️ **LES:** aprovada aqui (65.7% fair+1, 13% ROI na fair, n=35) — CONTRADIZ a regra antiga "LES 43.5% skip" (CLAUDE.md, dado de maio "all games"). O dado novo é trigger-only com fair por liga — mais fiel ao que se aposta. Regra antiga fica revogada quando Elvis validar linha da casa.

## Próximos passos propostos

1. Elvis confere linhas de kills disponíveis nas casas pras 5 ligas.
2. Wire: adicionar leagueIds ao daily_briefing + cron (fair fórmula, padrão EMEA) — tarefa de dev.
3. 2 semanas de operação-teste 1k nas ligas com linha; reavaliar com dado ao vivo.
4. Monitorar taxa de trigger nas majors quando split 3 delas começar (22/07+).
