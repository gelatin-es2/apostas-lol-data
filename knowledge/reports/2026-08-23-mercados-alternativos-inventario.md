# Mercados alternativos de LoL — inventário e caça a mispricing

**Data:** 2026-08-23
**Escopo:** eixo "mercados alternativos" — a operação vive 100% em total de kills do mapa. Existe outro mercado, nas mesmas casas, que já daria pra atacar?
**Hipóteses testadas nesta rodada: 38.** Aprovadas: **0**.

---

## Conclusão em uma frase

**A casa abre 17 mercados de LoL e o Elvis aposta em 1 — mas o mercado onde a casa é preguiçosa (torres: mesma linha e mesma odd em todo mapa) é exatamente o que a operação não sabe prever, e o mercado que a operação sabe prever já é o que ela aposta. Os "novos" que parecem atraentes são a mesma aposta reembalada.**

O número que fecha o caso: o sinal da operação (fair line de kills) correlaciona **r=0,334 (t=2,98, significativo)** com kills reais — e **r=0,062 com torres, r=0,025 com duração, r=−0,038 com dragões, todos não significativos (n=73)**. A operação tem um sinal, e ele só serve pra kills.

E não é um problema de uma casa só: **Pinnacle, Thunderpick e Shuffle também abrem torres, duração e first blood** (confirmado nas regras oficiais das três). A oferta existe em todo lugar. O que não existe é sinal.

**Nada aqui está aprovado.** Um item (total de torres) merece captura de 3-4 semanas, porque é barato de entrar e a casa comprovadamente não modela a partida ali. Isso é um pedido de dado, não um pedido de stake.

---

## (a) Inventário — mercados × casa × feed já capturado

### O que a rede Betby realmente abre (medido hoje, não é catálogo teórico)

Método: walk do feed sptpub sem login (`GET /api/v4/{live|prematch}/brand/{BRAND}/event/en/{eventId}`), skins `duel` e `rakebit`, 3 eventos live + 28 prematch, 23/08/2026. O catálogo bruto (`/api/v3/descriptions/brand/{BRAND}/markets/en`) tem 2.100 mercados; o que importa é o que vem **populado** num evento de LoL.

| ID | Mercado | Live | Prematch | Já capturado pelo projeto |
|----|---------|------|----------|---------------------------|
| **726** | map – total kills | 3/3 | 4/5 | **SIM** (único) |
| 725 | map – duration (minutos) | 3/3 | 3/5 | não |
| 50143 | map – total turrets | 2/3 | 3/5 | não |
| 50018 | map – total barons | 3/3 | 3/5 | não |
| 555 | map – kill handicap | 3/3 | 3/5 | não (coluna `spread_main` existe, vazia) |
| 50382 / 50383 | map – total kills de CADA time | 3/3 | 3/5 | não (coluna `team_totals` existe, vazia) |
| 731 | map – race to N kills (5/10/15) | 3/3 | 4/5 | não |
| 333 | map – quem faz a kill nº N (10/20/30) | 3/3 | 4/5 | não |
| 50117 | map – first blood | 2/3 | 4/5 | não |
| 557 | map – 1º barão | 3/3 | 4/5 | não |
| 558 | map – 1º inibidor | 3/3 | 4/5 | não |
| 50020 | map – kills odd/even | 2/3 | 3/5 | não |
| 330 | map – winner | 3/3 | 5/5 | não |
| 50350 / 50351 | winner + duração / winner + kills | 3/3 | 3/5 | não |
| 60040 / 60043 | total kills de JOGADOR / duelo de jogadores | – | 3/5 | não |
| 327/328/60030 | handicap de mapas / total de mapas / placar exato | 1/3 | 4/5 | não |
| 1000329 / 1000332 | total kills e handicap da SÉRIE inteira | – | 3/5 | não |

**No catálogo mas NÃO populado em nenhum evento de LoL observado:** 728 (`total towers` — a rede usa o 50143 no lugar), 396 (`xth aegis`), 397 (`xth tower`), 398 (`xth barracks`), 556 (`xth dragon`), 554 (`kill draw no bet`), 724 (`ultra kill`). **Total de dragões e first tower não apareceram em nenhum evento** — mercado catalogado ≠ mercado ofertado.

Vale pras skins Betby que o Elvis usa: **Winna, CoinCasino, Rakebit, Duel** (mesmo feed, mesmo brand model). ⚠️ BetFury usa o mesmo feed mas **filtra** o 726 — não assumir que toda skin expõe tudo.

### Pinnacle — ⚠️ os dumps do projeto enganam

Evidência interna: 61 dumps crus de `/matchups/{id}/markets/related/straight` (`cron-data/diag-live-kills/`, 14/08). Varredura de todos os campos:

- `units` distintos: **`Kills` — só isso**
- `type` distintos: `moneyline`, `spread`, `total`, `team_total`, `matchup`, `maxRiskStake`

**Isso NÃO significa que a Pinnacle só abre kills.** As regras oficiais da casa (https://www.pinnacle.com/en/future/betting-rules) listam explicitamente, com texto de liquidação:

- *"**Total Turrets Destroyed**: Nexus turrets only count towards settlement for the first time they are destroyed in a map"*
- *"**Elemental Dragons** includes only Cloud, Mountain, Infernal, Ocean, Chemtech, and Hextech dragons"*
- **First Blood**, **First Tower**, **First Turret**, **First Barracks**, **First Inhibitor** — todos com regra própria
- **Map Duration Over/Under**
- **Team Totals for Kills** e **handicap de kills** (faixa típica −5.5 a +5.5, confirmado em artigo da própria Pinnacle)

**Conclusão corrigida: a Pinnacle tem os mercados alternativos; o endpoint que o projeto captura é que não os traz.** `parseRelatedMarkets` filtra `units === 'Kills'` (`pinnacle_core.cjs:229`) e o `related/straight` daquela série só devolveu o matchup de Kills. Achar que "Pinnacle não tem torres" seria erro de leitura de um endpoint parcial. O probe pra localizar o matchup certo está na seção (d) — virou **prioridade alta**, porque a Pinnacle é a casa nº1 do Elvis (455 bets).

### Thunderpick — confirmado por regras próprias

Fontes: https://thunderpick.io/content/betting-rules + https://thunderpick.io/esports/league-of-legends. Confirmados por nome: **total kills**, **1st to x kills** (corrida), **First Blood**, **First Tower**, **First Inhibitor**, **Team to Slay the First Baron**, **Map Duration O/U**, **Total Dragons**, **Total Turrets**, **Total Kills Odd/Even**, **Killer Maker** (próxima kill), **Quadrakill/Pentakill Y/N**, **Dragon Type**, map winner / handicap de mapas / total de mapas.
Não confirmado: **handicap de kills** (o "handicap −1.5/+1.5" da página é de **mapas**) e **kills por time**.
Relevante: é a 3ª casa mais usada pelo Elvis (143 bets) e tem oferta alternativa rica.

### Shuffle — o catálogo mais completo que existe público

https://shuffle.com/info/sports publica a lista fechada com regra de liquidação de cada mercado de LoL. Tem tudo: total/handicap/odd-even de kills, race to 5/10/15/20, Nth kill, **Total Towers/Turrets/Dragons/Barons/Inhibitors** (O/U **e exato**), todos os "first" (blood, tower, dragon, baron, inhibitor), **Game Time O/U**, e *Both Teams to Slay a Dragon/Baron* — o "ambos marcam" existe, mas só pra objetivos, não pra kills.
⚠️ **Kills por time O/U não existe** na Shuffle — o que existe é *Team to Score the Most Kills* (2-way) + handicap. O texto comercial em `/sports/lol` fala em "total team kills" mas contradiz o catálogo de regras; vale o catálogo.
Se for padronizar nomenclatura de mercado no banco, essa é a referência.

### Rede Betby — Winna / CoinCasino / Rakebit

A BETBY publica só *"League of Legends — 500+ Events / 40+ Markets"*, sem nomear nada; o feed de esports vem da Oddin.gg (parceria B2B confirmada), e a Oddin **não publica catálogo**. Ou seja, **a via pública é beco sem saída** — a tabela de mercados desta seção veio da medição direta do feed, que é fonte mais forte que documentação de vendor.
Confirmação direta desta rodada: o host `api-i-c7818b61-624.sptpub.com` (skin **rakebit**) respondeu com o mesmo payload sptpub e os mesmos market IDs da skin duel. **Rakebit é Betby — medido, não inferido.** Winna e CoinCasino não foram sondadas hoje (winna.com/sports carrega vazio, coincasino bloqueia por geo); a equivalência delas segue apoiada no conhecimento interno do projeto, não em medição de hoje.

### Betano, Parimatch, EstrelaBet — NÃO CONFIRMADO

Betano (33 bets), Parimatch (64), EstrelaBet (92). Nenhuma publica catálogo extraível — todas bloqueiam leitura automatizada (403/Cloudflare/SPA/geo). O único item com fonte para Betano é editorial de terceiro citando "Vencedor, Vencedor do Mapa, Handicap, Resultado correto, Kills totais" para esports em geral — fraco demais, fica NC. Tudo sobre "Betano tem Primeiro Barão / Total de Torres" que circula vem de blog de afiliado. **Não conta e não entra no inventário.**
Fecha só com print da tela de mercados de um jogo ao vivo.

### O que a operação de fato aposta

Das 1.296 bets registradas: **844+ são "total kills"** (com variações de nome, passa de 95%), lado UNDER em 877 de 1.028 identificáveis. O único outro mercado que aparece é moneyline/vencedor de mapa (~20 bets). **A operação nunca tocou um mercado alternativo em nenhuma casa.**

---

## (b) Onde há mispricing — e onde não há

### Base de teste

Reconstruí o desfecho real de **287 mapas** (05/08 → 23/08/2026, 11 ligas) a partir de `game_frames` no Supabase — a tabela já guarda `towers_blue/red`, `dragons_blue/red`, `barons_blue/red`, `inhib_blue/red`, `game_clock_s` por minuto. Filtro: `is_final`, kills>0, duração>15min.

| métrica | média | sd | p10 | p25 | mediana | p75 | p90 |
|---|---|---|---|---|---|---|---|
| kills | 30,09 | 9,28 | 19 | 24 | 29 | 35 | 41 |
| torres | 11,81 | 2,29 | 9 | 10 | 12 | 13 | 15 |
| dragões | 4,52 | 1,04 | 3 | 4 | 4 | 5 | 6 |
| barões | 1,37 | 0,69 | 1 | 1 | 1 | 2 | 2 |
| inibidores | 1,66 | 1,04 | 1 | 1 | 1 | 2 | 3 |
| duração (min) | 32,23 | 5,21 | 26,3 | 28,9 | 31,7 | 34,8 | 38,6 |
| handicap (|kills A−B|) | 10,55 | 5,16 | 4 | 7 | 10 | 14 | 17 |

Split temporal: in-sample 155 mapas (05–15/08), out-of-sample 132 (15–23/08). Distribuição estável entre as metades (maior deslocamento: torres +0,41; kills −0,95).

### O achado que muda o enquadramento: a casa usa LADDER FIXO em torres

Medi a dispersão da odd **na mesma linha, entre mapas diferentes**. Se a odd é idêntica em todo mapa, a casa não está modelando a partida — está postando tabela.

| mercado | linha | nº de mapas | odd over média | **sd** | veredito |
|---|---|---|---|---|---|
| **total_towers** | 10.5 | 26 | 1,27 | **0,013** | **LADDER FIXO** |
| **total_towers** | 11.5 | 26 | 1,73 | **0,026** | **LADDER FIXO** |
| total_towers | 12.5 | 26 | 2,65 | 0,061 | ajuste leve |
| total_barons | 1.5 | 38 | 2,38 | 0,120 | ajuste leve |
| duracao_min | 32 | 40 | 1,88 | 0,158 | ajuste leve |
| duracao_min | 34 | 38 | 2,83 | **0,295** | casa MODELA |
| duracao_min | 36 | 38 | 4,69 | **0,583** | casa MODELA |
| team1_total_kills | 12.5 | 38 | 1,86 | **0,321** | casa MODELA |
| team1_total_kills | 13.5 | 38 | 2,04 | **0,380** | casa MODELA |

**Leitura:** em torres a casa posta as mesmas 3 linhas (10.5/11.5/12.5) com praticamente a mesma odd em todo mapa de toda liga. Em duração e kills-por-time ela **mexe** conforme a partida. Isso é decisivo pro método: **só onde o ladder é fixo a distribuição incondicional é o benchmark correto.** Onde a casa modela a partida, comparar contra a média da população é a armadilha metodológica clássica — e é por isso que a coluna de `total_kills` abaixo mostra "+45% de EV" em linhas altas, o que é obviamente falso: quando a casa posta 34.5 num confronto específico, a taxa populacional de 73,5% não se aplica àquele jogo.

### EV contra linha REAL ofertada (não contra mediana histórica)

Odds medianas realmente capturadas hoje. Mapeamento de outcome confirmado empiricamente: 12=over, 13=under; duração 1831=under, 1832=over.

| mercado | linha | odd UNDER | vig | UNDER real (n=287) | IC95 do UNDER | EV under | IC95 do EV | veredito |
|---|---|---|---|---|---|---|---|---|
| **torres** | **11.5** | 1,99 | 7,7% | 49,8% | [44,0%, 55,6%] | **−0,8%** | [−12,4%, +10,7%] | **INDISTINGUÍVEL DE JUSTO** |
| torres | 10.5 | 3,45 | 7,1% | 27,5% | [22,4%, 32,7%] | −5,0% | [−22,9%, +12,8%] | indistinguível |
| torres | 12.5 | 1,42 | 7,7% | 66,9% | [61,5%, 72,3%] | −5,0% | [−12,7%, +2,7%] | indistinguível |
| barões | 1.5 | 1,50 | 7,7% | 65,9% | [60,4%, 71,3%] | −1,2% | [−9,4%, +7,0%] | indistinguível (mas casa ajusta) |
| duração | 32 | 1,85 | 7,8% | 54,5% | [48,8%, 60,3%] | +0,9% | [−9,8%, +11,6%] | **NÃO TESTADO** (casa modela) |
| duração | 34 | 1,39 | 7,4% | 69,2% | [63,9%, 74,6%] | −3,8% | [−11,2%, +3,7%] | **NÃO TESTADO** (casa modela) |

**Nenhuma célula tem limite inferior de IC acima de zero. Zero aprovações.**

### O que é interessante mesmo assim: o pedágio é baratíssimo

A casa joga **toda a margem no lado OVER** desses mercados e deixa o UNDER quase justo. Quanto de poder preditivo seria preciso pra virar lucro:

| mercado / linha | odd under | breakeven | base real | **edge necessário** |
|---|---|---|---|---|
| **torres 11.5** | 1,99 | 50,3% | 49,8% | **0,4 pp** |
| torres 10.5 | 3,45 | 29,0% | 27,5% | 1,5 pp |
| barões 1.5 | 1,50 | 66,7% | 65,9% | 0,8 pp |
| duração 32 | 1,85 | 54,1% | 54,5% | −0,5 pp |
| torres 12.5 | 1,42 | 70,4% | 66,9% | 3,5 pp |
| **kills (odd real média do CEO)** | **1,75** | **57,1%** | — | **~3,5 pp+** |

Em kills o Elvis precisa vencer ~3,5pp de margem pra lucrar. Em torres 11.5 bastariam **0,4pp**. É a diferença entre subir uma escada e um degrau.

**Mas o degrau não tem ninguém pra subir:** o sinal da operação não move torres.

| desfecho | trigger de peel (n=14) | sem trigger (n=118) | delta | delta/sd | t |
|---|---|---|---|---|---|
| kills | 27,36 | 30,97 | **−3,62** | −0,41 | −1,66 |
| torres | 11,64 | 11,58 | +0,07 | 0,03 | 0,13 |
| dragões | 4,43 | 4,58 | −0,16 | −0,15 | −0,58 |
| barões | 1,29 | 1,33 | −0,04 | −0,07 | −0,22 |
| duração | 31,83 | 32,40 | −0,57 | −0,11 | −0,35 |
| handicap | 12,93 | 10,77 | +2,16 | 0,42 | 1,41 |

⚠️ **n=14 na célula com trigger — isso é OBSERVAÇÃO, não conclusão.** O gradiente por nº de supports de peel conta a mesma história (n=95/30/7): kills cai monotonicamente 31,6 → 28,2 → 27,0 enquanto torres fica parada em 11,52 → 11,73 → 11,86.

O teste com n decente é o da fair line (n=73), já citado na conclusão: fair de kills prevê kills (r=0,334, t=2,98) e **não prevê mais nada** (torres r=0,062; duração r=0,025; barões r=0,119; inibidores r=−0,171; handicap r=0,067 — todos não significativos).

---

## (c) O que é só kills disfarçado — risco, não oportunidade

Correlação de Pearson com total de kills do mapa, n=287:

| mercado alternativo | r com kills | r² | leitura |
|---|---|---|---|
| **kills do time vencedor (50382/50383)** | **0,880** | 0,775 | 🔴 **MESMA APOSTA** |
| **kills do time perdedor (50382/50383)** | **0,868** | 0,753 | 🔴 **MESMA APOSTA** |
| torres (50143) | 0,386 | 0,149 | risco distinto |
| barões (50018) | 0,385 | 0,148 | risco distinto |
| duração (725) | 0,373 | 0,139 | risco distinto |
| dragões | 0,280 | 0,078 | risco distinto |
| inibidores (558) | 0,220 | 0,049 | risco distinto |
| **handicap de kills (555)** | **0,055** | 0,003 | ortogonal — outro jogo |

🔴 **Total de kills por time é a armadilha do eixo.** Parece um mercado novo, tem ladder profundo (12-14 linhas por mapa), e é 77% a mesma variável que a operação já aposta. Apostar under no time A + under no total de kills não é diversificação — é dobrar a mesma posição com duas etiquetas. **E é o pior dos dois mundos: risco duplicado E a casa modela ativamente** (sd da odd 0,32–0,38, o maior da amostra). Se aparecer proposta de "diversificar em kills por time", a resposta é não.

Redundância interna entre os alternativos (pra não montar carteira que parece diversa e não é):
- **dragões × duração r=0,841** — dragão é literalmente relógio; são o mesmo mercado
- torres × duração r=0,665 · torres × barões r=0,601 · barões × duração r=0,650

Ou seja, torres/dragões/barões/duração formam **um único fator "jogo longo"**. Escolher um; empilhar os quatro é 1 aposta em 4 bilhetes.

**Handicap de kills (555) é o único genuinamente ortogonal** (r=0,055). Mas: (i) a operação não tem sinal sobre ele (r=0,067 com a fair, ns), e (ii) **não é testável com o dado atual** — a casa cota handicap assinado por competidor (`hcp=-1.5` no competitor1), e meu histórico só tem `|kills_A − kills_B|` sem saber quem era favorito. Comparar os dois foi o que produziu um falso "+43% de EV" numa versão anterior desta análise. **Descartado como achado; virou item de captura.**

---

## (d) O que capturar pra testar de verdade

Boa notícia: **o lado do DESFECHO já está resolvido e é de graça.** O que falta é o lado da LINHA.

### 1. Desfecho — nada de novo a raspar

`feed.lolesports.com/livestats/v1/window/{gameId}` (público, sem auth — testado hoje, HTTP 200) devolve por frame de 10s:
```
frames[].blueTeam / redTeam -> { totalKills, totalGold, towers, dragons, barons, inhibitors, participants }
```
- **totais** de torres/dragões/barões/inibidores: diretos
- **"first X"** (first tower, first dragon, first baron, first inhibitor): deriváveis do frame em que o contador do time vai de 0→1 — resolve os mercados 557/558 e os 396/397/398 se algum dia abrirem
- **duração**: `game_clock_s` do frame final

`feed.lolesports.com/livestats/v1/details/{gameId}` (também 200) devolve `participants[].kills` por jogador → **first blood** (primeiro participante a sair de 0 kills) e **player total kills** (mercado 60040).
⚠️ Granularidade de 10s: se os dois times pegam a 1ª torre dentro da mesma janela, o "first X" fica ambíguo. Raro, mas precisa de flag no dataset.

**Backfill:** `backtest-2025/data/games-2025-*.json` tem os `game_id` de milhares de mapas de 2025 (só LCK são 551). Rodar o window sobre eles levaria o n de torres/duração/objetivos de **287 para a casa dos milhares** — é o único caminho pra sair de "observação" e chegar em conclusão. Script-mãe já existe: `.claude/scripts/backfill-riot-livestats.cjs`.

### 2. Linha — extensão barata do coletor que já roda 24/7

`capture_betby_kills.cjs` já faz o walk certo e já bate no endpoint certo. Falta só parsear mais mercados do mesmo payload — **zero requests adicionais**, o `/event/en/{id}` já traz tudo.

Em `.claude/scripts/lib/betby_core.cjs`, `parseKillsLadder()` hoje lê só `markets['726']`. Adicionar:

| mercado | ID | specifier | outcomes | prioridade |
|---|---|---|---|---|
| total de torres | **50143** | `mapnr=N\|total=X.X` | 12=over, 13=under | **ALTA** |
| duração | **725** | `mapnr=N\|minute=X` | **1831=under, 1832=over** | ALTA |
| total de barões | **50018** | `mapnr=N\|total=1.5` | 12=over, 13=under | média |
| handicap de kills | **555** | `mapnr=N\|hcp=±X.X` | **1714=competitor1, 1715=competitor2** | ALTA (é o ortogonal) |
| kills por time | **50382 / 50383** | `mapnr=N\|total=X.X` | 12=over, 13=under | baixa (é kills disfarçado — capturar só pra medir, nunca pra apostar) |
| first blood | **50117** | `mapnr=N` | 4=competitor1, 5=competitor2 | média |
| race to N kills | **731** | `mapnr=N\|xth=5\|10\|15` | 4/5 | média |

⚠️ **555, 50382/50383, 50117 e 731 são cotados POR TIME.** Gravar `competitor1`/`competitor2` já resolvidos pro nome canônico via `lib/normalizeTeam.cjs` — sem isso o dado nasce inútil, que foi exatamente o que impediu de testar o handicap nesta rodada.

**Destino:** `odds_timeline` **já tem as colunas `team_totals` e `spread_main` criadas e vazias** (o coletor Betby grava null). Pra torres/duração/barões faltaria uma coluna de mercado ou uma linha por mercado — decisão de schema, não de método.

### 3. Probe da Pinnacle — PRIORIDADE ALTA

As regras oficiais confirmam que a Pinnacle abre **Total Turrets Destroyed, Map Duration, First Blood, First Tower, First Barracks, First Inhibitor, Elemental Dragons e Team Totals for Kills**. Os 61 dumps do projeto não mostram nada disso porque `parseRelatedMarkets` filtra `units === 'Kills'` (`pinnacle_core.cjs:229`) e o `related/straight` daquela série só devolveu o matchup de Kills.

Probe: rodar uma vez **sem o filtro de `units`**, logando todos os `units`/`type`/`matchupId` devolvidos, e varrer os matchups **irmãos** da série (não só o de Kills) atrás de `units` como `Turrets`/`Towers`/`Dragons`/`Duration`. Isso fecha o inventário da casa nº1 do Elvis (455 bets) — e a Pinnacle é onde a linha costuma ser mais afiada, ou seja, é o teste mais duro pra hipótese "casa precifica pior o que pouca gente aposta".

⚠️ Pinnacle exige proxy (`PINNACLE_PROXY_HOST`). Não rodei nesta análise — é ação externa em casa sensível, com histórico de bloqueio. **Aguarda o Elvis mandar.**

### 4. Thunderpick — 2ª frente, sem proxy

Thunderpick é a 3ª casa mais usada (143 bets) e as regras próprias confirmam **total kills, 1st to x kills, First Blood, First Tower, First Inhibitor, First Baron, Map Duration O/U, Total Dragons, Total Turrets, Total Kills Odd/Even**. Não tem coletor no projeto. Se der pra ler o feed dela sem login (não testei), é a comparação natural com o Betby: **duas redes independentes cotando o mesmo mercado de torres = dá pra ver quem está errado, sem precisar do desfecho.** Discrepância entre casas é o sinal de mispricing mais barato que existe.

### 5. Betano, Parimatch, EstrelaBet — NÃO CONFIRMADO

Nenhuma publica catálogo extraível (403/Cloudflare/SPA). Só fecha com print da aba de mercados de um LoL ao vivo. Não dá pra deduzir por rede — não são Betby.
Para padronizar nomenclatura no banco, usar o catálogo da Shuffle (`shuffle.com/info/sports`) como referência: é o único público, fechado e com regra de liquidação por mercado.

---

## Plano mínimo se o Elvis quiser seguir

1. **Ligar a captura de 50143 (torres) + 725 (duração) + 555 (handicap com times)** no coletor Betby que já roda. Custo: nenhum request novo.
2. **Backfill do window da Riot** sobre os game_ids de 2025 → n de milhares pra torres/duração/objetivos.
3. **Probe da Pinnacle sem o filtro `units==='Kills'`** (aguarda ordem — usa proxy, casa sensível).
4. **Só então** perguntar de novo: existe algum sinal de draft que preveja torres? Hoje a resposta medida é não (r=0,062, n=73).
5. Enquanto isso: **stake zero em mercado alternativo.**

O que **não** fazer: entrar em kills por time achando que diversifica (é 77% a mesma aposta), e empilhar torres+dragões+barões+duração achando que são quatro apostas (é uma, r entre 0,60 e 0,84).

---

## Ressalvas honestas

- **n=287 mapas, 19 dias, uma única captura de odds (23/08).** As odds da casa podem mudar; o retrato é de hoje.
- A comparação EV usa **distribuição incondicional**. Isso é metodologicamente válido **só** onde o ladder é fixo (torres 10.5/11.5, sd da odd 0,013/0,026). Em duração, barões e kills-por-time a casa modela a partida → aqueles EVs são **NÃO TESTADOS**, não "quase justos".
- A célula do trigger de peel tem **n=14**. Registrada como observação. O teste com n=73 (fair line) é o que sustenta a conclusão.
- **Nenhum backtest de mercado alternativo contra linha histórica foi feito, porque não existe linha histórica capturada.** Todo EV aqui é linha de hoje × desfecho de 19 dias. É um primeiro filtro, não um forward test.
- **Correção feita durante a análise:** cheguei a concluir, dos 61 dumps, que "a Pinnacle só abre kills". As regras oficiais da casa desmentem. O erro era ler ausência num endpoint parcial como ausência no produto. Fica registrado porque é o tipo de erro que se repete.
- **Betano, Parimatch e EstrelaBet seguem NÃO CONFIRMADOS.** Nenhuma fonte primária acessível. Não inventei linha de oferta pra nenhuma delas.
- A equivalência **Winna = CoinCasino = Betby** não foi medida hoje (só Rakebit foi). Vem do conhecimento interno do projeto.
- A tabela de mercados Betby é de **3 eventos live + 28 prematch** num único snapshot. Mercado que não apareceu (ex.: total de dragões) pode existir em outro horário/liga — "não observado" ≠ "não existe".
