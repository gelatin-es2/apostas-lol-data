# Mineração do eixo LIVE / in-game — kills O/U ao vivo (23/08/2026)

> Fase 2 da mineração de 17/08 (`knowledge/reports/2026-08-17-mineracao-padrao-novo-kills.md`, seção 5). Infra de captura: `knowledge/reports/2026-08-13-underkill-livebet-execucao.md`.
> Pergunta: **existe padrão AO VIVO abusável, com número?** Régua obrigatória: comparar sempre contra a **linha real ofertada no instante**, nunca contra mediana histórica.

---

## Veredito em frase de gente

**Não existe under ao vivo pra ser abusado — o livro chega no ponto antes de você. A informação que o minuto 10 te dá, a casa já cobrou na linha: em cima dos MESMOS mapas de Milio, apostar pós-draft acertou 13 de 17 e esperar o minuto 10 acertou 10 de 17, porque a linha caiu 4,3 kills no caminho. Em dinheiro, esperar teria custado R$22.560 em 9 dias. O único achado ao vivo com cheiro de edge é o contrário do que operamos (over em jogo já sangrento) e ele não passa no teste de multiplicidade — é observação, não aposta.**

E tem um teto físico que ninguém tinha medido: **a Betby fecha o mercado de kills do mapa por volta do minuto 15-20**. Depois disso não existe linha pra apostar, então "esperar o minuto 20" não é uma estratégia ruim — é uma estratégia impossível.

---

## 1. Universo e cobertura (o que o dado É, hoje)

| Item | Número |
|---|---|
| Mapas com série minuto a minuto (`game_frames`) | **332** |
| Mapas `finished` com `final_kills` (universo de pesquisa) | **287** |
| Desses, em ligas operadas | 249 |
| Janela temporal | **05/08 → 23/08** (19 dias) |
| Mapas com odds AO VIVO linkadas | **157** (137 dentro dos 287) |
| Mapas com trigger / com Milio | 64 / 49 |

**Qualidade do dado: boa.** 287/287 mapas com `final_kills` batem exatamente com o último frame (0 divergências). Só 5 mapas têm buraco na série (máx. 2 minutos). Ligas: LCK 59, LEC 36, LCP 28, LES 24, LPL 24, NACL 24, KCL 25, LFL 21, Prime 14, TCL 13, CBLOL 12, LCS 7.

**Linkagem odds↔Riot refeita em memória** (mesma lógica do `link-odds-to-riot.cjs`, sem escrever no banco): 248 séries linkadas, 0 ambíguas. Validação contra o que o linker oficial já gravou: **207 concordam, 0 discordam**. O linker oficial parou de rodar em 15/08 — ver seção 7.

### 1a. Teto duro: quando existe linha ao vivo pra apostar

| Minuto do mapa | Mapas com linha real ofertada (≤180s antes) |
|---|---|
| 5 | 83 |
| 10 | 84 |
| 15 | 60 |
| 18 | 34 |
| 20 | 25 |
| 25 | **0** |

Último minuto com linha, nos 72 mapas ≥30min desde 15/08: **p50 = minuto 15, p90 = 19, máximo = 22**. Mediana de **20 minutos de jogo sem mercado** até o mapa acabar.

Não é falha da coleta — é o mercado fechando: **em 72 de 72 mapas o coletor Betby continuou rodando (≥3 ticks) depois da última linha e não veio mais nada.** A Pinnacle é pior: dos 3.534 registros `phase=live`, só ~324 têm linha de kills (ela fecha o mercado ao vivo, como já sabíamos).

> Ressalva honesta: a escrita é delta-gated por `content_hash`. Em tese um mercado aberto com linha E odds 100% congeladas por 20 minutos não geraria row. Improvável num jogo vivo (as odds oscilam a cada tick), mas é a única brecha lógica que resta.

---

## 2. H2 — RITMO: jogo lento explode no late? **Não. Mito morto.**

Universo: 287 mapas, sem precisar de linha.

| Minuto | kills@M méd | resto méd | corr(kills@M, resto) | slope | corr(kills@M, duração) |
|---|---|---|---|---|---|
| 5 | 1,4 | 28,6 | 0,224 | +1,23 | −0,02 |
| 10 | 4,6 | **25,5** | 0,155 | +0,43 | −0,07 |
| 15 | 8,6 | **21,5** | 0,095 | +0,17 | −0,15 |
| 20 | 13,3 | 16,8 | 0,036 | +0,04 | −0,20 |

**Lei do resto constante:** a partir do minuto 10 sobram ~25,5 kills (dp 8,3); a partir do minuto 15, ~21,5 (dp 7,8) — **quase independente do que aconteceu antes**.

Por quartil de ritmo aos 15min, o resto praticamente não muda: Q1 (3,6 kills) → resto 20,9 · Q4 (14,4 kills) → resto 22,7. O ritmo do resto sobe de leve (1,17 → 1,45 kills/min), ou seja há **persistência fraca, nunca reversão**. Jogo lento continua lento; ele não "explode" pra compensar.

Consequência prática: `final ≈ 20,1 + 1,17 × kills@15`. E o estado ao vivo informa pouco — o desvio-padrão do total cai de **9,28 para 7,78 kills** sabendo o placar do minuto 15 (redução de 16%). No minuto 10, redução de 11%. Você troca 19 minutos de espera por 1/6 da incerteza.

**Distribuição condicional do total (287 mapas, sem linha):**

| kills @15 | n | final p10/med/p90 | P(final<25) | P(final<30) |
|---|---|---|---|---|
| 0-2 | 17 | 12 / 19 / 39 | 76% | 82% |
| 3-4 | 32 | 17 / 25 / 34 | 47% | 81% |
| 5-6 | 49 | 16 / 27 / 33 | 41% | 78% |
| 7-8 | 62 | 22 / 28 / 35 | 27% | 65% |
| 9-11 | 65 | 24 / 31 / 41 | 12% | 35% |
| 12+ | 62 | 26 / 37 / 52 | 6% | 21% |

Parece um sinal enorme. Não é — a casa já cobra por ele (seção 3).

---

## 3. H1 — ESTADO AOS X MINUTOS contra a LINHA REAL: nada com margem

Comparação sempre contra a linha Betby vigente no instante do frame (leitura ≤180s antes), liquidando com a odd real daquela leitura. BE de referência: **57,1%** (odd 1,75).

### Minuto 10 (n=84 mapas com linha real)

| estado (kills@10) | n | under% | linha méd | final méd | ROI under |
|---|---|---|---|---|---|
| 0-2 | 27 | 51,9% | 24,8 | 25,6 | −3,3% |
| 3-4 | 24 | 45,8% | 26,7 | 25,0 | −12,9% |
| 5-6 | 16 | 68,8% | 29,0 | 29,8 | +31,3% |
| 7-8 | 14 | 21,4% | 31,1 | 36,6 | −59,7% |
| **TOTAL** | **84** | **47,6%** | 27,5 | — | **−10,0%** (over −2,4%) |

### Minuto 15 (n=60)

| estado (kills@15) | n | under% | linha méd | final méd | ROI under |
|---|---|---|---|---|---|
| 0-2 | 3 | 100% | 20,8 | 16,3 | +88,0% |
| 3-4 | 8 | 50,0% | 24,0 | 25,6 | −5,5% |
| 5-6 | 11 | 36,4% | 25,2 | 25,6 | −29,9% |
| 7-8 | 18 | 38,9% | 26,8 | 27,3 | −25,6% |
| 9-11 | 11 | 36,4% | 28,6 | 30,6 | −30,7% |
| 12+ | 9 | 33,3% | 31,8 | 36,6 | −37,2% |

**Nenhuma célula com n≥30 fica acima do BE. O under ao vivo, na linha real, é 47,6% (min 10) e 41,7% (min 15) — perde.** Contra a mediana histórica ele pareceria bom; contra a linha ofertada, não é. É exatamente a armadilha que custou R$26.960 no peel morto, agora medida no live.

### Onde o livro erra (e não erra)

Definindo `slack = linha − kills@M` (quantos kills o livro ainda concede):

| | slack ofertado | resto real | erro do livro |
|---|---|---|---|
| minuto 10 (n=84) | 23,3 | 24,3 | **+0,9 kill** |
| minuto 15 (n=60) | 19,0 | 20,3 | **+1,3 kill** |

O livro precifica a lei do resto constante com erro médio de ~1 kill — dentro do próprio vig. Nenhum bucket de slack sobrevive: melhor célula foi `slack ≤17` no minuto 15 (erro +5,3 kills, over 78%), com **n=9**.

**A resposta ao "≤4 kills aos 15min tem margem?" é: não.** Nesse estado a Betby ofertou linha 20-24 (e não 29,5), o resto real foi 19,9 e o slack ofertado 20,0 — **erro do livro = 0,0**. Under nesse recorte: 63,6% em n=11. Abaixo de n=30 e sem margem no slack.

---

## 4. H3 — GOLD DIFF / OBJETIVOS: mexe no relógio, não nos kills

| minuto 15 | n | final méd | duração méd | kills/min do resto |
|---|---|---|---|---|
| \|gd\| <1,5k | 132 | 30,6 | 34,2 | 1,24 |
| \|gd\| 1,5-3k | 81 | 29,0 | 32,6 | 1,21 |
| \|gd\| 3-5k | 52 | 30,4 | 30,3 | 1,36 |
| \|gd\| 5k+ | 22 | 30,6 | 29,3 | 1,33 |

`corr(|gd|@15, total de kills) = +0,014` — **zero**. `corr(|gd|@15, duração) = −0,352`. `corr(|gd|@15, ritmo do resto) = +0,131`.

**Os dois efeitos se anulam exatamente:** vantagem grande encurta o jogo (~5 minutos a menos) e ao mesmo tempo acelera a matança (massacre). O total fica igual. Nenhum dos dois sinais domina — **gold diff não é sinal de kills**. Contra a linha real também não separa nada (min 15: <2k → under 33,3% n=36; 4k+ → 55,6% n=9).

Mesmo resultado no minuto 10: `corr(|gd|, final) = −0,016`.

---

## 5. H4 — VALE ESPERAR? **Não. É o achado principal, e ele é robusto.**

Comparação nos **MESMOS mapas**: linha PRE (última leitura pré-mapa) × linha LIVE no minuto M, ambas Betby (mesmo livro), liquidando com a odd de cada momento.

| minuto | grupo | n | PRE under% / ROI | LIVE under% / ROI | Δ linha |
|---|---|---|---|---|---|
| 3 | Milio | 15 | 80,0% / +50,9% | 66,7% / +26,6% | −3,13 |
| 5 | Milio | 18 | 77,8% / +46,3% | 61,1% / +17,1% | −3,67 |
| 8 | Milio | 18 | 77,8% / +46,3% | 61,1% / +15,1% | −4,22 |
| **10** | **Milio** | **17** | **76,5% / +43,9%** | **58,8% / +10,7%** | **−4,29** |
| 15 | Milio | 12 | 75,0% / +42,8% | 66,7% / +27,1% | −3,25 |
| 10 | trigger | 34 | 70,6% / +33,2% | 52,9% / −0,1% | −3,00 |
| 15 | trigger | 25 | 68,0% / +28,8% | 56,0% / +6,4% | −3,04 |
| 10 | todos | 83 | 55,4% / +4,7% | 47,0% / −11,1% | −1,12 |
| 15 | todos | 60 | 51,7% / −1,5% | 41,7% / −20,7% | −1,22 |

**Varredura completa: 7 minutos × 3 grupos = 21 células. Em 20 delas esperar é PIOR.** A única exceção (Milio, minuto 12, n=15) empata dentro de 1pp. O resultado se repete idêntico usando a Pinnacle como linha PRE em vez da Betby — não é artefato de comparar livros diferentes.

**Mecanismo:** o livro re-precifica o draft de peel assim que o mapa começa. Nos mapas de Milio a linha cai **4,3 kills** entre o pré e o minuto 10 (28,8 → 24,5). O seu edge inteiro está nesse intervalo. E o movimento é assimétrico: em mapas sem trigger a linha praticamente não se mexe (Δ +0,22).

### Os 17 mapas de Milio, um a um (05/08–23/08)

| data | liga | mapa | linha PRE | linha @10 | kills@10 | final | PRE | LIVE@10 |
|---|---|---|---|---|---|---|---|---|
| 15/08 | LCK | m2 | 29,5 | 29,5 | 7 | 19 | GREEN | GREEN |
| 15/08 | LEC | m2 | 29,5 | 26,5 | 5 | 24 | GREEN | GREEN |
| 15/08 | CBLOL | m3 | 27,5 | 27,5 | 4 | 19 | GREEN | GREEN |
| 15/08 | LCP | m3 | 27,5 | 24,5 | 2 | 20 | GREEN | GREEN |
| **16/08** | **LEC** | **m1** | **27,5** | **24,5** | 3 | **26** | **GREEN** | **RED** |
| 17/08 | LEC | m2 | 27,5 | 21,5 | 0 | 10 | GREEN | GREEN |
| 17/08 | LEC | m2 | 27,5 | 20,5 | 1 | 15 | GREEN | GREEN |
| 18/08 | LFL | m2 | 29,5 | 22,5 | 4 | 17 | GREEN | GREEN |
| **19/08** | **Prime** | **m1** | **34,5** | **25,5** | 2 | **30** | **GREEN** | **RED** |
| 20/08 | NACL | m1 | 28,5 | 24,5 | 1 | 15 | GREEN | GREEN |
| 21/08 | LCP | m1 | 28,5 | 24,5 | 8 | 31 | RED | RED |
| **21/08** | **NACL** | **m1** | **34,5** | **22,5** | 0 | **29** | **GREEN** | **RED** |
| 22/08 | LCK | m3 | 25,5 | 23,5 | 3 | 26 | RED | RED |
| 22/08 | LCK | m1 | 27,5 | 26,5 | 7 | 35 | RED | RED |
| 22/08 | LEC | m1 | 27,5 | 22,5 | 1 | 12 | GREEN | GREEN |
| 22/08 | LCS | m1 | 28,5 | 21,5 | 1 | 30 | RED | RED |
| 23/08 | LCK | m2 | 28,5 | 28,5 | 6 | 24 | GREEN | GREEN |

**13/17 (76,5%) pós-draft × 10/17 (58,8%) no minuto 10.** Três mapas viraram GREEN→RED só pela queda da linha, e em nenhum o caminho inverso aconteceu.

**Em R$, a 4u = R$4.000/mapa:** PRE **+R$29.840** × LIVE@10 **+R$7.280**. **Custo de esperar: −R$22.560 em 9 dias** (~R$2.500/semana no ritmo atual de oferta do Milio).

No conjunto trigger (34 mapas, a 1u = R$1.000): +R$11.288 pós-draft × −R$34 no minuto 10.

---

## 6. H5 — LATÊNCIA DE FEED: **não é mensurável com o dado que guardamos**

Só medição, sem recomendação de automação (conforme o brief).

- `game_frames` guarda **1 linha por minuto**. O feed da Riot (`livestats/v1/window`) publica frames de **10 em 10 segundos**, mas nós descartamos essa granularidade na escrita.
- A coleta Betby roda a **60s** (medido: p25=60,0s, p50=60,0s, p75=120,0s entre leituras com linha).

**A resolução do instrumento (60s) é mais grossa que o fenômeno que a pergunta quer medir.** Qualquer número em segundos que eu desse aqui seria invenção.

O que dá pra dizer na resolução de 1 minuto (644 pares minuto-a-minuto, 125 mapas): covariância entre Δlinha(t) e Δkills(t+lag) —

| lag | −2min | −1min | **0** | +1min | +2min |
|---|---|---|---|---|---|
| cov | −0,146 | −0,102 | **+0,154** | +0,047 | −0,216 |

A linha se move **no mesmo balde de minuto** do kill. O lag +1 (linha andando antes do kill) é fraco e não separa de ruído; os lags negativos são negativos, ou seja o movimento de linha reverte parcialmente — o livro corrige overshoot. **Conclusão: não há evidência de janela explorável, e principalmente não há instrumento pra achá-la.** Pra responder essa pergunta de verdade precisaria gravar frames de 10s + polling de odds sub-minuto (seção 7).

---

## 7. Dinheiro real: as bets AO VIVO que já existem

Identificação por marca textual nas `notes` (**não existe campo estruturado de fase da bet** — ver lacunas). Excluídas SIMULATED.

| Recorte | n | hit | PnL | ROI |
|---|---|---|---|---|
| Todas as live liquidadas | 48 | — | **+R$16.966** | 36,2% |
| Kills O/U ao vivo | 35 | 27 green | **+R$15.274** | 41,8% |
| — under ao vivo | 20 | 65,0% | +R$5.608 | 24,0% |
| — over ao vivo | 15 | **93,3%** | +R$9.666 | 73,7% |
| Outros (ML, punt) | 13 | — | +R$1.692 | 16,4% |
| Pendentes hoje (23/08, FEARX×NS m2) | 5 | — | exposição R$6.800 | — |

Leitura seca: o live discricionário do Elvis está no lucro, mas 14/15 no over com n=15 é seleção humana, não regra — e é **a direção oposta** do under que o dataset diz ser armadilha. Isso é coerente: as bets over live que ele fez foram em jogos já sangrentos, com linha atrás do placar. Ver seção 8.

---

## 8. O que sobrevive, o que morreu, e a régua

### 8a. SOBREVIVE — regra operável (custo zero, sem stake novo)

> **Regra 1 — não espera.** O under do método entra **pós-draft / na abertura do mapa**. Cada minuto de espera custa linha: −3,0 kills até o minuto 10 no trigger, −4,3 no Milio. 20 de 21 recortes minuto×grupo confirmam. Em dinheiro medido: R$22.560 em 9 dias nos 17 mapas de Milio.
>
> **Regra 2 — under ao vivo FORA do trigger é veto.** Sem trigger, no minuto 15: **31,4% de hit, ROI −40,1% (n=35, p=0,041)** — a pior célula de todo o levantamento. Com trigger, 56,0%. Se perdeu a janela pré-mapa num jogo sem trigger, o under ao vivo não é consolo, é sangria. (O p não sobrevive à multiplicidade, mas é um **negativo** — respeitar custa zero e ignorar custa dinheiro.)
>
> **Regra 3 — teto de horário.** Não existe plano que dependa de apostar depois do minuto ~20: a Betby fecha o mercado de kills do mapa em p50 = minuto 15, máximo observado 22. A Pinnacle já fecha antes. Qualquer desenho de "esperar o jogo definir" está morto por falta de mercado, não por falta de edge.

### 8b. OBSERVAÇÃO (não é aposta) — over em jogo já sangrento

| regra | n | over% | ROI | p bruto |
|---|---|---|---|---|
| OVER se kills@10 ≥ 7 | 17 | 76,5% | +41,6% | 0,049 |
| OVER se kills@15 ≥ 9 | 20 | 65,0% | +23,3% | 0,263 |
| OVER se kills@8 ≥ 6 | 13 | 76,9% | +43,7% | 0,092 |
| **união (kills@10≥7 OU kills@15≥9)** | **27** | **70,4%** | **+30,0%** | **0,052** |
| — descoberta ≤19/08 | 12 | 58,3% | +7,5% | — |
| — confirmação ≥20/08 | 15 | 80,0% | +48,0% | — |

Mecanismo plausível e coerente com o resto: no minuto 15 com 12+ kills o livro concede slack 17,0 quando o resto real é 21,8 — **ele assume que massacre acaba rápido, e o dado de H3 diz que não acaba: a duração cai mas o ritmo sobe e o total fica igual.**

**Por que NÃO promover:** n=27 (<30, é observação por regra da casa) · p bruto 0,052 já não passa nem sem correção · **146 células inferenciais testadas neste relatório → Bonferroni exige p<0,00034**, não chega perto · a metade de descoberta (58,3%) é fraca e só a confirmação é forte, o que é o padrão típico de ruído · e o mercado fecha justamente na janela em que a regra dispara. Gate proposto se o Elvis quiser acompanhar: **n≥50 mapas com piso ≥62%**, contagem passiva, sem stake.

### 8c. MORREU (e por quê)

| Hipótese | Status | Causa da morte |
|---|---|---|
| **Under ao vivo em estado de jogo lento** | ❌ MORTO | Contra a linha real: 47,6% (min 10) / 41,7% (min 15), BE 57,1%. A casa já derrubou a linha. Nenhuma célula com n≥30 acima do BE. |
| **"Jogo lento explode no late"** (justificativa pra fugir do under live) | ❌ MITO | Resto é ~constante (25,5 no min 10, 21,5 no min 15) e a correlação com o placar é +0,10 a +0,15 — persistência fraca, **nunca reversão**. O under live não é armadilha por explosão; é armadilha por preço. |
| **Gold diff / objetivos como sinal de kills** | ❌ MORTO | corr(\|gd\|@15, total) = +0,014. Encurta o jogo (−0,35 na duração) e acelera a matança (+0,13 no ritmo) — se anulam. |
| **Esperar o minuto 10 pra apostar melhor** | ❌ MORTO, com R$ | 20/21 células dizem que é pior. −R$22.560 em 17 mapas de Milio. |
| **Fade do movimento da linha live** (entrar contra Δlinha) | ❌ MORTO | 12 células, nada com p<0,18. Δ≥+2 no min 15: over 71,4% mas n=14; Δ≤−3: nada. É a seção 8b re-embalada, não sinal novo. |
| **Slack do livro como sinal** | ❌ MORTO | Erro médio do livro no resto: +0,9 kill (min 10), +1,3 (min 15) — dentro do vig. Melhor bucket tinha n=9. |
| **Janela de latência feed→linha** | ⬜ NÃO TESTÁVEL | Resolução do nosso dado = 60s; o fenômeno vive abaixo disso. Não inventei número. |

### 8d. Multiplicidade — contabilidade completa

**146 células inferenciais declaradas** (com hit%/ROI/p): H1a estado×minuto 14 · H1b slack 14 · H1c estado×split temporal 18 · H3b gold 5 · H4 grupos 6 · H4 pré×live 2 livros 20 · H4 varredura 7 minutos × 3 grupos 21 · H4b fade 12 · regras over 18 · robustez lead≤30/60 18. Mais ~48 células descritivas (correlações, quartis, distribuições) sem claim.

**Menor p bruto de todo o levantamento: 0,039** (over kills@10≥7 na confirmação, n=9). Limiar Bonferroni: **0,00034**. **Nenhum achado positivo sobrevive à multiplicidade.** Os achados que reporto como "sobrevivem" (seção 8a) não dependem de p: são (i) uma comparação pareada nos mesmos mapas com direção unânime em 20/21 recortes e mecanismo medido (a linha cai), e (ii) um limite físico de disponibilidade de mercado.

**Split out-of-sample — limitação honesta:** todo o dado ao vivo cabe em **19 dias**. O split que usei (descoberta ≤19/08 × confirmação ≥20/08) deixa 12 × 15 mapas na melhor célula. Isso é uma checagem de consistência, **não é out-of-sample de verdade**. Não existe período antigo pra descobrir e período recente pra confirmar — a captura só nasceu em 13/08.

---

## 9. O que falta de infra/dado pra operar isso de verdade

Ordenado por quanto trava a decisão.

1. **`link-odds-to-riot.cjs` parou de rodar em 15/08.** No banco só há **210 rows** com `riot_game_id`; sobram **3.070 rows de odds ao vivo (94%) sem link**. Eu refiz a linkagem em memória (248 séries, 157 mapas — validado 207/207 contra o que o linker gravou), mas **nada disso está persistido**. O script não está no cron. Sem isso, toda análise futura de live começa do zero. *É a lacuna nº1 e é barata de fechar.*
2. **`underkill/data/` está congelado em 13/08** (3.742 linhas / 106 mapas) enquanto o banco já tem 11.705 frames / 332 mapas. `build-dataset.cjs` precisa rodar depois do linker, também no cron.
3. **Não existe flag estruturada de bet ao vivo.** A tabela `bets` não tem `is_live`/`bet_phase`/`game_minute_at_bet`. Os R$16.966 da seção 7 saíram de grep em `notes` — número indicativo, não auditável. Sem esse campo é impossível medir PnL live × pré separadamente, que é justamente a decisão que este relatório levanta.
4. **Granularidade de 60s impede a pergunta de latência.** Pra respondê-la precisaria gravar os frames de 10s do `livestats/v1/window` (o feed já entrega, nós agregamos por minuto na escrita) **e** baixar o polling da Betby pra ~10-15s. Custo: mais requests e mais linhas. **Não recomendo ligar isso agora** — a pergunta que ele responde só vira dinheiro se houver execução automatizada, que está fora de escopo por decisão sua.
5. **Amostra curta:** 287 mapas / 19 dias. Nenhuma célula live com trigger passa de n=34; Milio ao vivo é n=17. Pra qualquer promoção de regra live é preciso ~2-3 meses de coleta contínua. O gargalo é tempo, não código.
6. **Só uma casa serve de referência de linha ao vivo** (Betby, mercado 726) — e ela fecha no minuto ~15-20. Pinnacle está fora (mercado fechado ao vivo). Se o Elvis quiser mercado ao vivo mais longo, isso é pesquisa de **casa**, não de método: mapear quem mantém total de kills do mapa aberto depois do minuto 20.
7. **45 dos 332 mapas com frames não têm `final_kills`** (37 `feed_dead`, 5 `live`, 3 `abandoned`) — excluídos aqui, mas é ~13,6% de perda estrutural do feed da Riot.

---

## 10. Hipóteses testadas (pré-registro cumprido)

| # | Hipótese do brief | Testada? | Resultado |
|---|---|---|---|
| 1 | Estado aos 10/15/20min → distribuição do total; existe estado com margem contra a **linha real**? | ✅ 46 células | **Não.** Under 47,6%/41,7% contra a linha real. Minuto 20 é intestável (25 mapas com linha, mercado fechando). |
| 2 | Ritmo prevê o total? Estável ou reverte? | ✅ 7 minutos + 8 quartis | **Persistência fraca, zero reversão.** Resto ≈ constante. O under live não é armadilha por explosão, é por preço. |
| 3 | Gold diff → fecha rápido ou vira massacre? Qual domina? | ✅ 7 buckets + 5 células com linha | **Nenhum domina — se anulam.** corr com total = +0,014. |
| 4 | Dentro do Milio/trigger, esperar o minuto 10 adiciona? | ✅ 21 células pareadas + 20 de robustez | **Não. Esperar é pior em 20/21.** −R$22.560 medidos. |
| 5 | Latência feed × linha, em segundos | ⬜ Não mensurável | Resolução do dado = 60s. Só medi e reportei; nada implementado, nada recomendado. |

---

## Rastreabilidade

Fontes: Supabase `game_frames` (11.705 rows), `game_drafts` (8.956), `odds_timeline` (10.659), `bets` (1.296), `capture_runs` (18.025, filtro `betby*` = 7.339 heartbeats). Linkagem odds↔Riot refeita **em memória** com a mesma lógica de `link-odds-to-riot.cjs` (`normalizeTeam` + janela de 36h + `game_number`==`map_number`, ambiguidade = skip), validada 207/207 contra o linker oficial.

**Nenhuma escrita no banco. Nenhum arquivo do repo alterado além deste relatório.** Scripts de análise reproduzíveis em `scratchpad/live/` (`link.cjs`, `panel.cjs`, `h1.cjs`, `h2.cjs`, `h4.cjs`, `h5.cjs`, `h6.cjs`).

Convenções respeitadas: hit por **MAPA** · sem SIMULATED · BE real 57,1% (odd 1,75) · liquidação sempre com a **odd real da leitura**, nunca com odd assumida · linha **real ofertada no instante**, nunca mediana histórica · n<30 = observação · multiplicidade declarada e aplicada.
