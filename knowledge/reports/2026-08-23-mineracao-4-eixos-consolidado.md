# Mineração 4 eixos — consolidado (2026-08-23)

Pedido do Elvis: "com todos os dados que você tem, busca outro padrão que eu possa abusar pra ganhar dinheiro".

Draft NÃO foi re-minerado — esgotado em 17/08 (12 agentes, dataset 8.585 mapas, resultado vazio).
Foram varridos os 4 eixos que nunca tinham sido olhados. 4 agentes independentes, ~590 células/comparações no total.

Reports-fonte:
- `2026-08-23-mineracao-eixo-contexto-partida.md`
- `2026-08-23-mineracao-eixo-execucao-preco.md`
- `2026-08-23-mineracao-eixo-live-ingame.md`
- `2026-08-23-mercados-alternativos-inventario.md`

---

## Veredito de uma linha

**Não apareceu método novo. Apareceu um vazamento grande: a régua do mapa 2.**
O resto do ganho disponível é execução (shopar odd) e proteção (vetos).

---

## 1. O achado que vale dinheiro — MAPA 2

A fair da Pinnacle no arquivo é **uma por série** (`applies_to_all_maps: true`). O mapa 2 é
sistematicamente mais sangrento que o mapa 1 da mesma série. Ou seja: o mapa 2 vem sendo
julgado com a régua do mapa 1.

Três pernas independentes:

| Perna | Número | n | Força |
|---|---|---|---|
| Kills m2 − m1 (pareado, mesma série) | **+1,67 kills** | 2.804 séries | t=7,34; 14/15 ligas; 4/4 períodos |
| Dentro do trigger | **+2,25 kills** | 190 | t=2,76 |
| Viés vs fair de série | **+0,78 kills** | 165 | Pinnacle REAL precifica por mapa (+0,59); o arquivo não |

Dinheiro real (sem SIMULATED, só pré-jogo):

| Slot | Hit | n | ROI |
|---|---|---|---|
| Mapa 2 | 55,6% | 207 | 7,9% (flat −2,2%) |
| Mapa 1 + Mapa 3 | 71,5% | 267 | 32,3% |
| **BO5 mapa 2** | **40,0%** | 50 | **−R$11.714** |

Gap −16,0pp, z=−3,61. Ordem de grandeza do vazamento: **~R$48 mil**.

**Ressalva honesta:** contra linha real POR MAPA (n=93) o viés some. O que está provado é que
**a régua está errada nesse slot** — não que o mapa 2 seja −EV contra o mercado.

**Proposta (NÃO implementada, aguarda martelo do Elvis):**
- No m2, exigir `linha ≥ fair_série + 1,5`; ou meia-stake com gate n≥50.
- **Não skipar** o slot — ele ainda deu +R$15.425 no acumulado.
- Consertar na fonte é melhor que regra de cabeça: fair por mapa em vez de por série.

**Flag associada (bandeira, não gatilho):** m2 depois de um m1 muito quente = **+2,14 kills**
(n=415, t=4,55). Pior spot de under do dataset.

---

## 2. Ganho de execução — shopar ODD na mesma linha

Único dinheiro comprovado do eixo de preço, e é pequeno mas certo.

- 50 mapas com 2 casas na **mesma linha**: delta mediano de odd **0,08** (máx 0,333).
- Perda já realizada: **R$2.659 em 64 bets**. Teto extrapolado: +R$13.745.
- Thunderpick bate Pinnacle em 13/17 duelos diretos (+0,061 médio); Pinnacle é 53% do volume.
- **Regra:** antes de confirmar no Pinnacle, olhar Thunderpick na mesma linha. ≥0,05 melhor → migra.

Isso é comparação de PREÇO do mesmo produto (mesmo jogo, mapa e linha), não performance por
casa — a doutrina de não analisar resultado por bookmaker não foi violada.

**Corolário:** escolher degrau de ladder **não paga nada** (+1 linha = −R$81, troca de sinal
entre as metades). Parar de gastar decisão nisso.

---

## 3. Proteção — vetos que economizam

- **Under do método entra PÓS-DRAFT, nunca esperando o jogo.** Mesmos 17 mapas Milio:
  pós-draft 76,5% (ROI +43,9%) × minuto 10 58,8% (ROI +10,7%). A linha cai 4,3 kills no caminho.
  Custo de esperar: **−R$22.560 em 9 dias**. 20 de 21 células concordam.
- **VETO: under ao vivo fora do trigger** = 31,4% hit, ROI −40,1% (n=35). Pior célula do levantamento.
- **Teto físico:** a Betby fecha o mercado de kills do mapa no minuto ~15-20 (p50=15). "Esperar
  o jogo definir" não é estratégia ruim — é impossível.
- **MAP 5 BO5 = matar a variante.** Efeito de kills real (−2,75, n=96, t=−3,21) mas dinheiro real
  n=18, 44,4%, −R$3.247; oferta ~1 mapa a cada 90. Vira linha na tabela de correção de fair,
  não gatilho. m5 segue 1u só com trigger normal.

---

## 4. Mercados alternativos — porta aberta, sem chave ainda

A casa abre **17 mercados de LoL**; a operação aposta em 1. Mas o sinal atual só serve pra kills:

| Correlação da fair de kills com… | r | Significativo? |
|---|---|---|
| Kills reais | 0,334 | Sim (t=2,98) |
| Torres | 0,062 | Não |
| Duração | 0,025 | Não |
| Dragões | −0,038 | Não |

- **Torres tem ladder FIXO** (mesmas 3 linhas, mesma odd, todo mapa; sd 0,013) — a casa não
  modela, só repete. `Torres under 11.5` precisa de só **0,4pp de edge** (BE 50,3%, base 49,8%)
  contra ~3,5pp em kills a 1,75. Degrau barato — falta o sinal pra subir nele.
- 🔴 **"Kills por time" é armadilha:** r=0,880 com total de kills. Mercado novo na aparência,
  77% a mesma aposta — e a casa modela ativamente.
- Torres/dragões/barões/duração são **um fator só** ("jogo longo"): dragões×duração r=0,841.
  Apostar nos 4 = 1 aposta em 4 bilhetes.
- Handicap de kills é o único ortogonal (r=0,055) — sem sinal e não testável hoje.

**Caminho barato (não executado):** `capture_betby_kills.cjs` já bate no endpoint que traz os 17
mercados — capturar todos é parsear mais IDs do MESMO payload, zero requests novos. Desfecho
(torres/dragões/barões por frame) sai do feed público da Riot; backfill leva o n de 287 pra milhares.

---

## 5. Cemitério — não re-minerar sem dado novo

| Hipótese | Veredito |
|---|---|
| Estado da série (0-1, 0-2) | Refutado — era o mapa 2 disfarçado |
| Playoff / eliminação / stakes | Morto — ROI 23,0% vs 25,2% regular |
| Back-to-back, patch novo, horário, dia da semana | Morto inteiro |
| Mismatch de força (stomp vs snowball) | Morto — se cancelam, zero monotonicidade |
| "Jogo lento explode no late" | Mito — corr +0,10/+0,15, persistência fraca, zero reversão |
| Gold diff prevê kills | Morto — r=+0,014 |
| Fade do movimento de linha | Morto — 12 células, nada com p<0,18 |
| Corte por gap linha−fair | Morto — some ao isolar bets solo sem ladder |
| CLV | Inconclusivo e roda ao contrário |
| Timing da aposta | **Não testável** — não existe hora real da aposta no banco |

---

## 6. Controle de acaso

- Contexto: 103 células pré-registradas, ~285 comparações. 8 células com |t|≥3 (esperado 0,26),
  **mas são 2 achados, não 8** — 6 são o mapa 2 reescrito. Pareado dá p≈1e-13; ×285 ainda p≈3e-11.
- Execução: ~320 células, Bonferroni |z|>3,8 — só a calibração da fair passa (z=7,24: 65,9% dos
  jogos com trigger fecham abaixo da fair, fair ~2,3 kills alta).
- Live: 146 células, menor p bruto 0,039 → **nenhum achado positivo sobrevive**. Os 2 vivos não
  dependem de p (comparação pareada + limite físico de mercado).
- Mercados: 38 hipóteses, 0 aprovações.

---

## 7. Dívida de dado — o que está furado (aguarda decisão do Elvis)

Ordem de prioridade:

1. **439 bets `bookmaker='SIMULATED'` seguem no banco com +R$51.230 de lucro fake.** Auditoria de
   08/08 achou e não marcou. Qualquer query sem filtro reporta lucro inflado.
2. **`link-odds-to-riot.cjs` parou em 15/08** — 3.070 rows de odds ao vivo (94%) sem link. Não está
   no cron. Barato de consertar.
3. **`cron-data/*-results.json` parou em 2026-08-15** — 8 dias só existem via `game_drafts`.
   Verificar se o cron caiu.
4. **Não existe flag PRÉ vs LIVE em `bets`** (131/1.296 têm `match_context.state`). Sem ela a
   análise de régua linha×fair MENTE — uma primeira versão mostrou "linha abaixo da fair acerta
   80%", artefato puro de bet live em jogo lento. As 35 bets live (+R$15.274) só foram achadas
   por grep em `notes`.
5. **Hora real da aposta** não é extraída (só 33/1.296) — bloqueia qualquer análise de timing.
   O slip da Pinnacle traz o dado.
6. `first_frame_utc` em 331 de 8.956 linhas de `game_drafts` — matou o teste de duração de mapa.
7. `underkill/data/` congelado em 13/08 (106 mapas vs 332 no banco).

Tabelas que **não existem** (checadas): `fair_lines`, `pinnacle_lines`, `odds_snapshots`, `live_state`.

---

## 8. Pendências que precisam de ação externa

- Probe da Pinnacle sem o filtro `units==='Kills'` — casa nº1, usa proxy, sensível. **Não executado.**
- Print da aba de mercados de Betano / Parimatch / EstrelaBet — oferta **não confirmada**.

---

## Nota metodológica

Todos os agentes foram instruídos a testar contra **linha real ofertada**, nunca contra "under vs
mediana" — régua provada descalibrada em 17/08 (o peel-morto passava nela com 57-60% e perdeu
R$27 mil). Onde não havia linha real, o achado foi classificado **NÃO TESTADO**, não aprovado.

Nenhuma escrita em banco. Nenhum arquivo de produção alterado — só relatórios.
