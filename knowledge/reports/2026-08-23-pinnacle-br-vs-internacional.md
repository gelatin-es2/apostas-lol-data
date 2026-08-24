# pinnacle.bet.br × pinnacle.com — é o mesmo livro?

**Data:** 2026-08-23
**Pergunta:** o Elvis aposta em `pinnacle.bet.br` (operação BR licenciada, A2FBR SA, Portaria SPA/MF nº 2.102), mas toda a captura de fair puxa de `guest.api.arcadia.pinnacle.com`. São livros diferentes? Se forem, a fair primária da operação — usada desde 05/08 em centenas de bets — não vem da casa onde ele aposta.
**Restrição:** SOMENTE LEITURA, SOMENTE DESLOGADO. Nenhum login, nenhuma credencial, nenhum cookie de sessão. Todo request saiu pelo proxy SOCKS5 (IP de saída `200.152.145.216`, BR). Nada escrito em banco, nenhum script de produção alterado. **Zero 403 em toda a coleta.**

---

## Conclusão em uma frase

**É o mesmo livro — não só parecido, é literalmente o mesmo objeto: os dois lados publicam os MESMOS ids de matchup, a MESMA linha e o MESMO preço até a terceira casa decimal. A fair da operação está certa. O que muda, e muda pra melhor, é que o endpoint brasileiro é servido SEM CACHE, enquanto o `.com` que a captura usa tem cache de 905 segundos — ou seja, existe hoje uma fonte pública, deslogada, do mesmo livro, e ela é ~7,5 minutos mais fresca de graça.**

O número que fecha o caso: **39 de 39** células (série × mapa) fora de jogo ao vivo com a **linha idêntica**, e **78 cotações** comparadas com desvio **máximo de 0,010** — que é o erro de arredondamento de converter odd americana pra decimal, não diferença de preço. E **7 de 7 ids de matchup de kills batem exatamente** entre os dois.

Não havia buraco de fair. Havia um endpoint melhor na mesa.

---

## 1. Veredito direto

| Pergunta | Resposta | Número |
|---|---|---|
| BR e internacional são livros diferentes? | **NÃO. Mesmo livro.** | 7/7 ids de matchup idênticos; 43/44 linhas idênticas (39/39 fora do ao vivo) |
| A fair histórica da operação está contaminada? | **NÃO** | viés linha apostada − linha principal capturada = **+0,10 kills, IC95 [−0,42, +0,61]**, mediana 0 (n=31) |
| Quanto isso custou? | **R$ 0** | o erro não existiu |
| Achei endpoint público do BR? | **SIM** | `sports2.pinnacle.bet.br/sports-service/sv/odds/events`, HTTP 200 deslogado |
| O endpoint BR é melhor que o `.com` guest? | **SIM, em frescor** | BR: sem cache (`cf-cache-status: DYNAMIC`, sem `Age`, sem `max-age`). COM: `max-age=905`, **Age mediano 504s, máximo 898s** (n=177 medições hoje) |
| Os ids 1634649021/22 vs 1634473813 eram espaços diferentes? | **NÃO** | 1634649022 é sub-matchup ao vivo cujo `parentId` **é** 1634473813 — mesmo espaço |

Distinção honesta: **provei que os dois publicam o mesmo preço.** Não provei — e não tentei — nada sobre a conta logada do Elvis (limites, stake máxima, se a oferta que aparece pra ele difere). Isso é outra pergunta e está fora do que dá pra medir deslogado.

---

## 2. O endpoint do BR, com evidência

### 2.1 Como cheguei nele

`pinnacle.bet.br` **não** é o stack da Pinnacle internacional. É um app Angular multimarca (chunk webpack `cg-wl-client`), o mesmo shell servido para as 6 marcas da A2FBR (betbra, fulltbet, bolsadeaposta, pinnacle, matchbook, betespecial). Esse app é só a **casca**. O sportsbook mora num iframe.

O construtor do iframe está no chunk `887.12df8f0065112495.js` (módulo `SportsbookModule`, rotas `/sportsbook` e `/e-sports`):

```js
setFrameUrl(a){ ... this.frameBase =
  "https://" + (a === j.vR.eSports ? "fv-" : "") + "sports2." + window.location.hostname + "/"; ... }
```

→ **`https://sports2.pinnacle.bet.br/`**. (Bate com o achado passivo do `performance.getEntriesByType` na aba logada: `1x sports2.pinnacle.bet.br`.)

### 2.2 O que `sports2` é

Header e config da própria página (`https://sports2.pinnacle.bet.br/pt/`, HTTP 200 deslogado):

```html
<meta property="og:image" content="http://www.pinnacle888.com/PINNACLE.png"/>
var envion={ oddsServicePath:"/sports-service/sv", lineServicePath:"/sports-service/sv",
  _site_:"Pinnacle", brandId:"1796", brandName:"B237-01 pinnacle.bet.br",
  cmsDomain:"//tizx11a.auremi88.com/static/index.php", liveServerHost:"live.auremi88.com",
  esportsHubUrlB2B:"https://fv-tizx11a.auremi88.com/{locale}/esports-hub/", ... }
```

Ou seja: a casca é white-label da A2FBR, mas **o sportsbook por dentro é a plataforma B2B da própria Pinnacle (Pinnacle888 / infra `auremi88.com`), com `pinnacle.bet.br` cadastrada como brand 1796**. É por isso que o livro é o mesmo: quem precifica é a mesma mesa.

### 2.3 Os endpoints públicos (deslogados)

Base: `https://sports2.pinnacle.bet.br/sports-service/sv`

| rota | pra quê | status deslogado |
|---|---|---|
| `/odds/events` | **linhas + escada + preços** | 200 |
| `/odds/es-leagues` | ligas de esports | 200 |
| `/odds/leagues`, `/odds/periods` | metadados | 200 |

Parâmetros de `/odds/events` (extraídos de `member/bundles/page.sports.js`): `sp=12` (esports), `mk=3` (Market.ALL), `ot=1` (decimal), `btg=1` (HDP_OU), `l`/`cl` = **profundidade da escada**, `_g=1` = flag de guest, `c=BR`.

⚠️ **Armadilha que eu mesmo caí:** com `l=5` a escada volta com 5 degraus e parece mais estreita que a do `.com`. Não é o livro — é o parâmetro. Com `l=9` as escadas ficam idênticas degrau a degrau. Registro porque é exatamente o tipo de erro que vira conclusão falsa.

Chamada de exemplo (a que gerou a tabela da seção 3):

```
GET https://sports2.pinnacle.bet.br/sports-service/sv/odds/events
    ?sp=12&mk=3&ot=1&btg=1&o=1&l=9&cl=9&v=0&me=0&more=false&c=BR&tm=0&pa=0&pn=-1&_g=1
Accept: application/json  |  X-Requested-With: XMLHttpRequest
→ HTTP 200 · cf-cache-status: DYNAMIC · (sem Age, sem Cache-Control)
```

### 2.4 O resto do wrapper (mapeado, não usado)

- REST da casca: `https://pinnacle.bet.br/client/api/` (conta, saldo, settings — nada de odds)
- STOMP over WebSocket: `wss://pinnacle.bet.br/client/ws/connect`, com `connectHeaders:{login:"guest",passcode:"guest"}` — **não conectei** (fora do escopo desta rodada)
- `exchange.pinnacle.bet.br` = iframe EWL da exchange da A2FBR (linhagem Bolsa de Aposta), **não** é produto Pinnacle. A Pinnacle internacional não tem exchange.
- `sports2.pinnacle.bet.br/member-auth/v2/pre-auth?...&token=...` = rota de sessão do usuário logado. **Não tocada, não reproduzida.**

---

## 3. A comparação de linhas (o teste direto)

3 coletas pareadas ao longo de ~25 minutos (`r1` 18:47, `r2` 18:52, `r3` 19:00 UTC), BR e COM lidos com **1–20 s de diferença** em cada rodada.

### 3.1 Ids de matchup — a prova estrutural

Snapshot `r2`, todos os matchups de kills de LoL nos dois lados:

| série | matchup de kills no BR | matchup de kills no COM | bate? |
|---|---|---|---|
| 1634462536 (LEC Shifters×KC) | 1634531102 | 1634531102 | **SIM** |
| 1634197107 (LCS Disguised×SEN) | 1634215320 | 1634215320 | **SIM** |
| 1634197143 (LCS DIG×FLY) | 1634218199 | 1634218199 | **SIM** |
| 1634473813 (CBLOL LOS×LOUD) | 1634544650 | 1634544650 | **SIM** |
| 1634585199 (LCK CL) | 1634612180 | 1634612180 | **SIM** |
| 1634628656 (CD VKS×INTZ) | 1634646508 | 1634646508 | **SIM** |
| 1634606525 (LRN Zeu5×Fuego) | 1634646507 | 1634646507 | **SIM** |

**7/7.** Duas casas "diferentes" não compartilham ids internos de matchup. Isso sozinho já encerra a pergunta; o resto é confirmação.

Isso também resolve a pista dos ids: `1634649022` (o que aparecia na URL logada) é o **sub-matchup ao vivo**, e o `parentId` dele é `1634473813` — exatamente o `series_id` que a listagem guest do `.com` trouxe. Mesmo espaço, níveis diferentes da mesma árvore.

### 3.2 Tabela jogo × mapa × linha (rodada `r2`, a mais limpa)

| liga | série | mapa | jogo | linha BR | linha COM | Δ | over BR/COM | under BR/COM |
|---|---|---|---|---|---|---|---|---|
| LCS | 1634197107 | 1 | Disguised × Sentinels | 28.5 | 28.5 | **0** | 2.03 / 2.03 | 1.729 / 1.730 |
| LCS | 1634197107 | 2 | Disguised × Sentinels | 28.5 | 28.5 | **0** | 2.00 / 2.00 | 1.751 / 1.752 |
| LCS | 1634197143 | 1 | Dignitas × FlyQuest | 28.5 | 28.5 | **0** | 2.11 / 2.11 | 1.671 / 1.671 |
| LCS | 1634197143 | 2 | Dignitas × FlyQuest | 28.5 | 28.5 | **0** | 2.07 / 2.07 | 1.699 / 1.699 |
| LEC | 1634462536 | 3 | Shifters × Karmine Corp | 27.5 | 27.5 | **0** | 1.99 / 1.99 | 1.757 / 1.758 |
| LCK CL | 1634585199 | 1 | DN SOOPers × Kiwoom DRX | 33.5 | 33.5 | **0** | 1.819 / 1.820 | 1.917 / 1.917 |
| LCK CL | 1634585199 | 2 | DN SOOPers × Kiwoom DRX | 32.5 | 32.5 | **0** | 1.806 / 1.806 | 1.934 / 1.935 |
| LCK CL | 1634585199 | 3 | DN SOOPers × Kiwoom DRX | 34.5 | 34.5 | **0** | 1.943 / 1.943 | 1.800 / 1.800 |
| CD | 1634628656 | 1 | VKS Academy × INTZ | 31.5 | 31.5 | **0** | 1.757 / 1.758 | 1.917 / 1.917 |
| CD | 1634628656 | 2 | VKS Academy × INTZ | 31.5 | 31.5 | **0** | 1.757 / 1.758 | 1.917 / 1.917 |
| LRN | 1634606525 | 1 | Zeu5 × Fuego | 35.5 | 35.5 | **0** | 1.833 / 1.833 | 1.833 / 1.833 |
| LRN | 1634606525 | 2 | Zeu5 × Fuego | 35.5 | 35.5 | **0** | 1.833 / 1.833 | 1.833 / 1.833 |
| LRN | 1634606525 | 3 | Zeu5 × Fuego | 35.5 | 35.5 | **0** | 1.833 / 1.833 | 1.833 / 1.833 |
| CBLOL ⚠️ | 1634473813 | 3 | LOS × LOUD (**ao vivo**) | 27.5 | 27.5 | **0** | 1.970 / 1.971 | 1.775 / 1.775 |
| CBLOL ⚠️ | 1634473813 | 2 | LOS × LOUD (**ao vivo**) | 27.5 | 27.5 | 0 | 1.943 / **1.763** | 1.806 / **1.990** |

**Escada completa idêntica em 15/15** nessa rodada. Exemplo cru (LEC mapa 3, os dois lados):

```
BR : 23.5 / 24.5 / 25.5 / 26.5 / 27.5 / 28.5 / 29.5 / 30.5 / 31.5
COM: 23.5 / 24.5 / 25.5 / 26.5 / 27.5 / 28.5 / 29.5 / 30.5 / 31.5
BR  m3 preços: [24.5→1.427/2.55] [25.5→1.571/2.27] [26.5→1.746/1.99] [27.5→1.970/1.775] [28.5→2.13/1.653] ...
COM m3 preços: [24.5→1.427/2.55] [25.5→1.571/2.27] [26.5→1.746/1.99] [27.5→1.971/1.775] [28.5→2.13/1.654] ...
```

### 3.3 Agregado das 3 rodadas

| recorte | células | linha idêntica |
|---|---|---|
| **todas** | 44 | **43 (97,7%)** |
| **excluindo a série AO VIVO** | 39 | **39 (100,0%)** |

Δ linha (BR − COM), n=44: **média −0,023 · mediana 0 · IC95 ±0,045**. Distribuição: `0` em 43 casos, `−1` em 1 caso (a série ao vivo).

**Preço**, 78 cotações (over+under das células com linha igual):
**máximo |Δ| = 0,0100 · mediana 0,0000 · apenas 1 acima de 0,005 · nenhuma acima de 0,02.**
Isso é ruído de conversão: o `.com` publica odd americana e o coletor converte com `toFixed(3)`; o BR publica decimal direto. Não é discordância de preço.

### 3.4 A única divergência, e por que ela confirma a tese

A célula que difere é sempre a **série ao vivo** (LOS × LOUD, CBLOL). Poll pareado de 10 minutos, de 60 em 60 s:

| tick | BR (m2) | COM (m2) | Age do COM |
|---|---|---|---|
| #0–#3 | 27.5 @1.943 | 27.5 @1.763 | 190 → 394 s |
| #4 | 27.5 @1.943 | **26.5 @2.01** | **93 s** (cache virou) |
| #5–#7 | 27.5 @1.943 | 26.5 @2.01 | 155 → 279 s |

O `.com` fica parado enquanto o `Age` sobe, **pula quando o cache expira** e anda na mesma direção que o BR. Não é um livro diferente: é o mesmo livro visto através de uma janela de 15 minutos.

Confirmação dinâmica no `r3`: a LEC m3 mudou nos dois lados **junto e para o mesmo número** — BR `1.84 / 1.900`, COM `1.84 / 1.901`. Quando os dois estão frescos, eles são o mesmo dado.

⚠️ Ressalva medida: nesse mesmo poll, o BR mexeu **3 células em 10 min** e o COM **5**. As duas cadências são parecidas nesta amostra curta, e as 5 do COM incluem artefato (ver 3.5). **Não estou afirmando que o BR entrega mais leituras in-play — isso não foi medido.** É a expectativa mecânica de um endpoint sem cache, e está na seção 6 como coisa a medir.

### 3.5 Bug encontrado de brinde (afeta a captura atual)

Numa série **ao vivo**, o `.com` publica **três sub-matchups de kills simultâneos** para o mesmo (série, mapa), com totais principais conflitantes — no tick #4: `27.5@1.763`, `27.5@1.877` e `26.5@2.01`, todos ao mesmo tempo.

`pinnacle_core.parseRelatedMarkets` resolve isso com `totals.find(t => !t.isAlternate)` — ou seja, **o primeiro que chegar**. Não há tiebreak por `version` para totals (existe para moneyline e spread, `mlVersion`/`spreadVersion`, mas **não para `total`**). Isso significa que a linha principal gravada em `odds_timeline` para série ao vivo pode alternar entre sub-matchups por ordem de chegada da API.

Isso é diagnóstico, não conserto — e vale a pena olhar, porque contamina justamente o eixo underkill livebet.

---

## 4. O teste histórico (o de n grande) — e onde ele não fecha

Ideia: se o livro BR fosse diferente, a linha que o Elvis efetivamente pegou divergiria de forma estável da linha que a captura do `.com` viu nos mesmos jogos.

### 4.1 Cobertura — diga onde faltou dado

| etapa | n | perda |
|---|---|---|
| bets `bookmaker='pinnacle'` (exclui SIMULATED) | 460 | — |
| mercado Total Kills com linha parseável no `pick` | 230 | −230 (moneyline, handicap, etc.) |
| dentro da janela do `odds_timeline` (05/08→23/08) | **99** | −131 (**a timeline só existe desde 05/08; as bets vão até abril**) |
| linkadas a uma série capturada (nome + janela temporal) | 39 | −60 (série nunca capturada) |
| com leitura capturada do **mesmo mapa** | **31** | −8 |

**n final = 31.** É observação sólida, não é o "centenas de observações" que o briefing esperava. **O gargalo é a cobertura do `odds_timeline`, não a análise.**

### 4.2 Efeito ladder, separado (era a preocupação central)

O Elvis escolhe degrau de propósito, então comparar linha apostada com linha principal mistura duas coisas. Medindo o efeito ladder isolado:

**linha apostada − linha PRINCIPAL capturada: n=31 · média +0,097 · IC95 [−0,420, +0,614] · mediana 0 · sd 1,47**

Distribuição: `−3:1  −2:3  −1:8  0:5  +1:10  +2:2  +3:2`

Leitura: ele **espalha para os dois lados quase simetricamente** e o centro é zero. Não existe deslocamento sistemático. Um livro diferente produziria um viés estável (todas as linhas dele 1 ou 2 kills acima/abaixo das capturadas) — **não é o que aparece**.

Split temporal: 1ª metade média 0,000 (n=15), 2ª metade +0,188 (n=16). Os dois IC95 contêm zero. Sem tendência.

**E o mais direto: a linha que ele apostou existia na escada capturada do `.com` em 31/31 casos (100%).**

### 4.3 O resíduo de preço — declarado como inconclusivo

Comparando a odd que ele pegou com a melhor odd capturada **na mesma linha**:

- assinado: n=31 · média **−0,096** · IC95 [−0,171, −0,020]
- absoluto: mediana **0,085** · média 0,139
- controle nulo (mesmo estimador, mesmas leituras, mesmo livro, gap ≥15 min): mediana **0,006**

Ou seja: o resíduo observado é **maior que o nulo** (Mann-Whitney z=5,64). **Isso NÃO sustenta "livro diferente"**, por três motivos que consegui verificar:

1. **Os maiores desvios são bets in-play.** O pior caso: `17/08 LEC GIANTX × Karmine m2, under 24.5 @1.719`, contra faixa capturada `[2.46, 2.82]`. Under 24.5 a 1.719 é preço de **jogo lento já em andamento**; 2.46–2.82 é preço **pré-mapa**. Mesmo livro, momentos diferentes. Mesmo padrão em `Hanwha × KT m2` (4 bets, 1.724–1.84, faixa capturada 1.935–2.22).
2. **Não consigo o instante da bet.** `bet_datetime` é o início do match e `created_at` é a hora do LOG (o bet-logger roda depois). Os 31 casos caem todos como "depois do início da série", então **não dá pra separar pré-jogo de in-play** — o split que resolveria isso é vazio por construção.
3. **O nulo é otimista.** Ele sorteia a "verdade" das próprias leituras capturadas, que estão na grade de 15 min; o instante da bet do Elvis não está nessa grade.

**Conclusão honesta desta subseção: o resíduo de preço é confundido por timing e eu não consigo desconfundi-lo com os dados atuais. Ele não vira evidência nem a favor nem contra.** O que decide é a seção 3, onde as duas fontes foram lidas com 1–20 s de diferença e deram o mesmo número.

---

## 5. Quanto custou

**R$ 0.**

A hipótese era: a fair vem do livro errado → todas as decisões desde 05/08 foram tomadas contra uma referência que não é a casa onde ele aposta. **A hipótese é falsa.** O livro é o mesmo, os ids são os mesmos, os preços são os mesmos. Nada a corrigir retroativamente, nada a reprocessar, nenhuma bet mal avaliada por esse motivo.

O que continua valendo é o custo já quantificado em `2026-08-23-teste-defasagem-odd-guest-pinnacle.md` (≈R$4,0 mil de ruído + ≈R$8,0 mil de edge não reivindicado em 19 dias), que vem de **defasagem**, não de livro errado. Deste, o cache de 905 s responde por ~20% (~7,5 min dos ~37 min de defasagem mediana) — e **essa parte agora tem conserto**.

---

## 6. O que fazer

**1. Não mexer em nada retroativo.** A fair histórica está correta. Não reprocessar, não recalcular, não reavaliar bets.

**2. Trocar (ou duplicar) a fonte de captura para o endpoint BR.** É o mesmo livro sem o cache de 905 s:

| | `.com` guest (hoje) | `sports2.pinnacle.bet.br` |
|---|---|---|
| Cache | `max-age=905`, Age mediano **504 s**, máx **898 s** | **sem cache** (`DYNAMIC`, sem `Age`, sem `Cache-Control`) |
| Requests por varredura | 1 lista + **1 por matchup** (~15 s) | **1 request** traz tudo (~2 s) |
| Escada | completa | completa (com `l=9`) |
| Login | não | não |

Ganho imediato: some a quantização de 15 min, e a varredura fica ~8× mais barata (1 request em vez de ~8–15). **Recomendação: rodar em paralelo com a fonte atual por 1–2 semanas** gravando `source='br-sports2'` no `odds_timeline`, e só promover a primária depois de comparar. Não trocar no escuro.

**3. Medir o eixo in-play, que é onde deve estar o ganho grande.** O relatório de hoje mediu **0,59 leituras in-play por mapa** na Pinnacle guest contra 5,60 da Betby, e atribuiu parte ao cache. Com um endpoint sem cache dá pra saber quanto era cache e quanto era o livro. **Isso não foi medido — é a próxima pergunta, não um resultado.**

**4. Olhar o bug da seção 3.5** (`parseRelatedMarkets` sem tiebreak por `version` para `total` em série ao vivo). Contamina o underkill livebet.

**5. Aumentar a cobertura do `odds_timeline`** se quiser que o teste histórico volte a ter n grande. Hoje 60 de 99 bets elegíveis caem fora porque a série nunca foi capturada.

⚠️ Nada aqui é mudança executada. É diagnóstico + recomendação; mexer na captura é decisão do Elvis.

---

## 7. Ressalvas honestas

- **A comparação forte tem n=44 células, em ~25 minutos, num domingo, com 7 séries.** Cobre LCS, LEC, LCK CL, CBLOL, Circuito Desafiante e LRN — **não** cobre LCK, LPL ou LEC em horário de pico. A conclusão de "mesmo livro" apoia-se sobretudo nos **ids de matchup idênticos**, que não dependem de n.
- **Só 1 série estava ao vivo** durante toda a coleta. Tudo que digo sobre comportamento in-play é n=1 série: **observação, não conclusão.**
- **O teste histórico tem n=31, não centenas.** O limitante é a cobertura do `odds_timeline` (existe só desde 05/08). Está declarado em 4.1.
- **O resíduo de preço histórico (mediana 0,085) ficou sem explicação fechada.** Atribuo a timing in-play com base em inspeção caso a caso, mas **não consegui provar** porque não tenho o instante da bet. Fica registrado como aberto.
- **Não conectei no STOMP WebSocket** (`wss://pinnacle.bet.br/client/ws/connect`, guest/guest). É provavelmente o canal de tempo real do site e pode ser melhor que o REST. Não testado.
- **A conta que estava logada é `api123` com saldo R$ 0,00.** Nada do que medi passou por conta nenhuma — foi tudo deslogado — mas registro que **limites, stake máxima e eventual oferta personalizada de uma conta real não foram e não podem ser testados por aqui.** "Mesmo preço público" ≠ "mesma oferta pra conta dele".
- **Ladder depth é parâmetro, não livro** (seção 2.3). Uma versão intermediária desta análise concluiu "escada mais estreita no BR" e estava errada.
- **Nenhuma escrita em banco. Nenhum script de produção alterado. Nenhum login, credencial ou cookie. Todo tráfego pelo proxy SOCKS5 (saída 200.152.145.216). Zero 403.**

---

## Fontes

**Coleta própria (só GET, deslogado, via proxy):**
- `pinnacle.bet.br/` + `main.b206ee6480b50442.js` + `runtime.16d2635f5c58f3ba.js` + 35 chunks lazy
- `sports2.pinnacle.bet.br/pt/` + `member/bundles/{framework,page.sports,init}.js`
- `sports2.pinnacle.bet.br/sports-service/sv/{odds/events,odds/es-leagues,odds/periods}`
- `guest.api.arcadia.pinnacle.com/0.1/{sports/12/matchups,matchups/{id}/markets/related/straight}` via `.claude/scripts/lib/pinnacle_core.cjs`
- 3 snapshots pareados (`r1`,`r2`,`r3`) + poll pareado de 10 ticks × 60 s

**Supabase (leitura):** `bets` (460 pinnacle, excluído SIMULATED), `odds_timeline` (8.444 rows com ladder; 4.604 Pinnacle, 05/08→23/08)

**Repo:** `.claude/scripts/lib/pinnacle_core.cjs`, `knowledge/reports/2026-08-23-teste-defasagem-odd-guest-pinnacle.md`

**Externo:** a2fbr.com.br (6 marcas, 2 portarias SPA) · migalhas.com.br/quentes/422692 (Bichara assessora A2FBR) · first.bet/matchbook-launches-in-brazil (padrão de licenciamento de marca no grupo) · aposta10.com (Pinnacle: conta/saldo do .com não migram pro .bet.br) · pinnacle888.com (marca B2B da Pinnacle, referenciada no `og:image` do `sports2`)
