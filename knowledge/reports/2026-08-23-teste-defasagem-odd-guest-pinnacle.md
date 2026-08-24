# A odd guest da Pinnacle está defasada? — teste sem login

**Data:** 2026-08-23
**Pergunta:** a odd pública da Pinnacle (API guest, sem login) chega atrasada em relação à que um usuário logado vê? Suspeita registrada em 07/08, nunca testada.
**Restrição:** resolvido SEM login, sem conta nova, sem tocar em script de produção, sem escrita no banco.
**Testes/células contadas nesta rodada: 61.** Detalhe da multiplicidade na seção 7.

---

## Conclusão em uma frase

**Sim, a odd guest chega velha — mas não porque a Pinnacle esconde odd de quem não está logado, e sim porque o endpoint público é servido de um cache que só troca de conteúdo a cada 15 minutos. E isso é o menor dos problemas: a fair que a operação realmente usa tem, no momento do jogo, 30 minutos de idade na mediana e 2 horas na média — o atraso que a própria coleta cria é 2 a 4 vezes maior do que o atraso que o feed impõe.**

O número que fecha o caso: **84% dos intervalos entre mudanças de linha da Pinnacle caem em múltiplos exatos de 905 segundos** (contra ~24% esperados por acaso), com 61% concentrados na faixa de 15–16 minutos. 905s é literalmente o `max-age` do `Cache-Control` que o endpoint devolve. A linha não "anda devagar" — ela é **amostrada** de 15 em 15 minutos.

**Criar segunda conta é a alavanca errada.** Ela atacaria, na melhor das hipóteses, a camada de 15 min — e só se o feed logado for mais fresco, o que continua não testado. Não atacaria os 30 min de grade da coleta, que são de graça pra consertar.

---

## 1. Veredito direto

| Pergunta | Resposta | Número que sustenta |
|---|---|---|
| A leitura guest é velha? | **SIM** | `Cache-Control: public, max-age=905` medido em 4 endpoints; `Age` observado até **891s** |
| O atraso é um gate contra deslogado? | **NÃO ACHEI EVIDÊNCIA** | 40 pares cache×origem forçada, **0 divergências** (seção 3) |
| A linha de fechamento guest é mal calibrada? | **NÃO** | viés kills−linha = **−0,27 ± 1,57** (n=124) — IC inclui zero |
| A Betby é fair melhor? | **NÃO — empate** | pareado n=25: Δ\|erro\| = **+0,32 ± 0,63**, t=1,00 |
| A operação perde dinheiro com isso? | **Pouco, e na direção conservadora** | ~R$8 mil de *edge não reivindicado* em 19 dias (seção 5) |
| O gargalo real é o feed? | **NÃO — é a grade de coleta** | fair usada tem mediana de **30 min** e média de **117 min** de idade |

Distinção que preciso fazer com todas as letras: **consegui provar que existe defasagem de até 15 min no feed guest, e consegui NÃO achar evidência de que ela seja diferente pra quem está logado.** A segunda coisa é mais fraca que a primeira. "Não achei" ≠ "provei que não há" — o teste que fecharia isso está na seção 8.

---

## 2. A prova do congelamento: a linha é amostrada, não lenta

### 2.1 Cadência de mudança, fontes com poll idêntico de 60s

`capture_runs` confirma que Pinnacle (`pc-live`, `gha-live`) e Betby (`betby-*`) **fazem poll na mesma cadência: mediana de 60s, p10=60s, p90=60s.** Isso mata a ressalva de "o lag observado é dominado pela frequência de amostragem" — as duas fontes são amostradas igual. O que diverge é o que elas devolvem.

Intervalo entre mudanças de `content_hash`, só linhas de kills, só fontes de 60s:

| fonte | n gaps | ≤120s | ≤300s | ≤600s | ≤900s |
|---|---|---|---|---|---|
| **Pinnacle guest** | 1.419 | **0,2%** | 1,1% | 5,1% | 11,4% |
| **Betby** | 2.976 | **52,4%** | 76,5% | 81,8% | 84,9% |

A Betby muda a linha dentro de 2 minutos em metade das vezes. A Pinnacle guest faz isso em **3 casos de 1.419**.

### 2.2 O histograma entrega o mecanismo

Distribuição dos gaps da Pinnacle, bucket de 1 minuto (n=1.419):

| gap | n | % | |
|---|---|---|---|
| 1–14 min | 159 | 11,2% | (cauda) |
| **15 min** | **598** | **42,1%** | ████████████ |
| **16 min** | **272** | **19,2%** | ██████ |
| 17–29 min | 45 | 3,2% | |
| **30–31 min** | **146** | **10,3%** | ███ |
| **45–46 min** | **56** | **3,9%** | █ |
| resto | 143 | 10,1% | |

Três picos, em 1×, 2× e 3× de ~15 minutos. Isso não é um livro reprecificando — é um relógio.

**Teste formal de quantização:** 84% dos gaps caem a menos de 12% de um múltiplo inteiro de 905s. Por acaso, o esperado seria ~24%. Não é sutil e não depende de multiplicidade.

### 2.3 De onde vem o 905

Medido hoje, direto no header de resposta do endpoint guest (`guest.api.arcadia.pinnacle.com/0.1`, mesmo que o coletor já usa):

| endpoint | Cache-Control | Age observado |
|---|---|---|
| `/matchups/{id}/markets/related/straight` (**é onde estão os preços**) | `public, max-age=905, must-revalidate` | 0 → **891s** |
| `/matchups/{id}` | `public, max-age=905, must-revalidate` | 0 → 858s |
| `/sports/12/matchups?withSpecials=true` | `public, max-age=875, must-revalidate` | **771s** |
| `/sports/12/matchups/live` | `public, max-age=905, must-revalidate` | 0 |

`server: cloudflare`, `cf-cache-status: HIT`. Exemplo cru capturado às 15:48:57 UTC: `Last-Modified: 15:37:06`, `Age: 715` — **o payload servido tinha 11min51s de idade.**

Ciclo completo flagrado ao vivo em `probe8`: matchup 1634213478 às 15:58:28 com `Age=866s`; às 15:59:08 virou `cf-cache-status: EXPIRED`, `Age=0`, e a versão do mercado mudou. 866 + 40 = 906s. É o TTL.

**Consequência:** o coletor bate de 60 em 60 segundos e recebe **o mesmo objeto 15 vezes seguidas**. Qualquer movimento de linha dentro da janela é invisível — só o líquido sobrevive. A idade média de uma leitura qualquer é ~452s (7,5 min); o teto é 905s.

### 2.4 Confirmação independente pelo relógio do jogo

Evento com relógio próprio (`game_frames` → `last_frame_utc` = fim do mapa N). Quanto demora até cada casa mexer a linha do mapa N+1?

| fonte | n | mediana | p25 | p75 | **p90** | média |
|---|---|---|---|---|---|---|
| **Pinnacle guest** | 79 | **7,7 min** | 4,0 | 12,6 | **14,8 min** | 8,3 ± 1,1 |
| **Betby** | 23 | **2,5 min** | 1,9 | 13,1 | 16,0 | 6,1 ± 2,6 |

O p90 da Pinnacle bate em **14,8 min e para** — teto duro, exatamente o TTL. E a mediana de 7,7 min é o que um offset uniforme em 0–905s prediz (7,54 min). Não é um livro que demora: é uma amostragem que esconde.

Diferença de médias: 2,2 min, t=1,52 — **não significativo** com esse n. A mediana e o formato da distribuição são o achado, não o teste de média.

---

## 3. O atraso NÃO é um gate contra deslogado (evidência interna)

Se a Pinnacle servisse dado velho **de propósito** pro guest, furar o cache não adiantaria — mas o teste inverso adianta: se o cache do Cloudflare fosse o único culpado, uma requisição que **fura o cache** (chave nova → `cf-cache-status: MISS` → busca na origem) devolveria dado mais novo que a cópia cacheada.

Rodei isso 80 vezes, em 2 experimentos paralelos (pré-jogo e com um mapa de LEC ao vivo), pareando cada leitura cacheada com uma leitura de origem forçada:

| experimento | amostras | cache ≠ origem | Age mediano / máximo do lado cacheado |
|---|---|---|---|
| probe8 (pré-jogo, 2 matchups, 14 min) | 44 | **0** | 452s / 891s |
| probe10 (com LEC ao vivo, 2 matchups, 11 min) | 42 | **0** | 456s / 889s |

O `Age` mediano de **452s** é, com uma casa decimal, a metade exata do TTL de 905s — a assinatura de amostragem uniforme sobre um cache de 15 min.

Incluindo **8 leituras com `cf-cache-status: MISS` confirmado** (ida real à origem) contra cache de 412s a 667s de idade: **versão e preços idênticos em todas.**

**Leitura:** a origem do tier guest não tem nada mais novo pra dar. O snapshot inteiro se regenera junto com o TTL. **Furar cache não resolve** — não existe atalho de engenharia pra ganhar frescor sem login.

⚠️ **O que isso NÃO prova:** que o feed logado seja igual. Se a Pinnacle mantém um tier guest inteiro que é uma réplica de 15 min, meu teste veria exatamente o que viu — cache e origem concordando, ambos velhos. Essa hipótese sobrevive e só cai com comparação logado×deslogado (seção 8).

⚠️ **Tentativa que falhou:** cache-buster com parâmetro arbitrário (`?_cb=...`) devolve **HTTP 204 vazio**. Só `withSpecials` e `primaryOnly` são aceitos, o que dá 4 chaves de cache — todas viram HIT depois do primeiro uso. Uma rodada anterior marcou "8/8 divergiu" e era **artefato do 204**; está corrigido aqui. Registro porque é o tipo de erro que se repete.

---

## 4. A calibração — a prova mais próxima do dinheiro

Se a guest fosse lixo defasado, ela erraria mais que a Betby. Base: última leitura de cada fonte antes do início do mapa (`game_drafts.first_frame_utc` pra mapas 2+), contra kills reais.

| conjunto | n | viés (kills−linha) | MAE | Brier | logloss | P(under) prevista → real | vig |
|---|---|---|---|---|---|---|---|
| Pinnacle guest, todas | **124** | **−0,27 ± 1,57** | 6,76 | 0,2521 | 0,6974 | 50,4% → 55,6% | 7,2% |
| Betby, todas | 35 | +0,61 ± 3,29 | 7,41 | 0,2517 | 0,6965 | 49,7% → 62,9% | 6,0% |
| Pinnacle, idade ≤30min | 105 | −0,25 ± 1,77 | 6,87 | 0,2511 | 0,6954 | 50,4% → 55,2% | 7,2% |
| Betby, idade ≤30min | 25 | +0,50 ± 4,19 | 7,98 | 0,2526 | 0,6984 | 49,6% → 60,0% | 5,7% |

**Pareado — mesmos 25 mapas, as duas casas:**

| | viés | MAE | Brier |
|---|---|---|---|
| Pinnacle | −0,22 ± 4,10 | 7,30 | 0,2584 |
| Betby | −0,42 ± 3,89 | 6,98 | 0,2503 |

- **Δ\|erro\| (Pinnacle − Betby) = +0,32 ± 0,63, t = 1,00** → indistinguível. A Betby aparece 0,32 kill melhor e isso é ruído.
- **linha Pinnacle − linha Betby = −0,20 ± 0,67** → sem offset sistemático. Uma fonte defasada 15 min contra uma fonte viva deveria mostrar viés de linha. Não mostra.
- Linha idêntica nas duas casas em só 3/25 mapas (12%) — elas discordam bastante, mas nenhuma discorda *do resultado* de forma sistemática.

⚠️ **n=25 no pareado é observação, não conclusão.** O que tem n de verdade é o viés da Pinnacle sozinha (n=124, IC inclui zero).

---

## 5. Quanto custa em R$

### 5.1 O que o refresh de 15 min esconde

Deriva da linha Pinnacle nos 15 minutos finais antes do mapa (n=139 mapas):

| \|deriva\| | mapas | % |
|---|---|---|
| 0 kills | 107 | **77%** |
| 1 kill | 15 | 11% |
| 2 kills | 15 | 11% |
| 3–4 kills | 2 | 1% |

Média de \|deriva\| = **0,374 kills**. Em 77% dos casos a janela cega não escondeu nada.

Com sd de kills = 9,17 (n=124), a densidade na linha é **4,35pp de probabilidade por 1 kill**. Logo 0,374 kills ≈ **1,63pp de ruído** na fair.

### 5.2 Existe um viés, e ele é conservador

Deriva **assinada** nos 15 min finais: **−0,230 ± 0,136 kills (t = −3,31, n=139)**. A linha da Pinnacle **cai** perto do início do jogo. Sobrevive a Bonferroni sobre as 18 células desse bloco (seção 7). Vem dos mapas 2+ (−0,321, t=−2,83); no mapa 1 é −0,115, não significativo.

Direção do estrago — e aqui a notícia é boa: a fair usada é a leitura **antiga**, ou seja, ~0,23 kill **mais alta** que a linha verdadeira no apito. Numa operação que aposta **UNDER em 877 de 1.028 bets identificáveis**, uma fair inflada torna o critério `linha ofertada ≥ fair` **mais difícil** de satisfazer. O erro **nunca fez uma bet parecer melhor do que era** — fez algumas boas parecerem ruins.

### 5.3 O número

Base real: **360 bets de 05/08 a 23/08, stake R$426.929,48, odd média 1,868, stake média R$1.185,92, PnL +R$107.460,53 (ROI 25,17%)**.

Sensibilidade: `dEV/dp = odd × stake = R$2.215 por 100pp` → **R$22,15 por 1pp por bet**.

| cenário | conta | R$ em 19 dias |
|---|---|---|
| Teto absurdo (toda a deriva sempre contra) | 1,63pp × R$22,15 × 360 | R$ 12.985 |
| **Estimativa realista** (só os 23% de mapas com deriva ≥1 kill, metade contra) | 0,115 × 4,35pp × R$22,15 × 360 | **≈ R$ 3.995** |
| Custo do **viés** de 0,23 kill (edge subestimado, direção conservadora) | 1,00pp × R$22,15 × 360 | ≈ R$ 7.974 (faixa R$2,9k–R$12,7k) |

**Como ler isso:** não é R$8 mil perdidos. É R$8 mil de **edge que a operação tinha e não reivindicou** — porque a fair inflada fez o filtro ficar mais duro do que precisava. Contra R$107 mil de lucro realizado no período, é ~7% de margem deixada na mesa, **na direção segura**. Não é sangramento; é freio de mão puxado.

---

## 6. E o mercado ao vivo? (o eixo underkill livebet)

Aqui a diferença é grande e o cache explica só parte dela.

Leituras da linha do mapa **enquanto o mapa está rodando** (janela: início+5min → fim):

| fonte | mapas | mapas com ≥1 leitura in-play | leituras in-play | **leituras por mapa** |
|---|---|---|---|---|
| Pinnacle guest | 129 | 51 (40%) | 76 | **0,59** |
| Betby | 40 | 32 (80%) | 224 | **5,60** |

**9,5× de diferença.** Se o cache de 905s explicasse tudo, a Pinnacle daria ~2 leituras por mapa de 30 min; ela dá 0,59. Ou seja: parte é cache, parte é a Pinnacle simplesmente não reprecificar kills ao vivo com a agressividade da Betby.

Observação de hoje que reforça (n=2 séries — **é observação, não conclusão**): no LEC ao vivo (Heretics × GIANTX, 23/08 16:00 UTC), o matchup de Kills `1634268773` tinha aberto só `s;2;ou;25.5` e `s;3;ou;25.5` — **mapas 2 e 3**. Nenhum mercado de kills pro mapa em andamento. Nos 61 dumps crus de 14/08 (`cron-data/diag-live-kills/`) o padrão é o mesmo: os mercados `s;1` somem quando o mapa 1 começa, sobram os do próximo mapa, todos com `status: "open"` e preço parado por 16 ticks de 60s seguidos.

⚠️ Isso também significa que **`phase='live'` no `odds_timeline` engana**: o coletor deriva a fase do `isLive` da **série**, não do mapa (`capture_pinnacle_to_supabase.cjs:265` e o equivalente na Betby). Uma linha marcada `live` pro mapa 3 é, quase sempre, uma linha **pré-jogo** do mapa 3 enquanto o mapa 1 roda. Qualquer análise futura de "linha ao vivo" tem que corrigir isso antes de concluir qualquer coisa.

---

## 7. O gargalo real: a fair da operação tem 30 minutos de idade

Esse achado é maior que a pergunta original.

A fair primária vem de `promote_fair_pinnacle_auto.cjs`, que promove a captura do `LolFairAutoCapture` (**Task Scheduler, a cada 30 min**), congelando (`frozen=true`) a última leitura pré-jogo. Cada entrada carimba a própria idade em `source_note`.

**198 entradas em 19 arquivos promovidos (05/08 → 23/08).** Idade da fair no momento do jogo:

| faixa | n | % |
|---|---|---|
| 0–15 min | 5 | **2,5%** |
| 15–30 min | 20 | 10,1% |
| **30–60 min** | **107** | **54,0%** |
| 60–120 min | 17 | 8,6% |
| 120–240 min | 4 | 2,0% |
| 240–480 min | 32 | 16,2% |
| 480+ min | 10 | 5,1% |

**Mediana 30 min · média 117 min (2,0 h) · p90 390 min (6,5 h) · máximo 1.110 min (18,5 h).**
Só **2,5%** das fairs são mais frescas que os 15 min do cache. Exemplo real de hoje: `minutes_before_start=510` (8,5 h) numa LPL.

**A conta da defasagem total:** 30 min de grade de coleta + ~7,5 min de cache = ~37 min na mediana. **O cache é ~20% do problema.** Os outros 80% são grade de 30 min e jogos em que a grade nunca chegou perto do apito.

Segunda conta que decide o assunto: logar resolveria, na melhor hipótese, os 7,5 min. **Rodar a captura mais perto do apito resolve os 30 min, é de graça, não viola regra nenhuma do Elvis e não mexe na conta em disputa.**

⚠️ Não estou propondo mudança — isso é diagnóstico. Mexer no `LolFairAutoCapture` é decisão do Elvis.

---

## 8. Evidência externa (5 buscas, hierarquia explícita)

### FATO DOCUMENTADO
- **Nada.** A Pinnacle não documenta em lugar nenhum delay pra deslogado. Varri doc oficial da API (github.com/pinnacleapi/pinnacleapi-documentation), help center e T&C.
- O que a doc **diz**: acesso exige conta *funded*; a API está **fechada ao público desde 23/07/2025**; rate limit oficial de **1 request / 2 min por endpoint por sportId**. Ou seja, mesmo o cliente pagante e compliant opera com dado de até 2 min. Nada sobre cache ou feed diferenciado.
- **Armadilha:** vi vendor citando o T&C ("no warranty as to timeliness") como prova do delay. É boilerplate de isenção presente em qualquer casa. **Não conta.**

### RELATO DE FÓRUM / TERCEIRO
- **O mais sólido:** thread do SBR (jan/2023) onde dois devs que consomem `guest.api.arcadia.pinnacle.com` chamam ele de *"the Arcadia delayed one"*. Nenhum mediu nada nem atribuiu ao login. **Uma thread, dois posters.**
- Arbusers: *"Pinnacle refreshes odds once every 21 seconds for live and 70 seconds for pre-match on their website, whereas their API refreshes at 5 seconds."* Mecanismo **diferente** (cadência de site vs API), vale pra logado e deslogado. Se for real, não explica meus 905s.
- Três threads do SBR com o título sendo literalmente a pergunta ("Pinnacle Delaying Lines when not logged in?"). Duas dão 301; a que abriu **tem a pergunta e zero respostas**. A crença circula há anos sem ninguém fechar.

### VENDOR — DESCONTAR PESADO
- Pinnacle Odds Dropper, pinnapi, SharpAPI e sportsgameodds repetem quase palavra por palavra: *"logged-in users with funded accounts receive real-time odds; the public-facing odds come with a delay."* **Zero citação, zero número, zero fonte.** Todos vendem acesso "real-time" à Pinnacle. É copy de venda.

### SEM FONTE / MITO
- "O delay é de 30 segundos" — número circula, nenhuma página sustenta.
- Surebet listando "Pinnacle888 (Delayed)" — abri: é o **tier comercial da Surebet** (feed barato vs caro), não característica da Pinnacle. Não usar como prova.

### O PRECEDENTE QUE IMPORTA
- **A Betfair faz exatamente isso, e é oficial:** atraso variável de **até 3 minutos** no Exchange pra quem não está logado, em web, mobile **e API**; pra ter odd atual precisa estar logado **e** ter conta já *funded*; motivo declarado é **dificultar scraping**. Anúncio de jun/jul 2017.
- Isso prova que a prática **existe na indústria** e torna a hipótese plausível pra Pinnacle. **Não prova nada sobre a Pinnacle.** Desconfio que boa parte do folclore seja contaminação do caso Betfair — a estrutura do claim dos vendors ("logado + funded = real time") é idêntica à regra da Betfair.

### Argumento de negócio contra a tese
O modelo da Pinnacle é margem baixa (1,5–3%) e volume, usando aposta de sharp pra afiar a própria linha. Servir odd **diferente** por perfil destruiria o mecanismo. O que eles gateiam é o **acesso ao dado** (Fair Use Policy, API fechada em jul/2025) e a **stake máxima** por conta — não o preço. As reclamações reais de usuário são sobre **limite de aposta**, nunca sobre odd adulterada.

⚠️ Várias fontes primárias não abriram direto (Arbusers 403, developer.betfair 403, threads antigas do SBR em 301) e foram lidas via snippet de buscador. Sinalizado caso a caso.

---

## 9. Multiplicidade

**61 células/testes nesta rodada:**

| bloco | células |
|---|---|
| Assinatura de congelamento (fonte × fase) | 4 |
| Fração de mudanças rápidas (2 fontes × 4 limiares) | 8 |
| Quantização módulo 905s e 900s | 2 |
| Reação ao fim de mapa (2 fontes) | 2 |
| Calibração da closing (3 recortes × 2 fontes + pareado) | 7 |
| Deriva assinada (2 fontes × 3 recortes × 3 janelas) | 18 |
| Movimento pré-jogo (2 fontes × 6 janelas) | 12 |
| Headers de cache (4 endpoints + 11 matchups) | 15 (medição, não teste) |

No bloco de deriva (18 células), **8 deram significativas a 5%** contra 0,9 esperadas por acaso. Sob Bonferroni (p<0,0028, |t|>2,9) sobram **2**: PINN/todos/15min (t=−3,31, n=139) e PINN/todos/30min (t=−3,27, n=138). **O viés de deriva sobrevive à multiplicidade.**

O achado principal — a quantização em 905s — **não é um teste estatístico marginal**: é 84% contra 24% de baseline, sobre n=1.419, com o mecanismo (`max-age=905`) medido diretamente no header. Não há multiplicidade que ameace isso.

O que **não** sobrevive: a diferença de reação Pinnacle×Betby na média (t=1,52) e a vantagem da Betby na calibração (t=1,00). Ambos ficam como observação.

---

## 10. Respostas às 4 perguntas do briefing

### (a) A odd guest está defasada? Sim ou não, com número.

**Sim.** Até **905 segundos (15,1 min)**, média ~452s. Prova em três camadas independentes:
1. `Cache-Control: public, max-age=905` no próprio header do endpoint de preços; `Age` observado até 891s.
2. 84% dos 1.419 intervalos entre mudanças caem em múltiplos de 905s (baseline por acaso ~24%); 61% na faixa de 15–16 min.
3. Lag de reação ao fim de mapa: mediana 7,7 min, **p90 travado em 14,8 min** — exatamente o que um offset uniforme de 0–905s prediz.

Mas a defasagem é de **amostragem por cache**, não um gate contra deslogado — 80 pares cache×origem, 0 divergências.

### (b) De quanto, e o que custa em R$.

Deriva escondida pela janela de 15 min: **média 0,374 kills**, mas **zero em 77% dos mapas**. Viés sistemático de **−0,230 ± 0,136 kills** (a linha cai perto do apito), o que deixa a fair usada ~0,23 kill **alta demais**.

Sobre 360 bets / R$426.929 de stake / odd 1,868 (05/08→23/08):
- **≈ R$ 4,0 mil** de ruído (estimativa realista)
- **≈ R$ 8,0 mil** de edge subestimado pelo viés (faixa R$2,9k–R$12,7k)
- Teto absurdo: R$ 13 mil

**Direção:** conservadora. A fair inflada endurece o filtro numa operação 85% under — nunca fez uma bet parecer melhor do que era. É freio de mão, não vazamento. Contra R$107.460 de lucro no período, é ~7% de margem deixada na mesa.

**E o número que realmente importa:** a fair usada tem **mediana de 30 min e média de 117 min** de idade no apito. O cache é ~20% da defasagem total; a grade de coleta de 30 min é o resto.

### (c) Betby é fonte de fair melhor, igual ou pior?

**Igual — estatisticamente indistinguível.** Não vale trocar de fonte.

| | Pinnacle guest | Betby |
|---|---|---|
| viés (n=124 / n=35) | −0,27 ± 1,57 | +0,61 ± 3,29 |
| MAE pareado (n=25) | 7,30 | 6,98 |
| **Δ\|erro\| pareado** | **+0,32 ± 0,63 (t=1,00)** | |
| vig | 7,2% | 6,0% |
| leituras in-play por mapa | 0,59 | **5,60** |

A Betby ganha em duas coisas concretas: **vig 1,2pp menor** e **9,5× mais leituras ao vivo**. Nenhuma dessas é "prever melhor" — a calibração empata. Tradução: **a Betby não serve pra substituir a fair pré-jogo, mas é claramente a fonte certa pro eixo livebet**, onde a Pinnacle guest simplesmente não tem dado.

⚠️ n=25 no pareado. Observação, não conclusão. Fecha com 3–4 semanas de captura simultânea.

### (d) O teste definitivo que ainda exige logado×deslogado

O que sobrou sem resposta: **se a Pinnacle mantém um tier guest inteiro que é uma réplica de 15 min do livro real.** Meu teste não distingue isso de "o livro em si não se mexeu" — nos dois casos cache e origem concordam.

**Protocolo manual — 5 minutos, 2 prints, sem automação e sem me passar credencial:**

1. Escolha **um jogo de LoL AO VIVO** com mercado de kills aberto (LCK/LPL de manhã costuma ter). Precisa estar ao vivo — pré-jogo parado não testa nada.
2. Abra **duas janelas lado a lado no mesmo PC**:
   - **A:** navegador normal, **logado** na Pinnacle, na página do jogo, mercado de total de kills do mapa.
   - **B:** **janela anônima**, **deslogado**, mesma página, mesmo mercado.
3. Espere a linha da janela A mexer (em jogo ao vivo isso acontece).
4. **No instante em que A mexer**, tire **um print único capturando as duas janelas juntas**, com o relógio do Windows visível.
5. Espere ~5 minutos e tire o **segundo print**, mesmo enquadramento.
6. Me mande os 2 prints.

**Como se lê o resultado:**
- **A e B com a mesma linha nos dois prints** → não há gate por login. A defasagem é 100% cache, e **a segunda conta não resolve nada.**
- **B travado na linha antiga por até ~15 min e depois pulando pro valor de A** → é exatamente o cache de 905s aparecendo na tela; **ainda assim a segunda conta não resolve** (o navegador logado passa pelo mesmo CDN? o print responde).
- **B atrasado de forma constante e curta (segundos a poucos minutos), independente de janela de 15 min** → aí sim existe gate por login, e vale reabrir a discussão da conta.

**Dica que faz o teste render:** se o print mostrar B com a linha antiga E o relógio, dá pra cronometrar o atraso exato. Um jogo, dois prints, resolve o que a internet inteira não documentou.

⚠️ **Não faça isso na conta em disputa se houver qualquer risco de chamar atenção.** É só visualização de página, sem apostar — mas a decisão é sua.

---

## 11. Ressalvas honestas

- **Provei defasagem de até 15 min no feed guest. NÃO provei que o logado é diferente.** São afirmações de força muito diferente e não devem ser misturadas.
- O experimento cache×origem tem **80 amostras em ~25 minutos de relógio**, em 3 matchups, num domingo. Não cobre horário de pico de LCK/LPL.
- **Só 1 mapa estava ao vivo** durante os probes (LEC). A conclusão sobre mercado in-play da Pinnacle apoia-se nos 61 dumps de 14/08 (2 séries) + essa observação. **n=2–3 séries: observação.**
- O pareado Pinnacle×Betby tem **n=25 mapas**. A Betby só existe no banco desde 14/08 e cobre 33 séries contra 175 da Pinnacle.
- A deriva de −0,23 kill foi medida sobre a série **já quantizada**. Ela estima corretamente o *líquido* da janela, mas qualquer vai-e-volta interno é invisível — o ruído real pode ser maior que 0,374.
- A conversão pra R$ usa densidade normal na linha (4,35pp/kill) e assume que a fair entra linearmente na decisão. É ordem de grandeza, não contabilidade.
- **`phase='live'` no `odds_timeline` é fase da SÉRIE, não do mapa.** Reprocessei tudo por `game_drafts.first_frame_utc` pra contornar, mas qualquer análise anterior que confiou nessa coluna precisa ser relida.
- Correção feita durante a análise: uma versão intermediária deste teste marcou "8/8 divergiu" no cache-bust. Era **HTTP 204 vazio** por parâmetro inválido, não divergência. Fica registrado.
- **Nada foi escrito no banco. Nenhum script de produção foi alterado. Nenhum login em casa de aposta.** As únicas requisições externas foram GETs no `guest.api.arcadia.pinnacle.com`, o mesmo endpoint público que o coletor já bate de 60 em 60 segundos.

---

## Fontes

- Supabase (leitura): `odds_timeline` (10.934 rows), `capture_runs` (18.541), `game_frames` (6.299 desde 13/08), `game_drafts` (276 desde 04/08), `method_reports` (99 desde 01/08), `bets` (360 desde 05/08)
- `cron-data/diag-live-kills/` — 61 dumps crus da Pinnacle, 60s de intervalo, 14–15/08
- `cron-data/2026-08-*-fair-pinnacle.json` — 19 arquivos promovidos, 198 entradas com `minutes_before_start`
- `.claude/scripts/lib/pinnacle_core.cjs`, `betby_core.cjs`, `capture_pinnacle_to_supabase.cjs`, `capture_pinnacle_kills_auto.cjs`, `promote_fair_pinnacle_auto.cjs`
- Probes ao vivo (somente GET, sem login): `guest.api.arcadia.pinnacle.com/0.1` — `/sports/12/matchups`, `/sports/12/matchups/live`, `/matchups/{id}`, `/matchups/{id}/markets/related/straight`
- Externo: github.com/pinnacleapi/pinnacleapi-documentation · sportsbookreview.com/forum (3 threads) · arbusers.com/pinnacle-s-real-time-odds-t6406 · betting.betfair.com/betfair-announcements/why-am-i-receiving-delayed-exchange-market-data-060717-6.html · developer.betfair.com/exchange-api/faq
