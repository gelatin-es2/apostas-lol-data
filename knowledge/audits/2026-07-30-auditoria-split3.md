# Auditoria completa — Split 3 (21/07 → 30/07/2026)

**Rodada:** 2026-07-30 · **Modo:** 100% READ-ONLY, nenhum PATCH, nenhum dado alterado
**Fontes:** `audit-output/30-split3-bets.json` · `31-split3-integrity.json` · `32-split3-recompute.json`
**Scripts:** `scripts/audit/split3-{fetch,integrity,recompute}.cjs`

---

## VEREDITO EM 5 LINHAS

1. **O split fechou +R$20.178,55 (ROI 21,80%), e o número está correto** — 84 de 91 settles conferem no recompute frio contra a API.
2. **Mas não há edge estatisticamente validado.** Nenhum recorte sobrevive à correção por múltiplos testes, e **todos os vereditos positivos morrem se UMA bet virar**.
3. **O resultado é o primeiro terço do split.** 21–25/07 rendeu ROI +30,45%; 26–30/07 caiu pra +7,65%, e o discricionário nesse período ficou **negativo (−6,11%)**.
4. **O núcleo do método carregou tudo:** Under trigger + Over janela Camille = +R$15.176 de +R$20.179 em 52 das 94 bets.
5. **O dinheiro vazou por desvio de régua**, não por azar: fair+2 (−R$5.142), Money Line em zebra 0/7 (−R$3.459), cashout acidental (−R$1.030).

---

## 0. Saneamento do universo — ler antes de qualquer número

| item | n |
|---|---:|
| registros no snapshot do split 3 | 107 |
| **SIMULATED** (`bookmaker='SIMULATED'`, stake fictício R$100) | **13** |
| **bets reais** | **94** |
| reais: green / red / cashout / pending | 58 / 32 / 1 / 3 |

⚠️ **As 13 simuladas não são dinheiro real.** Qualquer agregador que não filtre `bookmaker='SIMULATED'` conta 107 e infla volume. O dashboard filtra corretamente (mostra 94). Verificar os demais consumidores.

---

## 1. Integridade dos settles — recompute frio contra a API

```
MATCH ....................... 84   confere
MISMATCH .................... 3    pendentes que já tinham acabado
SUSPECT_FRAME ............... 4    investigado → falso alarme
CASHOUT_MANUAL_CHECK ........ 1    dinheiro perdido
OTHER_MARKET_MANUAL_CHECK ... 2    handicap, script não cobre
```

Checks de integridade: **0 CRITICAL, 0 HIGH.** MED: 11 × `D_no_kills`. LOW: 30 × `H_ladder_dual_path` (problema conhecido de path duplo no `ladder_group_id`).

### 🔴 Cashout acidental — R$ 1.030 perdidos

`10774345` · 25/07 · LCS · FlyQuest × LYON map 2 · Over 28.5 @1,85 · stake R$1.000

Jogo fechou com **48 kills** (frame `finished`, 26×22). Over 28.5 bateu — deveria pagar **+R$850**. Registrada como cashout **−R$180**. `settle_source` = `cashout_accidental_elvis`.

**Custo: R$1.030.** Registro correto, execução errada. Maior vazamento único do split.

### ✅ Falso alarme resolvido — R$3.000 que pareciam em risco

4 bets no LEC KOI×G2 m1 (24/07) vieram `SUSPECT_FRAME`: último frame do livestats `in_game`, não `finished`. Se os 28 kills fossem parciais e o final ≥30, as duas Over 29.5 (−R$2.000 e −R$999,98) estariam erradas.

**Confirmado externamente: 28 kills finais** (MKOI 22 × 6 G2, duração 29:54, gol.gg game 80337). Bate com o recompute — dois sinais independentes. As 4 estão corretas.

Frame ficou `in_game` porque o jogo encerrou aos 29:54 e o feed não fechou o estado. Mesma família do bug de `eventDetails` stale recorrente no split.

### Pendentes resolvidas

| Bet | Jogo | Resultado |
|---|---|---|
| `fc92be1f` | TLN Pirates × Esprit Shonen M1, Over 34.5 | 🟢 +R$800,01 *(auto-settle)* |
| `3e284374` | mesmo mapa, Over 34.5 @1,60 | 🟢 +R$585,54 *(auto-settle)* |
| `6a585aeb` | Joblife × Skillcamp M1, ML Joblife @3,95 | 🔴 −R$1.000 **— PENDENTE, settle manual** |

`6a585aeb` está travada em `moneyline_settle_not_implemented_yet`. O script não cobre moneyline → **nunca settla sozinha**.

---

## 2. Performance

| recorte | n settled | turnover | lucro | ROI | hit (bet) |
|---|---:|---:|---:|---:|---:|
| **GERAL** | 91 | R$ 92.574,42 | **+R$ 20.178,55** | **21,80%** | 64,44% |
| **SÓ MÉTODO** | 17 | R$ 23.008,58 | +R$ 10.407,71 | 45,23% | 82,35% |
| **FORA DO MÉTODO** | 74 | R$ 69.565,84 | +R$ 9.770,84 | 14,05% | 60,27% |

### Hit por bet vs por mapa — a leitura contra-intuitiva

| métrica | por BET | por MAPA |
|---|---:|---:|
| n decidido | 90 | 57 |
| hit | 64,44% | **66,67%** |
| breakeven | 53,14% | 53,15% |
| IC Wilson 95% | [54,15; 73,56] | [53,72; 77,51] |

O hit por **mapa é maior**, não menor. Ladders não inflaram o hit aqui: posições green têm 1,55 slips em média, red 1,68 — **as perdedoras foram mais fatiadas**. 6 posições são mistas (green e red no mesmo mapa), onde "hit por bet" perde sentido.

**Para decisão de método, usar hit por mapa.** Método puro: 82,35% (14/17 bets) → **84,62% (11/13 mapas)**.

### Melhor e pior dia

- **23/07 (+R$5.809,68):** 7 de 9 green, dois greens de método + duas posições Prime de 2u. Zero moneyline.
- **29/07 (−R$98,94):** ladder Clutch de 3 slips em LES (−R$2.062,58) + ML USE×TOG (−R$999,78). **Os dois piores buckets do split no mesmo dia.**

---

## 3. Significância estatística — a parte que importa

IC de Wilson 95%. Breakeven = 1 / odd média ponderada por stake. Veredito = IC inferior > breakeven.

### 3.1 Recortes com n ≥ 5

| recorte | n | hit | BE | IC 95% | veredito | ROI |
|---|---:|---:|---:|---|---|---:|
| GERAL | 90 | 64,44% | 53,14% | [54,15; 73,56] | passa **por 1,01pp** | 21,80% |
| total_kills | 73 | 71,23% | 56,29% | [59,99; 80,35] | passa (3,70pp) | 27,62% |
| FORA DO MÉTODO | 73 | 60,27% | 52,08% | [48,81; 70,71] | **NÃO** | 14,05% |
| `over_experimental_elvis` | 37 | 72,97% | 55,92% | [57,02; 84,60] | passa (1,10pp) | 24,46% |
| LPL | 28 | 71,43% | 54,55% | [52,94; 84,75] | **NÃO** | 33,64% |
| **SÓ MÉTODO** | 17 | 82,35% | 56,57% | [58,97; 93,81] | passa (2,40pp) | 45,23% |
| moneyline | 15 | 33,33% | 38,54% | [15,18; 58,29] | **NÃO** | −15,93% |
| Prime League | 14 | 78,57% | 49,84% | [52,41; 92,43] | passa (2,57pp) | 56,85% |
| LEC | 14 | 42,86% | 53,44% | [21,38; 67,41] | **NÃO** | −22,43% |
| 2peel | 11 | 81,82% | 54,63% | [52,30; 94,86] | **NÃO** | 46,22% |
| LCP | 10 | 70,00% | 50,42% | [39,68; 89,22] | **NÃO** | 8,99% |
| LFL | 9 | 66,67% | 56,61% | [35,42; 87,94] | **NÃO** | 28,37% |
| 1peel+flex | 9 | 77,78% | 56,00% | [45,26; 93,68] | **NÃO** | 48,07% |
| CBLOL | 6 | 66,67% | 46,90% | [30,00; 90,32] | **NÃO** | 44,10% |

Recortes com n<5 (LCS, LES, LCK, `ml_experimental`, `live_hedge`, `boost_series`) **não permitem conclusão**. LCK 100% e live_hedge 100% são anedota.

### 3.2 Correção por multiplicidade — aqui desmorona

**14 recortes testados.** Bonferroni: α = 0,05/14 = 0,0036.

| recorte | p unicaudal | sobrevive? |
|---|---:|---|
| GERAL | 0,0199 | **não** |
| total_kills | 0,0063 | **não** |
| SÓ MÉTODO | 0,0250 | **não** |
| `over_experimental_elvis` | 0,0252 | **não** |
| Prime League | 0,0279 | **não** |

**Nenhum recorte sobrevive.** Com 14 testes a 95%, o esperado é ~0,7 falso positivo por puro acaso — e temos 5 "passa". Essa é a assinatura de garimpo de subgrupo.

### 3.3 Sensibilidade — o veredito custa UMA bet

| recorte | observado | 1 green vira red |
|---|---|---|
| SÓ MÉTODO (bet, n=17) | IC lo **58,97** · passa | IC lo 52,74 · **reprova** |
| SÓ MÉTODO (mapa, n=13) | IC lo **57,77** · passa | IC lo 49,74 · **reprova** |
| GERAL (bet, n=90) | IC lo **54,15** · passa | IC lo 53,02 · **reprova** |
| GERAL (mapa, n=57) | IC lo **53,72** · passa | IC lo 51,94 · **reprova** |

**Os quatro vereditos positivos morrem com uma bet.** Não é edge comprovado, é resultado no fio da navalha.

### 3.4 Quantas bets o método precisaria

Odd média 1,7679 (BE 56,57%), n pra o IC inferior cruzar o breakeven:

| hit real assumido | n necessário |
|---|---:|
| 82,4% (o observado) | 13 — já cruzou, e é por isso que não vale nada |
| 70% | **48 bets** |
| 65% | **124 bets** |
| 62% | 309 bets |
| 60% | 781 bets |

**17 bets não distinguem um método de 82% de um de 60%.** Ambos produzem esse resultado com folga. IC de 34,8pp de largura é a prova.

### 3.5 Estabilidade temporal — a maior fragilidade

| período | n | hit | BE | veredito | lucro | ROI |
|---|---:|---:|---:|---|---:|---:|
| **21–25/07** | 52 | 73,08% | 55,03% | **passa** | +17.489,02 | **30,45%** |
| **26–30/07** | 38 | 52,63% | 50,36% | **NÃO** | +2.689,53 | **7,65%** |
| 21–25 fora do método | 44 | 70,45% | 54,45% | passa | +11.306,20 | 25,45% |
| **26–30 fora do método** | 29 | 44,83% | 48,44% | **abaixo do BE** | **−1.535,36** | **−6,11%** |

**86,7% do lucro foi feito nos primeiros 5 dias.** O método puro segurou o padrão nos dois períodos (n=8 e n=9, sem conclusão). **O que colapsou foi o discricionário.**

### 3.6 Gap settle manual vs API — precisa de 2º sinal

43 das 91 settladas foram fechadas manualmente. Só em total_kills:

| bucket | n | hit | BE | ROI |
|---|---:|---:|---:|---:|
| settle via `lolesports api` | 48 | **77,08%** | 56,13% | **+40,90%** |
| settle **manual** | 25 | **60,00%** | 56,63% | **+1,05%** |

**17pp de hit e 40pp de ROI de diferença.** Explicação mais provável: confusão temporal — o settle manual se concentra em 24–26/07 e 30/07, dias de `getEventDetails` stale, que são exatamente os dias fracos. **Não estou chamando de erro de settle.** Mas o gap é grande demais pra descartar sem verificar.

---

## 4. Aderência à diretriz

**42 das 94 bets reais (45%) estão fora do método declarado.**

| Bloco | n | Stake | PnL | ROI |
|---|---:|---:|---:|---:|
| **Núcleo** (Under trigger + Over janela Camille) | 52 | R$ 56.304 | **+R$ 15.176** | **+27,0%** |
| Todo o resto | 42 | R$ 39.246 | +R$ 5.002 | +12,7% |

### A regra mais violada é a mais cara: `fair+2`

Playbook diz **"fair+2 NUNCA"** (≈54%, colado no BE). **6 bets em fair+2: R$8.009 arriscados, −R$5.142.**

### Ranking de desvio por custo

| # | Desvio | n | PnL |
|---|---|---:|---:|
| 1 | **Money Line em zebra** (odd ≥2,20) | 8 | **−R$ 3.459** |
| 2 | **Over LEC fora da janela** (VIT×KOI m1, 26/07) | 3 | **−R$ 3.000** |
| 3 | Money Line na LCP (fora do recorte) | 3 | −R$ 850 |
| 4 | Série/mapas (boost Clutch) | 2 | −R$ 77 |

Custo líquido: **−R$7.386**. (O fair+2 se sobrepõe parcialmente com 1-2 — não somar em cima.)

**Money Line: 0 acertos em 7 settled.** Mercado sem régua, sem backtest, sem tier de stake. Stakes no olho: R$250, R$450, R$500, R$509. A oitava (`6a585aeb`) vai pra −R$1.000.

**VIT×KOI 26/07 é o pior objeto do split** — 4 violações num mapa: liga sob SKIP + fair+2 + odd 1,70–1,72 abaixo do piso 1,80 + **3u onde cabia 1u**. Um dia depois da revisão semanal que sinalizou o conflito.

### Dado que vai CONTRA a régua

| recorte | n | PnL | ROI |
|---|---:|---:|---:|
| Over **fora** da janela Camille, fora da LEC | 11 | +R$ 2.125 | **+19,8%** |
| Over **na** janela Camille (conforme) | 36 | +R$ 6.369 | +18,0% |

Fora da LEC, o Over off-janela rendeu **o mesmo ROI da janela**. n=11 não revoga a reprovação, mas sugere que o filtro "só Camille" pode estar estreito demais. Entra na fila com a decisão de Over LEC.

### Outros

- **LIT e LRS: zero bets.** ✅
- **KCL pós-27/07: 1 bet, SIMULADA** (R$0 real). Resíduo de automação: `scripts/track-observation-variants.cjs:120` ainda lista KCL nas ligas escaneadas.
- **Stake dentro do método: 13/13 posições conformes.** Disciplina impecável.

---

## 5. Stake — não é a causa do lucro

| cenário | turnover | lucro | ROI |
|---|---:|---:|---:|
| **real** | 92.574,42 | 20.178,55 | **21,80%** |
| normalizado pela régua | 96.000,00 | 20.807,70 | 21,67% |
| **flat 1u em tudo** | 57.000,00 | 11.701,37 | **20,53%** |

Achatar tudo em 1u tira só **1,27pp**. ~94% do ROI vem do acerto, não do tamanho. Confirmado por dois ângulos:
- Exposição média: green R$1.629,41 vs red R$1.613,52 — praticamente igual
- ROI por bucket: `<1u` −2,52% · `1u` +29,90% · `2u` +26,63% · `>2u` **+14,25%**

**As maiores posições performaram PIOR.** Não há viés retrospectivo de stake. Se algo, o sizing discricionário acima de 2u subtrai ROI.

---

## 6. Variância

| métrica | valor |
|---|---|
| maior sequência de greens | **10** (25→26/07) |
| maior sequência de reds | **7** (todo dentro de 26/07) |
| **drawdown máximo** | **R$ 5.758,85 = 5,76u** |
| DD em equity de fechamento diário | apenas −R$98,94 |

**O drawdown é intradiário.** 10 greens seguidos → 7 reds seguidos, quase 6u de swing, tudo em 26/07. **Quem olha só o fechamento diário vê um split sem drawdown — o que é falso.**

### Concentração

| métrica | valor |
|---|---:|
| top 3 bets | R$ 4.887,93 = **24,2%** do lucro |
| top 5 bets | R$ 8.067,95 = 40,0% do lucro |
| ganhos brutos | R$ 49.014,96 |
| **% dos ganhos devolvida pelas perdas** | **58,8%** |

24,2% em 3 bets é concentração moderada, esperada com stake plano e 91 bets. O que preocupa é o **giro**: R$49.015 de ganhos brutos viram R$20.179 líquidos. Com hit no fio do BE, **3 reds a mais deixam o split flat**.

---

## 7. Contabilidade suja — corrigir antes da próxima análise

| Problema | n | Efeito |
|---|---:|---|
| **#62** (LPL LNG×NIP) e **#103** (Prime EINS×ROSS) têm `trigger_type` preenchido e `is_method_bet=false` | 2 | Método marcado errado. Reclassificando: Under-método vai a n=18, +R$2.390 |
| **#97** (LPL TTG×JDG, Over) marcada `is_method_bet=true` | 1 | Única Over marcada como método. Lado errado. |
| **13 bets tier-2 com `fair_formula=29.5`** (fallback) contradizendo a nota (fair real 30,5/32,5/33,5/35,5) | 13 | **Qualquer query que leia esse campo calcula Δ-linha errado.** Contamina análise, não PnL. |
| **11 bets com `MED:D_no_kills`** | 11 | Snapshot não traz placar pra conferir se settle está certo |

---

## AÇÕES — em ordem de prioridade

| # | Ação | Impacto | Risco |
|---|---|---|---|
| 1 | **Settlar `6a585aeb` manualmente** (moneyline, script não cobre) | −R$1.000 no PnL | baixo |
| 2 | **Verificar os 25 total_kills settlados manualmente** contra livestats | 40pp de gap de ROI sem 2º sinal | baixo (read-only) |
| 3 | **Parar Money Line** até ter régua, backtest e tier de stake | 0/7, −R$3.459 | decisão |
| 4 | **Cortar posições >2u fora do método** | ROI 14,25%; as 2 maiores perdas do split | decisão |
| 5 | Corrigir flags #62, #103, #97 | limpa o recorte de método | baixo |
| 6 | Corrigir `fair_formula` dos 13 tier-2 | destrava análise de Δ-linha | baixo |
| 7 | Remover KCL de `track-observation-variants.cjs:120` | cosmético | baixo |
| 8 | Garantir que todo agregador filtre `bookmaker='SIMULATED'` | evita inflar volume | baixo |

**Não fazer:** aumentar stake com base neste split. O método precisa de ~50 bets (tem 17) pra o IC descolar do breakeven com margem que sobreviva a um red.

---

## O QUE NÃO DÁ PRA CONCLUIR

- Se o método é melhor que o discricionário **por mérito** ou porque foi acionado em condições diferentes (n=17, sem grupo de controle pareado)
- Se `2peel` é melhor que `1peel+flex` (n=11 e n=9, ICs totalmente sobrepostos)
- Se a degradação de 26–30/07 é regressão à média, mudança de meta, ou mudança de comportamento do operador. **Faltaria:** patch/meta por data + marcador estruturado de "entrada live vs pré-draft" (hoje só em texto livre nas `notes`)
- Se as 11 bets sem `total_kills` no `match_context` foram settladas corretamente
