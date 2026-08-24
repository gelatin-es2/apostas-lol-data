# Mineração — eixo CONTEXTO DA PARTIDA (23/08/2026)

> Primeira varredura fora do draft. Todo o mining anterior (09/08, 16/08, 17/08) foi champion/comp; este relatório não repete nada disso — nenhuma célula aqui usa champion como variável, só **quando/onde/em que situação** o mapa foi jogado.
> Dataset: **8.685 mapas** (8.585 do dataset canônico de 17/08 + 100 mapas novos de 16→23/08 vindos de `game_drafts`), 2025-01-12 → 2026-08-23, 34 ligas.
> Artefatos reproduzíveis (scratchpad da sessão, `C:\Users\Elvis\AppData\Local\Temp\claude\c--Users-Elvis-projects\b064d1d8-81eb-4bb6-b2bb-89b20e333a5d\scratchpad\ctx\`): `build-ctx.cjs` (monta o dataset), `link-odds.cjs` (liga linha real ofertada ao mapa), `analyze.cjs` (scan pré-registrado H1–H7 → `full-scan.txt`, `cells.json`), `analyze2.cjs`, `bets.cjs`, `final.cjs`, dados em `ctx.jsonl` / `schedule.json` / `odds_timeline.json` / `game_drafts.json` / `bets.json`.

---

## Conclusão em frase de gente

**O contexto quase todo é ruído — horário, patch novo, playoff, back-to-back, favorito x zebra: nada disso muda o total de kills. O que muda, e muda muito, é a posição do mapa dentro da série: o mapa 2 é sistematicamente mais sangrento que o mapa 1 da mesma série, e como a fair Pinnacle que você usa é UMA por série (não por mapa), você vem apostando under de mapa 2 com a régua do mapa 1. Isso já custou algo perto de R$48 mil.**

Em número: mapa 2 tem **+1,67 kills** a mais que o mapa 1 da mesma série (n=2.804 séries pareadas, t=7,34) e, no dinheiro real pré-jogo, os unders de mapa 2 acertam **55,6% (n=207)** contra **71,5% (n=267)** nos mapas 1 e 3 — 16 pontos de diferença, z=−3,61.

---

## 1. Sobreviventes

### 1a. ⭐ MAPA 2 É O BURACO — correção de fair, não método novo

O achado tem três pernas independentes que apontam para o mesmo lado.

**Perna 1 — o fato de kills (não depende de aposta nenhuma):**

| medida | valor |
|---|---|
| m2 − m1 **pareado dentro da mesma série** | **+1,67 kills** · n=2.804 séries · t=7,34 |
| m3 − m1 pareado (controle) | −0,07 kills · n=1.365 · t=−0,21 (nada) |
| ligas em que m2 > m1 | **14 de 15** (só NACL inverte, −0,22) |
| períodos em que m2 > m1 | **4 de 4** (2025 +0,95 · jan-mar/26 +1,97 · split2 +2,62 · split3 +0,72) |
| resíduo do m2 vs baseline liga×período | +1,09 (BO3, n=2.281, t=5,74 clusterizado por série) |
| **dentro do universo apostável (trigger)** | m1 resid −3,22 (n=592) vs m2 −1,24 (n=615); pareado **+2,25 kills**, n=190, t=2,76 |
| dentro de Milio+trigger | m1 −5,52 (n=135) vs m2 −2,83 (n=170) → **2,7 kills de edge a menos no m2** |

Ou seja: o mapa 2 não só é mais quente no geral — ele **come cerca de 2 kills da margem do próprio método** quando o trigger aparece.

**Perna 2 — o mecanismo (por que isso vaza pra você e não pro mercado):**
- O arquivo `cron-data/*-fair-pinnacle.json` tem `applies_to_all_maps: true` — **uma fair por série**. Ela não sabe qual mapa é.
- A Pinnacle real **precifica por mapa**: comparando as leituras pré-jogo de `odds_timeline` dentro da mesma série, a linha do m2 fica **+0,59 kills** acima da do m1 (n=165 séries; só 44% saem idênticas). Ela ajusta — parcialmente (+0,59 contra +1,67 reais).
- Resultado: quando você compara uma linha ofertada de mapa 2 contra uma fair de série, você acha folga que não existe. Vies medido: contra a fair Pinnacle de série, o m2 roda **+0,78 kills acima** (n=231) enquanto m1 roda −0,06 e m3 −0,35.

**Perna 3 — o dinheiro (bets reais, `bookmaker != SIMULATED`, pré-jogo, live excluído):**

| slot | n | hit | PnL | ROI sobre stake | ROI flat 1u |
|---|---|---|---|---|---|
| mapa 1 | 176 | 68,2% | +R$47.427 | 28,4% | 19,7% |
| **mapa 2** | **207** | **55,6%** | **+R$15.425** | **7,9%** | **−2,2%** |
| mapa 3 | 91 | 78,0% | +R$34.577 | 39,7% | 39,1% |
| mapa 4 | 26 | 42,3% | +R$2.108 | 11,0% | −24,4% |
| mapa 5 | 15 | 46,7% | −R$2.169 | −17,3% | −19,5% |
| **m1+m3 (comparação)** | **267** | **71,5%** | **+R$82.004** | **32,3%** | **26,3%** |

- Diferença m2 vs m1+m3: **−16,0pp, z=−3,61**. Breakeven na odd real média (1,75) = 57,1% → **o m2 roda abaixo do breakeven em taxa e no flat 1u**.
- **R$ deixado na mesa: ~R$47.844** (o mesmo volume de stake do m2 rendendo o ROI de m1+m3).
- Não é seleção de trigger: a fatia de `is_method_bet` é a mesma nos três slots (96% / 91% / 92%).
- Não é stake: no flat 1u (odd média idêntica, 1,79 nos três) o m2 é **−2,2%** e m1+m3 é **+26,3%**.
- Pior recorte: **BO5 mapa 2 — n=50, 40,0% hit, −R$11.714, ROI −25,3%** (BO3 m2 fica em 60,7%, ROI 17,9%).

**Estabilidade temporal (honestidade obrigatória):** o sinal é consistente em direção nos 3 sub-períodos, mas a magnitude não é estável.

| janela | m2 | m1+m3 | gap |
|---|---|---|---|
| abr-mai/26 | 50,7% (n=138) | 67,8% (n=143) | −17,1pp |
| jun-jul/26 | 41,2% (n=17) | 70,8% (n=24) | −29,6pp |
| ago/26 | 73,1% (n=52) | 77,0% (n=100) | **−3,9pp** |

Em agosto o buraco quase sumiu (mas o livro inteiro esquentou). Sinal 3/3 na direção, magnitude oscilando — isso é **motivo pra tratar como gate, não pra mexer em stake hoje**.

**Teste contra LINHA REAL OFERTADA — o que dá e o que não dá pra afirmar:**
- Painel de linha real por mapa (`odds_timeline` pré-jogo, 05→23/08): **224 mapas Pinnacle + 34 Betby/Duel**. Contra essa linha, o viés do m2 é **−0,04 kills (n=93, 53,8% under)** e o do m1 é +1,08 (n=95, 46,3%). Ou seja: **onde existe linha por mapa, o mercado já cobrou o mapa 2 e não sobra edge detectável** — mas com n≈90 por slot o painel não resolve diferenças de meio kill.
- Portanto a afirmação forte **"under de mapa 2 é −EV contra o mercado"** fica **NÃO TESTADA**.
- A afirmação que **está** sustentada é outra, e é a operável: **a sua régua de decisão (fair de série) está errada no mapa 2 em ~1,5 kill, e o dinheiro real mostra o efeito disso.**

**Regra proposta (decisão do Elvis — NÃO implementei nada):**
> No mapa 2, tratar a fair da série como **1,5 kill mais alta do que está no arquivo** antes de julgar a oferta. Na prática: só entra under de m2 se a linha ofertada estiver ≥ `fair_série + 1,5`. Em BO5 o corte deveria ser ainda mais duro (o m2 de BO5 é o único slot com PnL negativo relevante).
> Alternativa mais conservadora e reversível: manter o m2 no set, **stake 0,5u**, e contar até n≥50 com piso ≥60% antes de voltar a 1u.
> **Não recomendo skipar o mapa 2** — ele ainda entregou +R$15.425. O problema é preço, não é o slot.

Simulação de folga na fair Pinnacle (n=231 mapas com fair Pinnacle, todos os slots, sem trigger — serve pra calibrar a magnitude, não pra prometer hit):

| slot | under @fair | @fair+1 | @fair+2 |
|---|---|---|---|
| m1 | 53,2% | 56,7% | 62,8% |
| m2 | 51,5% | 56,7% | 60,2% |
| m3 | 53,6% | 58,9% | 66,1% |

O m2 precisa de ~+1,5 a +2 de folga pra cruzar o BE de 57,1%; o m3 cruza com +1.

No dinheiro real, o recorte por folga confirma a direção mas com n de observação: m2 com `linha ≥ fair+1` → **66,7% (n=15, +R$8.699)**; m2 com `linha = fair` → **40,9% (n=22, −R$8.146)**.

---

### 1b. 🚩 Flag (não é bet): série quente puxa o próximo mapa

- Correlação entre resíduo do mapa anterior e do mapa atual: **rho=0,075, n=4.488, z=5,02**. Pequena, mas real.
- Onde importa: **mapa 2 depois de um mapa 1 muito quente (>+8 kills acima do baseline) = +2,14 kills** (n=415, t=4,55; OLD +2,54 / NEW +1,74). É a **pior combinação possível pra um under**: slot ruim + série quente, ~3,8 kills acima do mapa 1 típico.
- Contra a fair Pinnacle: prev muito quente → 42,9% under (n=56); prev muito frio → 51,7% (n=60). Direção consistente, **os dois abaixo do BE** → **não vira aposta, vira bandeira vermelha** nos unders discricionários, igual à flag jungle gank×gank de 17/08.

---

### 1c. 👀 Observação sem claim: LEC segue rodando abaixo da linha

Três fontes independentes, mesma direção:

| liga | under vs fair Pinnacle | under vs linha real por mapa | bets reais pré-jogo |
|---|---|---|---|
| LEC | 60,0% (n=75) | 69,7% (n=33) | 57,6% (n=59), ROI 22,5% |
| CBLOL | 57,4% (n=54) | 64,3% (n=14) | 55,8% (n=77), ROI 22,3% |
| LCS | 52,5% (n=40) | 40,0% (n=10) | 66,7% (n=27), ROI 24,6% |
| LPL | 50,4% (n=131) | 28,9% (n=38) | 68,8% (n=128), ROI 19,9% |
| LFL | 57,4% (n=47) | 61,5% (n=13) | **34,3% (n=35), ROI −38,7%** |

Isto **não é achado novo** — o relatório de 17/08 já registrou "fair rodando alta em LEC/CBLOL/LCS" com expectativa de reversão. Aqui só ganhou uma fonte a mais (linha real ofertada). Com 13 ligas testadas, 1 resultado a p<0,05 é o esperado por acaso. **Observar, não operar.** O LFL negativo (n=35) é anedota do mesmo tamanho — registro pra não esquecer, não pra agir.

---

## 2. Mortos — e por quê (vale mais que os vivos)

| Hipótese | Veredito | Números |
|---|---|---|
| **H2 — time perdendo joga mais agressivo** | ❌ **REFUTADO: é o mapa 2 disfarçado** | "atrás 0-1" = +1,04 (n=1.905, t=5,25) **mas em BO3/BO5 o mapa 2 É sempre 1-0** — não dá pra separar. O único teste limpo é BO5 mapa 3: com 2-0 (alguém desesperado) resid **+0,12** (n=213); com 1-1 (empatado) **−0,80** (n=146) — diferença de 0,9 kill, sem significância e **com sinal invertendo entre períodos** (2-0: OLD +0,79, NEW −0,94). Estado da série **não adiciona nada** além da posição do mapa. |
| **H2b — mapa que decide é mais/menos sangrento** | ❌ redundante com H1 | "decisivo (ambos em match point)" = −1,10 (n=518, t=−2,96) — mas BO3 m3 ≡ 1-1 e BO5 m5 ≡ 2-2. É o mesmo efeito de slot já contado. Contra a fair Pinnacle: 50,0% under (n=56). Nada. |
| **H3 — duração do mapa anterior** | ⚠️ **NÃO TESTADO (dado não existe)** | Só **298 de 8.685 mapas** têm duração calculável (`first_frame_utc` quase nunca é gravado em `game_drafts`); com o mapa **anterior** também medido, sobram **167**. O que existe aponta pro mesmo lado do H3-kills (prev longo → mapa atual −2,24, n=58) mas é anedota. |
| **H4 — playoff / eliminação / final** | ❌ **MORTO** | regular resid −0,02 (n=5.256) · playoff +0,05 (n=1.558) · final +0,55 (n=164, t=0,68). No dinheiro, **tirando o mapa 2**: regular ROI 25,2% (n=132) × playoff ROI 23,0% (n=116) — **idênticos**. Toda a diferença bruta ("playoff pior") era mix de mapa 2/BO5. |
| **H4b — jogo sem importância (já classificado/eliminado)** | ⚠️ **NÃO TESTÁVEL** | Não existe classificação/standings em nenhuma fonte do projeto. Precisaria de tabela de liga por rodada. |
| **H5 — calendário inteiro** | ❌ **MORTO, sem exceção** | back-to-back (≤1,5d) +0,32 (n=2.594, t=1,81) · ambos back-to-back +0,25 · patch novo ≤3d **−0,09** (n=3.934) · patch 3-7d −0,14 · 1º jogo do dia −0,01 (n=2.845) · último jogo do dia −0,02 (n=2.790) · fim de semana +0,03 · horário: só UTC 00-06 dá +0,73 (t=1,91) e isso é **mix de liga** (LPL/LCK ocupam essa faixa), some no resíduo por liga. |
| **H6 — mismatch de força** | ❌ **MORTO: stomp e snowball se cancelam** | gap de winrate 0-10pp: +0,05 · 10-20pp: −0,16 · 20-35pp: +0,15 · >35pp: +0,14 (n=1.062). **Zero monotonicidade.** O jogo curto por dominância e o massacre com muito kill existem os dois e se anulam. "Soma de winrate 0,8-1,2" (+0,52, t=2,16) morre out-of-sample (NEW t=1,09) e não tem mecanismo. |
| **H7 — liga destoante e estável** | ⚠️ nível de liga é real, **mas já está na linha** | Níveis muito diferentes e estáveis (Prime League 33,9 kills · Arabian 38,5 · LCS 26,3 · LEC 27,5). Sinal estável nos 4 períodos: LEC(−), CBLOL(−), LCS(−), Prime(+), Arabian(+), Road of Legends(+). **Mas o mercado precifica cada liga separado** — o que sobra é só o item 1c. |

---

## 3. Veredito explícito: MAP 5 BO5 UNDERKILL

**Matar como regra/variante. Fica só como linha de correção de fair.**

O fenômeno de kills é **real e estável** — foi a única coisa da variante que sobreviveu:

| fonte | resultado |
|---|---|
| kills vs baseline liga×período | **−2,75 kills**, n=96, t=−3,21 |
| 2025 (backtest) | −2,29 (n=27) |
| 2026 jan-mar | −2,22 (n=19) |
| 2026 abr+ | −3,19 (n=50) |

Mas nada disso vira dinheiro, e nunca foi testado onde importa:

| tribunal | resultado |
|---|---|
| vs fair Pinnacle (linha real de série) | **n=9** — 44,4% under. Nada. |
| vs fair qualquer fonte | n=14 — 57,1%. Nada. |
| **vs linha real ofertada por mapa** | **n=2. NÃO TESTADO.** |
| bets reais (sem SIMULATED) | **n=18, 44,4% hit, −R$3.247** |
| bets reais pré-jogo | n=15, 46,7%, −R$2.169 |
| bets reais em BO5 m5 confirmado | n=14, 42,9%, −R$2.919, ROI −25,2% |

**A leitura seca:** o mapa 5 realmente tem menos kill, mas (a) o dinheiro real está negativo em todos os recortes, (b) contra linha real por mapa existem 2 observações na história inteira, e (c) a oferta é ~1 mapa a cada 90 (96 mapas em 8.685). Não há como uma regra com essa oferta e esse histórico ganhar dinheiro antes de n≥50, e o forward-test já vem perdendo.

**Decisão recomendada:** encerrar a variante "map 5 BO5 underkill". O que sobrevive dela vira **uma linha na tabela de correção de fair por slot** (abaixo), que é onde o efeito de kills tem serventia — ajudar a não pagar caro, não criar gatilho novo. m5 segue 1u **só quando o trigger normal aparecer**, como qualquer outro mapa.

**Tabela de correção de fair por slot** (kills observados − fair Pinnacle **de série**, o número a somar/subtrair mentalmente na fair antes de julgar a oferta):

| slot | viés vs fair de série | n | ação |
|---|---|---|---|
| mapa 1 | −0,06 | 231 | fair está certa |
| **mapa 2** | **+0,78** (BO5 m2: +1,39) | 231 | **fair está ~1,5 baixa — exigir folga** |
| mapa 3 | −0,35 | 112 | fair está certa, levemente a favor |
| mapa 4+ | +1,94 | 27 | observação (n baixo) |
| BO5 m5 | −2,5 (do dado de kills; n=9 na fair) | 96 kills / 9 fair | observação, **não é gatilho** |

---

## 4. Hipóteses testadas e análise de acaso

**7 hipóteses pré-registradas · 103 células no scan primário · ~180 recortes adicionais de confirmação (viés por slot, dinheiro real por slot/BO/liga/stage/trimestre, painel de linha real, folga da linha, robustez por liga e por período) ≈ 285 comparações no total.**

Contagem formal sobre o scan pré-registrado (97 células com n≥30):

| corte | observado | esperado por acaso |
|---|---|---|
| \|t\| ≥ 2 | **15** | 4,9 |
| \|t\| ≥ 3 | **8** | 0,26 |

**O topo do ranking NÃO é fabricável por sorte — mas ele também não são 8 achados, são 2.** Das 8 células com |t|≥3, **6 são a mesma coisa reescrita** (BO3 m2, BO3 len2 m2, "atrás 0-1", "BO3 estado 1-0", "match point 1 lado" — todas ≡ mapa 2; "BO3 mapa 3" e "decisivo" ≡ mapa decisor) e 2 são o mapa anterior quente. Contando fenômenos independentes: **posição do mapa** e **inércia de ritmo**. Ambos passam Bonferroni com folga (o teste pareado m2−m1 dá t=7,34, p≈1e-13; ×285 comparações ainda sobra p≈3e-11).

Todo o resto do scan — 4 hipóteses inteiras (H4 stakes, H5 calendário, H6 mismatch, H2 estado) — produziu **exatamente o que se espera de ruído**: nenhuma célula com |t|≥3 que sobreviva ao out-of-sample.

Régua aplicada, conforme a lição de 17/08 ("under vs mediana está descalibrada"): nenhuma célula foi promovida por bater a mediana. Hierarquia usada, do fraco pro forte: (1) resíduo de kills vs baseline liga×período — só descoberta; (2) viés vs fair Pinnacle de série, n=601 — a linha real da Pinnacle, mas de série; (3) viés vs **linha real ofertada por mapa** (Pinnacle pré-jogo n=224 · Betby/Duel n=34) — só ago/26; (4) **PnL real** das bets, sem SIMULATED, com live separado. Nenhum achado deste relatório é promovido a regra só pelos níveis 1-2.

---

## 5. Dado faltante (o que impediu conclusão)

1. **Duração de mapa praticamente não existe.** `game_drafts.first_frame_utc` está preenchido em **331 de 8.956** linhas. Só 298 mapas têm duração e 167 têm duração do mapa anterior → **H3-duração morreu por falta de dado, não por falta de efeito.** Fix barato: gravar `first_frame_utc` no `live-capture`/backfill.
2. **Linha real ofertada só existe desde 05/08/2026** (`odds_timeline`, 209 séries, 224 mapas linkados). Antes disso, o melhor disponível é a fair Pinnacle **de série** (601 mapas) ou a fórmula. Toda célula anterior a agosto é, por construção, **NÃO TESTADA contra linha real**.
3. **Não existe flag confiável PRÉ vs LIVE na tabela `bets`.** Só 131 de 1.296 linhas têm `raw_extraction.match_context.state`; tive que inferir live por 4 heurísticas combinadas. Sem esse campo, **qualquer análise de régua (linha × fair) mente** — a primeira versão desta análise mostrava "linha abaixo da fair acerta 80%", que é puro artefato de bet live em jogo lento. Fix: gravar `is_live` no save.
4. **439 bets com `bookmaker='SIMULATED'` continuam no banco** com status green/red e **+R$51.230 de profit fake** (auditoria de 08/08 identificou, não removeu/marcou). Qualquer consulta que não filtre isso reporta lucro inflado — inclusive a primeira rodada desta análise, que dizia m2 ROI 9,2% quando o número real é 7,9% e o flat é −2,2%. Fix: coluna `is_simulated` ou status próprio.
5. **Standings / importância do jogo não existem em nenhuma fonte** → "jogo sem importância (time já classificado ou eliminado)" ficou sem teste.
6. **`cron-data/*-results.json` parou em 2026-08-15.** Os últimos 8 dias só entraram via `game_drafts` (100 mapas). Vale checar se o cron caiu.
7. **Vencedor de mapa falta em 311 mapas** e o estado de série completo só fecha em 5.715 de 8.685 — o H2 rodou nesse subconjunto.

---

## 6. O que fica pra decisão do Elvis

1. **Mapa 2**: adotar a correção de fair (+1,5 no m2, mais duro em BO5) ou meia-stake com gate n≥50? Não mexi em nada. **Não skipar** — o slot ainda deu +R$15.425.
2. **Map 5 BO5**: encerrar a variante (recomendação) ou manter forward-test? O dado está fechado: −R$3.247 em 18 bets, 2 observações contra linha real.
3. **Bandeira "série quente"**: incluir na leitura de under discricionário (mapa 2 depois de mapa 1 com >+8 kills = pior spot do dataset)?
4. **Higiene de dado**: autorizar os 4 fixes baratos (first_frame_utc, is_live, marcar SIMULATED, checar cron de results.json)? Os dois do meio bloqueiam qualquer análise futura de régua de linha.

---

### Rastreabilidade

Nenhuma escrita no banco. Nenhum arquivo do repo alterado além deste. Fontes cruzadas: `dataset.jsonl` canônico de 17/08 (8.585 mapas, 0 divergências de kills em 4.380 mapas com 2+ fontes) + `game_drafts` (8.956) + `backtest-2025/data/*` (4.152 rows com `winner`/`stage`/`match_start`) + `audit-output/00-universe-*.json` (4.987, `winner_side`) + `getSchedule` da lolesports (18 ligas, 4.837 matches, `blockName`+`startTime`+`strategy.count`) + `odds_timeline` (10.660 leituras) + `bets` (1.296). Baseline de kills sempre liga×período (o meta subiu de 29,5 em 2025 pra 33,7 no split 3 — comparação sem esse controle é lixo). Erros de SE por correlação dentro da série tratados com SE clusterizado por `match_id`. Um bug encontrado e corrigido no meio do caminho: a primeira versão da derivação de estado de série não casava nome de vencedor com nome de time (universo dava nome longo, dataset dava nome curto), inflando "estado 0-0" de 1.570 pra 4.044 mapas — todos os números de H2 aqui são pós-correção.
