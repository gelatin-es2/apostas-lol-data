# Execução Fase 1 — fair fresca (2026-08-23)

Origem: `knowledge/plans/2026-08-23-plano-execucao.md`, aprovação do Elvis "pode executar" (23/08).
Escopo executado: **só Fase 1** (1.1, 1.2, 1.3). Fase 3 (higiene de banco) é de outro agente —
não toquei em `settle-pending-bets.cjs`, `link-odds-to-riot.cjs`, `supabase-save-bet.cjs`, nem em
migrations/SQL de `bets`.

Princípio respeitado em tudo: **nada que já rodava foi desligado.** `capture_pinnacle_to_supabase.cjs`
(coletor `.com` via GHA), `capture_pinnacle_kills_auto.cjs` + `promote_fair_pinnacle_auto.cjs`
(Task Scheduler `LolFairAutoCapture`, grade de 30min) continuam exatamente como estavam.
`promote_fair_pinnacle_auto.cjs` não foi tocado — nenhuma fonte foi promovida.

---

## 1.1 — Coletor BR sem cache

### O que foi descoberto (schema do payload — não documentado pela Pinnacle)

Endpoint confirmado: `GET https://sports2.pinnacle.bet.br/sports-service/sv/odds/events
?sp=12&mk=3&ot=1&btg=1&o=1&l=9&cl=9&v=0&me=0&more=false&c=BR&tm=0&pa=0&pn=-1&_g=1`
— HTTP 200 deslogado, `cf-cache-status: DYNAMIC`, sem `Age`/`max-age`.

O payload é **array por posição** (não objeto nomeado como o `.com`). Reverse-engineering feito
por comparação campo-a-campo, ao vivo, contra `guest.api.arcadia.pinnacle.com` no MESMO
matchupId no mesmo instante (matchupIds são idênticos entre as duas fontes — confirmado no
relatório `2026-08-23-pinnacle-br-vs-internacional.md`). Mapeamento completo documentado em
[`pinnacle_br_core.cjs`](.claude/scripts/lib/pinnacle_br_core.cjs) (cabeçalho do arquivo).

**Confirmado com confiança** (validado contra `.com` no mesmo instante — 28.5 @ 2.080/1.689 no
BR contra 28.5 @ 2.07/1.699 no `.com`, ~3min de diferença de leitura, mesma direção de vig):
matchup_id, series_id (parentId), league, team_home/away, start_time, map_number, main_line,
over_dec, under_dec, juice_pct, ladder completa de Total Kills.

**Deixado `null`, documentado, não inventado** (por falta de confiança na decodificação no
tempo desta tarefa):
- `ml_home_us` / `ml_away_us` — período tem um slot 2-way adicional não decodificado
- `spread_main` / `team_totals` — ladder de spread tem shape de 11 campos, ambíguo
- `market_version` — BR não expõe um contador de versão equivalente ao `version` do `.com`;
  gravado como constante `0` (documentado). O delta-gating real é por `content_hash` (linha +
  ladder completos), igual ao coletor `.com`.

**Fase (pre/live):** derivada por tempo (`now >= start_time`), não por um flag do payload —
existe um candidato (`m[5]`, 0/1) mas só confirmei o lado negativo contra o `.com`
(`isLive=false`↔`0`) porque não havia jogo de LoL ao vivo real no momento da investigação
inicial. Documentado como aproximação, mesma semântica "nível de série" (não de mapa) que o
`.com` já usa hoje — limitação conhecida, tratada separadamente na Fase 3 (item 3.4).

### Achado de bônus durante a validação

Ao rodar o coletor pela primeira vez peguei uma série de LCS **realmente ao vivo** (Disguised ×
Sentinels). Cross-check contra o `.com` no mesmo instante mostrou exatamente o cenário do bug da
Fase 1.3: a Pinnacle já tinha criado um sub-matchup "live" novo (`1634647555`) e havia **3
sub-matchups de Kills conflitantes** (`1634499710`, `1634215320`, `1634500258`) todos com
`isLive=false` mas representando o mesmo mapa. Confirma que o fix da 1.3 era necessário e não
teórico.

### Arquivos

- [`pinnacle_br_core.cjs`](.claude/scripts/lib/pinnacle_br_core.cjs) — parsing + transporte
  (proxy SOCKS5 + retry/backoff + PARA em 403, mesmo padrão do `pinnacle_core.cjs`)
- [`capture_pinnacle_br_to_supabase.cjs`](.claude/scripts/capture_pinnacle_br_to_supabase.cjs) —
  coletor (1 execução = 1 leitura completa; sem loop de 60s porque o endpoint BR traz tudo numa
  única request — não precisa de 1 request por matchup como o `.com`)
- [`run-capture-pinnacle-br.cmd`](.claude/scripts/run-capture-pinnacle-br.cmd) — wrapper do
  Task Scheduler

### Evidência de funcionamento

Dry-run (antes de qualquer escrita):
```
[dry-run] matchups de Kills LoL vistos: 5
[dry-run] gravaria 12 row(s) em odds_timeline (source=br-sports2): ...
```

Escrita real, confirmada por SELECT no Supabase (contagem `content-range` da API):
- Antes de rodar: `0` rows com `source=eq.br-sports2`
- Após 1ª execução real: `12` rows
- Re-execução imediata (mesmo estado): `0` rows novas — **delta-gating confirmado**
- Disparo real via `schtasks /run` (Task Scheduler, não invocação manual): `+4` rows novas
  (matchup novo entrou na janela)
- Estado atual (rodando sozinho a cada 30min desde então): **19 rows** com `source=br-sports2`

Confirmei também que o coletor `.com` (fonte `pc-live`, watcher local já rodando) **continuou
gravando normalmente** pro mesmo `series_id` durante todo o teste — zero interferência entre as
duas fontes (o `content_hash` do BR inclui salt `'br-sports2'` propositalmente, pra nunca colidir
com o índice único `(series_id, map_number, phase, market_version, content_hash)` do `.com` —
sem isso, leituras idênticas entre as duas fontes seriam silenciosamente descartadas pelo
`ignore-duplicates`, furando a comparação que é o objetivo da Fase 1.4).

### Cadência agendada

Task Scheduler `LolFairAutoCaptureBR` — a cada 30min, começando de `00:00:00` (mesma grade da
`LolFairAutoCapture`, "mesma cadência é suficiente por ora" conforme o plano). Testado via
`schtasks /run` real, exit code 0.

**Como desligar:** `schtasks /delete /tn LolFairAutoCaptureBR /f` (ou desabilitar pelo Painel de
Tarefas Agendadas). Não afeta nada mais — é um coletor isolado, escreve só em `odds_timeline`
com `source='br-sports2'`, não é lido por nenhum script de produção ainda.

---

## 1.2 — Captura ancorada no apito

### O que foi implementado

[`schedule-fair-anchor-capture.cjs`](.claude/scripts/schedule-fair-anchor-capture.cjs): lê a
agenda oficial (lolesports API, via `LEAGUE_IDS` já exportado de `lolesports-find-match.cjs` —
reuso, não duplicação) pras próximas 20h, e cria **1 Windows Scheduled Task por jogo** com 2
`TimeTrigger` (start−30min e start−10min), disparando **exatamente o mesmo comando** que a
`LolFairAutoCapture` já roda (`run-capture-pinnacle-auto.cmd` → `capture_pinnacle_kills_auto.cjs`
+ `promote_fair_pinnacle_auto.cjs`). Não é uma captura nova — é a MESMA captura, só mais perto do
apito. Isso responde diretamente ao achado do relatório de defasagem (mediana 30min / média
117min de idade da fair no apito, 80% da culpa é a grade cega de 30min).

Idempotente: roda de novo e recria as mesmas tasks com `/f` (overwrite), sem duplicar. Descarta
anchors que já passaram (só cria o m10 se o m30 já passou; pula o jogo inteiro se os dois já
passaram). Faz limpeza automática de tasks de jogos cujo anchor mais tardio já passou há mais de
4h (mantém o Task Scheduler enxuto — estado rastreado em
`cron-data/fair-anchor/state.json`).

Uma task master (`LolFairAnchorScheduler`, a cada 1h) roda esse script pra descobrir jogos
novos/reagendados. **Não bate na Pinnacle** — só na lolesports API, que o projeto já usa pesado
em outros scripts; volume de requisição da Pinnacle não aumenta por causa disso (isso é feito
pelas próprias execuções ancoradas do `run-capture-pinnacle-auto.cmd`, que são a MESMA captura de
sempre, só com 2 disparos extras por jogo/dia).

### Arquivos

- [`schedule-fair-anchor-capture.cjs`](.claude/scripts/schedule-fair-anchor-capture.cjs)
- [`run-schedule-fair-anchor.cmd`](.claude/scripts/run-schedule-fair-anchor.cmd) — wrapper

### Evidência de funcionamento

Dry-run:
```
[fair-anchor] 4 jogo(s) 'unstarted' nas próximas 20h.
  [dry-run] agendaria LolFairAnchor-115548681803406167 (LEC NAVI vs FNC): 2026-08-24T14:30:00.000Z, 2026-08-24T14:50:00.000Z
  ...
```

Execução real + confirmação via `schtasks /query /v`: task `LolFairAnchor-115548681803406167`
criada com 2 `TimeTrigger` (11:30 e 11:50 horário local = 14:30/14:50 UTC, batendo com o
start_time do jogo −30min/−10min), ação idêntica à `LolFairAutoCapture`.

Disparo real da task master via `schtasks /run /tn LolFairAnchorScheduler`: exit code `0`,
log confirma as 4 tasks recriadas de forma idempotente.

Tasks no ar agora (`schtasks /query`):
```
LolFairAnchor-115548681803406167    24/08/2026 11:30:00   Pronto   (LEC NAVI vs FNC)
LolFairAnchor-115548681803406247    24/08/2026 13:45:00   Pronto   (LEC GX vs G2)
LolFairAnchor-116889604984222933    24/08/2026 01:30:00   Pronto   (KCL DNS vs KRX)
LolFairAnchor-116889604984222939    24/08/2026 05:00:00   Pronto   (KCL BFX vs HLE)
LolFairAnchorScheduler              (a cada 1h)
LolFairAutoCapture                  (INTOCADA — grade de 30min original)
```

**Pendente de validação real** (não dá pra provar sem esperar): que o disparo do dia 24/08
realmente reduz a idade da fair no apito pros jogos LEC/KCL de amanhã. Vou saber isso só quando
esses horários passarem — não é algo que dá pra confirmar hoje.

### Como desligar (reversível)

1. `schtasks /delete /tn LolFairAnchorScheduler /f` — para de criar novas tasks.
2. `node .claude/scripts/schedule-fair-anchor-capture.cjs --cleanup-only` — remove as já criadas
   (lê `cron-data/fair-anchor/state.json`, deleta cada `LolFairAnchor-*` do Task Scheduler e
   zera o estado).
3. `LolFairAutoCapture` nunca é tocada por nenhum dos dois passos acima.

---

## 1.3 — Fix do parser em série ao vivo

### Bug

Em série ao vivo, o `.com` publica 3 sub-matchups de Kills conflitantes (mesmo period,
`isAlternate=false` nos 3) ao mesmo tempo. `parseRelatedMarkets` já tinha tiebreak por `version`
pra moneyline/spread (`mlVersion`/`spreadVersion`), mas não pra `total` — o main line vinha por
ordem de chegada/pontos após sort, instável.

### Fix

[`lib/pinnacle_core.cjs`](.claude/scripts/lib/pinnacle_core.cjs) — adicionado `mainTotalVersion`
ao slot de cada período; ao processar uma row `total` não-alternada: version menor que a atual é
descartada, version maior descarta os candidatos principais anteriores e assume, version igual
mantém o 1º visto (empate determinístico). Ladder (`isAlternate=true`) não é afetada — só a
linha principal.

Diff isolado (confirmado via `git diff` — só essas linhas mudaram no arquivo, o resto do diff do
arquivo é trabalho pré-existente não commitado, não é meu, não toquei):
```js
mlVersion: -1, spreadVersion: -1, mainTotalVersion: -1,
...
if (rowVersion < slot.mainTotalVersion) continue; // challenger velho — descarta
if (rowVersion > slot.mainTotalVersion) {
  slot.totals = slot.totals.filter((t) => t.isAlternate);
  slot.mainTotalVersion = rowVersion;
} else if (slot.totals.some((t) => !t.isAlternate)) {
  continue; // empate de version — mantém o 1º principal já visto (determinístico)
}
```

### Teste

Novo arquivo:
[`.claude/scripts/tests/pinnacle-core-total-tiebreak.test.cjs`](.claude/scripts/tests/pinnacle-core-total-tiebreak.test.cjs)
— 5 casos, reproduzindo exatamente o cenário medido (27.5@1.763/v3, 27.5@1.877/v3,
26.5@2.01/v5), com ordem de chegada normal E invertida (prova que o resultado não depende mais
de ordem), empate de version, e regressão do caso sem conflito.

```
══ pinnacle_core — tiebreak de version pra total (série ao vivo) — resultado ══
PASS  3 sub-matchups conflitantes (isAlternate=false) no mesmo period → vence maior version
PASS  mesmo conflito, ORDEM DE CHEGADA invertida → resultado idêntico (não depende mais de ordem)
PASS  empate de version entre 2 candidatos principais → mantém o 1º visto, determinístico
PASS  ladder (isAlternate=true) não é afetada pelo tiebreak — sobrevive mesmo com version baixa
PASS  regressão — cenário normal sem conflito (1 fonte só) continua funcionando como antes
5/5 passaram
```

Suítes existentes rodadas depois do fix (regressão em quem mais consome `pinnacle_core.cjs`):
```
node .claude/scripts/tests/run-tests.cjs        → 35/36 passaram — 1 FALHOU
node .claude/scripts/tests/run-tests-fase3.cjs  → 46/47 passaram — 1 FALHOU
```
As 2 falhas são **pré-existentes e não relacionadas** ao meu fix:
- `finder: alias legado DNF da Polymarket...` — em `lolesports-find-match.cjs`, arquivo que eu
  não toquei (já estava modificado, não commitado, por trabalho anterior/da outra sessão).
- `weekly-review: domingo operacional futuro...` — teste sensível ao dia da semana do sistema,
  sem relação com Pinnacle.
Confirmado via `git diff` que meu único delta em `pinnacle_core.cjs` é o bloco acima — nada nos
caminhos de código que esses 2 testes exercitam.

### Achado de bônus

A validação real do item 1.1 (série LCS ao vivo real, ver seção acima) reproduziu o cenário
exato do bug na prática — não precisei simular tudo artificialmente para confirmar que o
problema é real e atual.

---

## Resumo — o que está rodando agora que não rodava antes

| Task Scheduler | Cadência | O que faz | Novo/existente |
|---|---|---|---|
| `LolFairAutoCapture` | 30min | Captura `.com` → `cron-data/*-fair-pinnacle-auto.json` → promove fair primária | **INTOCADA** |
| `LolFairAutoCaptureBR` | 30min | Captura BR sem cache → `odds_timeline` (`source=br-sports2`) | **NOVA** |
| `LolFairAnchorScheduler` | 1h | Lê agenda, cria/atualiza tasks de anchor | **NOVA** |
| `LolFairAnchor-<matchId>` (×4 hoje) | 2× por jogo (m30/m10) | Roda a MESMA captura da `LolFairAutoCapture`, ancorada no apito | **NOVA**, cria/expira dinamicamente |

Código:
| Arquivo | Status |
|---|---|
| [`lib/pinnacle_br_core.cjs`](.claude/scripts/lib/pinnacle_br_core.cjs) | novo |
| [`capture_pinnacle_br_to_supabase.cjs`](.claude/scripts/capture_pinnacle_br_to_supabase.cjs) | novo |
| [`run-capture-pinnacle-br.cmd`](.claude/scripts/run-capture-pinnacle-br.cmd) | novo |
| [`schedule-fair-anchor-capture.cjs`](.claude/scripts/schedule-fair-anchor-capture.cjs) | novo |
| [`run-schedule-fair-anchor.cmd`](.claude/scripts/run-schedule-fair-anchor.cmd) | novo |
| [`lib/pinnacle_core.cjs`](.claude/scripts/lib/pinnacle_core.cjs) | modificado (só o tiebreak de `total`, ver 1.3) |
| [`tests/pinnacle-core-total-tiebreak.test.cjs`](.claude/scripts/tests/pinnacle-core-total-tiebreak.test.cjs) | novo |

`promote_fair_pinnacle_auto.cjs`, `capture_pinnacle_to_supabase.cjs`, `capture_pinnacle_kills_auto.cjs`
— **não tocados**. Nenhuma fonte foi promovida.

## O que ficou pendente / precisa de decisão do Elvis

1. **Comparação br-sports2 × `.com` (item 1.4 do plano)** — só faz sentido depois de 1-2 semanas
   de coleta em paralelo. Nada a decidir agora, só deixar rodando.
2. **`ml_home_us`/`ml_away_us`/`spread_main`/`team_totals` do BR seguem `null`** — não decodifiquei
   esses mercados com confiança no tempo desta tarefa. Se algum método futuro precisar deles
   (hoje nenhum usa), é trabalho adicional de reverse-engineering.
3. **`market_version=0` constante pro BR** — documentado, funciona pro delta-gating (que é feito
   por `content_hash`), mas não é um "contador de versão real" como o `.com` tem. Se algum dia
   quiser decodificar isso, é possível, não fiz por falta de sinal claro na estrutura do payload.
4. **Fase (pre/live) do BR é aproximada por tempo, não por flag confirmado** — mesma limitação
   "nível de série" que o `.com` já tem hoje (Fase 3, item 3.4, é de outro agente). Não é uma
   regressão minha, é herdada por design (pra manter a comparação 1.4 justa).
5. **Efeito real do anchor de 1.2 na idade da fair no apito** — só mensurável depois que os
   horários de amanhã (24/08) passarem. Não dá pra confirmar hoje, só a mecânica (tasks criadas
   corretamente, ação idêntica à produção).

## O que NÃO foi feito (fora de escopo, por regra explícita)

- Nenhuma mudança em `promote_fair_pinnacle_auto.cjs`, `settle-pending-bets.cjs`,
  `link-odds-to-riot.cjs`, `supabase-save-bet.cjs`, migrations/SQL de `bets`.
- Nenhuma promoção de fonte — `br-sports2` só escreve em `odds_timeline`, não é lida por
  `promote_fair_pinnacle_auto.cjs` nem por nenhum script de produção.
- Fase 2 (regras de aposta) — não aprovada, não tocada.
