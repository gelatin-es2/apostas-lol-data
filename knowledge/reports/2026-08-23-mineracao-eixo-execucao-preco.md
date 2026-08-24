# Mineração — eixo EXECUÇÃO / PREÇO (2026-08-23)

**Pergunta:** dentro das MESMAS bets que o Elvis já faz, tem dinheiro na mesa por execução? Mesmo sinal, preço melhor?

**Resposta curta:** quase nada. O degrau do ladder é precificado certo — mudar de linha não paga. O único dinheiro real e comprovado é **shopar a ODD na mesma linha**, e vale entre **R$ 2,7 mil (comprovado) e R$ 13,7 mil (otimista)** em 4 meses — 2,5% a 13% do lucro. O eixo TIMING não pôde ser testado: o banco não guarda a hora em que ele apostou.

---

## Universo da análise

Bets **reais** (bookmaker ≠ `simulated` — as 439 fake da auditoria 08/08 ficaram fora), settled (green/red), mercado **under kills**, com linha parseável do slip.

| | |
|---|---|
| n | **642 bets** |
| janela | 2026-04-25 → 2026-08-23 |
| stake total | R$ 623.181 |
| lucro real | **+R$ 107.646** |
| hit | 62,1% (BE real 57,1% @odd 1,75) — z=2,59, p=0,010 |
| com fair registrada | 601 (280 fair Pinnacle, 249 fórmula, 72 outra) |

Tudo abaixo é medido contra a **linha real do slip**. Nenhum número usa "under vs mediana".

---

## (a) Achados que sobrevivem

### 1. O degrau do ladder é precificado CERTO — não existe dinheiro em trocar de linha
**Em português:** subir ou descer a linha não melhora nada. A casa cobra exatamente o que a linha vale.

Teste: para cada bet real, recalculei o resultado se a linha fosse ±N, pagando/ganhando o passo canônico de odd (0,08–0,12 por linha, conforme a régua).

| movimento | custo/ganho de odd por degrau | reds→greens | swing líquido (n=579) |
|---|---|---|---|
| linha **+1** | 0,08 | 29 | +R$ 7.971 |
| linha **+1** | **0,10 (canônico)** | 29 | **−R$ 81** |
| linha **+1** | 0,12 | 29 | −R$ 8.132 |
| linha **+2** | 0,10 | 58 | −R$ 9.041 |
| linha **−1** | 0,10 | 20 greens→reds | +R$ 8.228 |
| linha **−2** | 0,10 | 54 | −R$ 28.142 |

Split temporal do +1 @0,10: **OLD +R$1.187 / REC −R$1.267**. Troca de sinal = ruído puro.

O "−1 linha" dá +R$8.228 e mantém o sinal nas duas metades (OLD +1.850, REC +6.378), mas o resultado inteiro depende do passo ser 0,10–0,12; a 0,08 vira +R$949 (zero). **Não é operável.**

**Como operar:** parar de gastar decisão escolhendo degrau. A linha que a casa dá na hora é tão boa quanto qualquer outra do ladder. Isso libera atenção pro que importa (o gatilho).

---

### 2. Shopar ODD na MESMA linha — o único dinheiro comprovado, e é pequeno
**Em português:** quando duas casas oferecem a mesma linha, elas pagam diferente. Ele nem sempre pega a que paga mais.

Evidência direta: **50 células** (mesmo `game_id` + mesmo mapa + **mesma linha**) em que ele apostou em 2+ casas.

- delta de odd entre a melhor e a pior casa: **mediana 0,08 · média 0,091 · máx 0,333**
- **perda comprovada: R$ 2.659 em 64 bets** (o que ele teria feito a mais pegando a melhor odd que ele mesmo tinha disponível naquele momento)

Head-to-head na mesma linha (quem paga mais):

| par | n | diff média de odd | vitórias do 1º |
|---|---|---|---|
| pinnacle vs thunderpick | 17 | **−0,061** | 4/17 |
| estrelabet vs pinnacle | 7 | +0,050 | 5/7 |
| parimatch vs pinnacle | 5 | +0,057 | 4/5 |
| estrelabet vs thunderpick | 5 | −0,094 | 1/5 |
| clutch vs pinnacle | 3 | −0,064 | 0/3 |

Taxa de vitória de odd (melhor preço na mesma linha): thunderpick 64% (16/25), betano 71% (5/7), estrelabet 44%, **pinnacle 28% (10/36)**.

Extrapolação: Pinnacle é 341 das 642 bets (R$359.925 de stake, 218 vitórias). Se as vitórias saíssem com +0,061 de odd → **+R$ 13.745**. É o teto otimista: Pinnacle ainda ganha 4 de 17 duelos, e n=17 é pouco.

> ⚠️ **Isto é análise de PREÇO, não de performance por casa.** A doutrina proíbe atribuir resultado à casa ("casa = onde, não causa") e ela não foi violada: não comparei hit/ROI entre casas. Comparei **a odd ofertada no MESMO jogo, MESMO mapa e MESMA linha** — é o preço do mesmo produto em duas prateleiras, não a performance de ninguém.

**Como operar:** antes de confirmar bet no Pinnacle, olhar Thunderpick na mesma linha. Se a odd for ≥0,05 maior e a stake couber, vai na Thunderpick. Custo: ~10 segundos. Valor: R$ 3–14 mil por 4 meses.

---

### 3. A fair está sistematicamente ~2,3 kills ALTA em jogos com trigger
**Em português:** nos jogos que dão gatilho, o número de kills fica bem abaixo da fair — e não é sorte, é regra.

Medido em `method_reports` (519 jogos com trigger e fair registrada) — **sem viés de seleção**, inclui jogos que ele não apostou:

- erro médio (kills reais − fair): **−2,32** · mediana −3,5
- **65,9% dos jogos fecham abaixo da fair** — z = 7,24, p < 0,000001
- estável fora de amostra: OLD −1,84 / REC −2,80
- consistente em todas as ligas: LPL −2,04 · LCK −2,22 · CBLOL −2,39 · LCS −2,65 · LFL −2,67 · LEC −2,68
- consistente nos dois gatilhos: 2peel −2,87 · 1peel+flex −1,62

Nas bets reais dele o número bate: erro −2,55 (n=542); margem média das bets (linha − kills reais) = **+2,03**.

Este é o único achado que passa folgado no controle de multiplicidade.

**Ressalva importante:** isto mede a **calibração da referência de preço**, não autoriza regra de aposta. A régua fair já se provou descalibrada como filtro (o peel passava nela com 57–60% e perdeu R$27 mil). **Não estou propondo linha mínima nem flexibilização de linha** — a flex "fair−2 no Milio" foi revogada em 15/08 e não é re-proposta aqui.

**Como operar:** nada muda na mesa. O uso é interno — quando um relatório disser "linha X está abaixo da fair", lembrar que a fair carrega ~2,3 kills de viés pra cima. Serve pra calibrar leitura, não pra liberar bet.

---

## (b) Achados mortos — e por quê

### 4. H1 TIMING — **não testável**, não refutado
A hipótese "existe janela em que a linha está mais alta" **não pôde ser testada**: o banco não guarda quando ele apostou.

- `bet_datetime` é o **horário de início do match**, não da aposta (está documentado assim no CLAUDE.md). Mediana de `start_time − bet_datetime` = **0**; p25 = p50 = p75 = 0. Por casa: pinnacle 72% exatamente zero, thunderpick 67%, simulated 82%.
- `raw_extraction.bet_placed_at` existe em **33 de 1.296 bets**. `bookmaker_native.placed_at_*` em ~20.
- `created_at` é quando o print foi logado (mediana 166 min depois do start) — não serve de proxy.

Os 23% com `minToStart` negativo são majoritariamente mapa 2+ (que sempre começam depois do match), não bets live identificáveis. Rodei as janelas mesmo assim: nenhuma célula pré-jogo passa de n=9 fora do bucket "0–5min antes" (n=297, que na verdade é "bet_datetime = start_time"). **Não há sinal porque não há relógio.**

### 5. H5 GAP → HIT — sinal forte que NÃO sobrevive
O bruto era chamativo:

| gap (linha − fair) | n | hit | ROI | lucro |
|---|---|---|---|---|
| gap < 0 | 230 | **69,1%** | **+30,1%** | +R$ 76.226 |
| gap ≥ 0 | 371 | 60,4% | +11,2% | +R$ 38.424 |

E aguentou vários controles: OLD +6,6pp / REC +6,4pp · só mapa 1 +7,7pp · só fair Pinnacle +8,9pp · sem as 10 maiores stakes +7,8pp · sem stake ≥R$3k +7,0pp.

**Mas morre em dois pontos:**

1. **Controle mais limpo (bets solo, sem ladder): o efeito some.** gap<0 62,5% (n=32) vs gap≥0 63,2% (n=95) → **z = −0,07**. Todo o efeito vive nas células de ladder (+15,9pp lá). Ou seja: não é a bet que é melhor quando o gap é negativo — é que os JOGOS em que o ladder inteiro fica abaixo da fair são jogos de poucos kills. O n=32 é pequeno demais pra refutar sozinho, mas é o único corte sem contaminação.
2. **Multiplicidade:** z = 2,17 (p = 0,030). Com ~320 células testadas, o limiar Bonferroni é p < 0,00016 (|z| > 3,8). **Passa longe.**

Também **não é monotônico** — o bucket ">= +2,5" (n=35) dá 54,3% e ROI −6,3%, pior que todos. Não existe corte de gap defensável, nem por baixo nem por cima.

Checagem extra: gap **não** é a odd disfarçada (correlação odd × gap = −0,24), então a circularidade da régua não explica o achado — ele simplesmente não é forte o bastante.

**Veredito: observação, não achado. Nenhum corte de gap deve ser adotado.**

### 6. H2 CASA (linha) — nenhuma casa oferta linha sistematicamente melhor
Controlando pela referência sharp (fair Pinnacle), gap médio da linha ofertada:

| casa | n | gap médio vs fair Pinnacle | odd média |
|---|---|---|---|
| pinnacle | 173 | −0,73 | 1,775 |
| thunderpick | 59 | −0,05 | 1,764 |
| estrelabet | 12 | +1,25 | 1,749 |
| betano | 9 | −0,22 | 1,818 |
| resto | ≤6 cada | — | — |

Só thunderpick tem n≥30 além do Pinnacle, e a diferença é −0,05 (nada). O −0,73 do Pinnacle é definicional: o Pinnacle **é** a referência, e ele ladderiza pra baixo lá dentro. Nas células casa×liga com n≥10, nenhuma passa de +0,42.

**Na LINHA não há nada.** O que existe é na ODD (achado 2).

### 7. H3 CLV — medido, inconclusivo, e roda ao contrário
Consegui linkar **59 bets** (desde 05/08) a uma `closing_line` capturada do mesmo mapa.

- CLV médio (linha apostada − linha de fechamento): **−0,98** · mediana −1
- **63% das vezes ele pega linha ABAIXO do fechamento** (17% acima, 20% igual) — z = 1,95, p = 0,051, falha na multiplicidade

Isso *sugeriria* que esperar renderia ~1 kill a mais. Mas os buckets rodam ao contrário do que a teoria de CLV prevê:

| CLV | n | hit | ROI |
|---|---|---|---|
| ≤ −2 (pegou pior) | 25 | **68,0%** | **+29,3%** |
| −1 | 12 | 58,3% | −1,6% |
| = 0 | 12 | 58,3% | −12,2% |
| +1 | 5 | 40,0% | −16,3% |
| ≥ +2 (pegou melhor) | 5 | 80,0% | +54,2% |

Sem gradiente, n minúsculo nos extremos. **CLV não valida como sinal de qualidade nesta base.** E como o achado 1 mostra que o degrau é precificado certo, ganhar 1 de linha não vale 1 de linha — vale zero.

### 8. H4 LIGA / HORÁRIO / MAPA — nenhum sinal de execução
- **Liga:** bias (linha − fair) vai de −1,15 (LCS) a +1,18 (EMEA Masters), mas não acompanha resultado. LFL tem bias −1,10 **e** o pior ROI (−24%, n=39); LCS tem bias −1,15 **e** +29% de ROI (n=33). Sinais opostos com o mesmo bias = não é o bias que explica.
- **Posição do mapa:** m1 −0,28 · m2 −0,06 · m3 −0,56 · m4 −0,19 · m5 −0,25. Sem gradiente.
- **Dia da semana:** as células chamativas são segunda (21,7% hit, n=23) e sábado (79,5%, n=88) — mas o bias é praticamente igual nos dois (−0,13 vs −0,41). Não é preço.
- **Hora UTC:** 17h com 94,1% (n=17) e 06h com 25% (n=12). Todas n<20. Ruído.

Nada aqui é operável.

---

## (c) Contagem de hipóteses e multiplicidade

**5 hipóteses pré-registradas** testadas + 4 testes derivados (calibração da fair, odd×hit, linha absoluta×hit, precificação do degrau).

Células agregadas examinadas: **~320**

| bloco | células |
|---|---|
| H1 timing (7 janelas × all/old/rec, mapa1, gap por janela, cruzamentos) | ~46 |
| H2 casa (16 casas, 8 casa×liga, 6 linhas × ~5 casas, 9 head-to-head) | ~63 |
| H3 CLV / dispersão | ~15 |
| H4 liga/mapa/dia/hora | ~44 |
| H5 gap (6 buckets × 6 variantes, binários, 9 testes de robustez) | ~63 |
| derivados (odd, linha, calibração, ladder) | ~89 |

Limiar Bonferroni: p < 0,00016 (|z| > 3,8). No acaso puro, ~16 células "significativas a 5%" apareceriam sozinhas.

| achado | z | passa Bonferroni? |
|---|---|---|
| fair enviesada 2,3 kills pra cima (n=519) | **7,24** | **SIM** |
| odd <1,70 vs ≥1,86 (hit) | 2,64 | não |
| hit geral vs breakeven | 2,59 | não |
| gap<0 vs gap≥0 | 2,17 | não |
| CLV<0 63% vs 50% | 1,95 | não |
| gap<0, só bets solo | −0,07 | não |

Os dois achados operáveis (degrau precificado certo; shopping de odd) **não dependem de teste de hipótese** — são contabilidade direta sobre o PnL real, não inferência. Por isso sobrevivem.

---

## (d) Que dado falta pra fechar o que ficou aberto

1. **Hora real da aposta** — bloqueia H1 inteira.
   `bet_datetime` é o start do match. Existe em 33/1.296 bets como `raw_extraction.bet_placed_at`. O slip do Pinnacle traz o horário; o bet-logger não extrai. **Fix:** passar a gravar `bet_placed_at` (UTC) no registro. Só a partir daí dá pra responder "existe janela melhor".

2. **Linha de uma SEGUNDA casa no mesmo instante** — bloqueia H3 de verdade.
   `odds_timeline` (10.659 linhas, 05/08→23/08) é essencialmente Pinnacle: as fontes são `gha-live` 587, `gha-baseline` 339, `pc-live` 39, `local-test` 26, `pc-baseline` 7 e **apenas 2 linhas `betby-duel`**. Sem uma segunda casa capturada em paralelo, a dispersão entre casas só existe nas 63 células acidentais em que ele apostou em 2 lugares. **Fix:** ligar a captura Betby (`capture_betby_kills.cjs` já existe) em paralelo à do Pinnacle.

3. **`riot_game_id` em `odds_timeline`** — só **210 de 10.659 linhas** têm. Das 249 bets reais desde 05/08, só **24** linkam por game_id. O `link-odds-to-riot.cjs` praticamente não está rodando. Tive que linkar `closing_lines` por nome de time + data (84/249 candidatas, 59 utilizáveis).

4. **`closing_lines` não tem `riot_game_id`** — a chave é `series_id` (Pinnacle/Betby). Não existe coluna de ligação com o mundo Riot. Enquanto isso, CLV é sempre estimativa por nome.

5. **Passo real do ladder** — o achado 1 vira ou não vira dinheiro dependendo de o passo ser 0,08 ou 0,12. Hoje isso é uma constante de memória ("≈0,09–0,12"), não um dado medido. Dá pra medir com precisão a partir de `odds_timeline.ladder` (coluna existe) — não fiz porque está fora do escopo desta rodada.

**Tabelas/colunas que NÃO existem** (checadas): `fair_lines`, `pinnacle_lines`, `odds_snapshots`, `live_state`. Existem: `bets` (1.296), `method_reports` (519), `odds_timeline` (10.659), `game_drafts` (8.956), `game_frames` (11.703), `closing_lines` (635).

---

## Conclusão

O eixo execução/preço **não é onde está o dinheiro**. O mercado precifica o degrau do ladder corretamente, nenhuma casa dá linha melhor de forma sistemática, e não existe corte de gap que sobreviva. A única coisa acionável custa 10 segundos por bet — conferir a odd na mesma linha em 2 casas — e vale entre R$ 2,7 mil e R$ 13,7 mil por 4 meses.

O achado com força estatística real (fair ~2,3 kills alta) é sobre a **régua**, não sobre a mesa, e explicitamente **não** vira regra de aposta nesta rodada.
