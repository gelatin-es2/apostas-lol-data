# Execução da FASE 3 — higiene do banco (2026-08-23)

Contrato: `knowledge/plans/2026-08-23-plano-execucao.md`, seção FASE 3. Aprovação do Elvis: "pode executar".
Fase 1 (coletor BR, captura no apito, parser live) é de outro agente — nenhum arquivo dele foi tocado.

---

## Veredito em uma linha

As quatro tarefas foram executadas. **A maior descoberta é que duas das premissas do plano estavam erradas:**
o `cron-data/*-results.json` nunca parou (o clone local é que está 17 commits atrás), e as 439 bets
SIMULATED já estavam marcadas três vezes no dado — quem mente é a *query*, não o banco.
Escrita real em produção: **2.341 linhas** (502 em `bets`, 1.839 em `odds_timeline`), zero erro, zero deleção.

---

## Backup

`cron-data/snapshots/bets-2026-08-23.json` — 1.309 bets, 3.908 KB, tirado **antes** de qualquer escrita
via `node .claude/scripts/export-bets-snapshot.cjs`.

```
[export-bets-snapshot] 2026-08-23
  fetching rows 0–999...    got 1000 rows
  fetching rows 1000–1999... got 309 rows (total so far: 1309)
  snapshot salvo: cron-data\snapshots\bets-2026-08-23.json (1309 bets, 3908 KB)
```

`odds_timeline` não foi exportada: a operação lá foi **só preencher coluna NULL** (`riot_game_id`,
`game_clock_s`), nunca sobrescrever valor existente — o alvo da query é literalmente
`riot_game_id=is.null`. O rollback é `set riot_game_id = null` na janela de datas.

---

## Limitação estrutural que moldou tudo: não existe caminho de DDL

Checado antes de planejar, não assumido:

| Caminho | Resultado |
|---|---|
| `psql` | não instalado |
| Supabase CLI | não instalado |
| `DATABASE_URL` / senha do banco / PAT `sbp_` | não existe no `.env`, no ambiente, nem no repo |
| RPC `exec_sql` | não existe — os únicos 9 RPCs expostos são do `bet_upload` |

É consistente com o histórico do projeto: `.claude/scripts/sql/*.sql` dizem *"Rodar UMA VEZ no SQL
Editor do painel Supabase"*. **DDL aqui é sempre aplicada à mão pelo Elvis.**

Consequência: coluna nova (`is_simulated`, `bet_phase`) e conserto de view viraram **migration pronta
pra colar**, não execução. Tudo que dava pra fazer por PostgREST **foi feito**.

- `migrations/2026-08-23-fase3-flags.sql`
- `migrations/2026-08-23-fase3-flags.rollback.sql`

---

## 3.1 — as 439 bets SIMULATED

### O que foi medido (não herdado do relatório de 08/08)

| | n | profit |
|---|---:|---:|
| `bookmaker='SIMULATED'` | **439** | **R$ 51.230,00** |
| reais | 870 | R$ 151.641,05 |
| total no banco | 1.309 | R$ 202.871,05 |

Os números de 08/08 (439 / R$51.230) **bateram exatamente**.

### A descoberta: o dado já estava marcado 3×

| marcador | cobertura nas 439 | falso positivo nas 870 reais |
|---|---:|---:|
| `bookmaker = 'SIMULATED'` | 439/439 | 0 |
| `raw_extraction.simulated = true` | 439/439 | 0 |
| `notes` começando com `"SIMULATED"` | 439/439 | 0 |

**Não escrevi marcação nova no banco, de propósito.** Um quarto marcador redundante não conserta nada
e seria escrita em produção sem ganho. O buraco nunca foi o dado — é a query que esquece de filtrar.

Também **rejeitei** a alternativa de trocar `status` (`green`→`sim_green`), que tornaria a exclusão
automática em toda query `status in ('green','red')`: quebraria os 5 consumidores que usam as SIMULATED
**de propósito** (`lib/analiseStats.cjs`, `compute_real_bets_method.cjs`, `build_milio_dashboard_data.cjs`,
`track-observation-variants.cjs`, aba Método do dashboard). Raio de dano maior que o problema.

### Auditoria dos consumidores de PnL

| consumidor | filtra SIMULATED? | situação |
|---|---|---|
| `dashboard/index.html` | ✅ sim (`.neq('bookmaker','SIMULATED')`, 2×) | ok, nada a fazer |
| `lib/analiseStats.cjs` | ✅ sim (dedup defensiva + tratamento próprio) | ok, usa de propósito |
| `rebuild_dashboard_stats_cron.cjs`, `compute_real_bets_method.cjs`, `build_milio_dashboard_data.cjs`, `backfill-fair-columns.cjs`, `scripts/analysis/*`, `track-observation-variants.cjs` | ✅ sim | ok |
| `daily_briefing.cjs` | n/a | não consulta `bets` |
| **`quant-query.cjs`** | ❌ **NÃO** | **corrigido — era o único** |
| **view `bets_summary`** | ❌ **NÃO** | **precisa de DDL — no passo 4 da migration** |

### Correção aplicada: `quant-query.cjs`

Era o pior caso possível — é a ferramenta de análise ad-hoc que o COO e os subagentes usam o tempo todo.

**Antes** (`node .claude/scripts/quant-query.cjs`, sem filtro):
```
"matched": 1300,  "hit_rate": 0.6215,  "profit": 203810.11,  "roi": 0.1614
```
**Depois** (padrão passou a excluir backtest):
```
"universe": { "total_bets": 1309, "simulated_no_banco": 439,
              "simulated_excluidas": 439, "simulated_profit_fora_da_conta": 51230 },
"matched": 861, "hit_rate": 0.6272, "profit": 152580.11, "roi": 0.1827
```
Diferença: **R$ 51.230,00 exatos** de lucro que não existia (+33,6% de inflação no número reportado).

- Exclusão por qualquer um dos 3 marcadores (redundante de propósito).
- `--include-simulated` recupera o comportamento antigo pra quem quiser olhar backtest.
- A saída **sempre** informa quantas foram excluídas e quanto lucro ficou fora — nenhum número sai
  daquele script sem contexto.

### A view `bets_summary` também mente

Não estava no escopo, apareceu na auditoria. Prova:
`bets_summary` do dia `2026-04-01` → `total=2, profit=-170,00`. As **duas** bets daquele dia são SIMULATED.

Conserto exige DDL → passo 4 da migration. **Escrito como 2 passos de propósito**: primeiro
`pg_get_viewdef` pra ver a definição real, depois trocar. Não colar de memória.

---

## 3.2 — o que "parou em 15/08"

### (b) `cron-data/*-results.json` — **FALSO ALARME, nada quebrado**

O cron do GitHub Actions **nunca caiu**. Rodou hoje e passou:

```
completed  success  Apostas LoL — daily cron   main  schedule  32639022231  10m16s  2026-08-23T12:18:35Z
```
e commitou (`10 files changed, 119482 insertions(+)`).

```
$ git fetch origin
   39347b9..7d4d228  main -> origin/main
$ git log --oneline -1                    # local
24bc4be Add fair-pinnacle captures 2026-08-01..16
$ git log --oneline -1 origin/main
7d4d228 cron: 2026-08-23T12:28Z
$ git rev-list --left-right --count HEAD...origin/main
0   17                                     # 0 à frente, 17 atrás
$ git ls-tree --name-only origin/main cron-data/ | grep results | tail -5
cron-data/2026-08-20-results.json
cron-data/2026-08-21-results.json
cron-data/2026-08-22-results.json
cron-data/2026-08-23-results.json
```

**A causa é o clone local estar 17 commits atrás do origin.** Os 8 dias "que só existiam via
`game_drafts`" existem em `origin/main` desde sempre.

⚠️ **NÃO rodei `git pull`.** O working tree tem **221 arquivos modificados**, incluindo os arquivos que
o outro agente está editando agora (`lib/pinnacle_core.cjs`, `capture_pinnacle_to_supabase.cjs`).
Puxar 17 commits sobre isso é ação de alto risco que eu não pedi e pode atropelar trabalho em voo.
**Ação pro Elvis:** combinar com o outro agente e então `git pull --ff-only` (é fast-forward limpo:
0 commits locais à frente).

Observação de brinde: falta `cron-data/2026-08-18-results.json` em `origin/main` (16, 17, **19**, 20…).
Um dia isolado, não um cron parado. Não investiguei — fora do escopo.

### (a) `link-odds-to-riot.cjs` — **estava parado de verdade; religado**

**Por que parou:** não estava em agenda nenhuma. Não está em nenhum dos 5 workflows, não está em
nenhuma task do Task Scheduler (checado: `LolFairAutoCapture`, `LolPinnacleWatcher`, `LolBetbyWatcher`,
`ApostasLoL-SettlePending`, `ApostasLoL-BetUploadWatcher`, 2 log-rotates — nenhuma o chama). O único
lugar que o cita é `package.json` como script npm manual. **Rodou à mão umas duas vezes em agosto e
acabou.** Última linha linkada: `captured_at = 2026-08-15`.

O script em si **não tinha bug** — dry-run rodou de primeira.

**Backfill executado, em 5 lotes com contagem entre cada um:**

| lote | alvo | linkadas | erros | SEM link (depois) | COM link (depois) |
|---|---:|---:|---:|---:|---:|
| *(antes)* | — | — | — | 3.295 | 210 |
| 2026-08-16..17 | 730 | 395 | 0 | 2.900 | 605 |
| 2026-08-18..19 | 475 | 193 | 0 | 2.707 | 798 |
| 2026-08-20..21 | 775 | 411 | 0 | 2.297 | 1.209 |
| 2026-08-22..23 | 853 | 600 | 0 | 1.697 | 1.809 |
| 2026-08-01..15 | 463 | 241 | 0 | **1.457** | **2.050** |

**Total: 1.840 linhas linkadas, 0 erros de PATCH, 0 séries ambíguas.** Cada lote fechou exatamente
(`COM link` subiu exatamente o `patched` de cada rodada).
`game_clock_s` foi junto: **123 → 1.315 linhas** (+1.192).

Cobertura de `phase=live, map>=1`: **6,0% → 58,5%**.

*(No lote 20..21 o `SEM link` fechou em 2.297 em vez de 2.296 — 1 linha nova entrou durante a
execução. Os watchers de captura estão rodando 24/7; é esperado, não é divergência.)*

**Os 1.457 que sobraram — e por quê (dry-run final, `rows_would_link: 0`, ou seja: nada mais é
linkável hoje):**

| motivo | linhas |
|---|---:|
| `no_draft_for_map` — série resolveu, mas `game_drafts` não tem aquele mapa (Pinnacle cota map 3/4/5 que nunca foi jogado, ou o draft não foi capturado) | 1.049 |
| 32 séries `not_found` — ligas fora do lolesports | ~408 |
| ambíguas | **0** |

Ligas dos `not_found`: Circuito Desafiante, LCP, LES, TCL, Rift Legends, LPL avulso, LCK CL, EWC
qualifiers. O linker **pula em vez de chutar** — comportamento correto, é a regra dura do projeto.

*(Na conferência final, ~40 min depois, o número já estava em 1.497 e não 1.457: os watchers captaram
linhas novas nesse meio-tempo. `COM riot_game_id` seguiu em 2.050 — nada regrediu, é só jogo novo
entrando. É exatamente o que a execução diária do linker passa a varrer.)*

**Agenda recorrente:** adicionado ao `.github/workflows/daily-cron.yml`, janela de 4 dias, idempotente.

> ⚠️ **Não usei o Task Scheduler** — está explicitamente fora do meu escopo (é do outro agente).
> O GitHub Actions foi a alternativa certa: o script só precisa de Supabase + API lolesports, sem proxy.
> Precisou de `LOLESPORTS_API_KEY` no `env:` do job (`lolesports-find-match.cjs` lê do ambiente,
> ao contrário dos outros scripts que trazem a key pública hardcoded). O secret **já existia** no repo
> (`gh secret list`: `LOLESPORTS_API_KEY`, criado 2026-08-12) — não criei credencial nenhuma.

> 🔴 **A agenda só passa a valer depois do push.** A edição do workflow está só no working tree local.
> Push é ação externa e exige aprovação separada — **não fiz**.

---

## 3.3 — flag PRÉ vs LIVE em `bets`

### Escrito no banco: 502 linhas

Como não dá pra criar coluna, gravei em `raw_extraction.bet_phase` (`'pre'`/`'live'`) +
`raw_extraction.bet_phase_meta` (evidência, versão da regra, timestamp). O passo 2 da migration
**promove esse jsonb pra coluna `bet_phase`** com um `update` determinístico — nenhum trabalho é perdido.

Script novo: `.claude/scripts/backfill-bet-phase.cjs` (dry-run por padrão, `--apply`, `--undo`,
lotes de 25, re-lê cada linha imediatamente antes de escrever pra não atropelar o hook de settle).

| | antes | depois |
|---|---:|---:|
| `bet_phase = 'live'` | 0 | **41** |
| `bet_phase = 'pre'` | 0 | **461** (439 SIMULATED + 22 reais) |
| NULL | 1.309 | **807** |

```
lote 1: 25 gravadas, 0 erros  ...  lote 19: 461 gravadas, 0 erros
"mode": "APPLY", "rows_a_escrever": 461, "written": 461, "errors": 0
```
Validação direto no banco depois:
```
live: 41   pre: 461   total: 1309   (sem fase: 807)
SIMULATED: 439 | delas marcadas pre: 439 | pre REAIS: 22
```
Idempotência provada: segunda execução → `rows_a_escrever: 0, written: 0`.

### As 41 bets LIVE: **+R$ 16.139,14**

Reconcilia com o número do relatório de mineração (R$16.966 por grep, que o próprio relatório
classificou como *"indicativo, não auditável"*). Agora é auditável: cada linha carrega a evidência
que a classificou.

### Como classifiquei — e o que recusei classificar

Regra dura: **só evidência explícita. Sem evidência = NULL.** Revisei as 47 candidatas **uma a uma**.

Armadilhas reais que encontrei no dado (todas custaram falso positivo antes de eu apertar a regra):

1. **`"livestats"` não é evidência de live** — é a fonte de settle. Aparecia em 48 notas, incluindo
   uma que dizia literalmente *"PRÉ-DRAFT"*.
2. **Negação** — *"Bet AO VIVO (… nao pre-jogo)"* e *"Bet PRE-JOGO (nao live)"* caíam as duas como
   conflito. Negações são neutralizadas antes do match.
3. **`"pre-jogo"` solto não serve** — aparece em *"a fair pre-jogo capturada pela Pinnacle"*, que fala
   da **fair**, não da aposta.
4. **Busca livre no `raw_extraction` inteiro dá falso positivo** — *"ao vivo"* enterrado no
   `match_context` de bet pré-jogo. Só campos estruturados específicos contam.
5. **Ordem das palavras** — *"Live bet no mapa 2"* e *"Punt live"* precisavam de regra própria; sem
   ela eu perdia 2 bets ao vivo legítimas.

**10 candidatas foram revisadas e recusadas** (ficam NULL de propósito, com o motivo registrado em
`REVIEWED_NOT_LIVE` dentro do script, e uma trava que aborta se alguma delas voltar a ser classificada
como live):

| id | por que NÃO é live |
|---|---|
| `46020d9a` `ec843afb` `f3c6904e` `1118b90c` | *"~fair da linha live"* fala da **linha**, não da aposta |
| `4dfb5f27` | *"ML pre/live no mapa 1"* — o próprio autor não sabia |
| `aa63f193` | *"stream do jogo ao vivo"* — o **stream** usado pra inferir o match |
| `4fca391f` | *"selected_reason=live"* é motivo do match-finder + estado da **série** |
| `f5c613da` | contraditório: lolesports *"unstarted, sem frames ao vivo"* × casa mostrando AO VIVO |
| `d28c0ff6` `e75cb380` | *"mercado ao vivo se moveu"* — o **mercado**, não prova sobre a aposta |

### ⚠️ Achado importante: `match_context.state` NÃO serve pra isso

Parece o campo óbvio (248 bets reais têm), mas é o estado da **SÉRIE** no schedule no momento do
registro. **Uma bet de mapa 2 feita pós-draft aparece com `state: "inProgress"` e é PRÉ.**
É a mesma armadilha do item 3.4. Quem usar `state` como proxy de "aposta ao vivo" erra.

Idem `bet_datetime`: é o `startTime` do match, **não a hora da aposta** (documentado no CLAUDE.md).
Não dá pra inferir fase por relógio — só 33/1.309 bets têm hora real.

### Ficaram NULL: 807 (todas reais), R$ 129.015,90

Não são erro — é a resposta honesta. Sem marcação no `notes` e sem campo estruturado, não há como
provar a fase. **Chutar aqui envenena exatamente a análise que a flag existe pra salvar** (o artefato
"linha abaixo da fair acerta 80%"). Pra reduzir esse número só há dois caminhos: o Elvis marcar no
registro daqui pra frente (já encaminhado abaixo), ou revisão manual do histórico com ele.

### Gravação de bets novas — ajustado

O ponto de escrita (`supabase-save-bet.cjs`) **não precisou mudar**: `raw_extraction` é passthrough,
então `bet_phase` no payload já é salvo. Deliberadamente **não** mexi na validação daquele script —
é o caminho crítico de registro de aposta, tem contrato versionado e 36 testes; tornar o campo
obrigatório é mudança que quebra e precisa de decisão do Elvis.

Quem mudou foi o **produtor**, os dois checklists do bet-logger:
- `.claude/agents/bet-logger.md`
- `~/.claude/agents/bet-logger.md`

com a instrução do campo, o aviso de que `match_context.state` não responde isso, e a regra
**"na dúvida, OMITA"**.

---

## 3.4 — o `phase` enganoso de `odds_timeline`

`phase='live'` é a fase da **SÉRIE** na leitura da Pinnacle, não a do mapa daquela linha
(`capture_pinnacle_to_supabase.cjs:265` — arquivo do outro agente, **não editado**).

### Quantifiquei a contaminação

Linhas `phase='live'`, `map_number>=1`, desde 13/08, confrontadas com a fase real do mapa:

| `odds_timeline.phase` | fase REAL do mapa | linhas |
|---|---|---:|
| live | **live** ✅ | 1.303 |
| live | **pre** ❌ | **705** |
| live | **post** ❌ | 9 |
| live | sem âncora (indeterminável) | 1.228 |

**31,6% das linhas com âncora que se dizem `live` são, pro mapa delas, PRÉ-JOGO** (705 de 2.228).
Numa BO3, enquanto o mapa 1 rola a Pinnacle já cota o mapa 2 — e essa leitura entra com `phase='live'`.

Isso é dinheiro: qualquer conclusão sobre "under ao vivo" tirada de `where phase='live'` está
misturando linha pré-mapa com in-play.

### Entregue

**1. Helper reutilizável — `lib/mapPhase.cjs`**

- `deriveMapPhase({capturedAt, firstFrameUtc, lastFrameUtc})` → `'pre'|'live'|'post'|null`, função pura.
- `buildMapPhaseIndex(url, key, {from, to})` → índice consultável, `idx.phaseOf(row)` devolve
  `{phase, source, confident}`.
- Duas fontes independentes, nessa ordem: `game_drafts.first_frame_utc/last_frame_utc` (relógio da
  Riot) e, como fallback, `closing_lines.first_seen_live_at` (1ª leitura live daquele mapa na própria
  Pinnacle — a DDL de 04/08 já criava esse campo justamente como âncora independente da Riot).
- Sem âncora → **`null`**, nunca chute. `confident: false` marca quando não dá pra separar
  `live` de `post`.

Testes contra produção:
```
ok  {capturedAt 10:00, firstFrame 10:30}                 -> pre
ok  {capturedAt 10:45, firstFrame 10:30, last 11:10}     -> live
ok  {capturedAt 11:30, firstFrame 10:30, last 11:10}     -> post
ok  {capturedAt 11:30}                                    -> null
indice: {drafts_indexados:219, closings_indexados:506, closings_com_first_seen_live:252}
```

**2. Documentado onde quem consulta vai ver**, em três lugares:
- `.claude/scripts/sql/2026-08-04-odds-capture.sql` — aviso em bloco na definição da tabela, com os números
- `.claude/scripts/README.md` — nova seção **"Armadilhas de consulta — ler antes de escrever query"** (4 itens)
- `migrations/2026-08-23-fase3-flags.sql` — `comment on column public.odds_timeline.phase`, que fica **no
  próprio banco** (aparece no painel do Supabase e em qualquer introspecção)

---

## O que NÃO foi feito, e por quê

| item | motivo |
|---|---|
| Criar as colunas `is_simulated` / `bet_phase` | Sem caminho de DDL (ver seção acima). Migration pronta pra colar. |
| Consertar a view `bets_summary` | Idem — DDL. Passo 4 da migration, em 2 tempos (inspecionar → trocar). |
| `git pull` dos 17 commits | 221 arquivos dirty, outro agente trabalhando no tree. Alto risco, iniciativa minha → não faço sem combinar. |
| `git push` do workflow + scripts | Ação externa, exige aprovação separada. |
| Tornar `bet_phase` obrigatório em `supabase-save-bet.cjs` | Caminho crítico de registro, contrato versionado, mudança que quebra. Decisão do Elvis. |
| Investigar o `2026-08-18-results.json` faltando | Fora do escopo; anotado. |
| Reduzir os 807 NULL de `bet_phase` | Não há evidência no dado. Chutar é pior que NULL. |

**Teste que falha e não é meu:** `run-tests.cjs` dá 35/36. O que falha é
`finder: alias legado DNF da Polymarket encontra DNS / DN SOOPers da API` — bate na API lolesports e
mexe com aliases de time. Não toquei nesses arquivos; `lolesports-find-match.cjs` e
`team-aliases.json` já estavam modificados no working tree antes de eu começar.

---

## Como reverter

| o quê | como |
|---|---|
| `bet_phase` nas 502 bets | `node .claude/scripts/backfill-bet-phase.cjs --undo --apply` (remove as 2 chaves, preserva o resto do `raw_extraction`). Rede de segurança: `cron-data/snapshots/bets-2026-08-23.json`. |
| `riot_game_id`/`game_clock_s` nas 1.840 linhas | `update odds_timeline set riot_game_id=null, game_clock_s=null where captured_at >= '2026-08-01' and riot_game_id is not null;` — mas note que 210 dessas já eram legítimas de antes. Nada foi sobrescrito: só NULL virou valor. |
| Migration (se aplicada) | `migrations/2026-08-23-fase3-flags.rollback.sql`. ⚠️ o rollback da `bets_summary` depende de você ter salvo o `pg_get_viewdef` no passo 4a — por isso o passo existe. |
| Mudanças em arquivo | Nada foi commitado nem pushado. `git diff` / `git checkout --` nos arquivos abaixo. |

**Arquivos alterados/criados (todos só no working tree local):**

```
novo    migrations/2026-08-23-fase3-flags.sql
novo    migrations/2026-08-23-fase3-flags.rollback.sql
novo    .claude/scripts/backfill-bet-phase.cjs
novo    lib/mapPhase.cjs
novo    knowledge/reports/2026-08-23-execucao-fase3.md
edit    .claude/scripts/quant-query.cjs            (exclui SIMULATED por padrão)
edit    .github/workflows/daily-cron.yml           (step do linker + LOLESPORTS_API_KEY)
edit    .claude/scripts/sql/2026-08-04-odds-capture.sql   (só comentário)
edit    .claude/scripts/README.md                  (armadilhas de consulta + 2 scripts na tabela)
edit    .claude/agents/bet-logger.md               (contrato do bet_phase)
edit    ~/.claude/agents/bet-logger.md             (idem, versão global)
```

---

## Pendências pro Elvis (em ordem de valor)

1. **Colar `migrations/2026-08-23-fase3-flags.sql` no SQL Editor.** Sem isso, `bets_summary` continua
   somando R$51.230 de backtest, e as flags seguem só em jsonb.
   No passo 4, rodar o `pg_get_viewdef` **antes** de trocar a view.
2. **Combinar com o outro agente e `git pull --ff-only`** — o clone local está 17 commits atrás.
   Enquanto não puxar, qualquer análise que leia `cron-data/` local vai achar que o mundo parou em 15/08.
3. **Aprovar o push** — a agenda do linker só existe depois que o `daily-cron.yml` chegar no GitHub.
4. Decidir se `bet_phase` vira campo obrigatório no `supabase-save-bet.cjs` (hoje é opcional e o
   bet-logger foi instruído a preencher).
