# Bard como flex do método Under — análise definitiva

**VEREDITO: o Bard FICA no `FLEX_ENGAGE`. Ele é o MELHOR dos 4 flex e empata com o 2peel (core do método): 68,7% de Under na fair+1 em 361 mapas, CI 95% [63,7–73,3], ROI +18,2% @1,72. Aguenta fair causal, controle de liga, out-of-sample e correção de comparações múltiplas. O "67,2 × 58,1" nunca foi contradição — são duas coisas diferentes medidas com nomes parecidos. A regra "skip Bard vs Lulu/Karma" CAI: Karma 69,1% (n=97) e Lulu 63,8% (n=58), as duas ACIMA do breakeven. E o problema real nunca foi o boneco: as bets de Bard perderam R$8.280 de verdade, e R$11.686 desse buraco está em 12 mapas com LADDER (25% de hit); os 25 mapas com 1 perna só deram +R$3.406 e 60% de hit.**

**Data:** 2026-07-26 · **Pedido:** Elvis ("o Bard é under mesmo quando tem +1 peel do outro lado? split 3 e split 2 separados e juntos" + complemento "análise complexa") · **Script:** `scripts/analysis/bard-flex-definitivo.cjs` → `audit-output/34-bard-flex.json` · **Base:** 3.801 mapas válidos (split 1 jan–mar n=667 · split 2 abr–jun n=2.613 · jul-pré 01–20/07 n=344 · **split 3 21–26/07 n=177, coletado hoje**) · Réguas: Under na fair @1,83 (BE 54,6%) e Under na fair+1 @1,72 (BE 58,1%).

> **Definição de "Bard flex" usada em tudo:** Bard é o support de um time E o support do outro time está na `PEEL_PURE`. Isso é exatamente o trigger `1peel+flex` com o Bard sendo o flex. Detalhe que resolve a pergunta "e se o Bard estiver do lado do peel?": **não existe esse caso** — cada time tem 1 support só, então Bard e o peel estão SEMPRE em times opostos.

---

## 1. A resposta direta — o Bard é under com 1 peel do outro lado?

**É.** Nos 4 recortes de tempo, sem exceção, e sempre acima do breakeven.

| Recorte | n mapas | kills méd | delta (kills−fair) | Under@fair [CI95] | ROI @1,83 | Under@fair+1 [CI95] | ROI @1,72 |
|---|---|---|---|---|---|---|---|
| **Split 1** (jan–mar) | 24 | 24,8 | −2,13 | 75,0% [55–88] | +37,3% | 79,2% [60–91] | +36,2% |
| **Split 2** (abr–jun) | 315 | 29,5 | −2,08 | 64,1% [59–69] | +17,4% | **67,3% [62–72]** | **+15,8%** |
| jul-pré (01–20/07) | 15 | 29,5 | −5,17 | 80,0% [55–93] | +46,4% | 80,0% [55–93] | +37,6% |
| **Split 3** (21–26/07) | **7** ⚠️ | 29,3 | −1,93 | 57,1% [25–84] | +4,6% | 71,4% [36–92] | +22,9% |
| **POOLED split 2+3** | 322 | 29,5 | −2,07 | 64,0% [59–69] | +17,1% | **67,4% [62–72]** | **+15,9%** |
| **POOLED split 1+2+3** | 346 | 29,1 | −2,08 | 64,7% [60–70] | +18,5% | **68,2% [63–73]** | **+17,3%** |
| POOLED tudo (com jul-pré) | 361 | 29,2 | −2,21 | 65,4% [60–70] | +19,6% | **68,7% [64–73]** | **+18,2%** |
| *benchmark* 2peel (core) | 803 | 29,6 | −2,28 | 63,5% [60–67] | +16,2% | 67,7% [64–71] | +16,5% |
| *benchmark* universo SEM trigger | 2.439 | 33,3 | **+1,18** | 48,5% | −11,2% | 53,3% | −8,3% |

### ⚠️ Split 3 tem n=7 — NÃO é base de dados

O split 3 (21→26/07, coletado hoje das 43 ligas da API) tem **177 mapas, 18 com trigger e só 7 com Bard flex**. Bootstrap de 1.000 reamostragens: intervalo [42,9% – 100%]. **Qualquer número do split 3 sozinho é ruído.** O que dá pra dizer: os 7 mapas não contradizem nada (5 verdes na fair+1).

Os 7 mapas, pra registro: DIG×SEN M2 (LCS, 21 kills, Milio/Bard) · Arneb×RAYN M3 (LJL, 36, Bard/Karma) · VES×Lund M2 (NLC, 34, Bard/Nami) · KC Blue×TLN M1 (LFL, 29, Bard/Milio) · GX ITERO×HRTS M1 (LES, 27, Sona/Bard) · Valerion×Spartans M2 (HLL, 39, Bard/Karma) · Estral×paiN Academy M1 (CD, 19, Bard/Milio).

### Bootstrap (1.000 reamostragens dos mapas), hit @fair+1

| recorte | n | hit | p2,5 | mediana | p97,5 | separa do BE 58,1? |
|---|---|---|---|---|---|---|
| split 1 | 24 | 79,2% | 62,5% | 79,2% | 91,7% | **sim** |
| split 2 | 315 | 67,3% | 62,5% | 67,3% | 72,7% | **sim** |
| split 3 | 7 ⚠️ | 71,4% | 42,9% | 71,4% | 100% | não |
| pooled 2+3 | 322 | 67,4% | 62,4% | 67,4% | 72,4% | **sim** |
| pooled 1+2+3 | 346 | 68,2% | 63,3% | 68,2% | 73,1% | **sim** |

---

## 2. A reconciliação 67,2% × 58,1% — em português

Os dois números estão **certos**. Eles medem coisas diferentes:

| | **67,2%** (o número "bonito") | **58,1%** (o número "feio") |
|---|---|---|
| **Onde nasceu** | `audit-output/26-les-complete.json` → `bard.under_flex.pooled` | `audit-output/10-improve.json` → `B.B2_flex_champ` |
| **Quem é a amostra** | **TODOS os jogos** de Bard flex que existiram (332 mapas, ~30 ligas, abr→21/07) | **Só os 124 mapas do split 2 em que EXISTIU uma bet** (36 reais + 88 SIMULATED do cron) |
| **Qual linha foi testada** | Linha sintética **fair+1**, com fair calculada leave-one-out por liga | A **linha que foi de fato registrada** na bet (a maioria SIMULATED, na fair do cron — não na fair+1) |
| **O que responde** | "O boneco puxa kills pra baixo?" | "As bets que eu (ou o cron) registrei ganharam?" |

Reproduzi os dois hoje, no mesmo script:

| Célula | n | hit @fair+1 |
|---|---|---|
| allregions abr→21/07, todas as ligas (o "67,2") | 332 | **67,8%** |
| ídem, só as 6 ligas originais | 124 | 66,9% |
| Bard flex pooled 1+2+3 (recorte de hoje) | 346 | 68,2% |
| Os 124 mapas do split 2 com bet, **na linha registrada** (o "58,1") | 124 | **58,9%** |

**Três coisas separam os dois números, nesta ordem de tamanho:**

1. **A linha (≈ +5 a +7pp).** Nos mesmos 122 mapas que viraram bet: na linha efetivamente pega o hit foi 60,7%; se a linha tivesse sido SEMPRE fair+1, teria sido 67,2%. A escada é monotônica — quanto mais alta a linha, mais fácil o Under:

| linha pega vs fair | n mapas | hit real |
|---|---|---|
| ≤ fair−2 | 41 | 51,2% |
| fair−1 | 28 | 64,3% |
| fair | 29 | 65,5% |
| fair+1 | 20 | **70,0%** |

2. **Quais mapas viraram bet (≈ +13pp, mas não conclusivo).** Nos **36 mapas com bet real**, a régua do backtest (fair+1) daria só **55,6%**, contra 68,7% da população. p (uma cauda) = **0,067** — fica no limite: não dá pra cravar "seleção adversa", mas também não dá pra chamar de coincidência confortável. Fica como alerta.

3. **Escopo de liga (≈ +1pp, praticamente zero).** 6 ligas originais 66,9% vs todas as ligas 67,8%. **Não é escopo** — o `les-complete` já tinha sugerido isso e hoje confirma.

**Não é a fair.** Testei as três réguas de fair na mesma população: leave-one-out 68,7%, trailing causal (só jogos anteriores, zero informação do futuro) 67,3%. Diferença de 1,4pp. A fair Pinnacle manual só cobre **18** dos 361 mapas (o Elvis só loga fair nas majors, e desde 23/05) e nesse pedacinho dá 50% — mas **na mesma amostra de 18 mapas a fair LOO também dá 50%**. Ou seja: aqueles 18 mapas foram ruins de verdade, não é a régua. n=18 não decide nada.

---

## 3. A regra "skip Bard vs Lulu / vs Karma" — CAI

A regra veio de `10-improve` (bets reais/SIMULATED do split 2): Bard×Karma 44% (n=25), Bard×Lulu 50% (n=18). No universo completo de jogos, com a régua do método:

| Peel inimigo | n | delta | Under@fair+1 [CI95] | ROI @1,72 | Veredito |
|---|---|---|---|---|---|
| **Milio** | 46 | −3,85 | **76,1% [62–86]** | +30,9% | 🟢 melhor célula |
| **Karma** | 97 | −2,16 | **69,1% [59–77]** | +18,8% | 🟢 acima do BE — SKIP não se sustenta |
| Nami | 52 | −2,56 | 69,2% [56–80] | +19,1% | 🟢 |
| Seraphine | 97 | −1,43 | 67,0% [57–76] | +15,3% | 🟢 |
| **Lulu** | 58 | −1,83 | **63,8% [51–75]** | +9,7% | 🟡 acima do BE, mas a pior da lista |
| Renata / Sona / Yuumi / Soraka | 1–7 ⚠️ | — | — | — | não é base de dados |
| Bard flex SEM Lulu/Karma | 206 | −2,33 | 69,9% [63–76] | +20,2% | referência |

Detalhe honesto: restringindo às 6 ligas originais, **Karma cai pra 58,3% (n=36)** e Lulu sobe pra 73,9% (n=23) — ou seja, os subcortes por liga ficam n<40 e brigam entre si. E no **teste out-of-sample a regra não sobrevive** nos dois desenhos testados (treino split 1 → teste split 2: célula Lulu/Karma 65,9% vs resto 68,3%, gap de 2,4pp e AINDA acima do BE; treino split 1+2 → teste jul: 61,5% n=13 vs 100% n=9, os dois n<15).

**Recomendação:** revogar o **SKIP**. Nem Lulu nem Karma ficam abaixo do breakeven em nenhuma leitura pooled. O que sobra é: **Lulu = a mais fraca dos peels com Bard, entra sem boost e só com linha ≥ fair**. Karma volta a ser peel normal.

Contra-evidência que o Elvis precisa ver antes de decidir: em dinheiro real, Bard vs Lulu/Karma foram 10 mapas e **−R$2.399**. n=10 mapas não derruba n=155 mapas de universo, mas é o dado que gerou a regra.

---

## 4. Ranking dos 4 flex — o Bard é o melhor, não o pior

Mesma régua (fair LOO, fair+1, @1,72), mesma população, todos com 1 peel do outro lado:

| Flex | n | delta | Under@fair+1 [CI95] | ROI @1,72 | split 1 | split 2 | split 3 |
|---|---|---|---|---|---|---|---|
| **Bard** | **361** | **−2,21** | **68,7% [64–73]** | **+18,2%** | 79,2% (24) | 67,3% (315) | 71,4% (7)⚠️ |
| Rakan | 141 | −1,51 | 64,5% [56–72] | +11,0% | 63,3% (30) | 66,3% (98) | 100% (2)⚠️ |
| Anivia | 39 | −2,50 | 64,1% [48–77] | +10,3% | 100% (1)⚠️ | 63,9% (36) | 0% (1)⚠️ |
| Lux | 18 | **+3,17** | 61,1% [39–80] | +5,1% | — | 62,5% (16) | 100% (1)⚠️ |
| *2peel (core)* | 803 | −2,28 | 67,7% [64–71] | +16,5% | — | — | — |

O Bard sozinho tem **mais amostra que Rakan + Anivia + Lux somados** (361 vs 198) e é o único flex cujo CI inferior (63,7%) fica acima do BE com folga. A frase antiga "Bard é o sangrador" (2026-05-05, n=9) está morta há muito tempo.

Nota lateral, não é o escopo desta análise: **Lux segue sendo a pior** (n=18, delta **+3,17** — mata acima da fair). Decisão do Elvis de 25/07 foi não reabrir; este relatório não reabre.

---

## 5. Controles de confundidor — o efeito é do Bard, não do contexto

### Liga — não é a liga

Bard flex bateu o baseline da **própria liga** em 12 das 14 ligas com n≥10.

| Liga | n Bard flex | hit Bard | baseline da liga | delta |
|---|---|---|---|---|
| LCK Challengers | 28 | 82,1% | 60,3% | **+21,8** |
| Arabian League | 10 | 80,0% | 58,5% | +21,5 |
| EMEA Masters | 14 | 78,6% | 60,8% | +17,8 |
| LEC | 27 | 74,1% | 56,1% | +18,0 |
| LCS | 20 | 75,0% | 59,6% | +15,4 |
| Prime League | 13 | 69,2% | 53,3% | +15,9 |
| La Ligue Française | 17 | 70,6% | 57,4% | +13,2 |
| LPL | 44 | 70,5% | 58,7% | +11,8 |
| NACL | 21 | 71,4% | 59,7% | +11,7 |
| LCP | 11 | 63,6% | 58,1% | +5,5 |
| LCK | 28 | 64,3% | 59,5% | +4,8 |
| Hellenic Legends | 13 | 53,8% | 54,3% | −0,5 |
| CBLOL | 13 | 53,8% | 59,5% | −5,7 |
| Circuito Desafiante | 10 | 40,0% | 62,2% | −22,2 |

**Baseline padronizado** (média das ligas ponderada pela distribuição de jogos do Bard) = 58,4%. Bard flex = 68,7%. **Delta +10,3pp** — o efeito não some quando controla por liga. As duas ligas negativas (CBLOL n=13, Circuito n=10) estão no limite do "não é base de dados".

**Só nas ligas que o Elvis opera hoje** (LCK/LPL/LEC/CBLOL/LCS/LFL/LES/Prime/EUM/LCP): n=196, **69,9% [63,1–75,9], ROI +20,2%** — igual ou melhor que o número global. Com fair trailing causal: 67,9%. Ligas não operadas: 67,3% (n=165). **Não é um efeito de tier-2.**

### Comp inimiga — não muda nada

| Célula | n | hit @fair+1 |
|---|---|---|
| comp inimiga 0–1 engage/teamfight | 258 | 67,8% |
| comp inimiga 2 engage/teamfight | 96 | 70,8% |
| comp inimiga 3+ engage/teamfight | 7 ⚠️ | 71,4% |
| comp DO BARD com 3+ engage/teamfight | 12 | 91,7% |
| Camille em qualquer lado | **0** | não dá pra testar |
| Shen em qualquer lado | 5 ⚠️ | 80,0% |

O efeito **não some** contra comp de engage — se algo, é levemente melhor. Camille nunca aparece num jogo de Bard flex (ela é sup em 115 dos 142 jogos em que aparece, e sup Camille exclui o trigger por definição), então essa hipótese não é testável.

### Tempo e patch — estável

Mês a mês: abr 66,9% (142) · mai 66,7% (138) · jun 71,4% (35) · jul 77,3% (22). Por patch, com n≥10, o pior é **16.8.765 → 58,2% (n=55)** e o resto fica entre 64,6% e 84,6%. **Não é artefato de um período nem de um patch.**

### Lado e resultado

| Célula | n | hit @fair+1 |
|---|---|---|
| Bard no lado azul | 174 | 70,1% |
| Bard no lado vermelho | 187 | 67,4% |
| time do Bard **venceu** o mapa | 202 | **72,8%** |
| time do Bard **perdeu** o mapa | 156 | 64,1% |

Lado azul/vermelho: irrelevante (2,7pp). Ganhar/perder: o Under é melhor quando o time do Bard ganha (+8,7pp) — mas isso **não é operável** (você não sabe quem ganha antes de apostar); serve só como evidência de mecanismo (Bard atrasando o jogo do lado que domina).

### Role

Bard é **support em 829/829 aparições**. Não existe Bard top/mid nessa base — a pergunta "Bard em outra role" não tem amostra.

---

## 6. Mecanismo — é PACE, não duração

Duração medida pela janela do VOD oficial (`startMillis`→`endMillis` do getEventDetails), cobertura 77% dos mapas. Vale como comparação relativa entre células.

| Célula | n c/ duração | duração média (min) | kills médio | **kills/min** |
|---|---|---|---|---|
| **Bard flex** | 274 | **39,9** | 29,4 | **0,78** |
| 2peel (core) | 625 | 39,8 | 29,7 | 0,79 |
| 1peel+rakan | 113 | 40,2 | 30,4 | 0,79 |
| Bard sup SEM peel do outro lado | 350 | 39,8 | 32,8 | 0,86 |
| universo sem trigger | 1.869 | 40,2 | 33,4 | 0,88 |
| universo inteiro | 2.926 | 40,1 | 32,1 | 0,84 |

**Decomposição:** o jogo de Bard flex tem −2,7 kills a menos que a média. Desses, **−2,41 vêm de pace** (menos kill por minuto) e apenas **−0,17 de duração** (o jogo dura praticamente o mesmo tempo).

**O que isso muda na prática:** o edge do Bard NÃO é "o jogo demora mais". É "o jogo mata menos por minuto". Isso é importante porque significa que **jogo longo com Bard não é sinal de perigo** — o total continua baixo. E o Bard sozinho não faz isso: Bard sup sem peel do outro lado roda a 0,86 kills/min (praticamente a média). **O efeito é da DUPLA peel×Bard, não do boneco solto.** (Bard sup em qualquer contexto: 61,0% fair+1, n=829 — apenas marginal acima do BE.)

---

## 7. Out-of-sample — passa em todos os desenhos

Foi este teste que matou o método Over engage. O Bard passa:

| Desenho | n treino | hit treino | n teste | hit teste [CI95] | ROI teste | passou o BE? |
|---|---|---|---|---|---|---|
| split 1 → split 2+jul | 24 | 79,2% | 337 | **68,0% [63–73]** | +16,9% | **SIM** |
| split 1+2 → jul-pré+split 3 | 339 | 68,1% | 22 | 77,3% [57–90] | +32,9% | SIM (n baixo) |
| split 2 → split 3 | 315 | 67,3% | 7 ⚠️ | 71,4% | +22,9% | sem valor (n=7) |
| split 1+2+jul-pré → split 3 | 354 | 68,6% | 7 ⚠️ | 71,4% | +22,9% | sem valor (n=7) |

O único desenho com amostra de teste grande (split 1 → resto, n=337) cai 11pp em relação ao treino mas **continua 10pp acima do breakeven**. Isso é o padrão saudável (regressão à média sem colapso), o oposto do Over engage que caiu de 57,6% pra 50%.

---

## 8. Comparações múltiplas — quantas células passariam por acaso

**42 células testadas** com n≥10. Por acaso, a 5%, esperaríamos ~2,1 passando. Passaram **17** no teste ingênuo (p<0,05 vs BE 58,1%) e **9 sobrevivem à correção Benjamini-Hochberg** (FDR 5%):

| Célula sobrevivente | família | n | hit@fair+1 | p |
|---|---|---|---|---|
| time do Bard venceu | lado | 202 | 72,8% | <0,0001 |
| peel inimigo ≠ Milio | comp | 315 | 67,6% | 0,0003 |
| Bard lado azul | lado | 174 | 70,1% | 0,0007 |
| comp inimiga 0–1 engage | comp | 258 | 67,8% | 0,0008 |
| Bard lado vermelho | lado | 187 | 67,4% | 0,0058 |
| Bard flex LCK Challengers | liga | 28 | 82,1% | 0,0065 |
| comp inimiga 2 engage | comp | 96 | 70,8% | 0,0068 |
| Bard vs Milio | peel | 46 | 76,1% | 0,0086 |
| Milio é o peel inimigo | comp | 46 | 76,1% | 0,0086 |

Leitura: os sobreviventes são quase todos **recortes grandes que contêm a maior parte da amostra** (azul, vermelho, ≠Milio, 0–1 engage). Isso é a assinatura de um efeito **principal, não de um subcorte garimpado** — o Bard flex passa em qualquer fatia grande, não numa célula específica. O único subcorte pequeno que sobrevive é Bard×Milio (n=46).

---

## 9. Escada de linha — onde a célula ainda paga

| Degrau | odd de referência | BE | n | hit | CI95 | ROI | passa? |
|---|---|---|---|---|---|---|---|
| fair−2 | 2,05 | 48,8% | 361 | 56,0% | [51–61] | +14,7% | **SIM** |
| fair−1 | 1,95 | 51,3% | 361 | 61,8% | [57–67] | **+20,5%** | **SIM** |
| fair | 1,83 | 54,6% | 361 | 65,4% | [60–70] | +19,6% | **SIM** |
| fair+1 | 1,72 | 58,1% | 361 | 68,7% | [64–73] | +18,2% | **SIM** |
| fair+2 | 1,62 | 61,7% | 361 | 71,5% | [67–76] | +15,8% | **SIM** |

**Todos os degraus pagam** *se* a odd for a de referência. O problema em dinheiro real (§10) não foi o degrau em si — foi pegar degrau baixo **com odd de degrau alto**.

Por número de mapa (a "cautela mapa 2" do playbook se confirma):

| | n | hit @fair+1 |
|---|---|---|
| Mapa 1 | 216 | **73,1%** |
| Mapa 2 | 109 | 62,4% |
| Mapa 3+ | 36 | 61,1% |

---

## 10. O dinheiro de verdade — R$8.280 no vermelho, e não é culpa do Bard

Bets reais (não-SIMULATED), mercado Under, settladas, em jogo de Bard flex:

| Recorte | bets | mapas | hit por mapa | stake | **P/L** | ROI |
|---|---|---|---|---|---|---|
| **Bard flex — TODAS as reais** | 55 | 37 | **48,6%** | R$39.522 | **−R$8.280** | −21,0% |
| ↳ com Milio como peel | 10 | 7 | 57,1% | R$9.513 | +R$186 | +2,0% |
| ↳ sem Milio | 45 | 30 | 46,7% | R$30.009 | −R$8.466 | −28,2% |
| ↳ vs Lulu/Karma | 12 | 10 | 50,0% | R$9.781 | −R$2.399 | −24,5% |
| Bard flex — SIMULATED (cron) | 111 | 111 | 62,2% | R$111.000 | +R$15.090 | +13,6% |

**Contrafactual "Bard nunca foi flex":** essas 55 bets viram skip → o Elvis teria **economizado R$8.280**.

### Mas o buraco tem endereço: LADDER

| | mapas | hit por mapa | stake | **P/L** |
|---|---|---|---|---|
| Mapas com **1 perna só** | 25 | **60,0%** | R$19.900 | **+R$3.406** |
| Mapas com **ladder (2+ pernas)** | 12 | **25,0%** | R$19.622 | **−R$11.686** |

Os mapas de 1 perna hitaram **60%** — coerente com o backtest, dado que boa parte foi em linha abaixo da fair. Os 12 mapas com ladder hitaram 25% e queimaram R$11.686 com a MESMA exposição total. Os **3 piores mapas sozinhos** (LEC 25/05 mapa 4 com 7 pernas −R$2.148 · LCK 23/05 2 pernas −R$2.000 · LPL 24/05 2 pernas −R$2.000) valem **−R$6.148 dos −R$8.280 (74%)**.

Por número de mapa, no dinheiro real: mapa 1 −R$726 (28 bets) · mapa 2 −R$3.425 (18 bets) · **mapa 4 −R$4.129 (9 bets)** — o mapa 4 é o ladder único de 25/05.

### E os mapas escolhidos foram piores que a média

Nos **36 mapas com bet real** que casam com o universo, a régua do backtest (fair+1) daria **55,6%**, contra **68,7%** da população inteira. p (uma cauda) = **0,067**. Não passa o corte de 5% — então **não dá pra afirmar** que a seleção do Elvis é adversa. Mas é um sinal amarelo que merece re-checagem quando o split 3 acumular volume.

O caso mais caro ilustra o risco de fair errada: **LEC 25/05 mapa 4** — `fair_pinnacle = 27,5`, `fair_formula = 30,5` (3 kills de diferença). O ladder foi montado entre Under 27,5 e Under 30,5 acreditando na fórmula; o jogo deu 38 kills. Todas as 7 pernas red.

---

## 11. Recomendação operacional (graduada)

O Bard não é binário — o que precisa mudar é a execução, não a lista.

| # | Regra proposta | Base |
|---|---|---|
| 1 | **Bard MANTÉM na `FLEX_ENGAGE`.** Nenhuma mudança no trigger. | 68,7% n=361, CI [63,7–73,3], passa OOS, controle de liga e BH |
| 2 | **Bard flex sai do "rebaixado".** Hoje o playbook exige "sinal extra" pro `1peel+flex`; o Bard sozinho performa igual ao 2peel (68,7% vs 67,7%). Proposta: `1peel+BARD` volta pra **stake cheia (1k)**; `1peel+rakan/anivia/lux` continua rebaixado (meia stake com sinal extra). | Ranking §4 |
| 3 | **Revogar o SKIP Bard×Karma.** Karma vira peel normal (69,1%, n=97). | §3 |
| 4 | **Bard×Lulu: rebaixar de SKIP para "sem boost + linha ≥ fair"** (63,8% n=58 é acima do BE, mas é a pior célula da lista e no split 2 ficou em 58,0%). | §3 |
| 5 | **Bard×Milio = a melhor célula do método** (76,1%, n=46, ROI +31%, sobrevive à correção de comparações múltiplas). Mantém o tier Milio. | §3, §8 |
| 6 | **Teto de ladder em mapa de Bard flex: 2 pernas e stake total do tier.** Foi ladder que produziu 100% do prejuízo real (1 perna +R$3.406 / ladder −R$11.686). | §10 |
| 7 | **Nunca abrir Bard flex abaixo da fair quando a fair vem só da fórmula.** O pior caso (−R$2.148) teve fórmula 3 kills acima da Pinnacle. Se não tem fair Pinnacle, linha mínima = fair da fórmula (não fair−1/−2). | §10 |
| 8 | **Mapa 2+ com Bard flex: só linha ≥ fair+1** (62,4% e 61,1% vs 73,1% do mapa 1) — alinhado com a cautela de mapa 2 que já existe. | §9 |

Regras 1, 3, 5 são leitura direta do dado. Regras 2, 4, 6, 7, 8 são **propostas** — precisam de decisão do Elvis.

---

## 12. O que NÃO dá pra afirmar

1. **Nada sobre o split 3.** n=7 mapas de Bard flex em 6 dias. O bootstrap vai de 43% a 100%. O patch novo (16.14) tem 5 mapas. Só re-checar com ~4 semanas de volume.
2. **Não dá pra dizer que o Elvis anti-seleciona.** Os 36 mapas apostados dariam 55,6% pela régua do backtest vs 68,7% da população, mas p=0,067 — dentro do que 36 mapas de variância explicam. É alerta, não conclusão.
3. **A fair Pinnacle não decide nada aqui.** Só 18 dos 361 mapas têm fair Pinnacle (o Elvis só loga desde 23/05 e só nas majors). E nesses 18 a fair LOO dá exatamente o mesmo resultado — não é diferença de régua, é uma amostra pequena e ruim.
4. **Duração é proxy.** É a janela do VOD (inclui overhead de pré-jogo constante) e cobre 77% dos mapas. Serve pra comparar células entre si; não use o valor absoluto "39,9 min" como duração de jogo.
5. **Camille × Bard flex: 0 casos.** Não é "não tem efeito", é "não tem amostra" (Camille sup exclui o trigger por definição).
6. **Bard fora do support: 0 casos.** Não existe na base.
7. **Os subcortes por liga são frágeis.** As duas ligas com delta negativo (CBLOL n=13, Circuito Desafiante n=10) estão no limite de "não é base de dados"; não tratar como "skip CBLOL".
8. **A fair LOO usa o período inteiro** (inclui jogos posteriores na média do time). Rodei a versão causal (trailing, só jogos anteriores) e o resultado praticamente não muda (67,3% vs 68,7%) — mas a régua principal das tabelas continua sendo a LOO, por compatibilidade com o resto do repo.
9. **Coleta do split 3 teve um remendo.** O `getEventDetails` da Riot serviu estado velho pra LCS/CBLOL/LEC de 24–25/07 (games marcados `unstarted` num match já `completed` — mesmo bug apontado na revisão de domingo). Contornei aceitando todos os games do match quando o schedule diz `completed` e deixando o livestats decidir (`--trust-schedule-completed` em `camille-collect.cjs`). Sem isso, 18 mapas de major sumiam da amostra (LCS 0→6, CBLOL 0→6, LEC 5→11). 17 mapas do split 3 continuam suspeitos/sem frame e ficaram de fora.

---

## Arquivos

- Script: `scripts/analysis/bard-flex-definitivo.cjs` (re-rodável, 100% cache exceto a coleta do split 3; `--no-bets` pula o Supabase)
- Dados: `audit-output/34-bard-flex.json`
- Universo novo: `audit-output/00-universe-split3-window.json` (21→26/07, 43 ligas, 194 mapas / 177 válidos)
- Coletor estendido: `scripts/analysis/camille-collect.cjs` agora aceita `--from/--to/--out/--fresh-schedule/--fresh-events/--trust-schedule-completed` (defaults inalterados)
- Cache derivado (patch/picks/duração): `audit-cache/_derived-gameinfo.json`
