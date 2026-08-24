# Movimento da linha m1 → m2 na Pinnacle — a hipótese do Elvis medida (23/08/2026)

> Pergunta que originou: *"mapa 1 acontece um super over kill, mapa 2 a linha já sobe 3 ou 4"*.
> Contexto: a mineração de contexto de hoje (`2026-08-23-mineracao-eixo-contexto-partida.md`) achou que a fair da operação é **uma por série** (`promote_fair_pinnacle_auto.cjs` grava `applies_to_all_maps: true`) enquanto o m2 é +1,67 kills mais quente que o m1. Este relatório mede o outro lado: **quanto a Pinnacle mexe na linha do m2**, e se sobra edge nisso.
> **Somente leitura. Nenhuma escrita no banco, nenhum script de produção alterado.**

---

## Conclusão em frase de gente

**A linha não sobe 3 nem 4. A Pinnacle sobe a linha do mapa 2 em meio kill, e ela sobe esse meio kill *antes de a série começar* — ela quase não reage ao que aconteceu no mapa 1.** Só que reagir pouco está certo: no período em que temos linha real por mapa, o mapa 2 também está vindo só meio kill mais quente que o mapa 1. Casa e realidade batem. O buraco do mapa 2 não é a casa errando o movimento — é a **sua** fair de série, que é a mesma nos dois mapas e por isso não acompanha nem esse meio kill.

E a parte que decide a regra: **under de mapa 2 depois de um massacre no mapa 1 é o pior spot da amostra, não o melhor.** A casa não sobe-corrige — ela sub-corrige, e a realidade vai no mesmo sentido dela (mapa quente puxa mapa quente).

Em número, os três de fechamento:
- linha do m2 − linha do m1 (Pinnacle real, por mapa, pré-série): **+0,44 kills [0,28; 0,59], n=165**
- sensibilidade da linha do m2 ao erro do m1: **b = 0,024 kills por kill [−0,045; 0,093], t=0,68, n=66** → um m1 que estoura +8 acima da linha move o m2 em **+0,19 kills**, não em +3
- under de m2 depois de m1 ≥ fair+8: **35,3% de acerto (n=34)** contra 53,7% do m2 em geral (n=205); no dinheiro real, **−R$7.665 em 20 bets**

---

## 0. Dado usado, e o que ele NÃO cobre

| Fonte | O que é | Cobertura | Limite |
|---|---|---|---|
| `odds_timeline` | **linha real ofertada, por mapa**, capturada da Pinnacle e de Betby | 10.771 leituras · **05/08 → 23/08/2026** · 210 séries · 8.123 com `main_line` | **18 dias.** É todo o histórico que existe de linha por mapa. |
| `cron-data/*-fair-pinnacle.json` (via `ctx.jsonl`) | **fair Pinnacle de série**, logada pelo Elvis — linha real, mas uma só pra série inteira | 601 mapas · 23/05 → 23/08 · 205 pares m1→m2 · 109 pares m2→m3 | não sabe qual mapa é |
| `ctx.jsonl` (dataset canônico 17/08 + tail) | 8.685 mapas com kills reais | 2025-01 → 2026-08 · 2.804 pares m1→m2 | baseline liga×período, **não é linha ofertada** — serve só pra forma |
| `bets` | 1.296 bets; **439 `SIMULATED` excluídas** | 252 unders reais de mapa 2 settled | só 109 têm linha ofertada **e** fair no registro |

Fontes das linhas: `pc-baseline`/`pc-live`/`gha-baseline`/`gha-live`/`local-test` = **Pinnacle**; `betby-duel`/`betby-rakebit` = **rede Betby**.

**Descoberta estrutural do dado que muda a leitura:** a Pinnacle **publica a linha do mapa 2 junto com a do mapa 1, antes de a série começar**. Existem portanto duas linhas de m2 distintas:
1. a **prévia** (posta antes de o m1 ser jogado) e
2. a **pós-m1** (última leitura depois que o m1 acabou e antes de o m2 começar).

A hipótese do Elvis é sobre a 2ª. Este relatório separa as duas.

**Linkagem odds → resultado:** por `series_id` + nomes de time (`lib/team-aliases.json`) + janela de horário, em 3 níveis (2 times batem / 1 time bate e candidato único na liga / liga+horário único). **123 de 210 séries linkadas** (112 pelo nível forte). As 87 restantes são majoritariamente ligas que não existem no dataset de resultados (LCK CL 16, LPL 16, CD 6). Dessas 123, **98 têm kills reais do mapa N e N+1** e **66 têm também uma leitura Pinnacle do m2 depois do fim do m1** — esse é o n do painel de movimento.

---

## 1. Q1 — Quanto a Pinnacle move a linha do m2 em função do m1?

**Resposta: quase nada.**

### 1a. A regressão

| medida | valor |
|---|---|
| **b (delta da linha do m2 ~ erro do m1)** | **0,024 kills por kill** [−0,045; 0,093] · t=0,68 · r=0,085 · n=66 |
| b da parte de **reação** (linha pós-m1 − linha prévia) | 0,043 [−0,025; 0,112] · t=1,24 · n=66 |
| idem, subamostra limpa (leitura ≤25min após o fim do m1) | 0,071 [−0,006; 0,149] · t=1,80 · n=43 |
| **tradução:** m1 estoura **+8 kills** acima da linha → linha do m2 sobe | **+0,19 kills** (IC −0,36 a +0,74) |

Mesmo pegando o coeficiente mais generoso das três estimativas (0,071), um m1 +8 acima da linha move o m2 em **+0,57 kills**. A hipótese pede 3 a 4. **Está errada por um fator de 5 a 20.**

### 1b. A distribuição crua (é o número mais honesto de todos)

Delta total (linha do m2 na véspera do m2 − fechamento do m1), n=66 séries:

| delta | −5 | −4 | −3 | −2 | −1 | **0** | +1 | +2 | +3 | +4 | +5 | +6 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| séries | 1 | 5 | 2 | 3 | 5 | **27** | 12 | 5 | 2 | 2 | 1 | 1 |

- **27 de 66 (41%) a linha não mexe nada.**
- Subiu **≥ +3** em **6 de 66 (9%)** — e caiu ≥ −3 em **8 de 66 (12%)**. O movimento grande existe, mas é **simétrico**: acontece pros dois lados com a mesma frequência. É variação, não reação.
- Delta total médio: **+0,08 [−0,43; +0,58], n=66** — indistinguível de zero.

### 1c. Buckets pelo erro do mapa 1 (todos são observação, n<30)

| erro do m1 vs a linha do m1 | n | delta TOTAL da linha do m2 | delta de REAÇÃO | erro da linha do m2 depois |
|---|---|---|---|---|
| m1 ≤ linha−8 (gelado) | 11 | +0,09 | −0,55 | −4,32 |
| linha−8 .. linha−3 | 16 | +0,13 | −0,56 | +1,38 |
| na linha (±3) | 19 | −0,42 | −0,68 | −1,18 |
| linha+3 .. linha+8 | 12 | −0,08 | −0,58 | −2,67 |
| **m1 ≥ linha+8 (massacre)** | **8** | **+1,38** | **+1,38** | −1,38 |

Só o bucket massacre mostra o movimento que o Elvis descreve — **e ele tem n=8**. Com 8 observações e um desvio de ±2 kills por série, +1,38 é ruído. É a única célula do relatório inteiro que dá algum apoio à hipótese, e ela não sustenta peso.

### 1d. m2 → m3 (n=24, observação)

Delta total **−0,71 [−1,84; +0,43]**; b=0,065 (t=0,84). No m2→m3 a linha tende a **cair**, não subir. Mesmo padrão: sem relação com o resultado do mapa anterior.

---

## 2. Q2 — Delta médio m2−m1 independente do resultado (o baseline estrutural)

**Refeito com filtro limpo de pré-jogo (a mineração da manhã pegou leituras já pós-início, contaminadas).**

| painel | delta m2 − m1 pré-série | n |
|---|---|---|
| **Pinnacle** | **+0,44 kills [0,28; 0,59]** · t=5,46 | **165** |
| Pinnacle, 1ª metade (05→17/08) | +0,45 [0,22; 0,69] · t=3,75 | 82 |
| Pinnacle, 2ª metade (17→23/08) | +0,42 [0,21; 0,63] · t=3,98 | 83 |
| Betby/Duel | +0,47 [0,04; 0,89] · t=2,14 | 30 |
| Pinnacle m3 − m2 | +0,08 [−0,12; 0,28] · t=0,77 | 38 |

- **107 de 165 séries (65%) saem com a linha do m2 idêntica à do m1.** Quando difere, é quase sempre pra cima (50 acima × 8 abaixo).
- **Estável out-of-sample** (+0,45 × +0,42), e a Betby chega no mesmo número por conta própria (+0,47) — duas casas independentes concordando.
- Correção do relatório da manhã: o número era **+0,59**; com o filtro pré-início correto é **+0,44**. Não muda nenhuma conclusão.

### O contraponto que muda a leitura do vazamento

| medida | valor |
|---|---|
| kills m2 − m1 pareado, **dataset inteiro** (2025→2026) | +1,67 [1,23; 2,12] · n=2.804 · t=7,34 |
| kills m2 − m1 pareado, **janela em que existe linha por mapa (05→23/08)** | **+0,39 [−1,27; +2,06] · n=228 · t=0,46** |
| linha m2 − m1 da Pinnacle na mesma janela | **+0,44** |

**Na janela atual, casa (+0,44) e realidade (+0,39) batem.** O +1,67 é média histórica puxada por períodos antigos. Ou seja: a Pinnacle não está sub-precificando o mapa 2 — **ela está certa**. Quem está errado é a fair de série, que aplica o mesmo número nos dois mapas e por isso perde até esse meio kill.

---

## 3. Q3 — A linha do m2 corrige demais ou de menos? O under pós-massacre é bom?

**Corrige de MENOS, e mesmo assim o under pós-massacre é ruim — porque a realidade também vai pra cima.** Não existe sobre-correção pra explorar.

Quatro tribunais, do mais fraco pro mais forte:

### 3a. Física, n grande (resíduo vs baseline liga×período — só forma)

| resíduo do m1 | n | resíduo médio do m2 |
|---|---|---|
| m1 ≤ baseline−8 | 562 | −0,16 [−0,91; +0,60] |
| baseline−8 .. −3 | 622 | +0,74 [0,08; 1,41] |
| baseline ±3 | 759 | +1,34 [0,73; 1,96] |
| baseline+3 .. +8 | 440 | +1,28 [0,44; 2,12] |
| **m1 ≥ baseline+8 (massacre)** | **421** | **+2,11 [1,19; 3,04]** · t=4,49 |

OLS: **b = 0,0739 [0,036; 0,112], t=3,84, n=2.804.** A inércia é real e significativa — e **minúscula**: 0,07 kill de mapa 2 por kill de excesso no mapa 1. Um m1 +8 acima puxa o m2 em +0,6.

Comparando com o que a casa faz (b entre 0,024 e 0,071): **casa e realidade se movem na mesma escala.** A casa não sub-corrige de forma explorável.

### 3b. Contra a fair Pinnacle **de série** (linha real, n=205, 23/05→23/08)

| erro do m1 (kills_m1 − fair) | n | correção do m2 (kills_m2 − fair) | under do m2 @fair |
|---|---|---|---|
| m1 ≤ fair−8 | 47 | −1,48 [−3,92; 0,96] | 61,7% |
| fair−8 .. −3 | 37 | +2,58 [−1,20; 6,36] | 51,4% |
| fair ±3 | 54 | +2,07 [−0,57; 4,72] | 48,1% |
| fair+3 .. +8 | 33 | −2,17 [−4,88; 0,55] | **72,7%** |
| **m1 ≥ fair+8 (massacre)** | **34** | **+2,85 [−0,05; 5,75]** | **35,3%** |
| (todos) | 205 | +0,80 [−0,52; 2,12] | 53,7% |

OLS: b=0,071 [−0,082; 0,223], t=0,91 — **sem relação detectável.**

**Os buckets não são monotônicos e se contradizem**: "quente" (+3..+8) dá under 72,7% e "massacre" (≥+8) dá 35,3%. Efeito real não inverte de sinal ao ficar mais forte. Com a amostra de "qualquer fair" (n=474) a mesma contradição se repete (66,7% × 50,0%). **Isso é ruído, não padrão.**

Split temporal: 1ª metade (n=102) b=0,076 · quente→+0,72; 2ª metade (n=103) b=0,064 · quente→−0,02. **Não replica.**

### 3c. Contra a **linha real ofertada por mapa** (o tribunal mais duro)

| referência | n | under do m2 | viés (kills − linha) |
|---|---|---|---|
| painel amplo: todo m2 com linha Pinnacle pré-série + kills reais | **97** | **57,7%** | **−0,46 [−2,34; +1,42]** |
| subamostra com leitura pós-m1 (a do painel de movimento) | 66 | 66,7% | −1,38 [−3,72; 0,96] |
| controle: m1 contra a própria linha do m1 | 66 | 56,1% | −0,58 |
| m1, painel amplo | 99 | 52,5% | +0,76 |

O 66,7% da subamostra **não sobrevive** — no painel amplo (n=97) o m2 cai pra 57,7%, em cima do breakeven de 57,1% e com IC atravessando qualquer coisa entre −2,3 e +1,4 kills. Bate com a mineração da manhã (53,8%, n=93). **A subamostra de 66 é seleção, não achado.**

Nos buckets pós-massacre contra linha ofertada: n=8. **Não testado.**

### 3d. Dinheiro real (sem `SIMULATED`)

Unders de mapa 2 com o resultado do m1 conhecido, cortado pelo resíduo do m1 vs baseline liga×período (n=202 — o corte com maior n disponível):

| resultado do m1 | n | hit | PnL | ROI | flat 1u |
|---|---|---|---|---|---|
| muito frio | 34 | 52,9% | +R$9.646 | 30,4% | −2,3u |
| frio | 38 | 71,1% | +R$16.261 | 35,0% | +8,9u |
| neutro | 53 | 47,2% | −R$4.243 | −6,6% | **−9,0u** |
| quente | 44 | 50,0% | +R$1.570 | 4,0% | −5,3u |
| **massacre >+8** | **33** | **51,5%** | **−R$2.704** | **−8,4%** | **−2,5u** |

Com o corte pela fair (n=92, mais restrito): pós m1 ≥ fair+8 → **n=20, 40,0% hit, −R$7.665, ROI −34,7%, −5,67u**. Mas **essas 20 bets são 9 partidas** (LFL 27/05 ×2, LCP 31/07 ×4, LPL 02/08 ×3, LCK 15/08 ×4, LPL 16/08 ×2…) — n efetivo ≈ 9, não 20. E no corte de n maior (n=33) o efeito encolhe pra −8,4% de ROI, **pior que a média mas não pior que o bucket "neutro"** (−6,6% com n=53 e −9,0u no flat).

### Veredito de Q3

| pergunta | resposta | número | n |
|---|---|---|---|
| A casa sobe-corrige após m1 quente? | **Não. Sub-corrige levemente** — e a realidade sub-corrige junto | casa b≈0,02–0,07 · realidade b=0,074 | 66 / 2.804 |
| Under de m2 pós-massacre é boa aposta? | **Não. É ruim** | 35,3% under @fair (n=34) vs 53,7% base; m2 vem +2,85 acima da fair; dinheiro real −R$2.704 / −2,5u (n=33) | 34 / 33 |
| Dá pra virar regra? | **Não.** Todas as células estão em n<30 no tribunal de linha real, e o dado de dinheiro está clusterizado em 9 partidas | — | — |

---

## 4. Q4 — Tabela de correção operável

O que sobrevive à régua (célula com n≥30 e sinal que não inverte entre períodos) é **correção por posição de mapa**, não por resultado do mapa anterior.

### 4a. Tabela por slot — quanto somar na fair de série (tribunal: fair Pinnacle real, 23/05→23/08)

| slot | correção a somar na fair de série | n | under @fair | status |
|---|---|---|---|---|
| **mapa 1** | **0,0** (viés −0,06 [−1,21; +1,08]) | **231** | 53,2% | **CONCLUSÃO — fair está certa** |
| **mapa 2** | **+0,8** (viés +0,78 [−0,43; +1,98]) | **231** | 51,5% | **CONCLUSÃO de direção** — a magnitude não é significativa (t=1,27); o IC não exclui zero |
| **mapa 3** | **0,0** (viés −0,35 [−1,93; +1,24]) | **112** | 53,6% | **CONCLUSÃO — fair está certa** |
| BO3 mapa 2 | +0,6 | 186 | 52,7% | conclusão de direção |
| BO5 mapa 2 | +1,4 | 45 | 46,7% | conclusão fraca (n=45, IC ±2,7) |
| mapa 4+ | +1,9 | 27 | 33,3% | **OBSERVAÇÃO (n<30)** |
| BO5 mapa 5 | −2,5 (kills) / n=9 na fair | 96 kills / 9 fair | — | **OBSERVAÇÃO — não é gatilho** (encerrada em 23/08) |

**A correção pra usar é +0,8 no mapa 2 — não +1,5.** O +1,5 proposto de manhã veio da simulação de folga em kills; contra a fair real e contra o dinheiro (§5) ele é caro demais.

### 4b. Correção condicional ao resultado do mapa anterior — **NÃO OPERÁVEL**

| tribunal | o que dá | veredito |
|---|---|---|
| resíduo vs baseline (n=2.804) | b=0,074, t=3,84 → **≤ +0,6 kill** no extremo | real mas **abaixo da resolução de meia unidade da linha** |
| fair Pinnacle de série (n=205) | b=0,071, t=0,91 · buckets não monotônicos · não replica no split | **ruído** |
| linha real por mapa (n=66) | b=0,024, t=0,68 | **ruído** |
| dinheiro real (n=202) | massacre −8,4% ROI × neutro −6,6% ROI | **sem padrão** |

**Não existe linha de tabela "dado o resultado do mapa N, some X no mapa N+1" que passe a régua.** O efeito físico é de +0,6 kill no extremo — menor que o passo de meia unidade da linha e menor que o erro de medição em qualquer amostra disponível.

Registro do que a física diz, pra não perder o dado (**observação, não regra**):

| resultado do m1 | correção física do m2 (vs baseline) | n |
|---|---|---|
| m1 ≤ baseline−8 | −0,2 | 562 |
| m1 na baseline ±3 | +1,3 | 759 |
| m1 ≥ baseline+8 | +2,1 | 421 |

(o "+1,0 do gelado pro massacre" já está quase todo dentro do +1,0 estrutural do slot m2 — o incremento condicional puro é o b=0,074.)

### 4c. Por liga — **nenhuma célula qualifica**

Contra a fair Pinnacle, viés do mapa 2 por liga:

| liga | n (m2) | viés do m2 vs fair de série | status |
|---|---|---|---|
| LPL | 52 | **+2,15 [−0,35; 4,66]** | n≥30, IC atravessa zero → direção, não número |
| LCK | 50 | −0,94 [−3,28; 1,40] | n≥30, nada |
| LEC | 31 | −0,47 [−3,84; 2,91] | n≥30, nada |
| CBLOL | 22 | +0,73 | OBSERVAÇÃO |
| LCP / LCS / LFL / LES / Prime | 9–16 | — | OBSERVAÇÃO |

Correção condicional por liga: **não existe nenhuma célula com n≥30 no tribunal de linha real.** No tribunal de resíduo (n grande) sobrevivem LPL (m2−m1 +0,76, pós-quente +1,85, n=148) e LCK (+0,74, pós-quente +1,17, n=116) — mesma ordem de grandeza do global, sem liga destoante.

**Resumo de Q4: a tabela operável tem uma linha só — `+0,8 no mapa 2`. Todo o resto é observação.**

---

## 5. Q5 — Quanto isso mudaria nas bets reais de mapa 2

Universo: unders reais settled, **`bookmaker != 'SIMULATED'` (439 bets fake excluídas)**.

| recorte | n | hit | PnL | ROI |
|---|---|---|---|---|
| mapa 2, todas | 252 | 56,7% | +R$27.828 | 10,7% |
| mapa 2 pré-jogo | 207 | 55,6% | +R$15.425 | 7,9% |
| mapa 2 live | 45 | 62,2% | +R$12.403 | 19,3% |
| **mapa 2 com linha ofertada E fair no registro** | **109** | 54,1% | +R$13.747 | 9,1% |

⚠️ **Só 109 de 252 bets de mapa 2 (43%) têm os dois campos necessários pra simular a regra.** O resto não dá pra avaliar — não é escolha minha, é buraco de dado.

### 5a. Regra de slot — "só entra no m2 se a linha ≥ fair de série + C"

Pré-jogo (n=69 com linha+fair), que é onde a comparação linha × fair de série faz sentido:

| C | MANTÉM | DESCARTA | efeito em R$ |
|---|---|---|---|
| **+1,0** | n=15 · 66,7% · +R$8.699 · ROI 44,9% · +2,3u | **n=54 · 46,3% · −R$3.807 · ROI −5,1% · −8,9u** | **+R$3.807** |
| +1,5 | n=5 · 60,0% · +R$1.178 · ROI 25,5% | n=64 · 50,0% · **+R$3.715** · ROI 4,2% | **−R$3.715** |
| +0,0 | n=37 · 51,4% · +R$554 | n=32 · 50,0% · +R$4.339 | −R$4.339 |

**Resposta direta: 54 das 109 bets mensuráveis de mapa 2 (49%) mudariam de decisão sob a correção `linha ≥ fair+1`, e isso teria valido +R$3.807.** O corte em +1,5 recomendado de manhã **custaria R$3.715** — não usar.

**Placebo (a prova de que é do slot e não do filtro), mesmo C=+1, pré-jogo:**

| mapa | o que o filtro descarta | ROI descartado | flat |
|---|---|---|---|
| mapa 1 | n=61 · +R$23.605 | **+30,2%** | +16,8u |
| **mapa 2** | **n=54 · −R$3.807** | **−5,1%** | **−8,9u** |
| mapa 3 | n=34 · +R$16.864 | **+42,0%** | +14,7u |

O mesmo filtro joga fora bets excelentes no m1 e no m3 e bets ruins no m2. **Três células, todas com n≥30, sinal invertido só no mapa 2.** É a evidência mais limpa do relatório inteiro a favor da correção de slot.

Split temporal do filtro no m2 (n=109, pré+live): 1ª metade descarta n=48 com ROI +1,7%; 2ª metade descarta n=50 com ROI +16,1%. **Não replica out-of-sample no universo pré+live** — o efeito vem quase todo do recorte pré-jogo.

### 5b. Regra condicional (a hipótese do Elvis virada em regra)

"Pular under de m2 depois de m1 ≥ fair+8": **20 bets, 40,0% hit, −R$7.665, −5,67u.** Skipar teria valido **+R$7.665**.

**Mas não conte com esse número:** as 20 bets são **9 partidas** (n efetivo ≈9, bem abaixo de 30) e no corte de n maior (resíduo vs baseline, n=33) o mesmo spot dá só −R$2.704 / −2,5u — pior que a média, mas empatado com o bucket "neutro" (−R$4.243, −9,0u, n=53). Placebo no mapa 3 pós-m2 quente: n=4. Nada.

**Classificação: bandeira de leitura, não regra.** Mesmo status que a mineração da manhã deu.

### 5c. Total

| regra | bets que mudam | R$ |
|---|---|---|
| **slot +1,0, pré-jogo (n≥30, com placebo)** | **54 de 109** | **+R$3.807** |
| slot +1,5 (o proposto de manhã) | 64 de 109 | **−R$3.715** |
| condicional pós-massacre (n<30) | 20 de 92 | +R$7.665 (não confiável) |
| combinada slot+1 & pula pós-massacre | mantém 15 de 92 · 73,3% · +R$10.471 | observação (n=15 mantidas) |

**Nada disso recupera os ~R$48k de "dinheiro na mesa" da mineração da manhã** — aquele número é o contrafactual de o volume do m2 render o ROI do m1+m3, e nenhum filtro de folga entrega isso, porque as bets de m2 do Elvis se concentram exatamente na fair (22 bets com folga 0, 15 com folga −1). O que a correção entrega de fato é **R$3,8k de perda evitada**, e uma redução de 78% no volume do slot.

---

## 6. Contagem de células e análise de acaso

**263 células testadas** ao todo (75 no painel de movimento Q1/Q2/Q3 · 14 nos controles anti-artefato · 102 na tabela de correção Q3/Q4 · 41 na simulação de bets Q5 · 19 no fechamento · 12 no placebo).

Com 263 comparações, o esperado por acaso a p<0,05 é **≈13 células**. Achados com |t|≥3 fora dos que já eram conhecidos: **dois**, e os dois são a mesma coisa —
1. o delta estrutural da linha da Pinnacle (+0,44, t=5,46), que **replica out-of-sample nas duas metades e numa segunda casa independente**;
2. a inércia física de ritmo (b=0,074, t=3,84, n=2.804), já registrada em 23/08 como bandeira.

**Todas as células que sustentariam a hipótese do Elvis estão em n<30, e as que têm n≥30 apontam contra ela.** Não há nada aqui que precise de correção de Bonferroni pra ser derrubado — ele já não passa no teste simples.

Régua aplicada, do fraco pro forte: (1) resíduo vs baseline liga×período — só descoberta; (2) fair Pinnacle **de série** (n=205/601) — linha real, mas cega ao mapa; (3) **linha real ofertada por mapa** (`odds_timeline`, n=66–97) — o tribunal duro, mas só de 05/08 pra cá; (4) PnL real sem `SIMULATED`, com live separado. Nenhuma conclusão deste relatório foi promovida só pelos níveis 1–2.

---

## 7. Onde o dado NÃO permite responder (dito explicitamente)

1. **Linha real por mapa só existe desde 05/08/2026 — 18 dias.** Todo o painel de movimento (Q1) roda em n=66 séries m1→m2 e n=24 m2→m3. **Nenhum bucket condicional chega a n=30.** Para responder Q1 com força seriam necessárias ~200 séries com m1 e m2 linkados, ou seja **mais 3 a 4 meses de captura**. Não há como estimar isso com o que existe hoje — e eu não estimei.
2. **87 de 210 séries do `odds_timeline` não linkam com resultado.** As maiores perdas são ligas ausentes do dataset de resultados: **LCK CL (16 séries)**, LPL (16), CD (6), KeSPA (4). LCK CL nem existe no `game_drafts`. Fix barato: gravar o `riot_game_id` na captura de odds — o `link-odds-to-riot.cjs` **parou em 15/08** e o campo está preenchido em quase nenhuma linha, o que forçou toda a linkagem a ser por nome+horário.
3. **`game_clock_s` está preenchido em 123 de 10.771 leituras** e o campo `phase` é inconsistente (aparece `phase='pre'` com `minutes_to_start=−73`). Sem isso, não dá pra separar com certeza a última linha pré-mapa da primeira linha live do mapa — tive que usar "≤45min após o fim do mapa anterior" e checar sensibilidade em 25min. **É a maior fragilidade metodológica do Q1.**
4. **`is_live` não existe na tabela `bets`** — inferido por 4 heurísticas. 45 das 252 bets de m2 são live pela heurística; se a classificação estiver errada em 10 delas, o número de Q5 muda de sinal em alguns cortes.
5. **57% das bets de mapa 2 (143 de 252) não têm linha ofertada e/ou fair no registro** — ficaram fora de toda a simulação de Q5.
6. **4 bets têm folga absurda** (linha−fair = −26,5 / −27,5 / −28,5): parse de linha errado a partir do texto do `pick`. Impacto desprezível, mas o parser tem bug.
7. **Duração de mapa continua indisponível** (`first_frame_utc` em 331 de 8.956) — não dá pra testar se o intervalo entre mapas ou o tempo do m1 muda o movimento da linha.

---

## 8. O que fica pra decisão do Elvis

1. **Adotar `+0,8 no mapa 2` (não +1,5)** como correção mental na fair de série? Evidência: viés +0,78 (n=231) + placebo limpo no dinheiro (m1/m3 invertem o sinal, n≥30 nos três). Custo do +1,5: R$3.715 no histórico.
2. **Enterrar a hipótese "a linha sobe 3 ou 4"?** O dado é claro: sobe 0,44 antes da série, e reage +0,19 a um m1 +8. Em 41% das séries não mexe nada.
3. **Enterrar também a ideia de under de m2 pós-massacre.** Não é edge escondido — é o spot mais caro. Continua como **bandeira vermelha** de leitura, sem stake própria.
4. **Autorizar o fix do `riot_game_id` na captura de odds** (o linker parou em 15/08) e gravar `game_clock_s` / `is_live`? Sem esses três campos, este relatório não fica mais forte com o tempo — só fica mais longo.

---

### Rastreabilidade

Nenhuma escrita no banco, nenhum script de produção alterado, nenhum arquivo do repo tocado além deste.
Artefatos reproduzíveis em `C:\Users\Elvis\AppData\Local\Temp\claude\c--Users-Elvis-projects\b064d1d8-81eb-4bb6-b2bb-89b20e333a5d\scratchpad\m1m2\`: `pull.cjs` (dump `odds_timeline`), `pullbets.cjs` (dump `bets`), `link.cjs` (linkagem série→resultado em 3 níveis), `build.cjs` (painel de movimento), `q123.cjs`, `q3b.cjs` (controles anti-artefato), `q4.cjs` (tabela de correção), `q5.cjs` / `q5b.cjs` (bets), `final.cjs`, `stats.cjs`. Dataset canônico de mapas reaproveitado de `..\ctx\ctx.jsonl` (8.685 mapas, montado hoje pela mineração de contexto).
Fontes: `odds_timeline` (10.771 leituras, 05→23/08/2026), `bets` (1.296; 439 `SIMULATED` excluídas), `ctx.jsonl`, `game_drafts` (8.956), `cron-data/*-fair-pinnacle.json` via `ctx.jsonl` (601 mapas com fair Pinnacle), `lib/team-aliases.json`.
Erros-padrão simples (cada série contribui um par); onde há bets múltiplas na mesma partida isso está sinalizado no texto (o corte pós-massacre de Q5 tem 20 bets em 9 partidas).
