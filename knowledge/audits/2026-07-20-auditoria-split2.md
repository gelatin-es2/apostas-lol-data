# Auditoria completa do banco — Split 2 (2026-04-01 → 2026-06-30)

**Gerado em:** 2026-07-20T16:34:58.219Z
**Escopo:** 707 bets no período [2026-04-01, 2026-07-01) das 6 ligas Riot API (LCK/LPL/LEC/CBLOL/LFL/LCS) + 48 bets EWC (fora da Riot API, checklist manual). 756 bets totais no banco = 707 + 48 + 1 (bet MSI 2026-07-01, fora de ambos os escopos por data).
**Nota:** gerado por `scripts/audit/build-report.cjs` a partir de `audit-output/*.json` — re-rodável (`node scripts/audit/build-report.cjs`). Os spot-checks externos (gol.gg/ggscore) das seções 2 e 10 são verificação manual pontual de 2026-07-20, não recomputados a cada rerun.

---

## 1. Sumário executivo

| Categoria | Severidade | Contagem | Impacto R$ / observação |
| --- | --- | --- | --- |
| Kills/status (bet real 61507820) | CRITICAL | 4 findings / 1 bet | swing de -R$ 1.790,00 (declarado R$ 790,00, correto -R$ 1.000,00) |
| Kills/status (SIMULATED 2432691d, mesmo jogo) | CRITICAL | 2 findings / 1 bet | swing SIM de -R$ 1.830,00 (não é dinheiro real, afeta só stats do backtest) |
| Profit rounding (2 bets) | CRITICAL | 2 findings / 2 bets | -R$ 0,15 total (cosmético, float) |
| Cobertura — jogos elegíveis sem bet (MISSING_BET) | HIGH | 36 jogos | indeterminado — oportunidades de aposta não capturadas |
| Campos obrigatórios faltando (FIELD_MISSING) | HIGH | 4 bets | operacional — arrisca settle/backfill quebrar se repetir |
| Trigger divergente em bets (TRIGGER_MISMATCH) | MEDIUM | 3 bets | nenhum em R$ — não afeta profit, afeta rótulo de trigger |
| Trigger divergente em results.json (Alistar/pipeline arquivado) | MEDIUM | 30 jogos (11 Alistar) | fora de escopo — bug de código arquivado, não das bets |
| method_reports — trigger com Alistar | MEDIUM | 6 rows | não afeta bets — afeta só backtest histórico |
| Fair mismatch (fair_formula) | MEDIUM | 583 findings | NÃO é bug de bet — limitação de fonte histórica (ver §5) |
| Fair mismatch (fair_pinnacle null → backfill real) | MEDIUM | 10 findings | backfill legítimo via backfill-fair-columns.cjs |
| method_reports faltando (MR_MISSING) | MEDIUM | 274 / 418 jogos elegíveis | não afeta bets — backtest incompleto (66% dos jogos sem row) |
| Bookmaker case (estrelabet/EstrelaBet, pinnacle/Pinnacle) | LOW | 3 rows (de 181 nos 2 grupos) | cosmético |
| Duplicatas (dedup) | LOW | 8 bets (7 grupos) | redundância pequena no banco |
| SIM line generation (informativo) | INFO | 390 bets SIMULATED | informativo — não é erro |
| MANUAL_CHECK (kills não confiáveis via API) | INFO | 72 bets | requer conferência gol.gg/Leaguepedia manual |
| EWC (fora da Riot API) | — | 0 findings internos / 48 bets checklist manual | pendente conferência manual do CEO |

### Veredito

**Banco OK pro Split 3? COM RESSALVAS.**

1. **1 bet real com erro material confirmado externamente** (61507820, LPL LNG×LGD map 2, 2026-05-14): API/gol.gg concordam em 32 kills, pick "Menos de 25.5" perdeu, bet está `green R$ 790,00` e devia ser `red -R$ 1.000,00` — swing de -R$ 1.790,00 no registro de banca. Precisa correção antes do Split 3 (lote A), senão o histórico de ROI real do CEO carrega esse erro.
2. **36 jogos elegíveis (trigger ativo) sem bet correspondente** — não é erro de dado, é lacuna operacional: o método disparou e não gerou registro. Vale investigar causa raiz (SIMULATED devia ter sido gerada automaticamente e não foi?) antes do Split 3 pra não repetir.
3. **Volume de erro é baixo em proporção**: das 707 bets no escopo, só 4 têm finding CRITICAL (0,57%) e o grupo de controle de 37 bets settled automático em junho deu 0 mismatch — o pipeline funciona corretamente na maioria esmagadora dos casos.
4. **A maior contagem numérica (593 FAIR_MISMATCH) NÃO é bug de bet** — é limitação documentada da própria auditoria (fonte histórica `cron-data/*-results.json` não cobre tier2 e não é imutável). Não figura no veredito como erro real.
5. Ação recomendada: aplicar lote A (kills/status/profit) + lote C (campos obrigatórios) antes de 21/07, lote D (cobertura) como investigação prioritária mas não bloqueante pro início do split — nenhum fix roda sem aprovação por lote.

---

## 2. CRITICAL — kills/status/profit (lote A)

### bet `61507820-8d22-41d4-9f21-aed990f9b678` — estrelabet — LPL — LNG vs LGD GAMING (2026-05-14)

| Campo | Atual | Esperado | Evidência |
| --- | --- | --- | --- |
| match_context.total_kills | 0 | 32 | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |
| match_context.kills_blue | 0 | 21 | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |
| match_context.kills_red | 0 | 11 | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |
| status | green | red | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |

**Spot-check externo (gol.gg):** CONFIRMADO — blue (LNG) 21 kills, red (LGD) 11 kills, total 32 kills. Idêntico ao valor da API lolesports (kills_blue=21, kills_red=11, total=32). Pick "Menos de 25.5" perde (32 > 25.5) — bet devia ser red, está green.
URL: https://gol.gg/game/stats/78097/page-fullstats/

### bet `0f79cb9e-01a5-4b91-b2f6-0945090be420` — parimatch — LPL — WE vs LNG (2026-05-23)

| Campo | Atual | Esperado | Evidência |
| --- | --- | --- | --- |
| profit | 181.3 | 181.43 | {"stake":251.98,"odd":1.72,"formula":"stake*(odd-1)"} |

_(fora do escopo do spot-check externo desta rodada — evidência só via API lolesports, ver URL abaixo)_

### bet `2432691d-b598-4605-82cf-279dcef80321` — SIMULATED — LPL — LNG vs LGD GAMING (2026-05-14)

| Campo | Atual | Esperado | Evidência |
| --- | --- | --- | --- |
| match_context.total_kills | 0 | 32 | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |
| status | green | red | [window](https://feed.lolesports.com/livestats/v1/window/115615926685761093) |

**Spot-check externo (gol.gg):** CONFIRMADO — blue (LNG) 21 kills, red (LGD) 11 kills, total 32 kills. Idêntico ao valor da API lolesports (kills_blue=21, kills_red=11, total=32). Pick "Menos de 25.5" perde (32 > 25.5) — bet devia ser red, está green.
URL: https://gol.gg/game/stats/78097/page-fullstats/

### bet `b0481dab-6fb4-46e6-a4b3-33619f1f4ccd` — thunderpick — LCS — FlyQuest vs Sentinels (2026-05-30)

| Campo | Atual | Esperado | Evidência |
| --- | --- | --- | --- |
| profit | 2599.99 | 2600.01 | {"stake":4000.01,"odd":1.65,"formula":"stake*(odd-1)"} |

_(fora do escopo do spot-check externo desta rodada — evidência só via API lolesports, ver URL abaixo)_


---

## 3. HIGH — cobertura: 36 MISSING_BET (lote D)

Jogos do universo com trigger ativo (2peel ou 1peel+flex), frame confiável, e SEM bet correspondente no banco.

### Por liga/mês

| Liga | Mês | Qtd |
| --- | --- | --- |
| CBLOL | 2026-05 | 1 |
| LCK | 2026-05 | 4 |
| LCK | 2026-06 | 2 |
| LCS | 2026-05 | 1 |
| LCS | 2026-06 | 2 |
| LEC | 2026-05 | 3 |
| LEC | 2026-06 | 6 |
| LPL | 2026-05 | 4 |
| LPL | 2026-06 | 13 |

### Lista completa

| Liga | Data | Times | Mapa | Trigger | Kills B/R (total) | game_id |
| --- | --- | --- | --- | --- | --- | --- |
| LPL | 2026-05-30 | BILIBILI GAMING vs Xi'an Team WE | 1 | 1peel+flex | 9/18 (27) | `115616219464541926` |
| LPL | 2026-05-30 | Xi'an Team WE vs BILIBILI GAMING | 2 | 2peel | 23/39 (62) | `115616219464541927` |
| LPL | 2026-05-30 | BILIBILI GAMING vs Xi'an Team WE | 3 | 1peel+flex | 25/21 (46) | `115616219464541928` |
| LPL | 2026-05-31 | TOP ESPORTS vs Beijing JDG Esports | 1 | 1peel+flex | 3/18 (21) | `115616219464541932` |
| LPL | 2026-06-02 | THUNDER TALK GAMING vs LGD GAMING | 1 | 1peel+flex | 6/16 (22) | `115616219464607480` |
| LPL | 2026-06-02 | THUNDER TALK GAMING vs LGD GAMING | 4 | 1peel+flex | 21/14 (35) | `115616219464607483` |
| LPL | 2026-06-03 | BILIBILI GAMING vs EDWARD GAMING | 1 | 1peel+flex | 22/6 (28) | `115616219464607486` |
| LPL | 2026-06-03 | BILIBILI GAMING vs EDWARD GAMING | 2 | 1peel+flex | 17/8 (25) | `115616219464607487` |
| LPL | 2026-06-06 | Beijing JDG Esports vs BILIBILI GAMING | 2 | 1peel+flex | 28/12 (40) | `115616219464607505` |
| LPL | 2026-06-06 | Beijing JDG Esports vs BILIBILI GAMING | 3 | 2peel | 2/8 (10) | `115616219464607506` |
| LPL | 2026-06-07 | TOP ESPORTS vs Xi'an Team WE | 2 | 2peel | 16/5 (21) | `115616219464607493` |
| LPL | 2026-06-08 | Anyone's Legend vs BILIBILI GAMING | 1 | 2peel | 14/12 (26) | `115616219464607510` |
| LPL | 2026-06-08 | BILIBILI GAMING vs Anyone's Legend | 3 | 1peel+flex | 25/9 (34) | `115616219464607512` |
| LPL | 2026-06-13 | Xi'an Team WE vs BILIBILI GAMING | 1 | 2peel | 4/21 (25) | `115616219464607516` |
| LPL | 2026-06-13 | BILIBILI GAMING vs Xi'an Team WE | 3 | 1peel+flex | 9/17 (26) | `115616219464607518` |
| LPL | 2026-06-13 | BILIBILI GAMING vs Xi'an Team WE | 5 | 2peel | 21/8 (29) | `115616219464607520` |
| LPL | 2026-06-14 | BILIBILI GAMING vs TOP ESPORTS | 3 | 2peel | 16/10 (26) | `115616219464607524` |
| LEC | 2026-05-30 | Natus Vincere vs Karmine Corp | 1 | 2peel | 6/11 (17) | `115548668059589371` |
| LEC | 2026-05-31 | Team Vitality vs GIANTX | 1 | 1peel+flex | 14/24 (38) | `115548668059589377` |
| LEC | 2026-05-31 | Team Vitality vs GIANTX | 3 | 1peel+flex | 15/13 (28) | `115548668059589379` |
| LEC | 2026-06-01 | Karmine Corp vs GIANTX | 2 | 2peel | 14/4 (18) | `115548668059589384` |
| LEC | 2026-06-01 | Karmine Corp vs GIANTX | 3 | 2peel | 19/2 (21) | `115548668059589385` |
| LEC | 2026-06-06 | Karmine Corp vs Movistar KOI | 2 | 2peel | 21/7 (28) | `115548668059589390` |
| LEC | 2026-06-06 | Karmine Corp vs Movistar KOI | 3 | 2peel | 22/8 (30) | `115548668059589391` |
| LEC | 2026-06-07 | G2 Esports vs Karmine Corp | 1 | 1peel+flex | 7/12 (19) | `115548668059589395` |
| LEC | 2026-06-07 | Karmine Corp vs G2 Esports | 2 | 2peel | 3/14 (17) | `115548668059589396` |
| CBLOL | 2026-05-30 | LOS vs Fluxo W7M | 1 | 1peel+flex | 17/16 (33) | `115565670260181864` |
| LCS | 2026-05-30 | FlyQuest vs Sentinels | 3 | 1peel+flex | 15/7 (22) | `115564793879469309` |
| LCS | 2026-06-06 | FlyQuest vs Team Liquid Alienware | 3 | 1peel+flex | 6/14 (20) | `115564793879469321` |
| LCS | 2026-06-07 | LYON vs Cloud9 Kia | 2 | 1peel+flex | 20/6 (26) | `115564793879469302` |
| LCK | 2026-05-27 | BNK FEARX vs KIWOOM DRX | 2 | 1peel+flex | 5/18 (23) | `115548128962971941` |
| LCK | 2026-05-27 | KIWOOM DRX vs BNK FEARX | 3 | 2peel | 12/20 (32) | `115548128962971942` |
| LCK | 2026-05-29 | KIWOOM DRX vs Dplus KIA | 3 | 1peel+flex | 8/21 (29) | `115548128963037550` |
| LCK | 2026-05-30 | kt Rolster vs DN SOOPers | 2 | 1peel+flex | 18/7 (25) | `115548128962971957` |
| LCK | 2026-06-12 | T1 vs Hanwha Life Esports | 2 | 1peel+flex | 16/11 (27) | `115548128963037577` |
| LCK | 2026-06-12 | T1 vs Hanwha Life Esports | 3 | 2peel | 7/20 (27) | `115548128963037578` |

---

## 4. HIGH — campos obrigatórios (lote C): 4 FIELD_MISSING

| bet_id | Bookmaker | Liga | Times | Data | Campo | Atual | Esperado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2e8053b9-8c21-48fa-a02d-ab1b307a720a | estrelabet | LPL | UP vs LNG | 2026-05-08 | match_context.lolesports_game_id | null | not null (settled bet) |
| a3f39f6e-4ef8-4c49-9e11-049bce030750 | pinnacle | LFL | Galions vs Solary | 2026-05-20 | match_context.lolesports_game_id | null | not null (settled bet) |
| b0481dab-6fb4-46e6-a4b3-33619f1f4ccd | thunderpick | LCS | FlyQuest vs Sentinels | 2026-05-30 | match_context.lolesports_game_id | null | not null (settled bet) |
| 6ae02cd7-b5e8-442c-acac-c674ba014550 | pinnacle | EMEA Masters | Galions vs Eintracht Spandau | 2026-06-14 | match_context.lolesports_game_id | null | not null (settled bet) |

Todos os 4 são `match_context.lolesports_game_id` null em bet já settled (green/red) — o matching da auditoria ainda achou o jogo certo via fallback (nome+data+mapa), mas o campo canônico não foi preenchido no settle original. Backfillable via `backfill-match-id.cjs`.

---

## 5. MEDIUM — trigger (lote B) e fair (sem lote)

### Trigger — 3 bets (TRIGGER_MISMATCH)

| bet_id | Bookmaker | Liga | Times | Data | Atual | Esperado | Sup blue/red |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6740f14f-ebde-4646-ac94-a02831e0af0c | betano | LPL | NIP vs EDG | 2026-05-24 | ewc_unclassified | null | Thresh / Yuumi |
| c4eda66d-61bc-4249-93bd-c92f4074dbc8 | betano | LPL | NIP vs EDG | 2026-05-24 | ewc_unclassified | null | Thresh / Yuumi |
| b0481dab-6fb4-46e6-a4b3-33619f1f4ccd | thunderpick | LCS | FlyQuest vs Sentinels | 2026-05-30 | null | 2peel | Milio / Seraphine |

2 dos 3 (`6740f14f`, `c4eda66d`) são o mesmo jogo NIP vs EDG (LPL, mapa 5) com `trigger_type: "ewc_unclassified"` — sentinela de EWC vazando pra bet de liga regular (ver §7). O 3º (`b0481dab`, LCS) tem `current: null` mas devia ser `2peel` (Milio+Seraphine) — trigger nunca foi calculado nesse settle.

### Trigger — 6 rows de method_reports com Alistar

| report_id | Liga | Data | Times | Mapa | Atual | Esperado | Sup blue/red |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10aac6be-14f8-4ab3-8dd0-48317614ca32 | CBLOL | 2026-05-02 | RED vs FUR | 1 | 1peel+flex | null | Alistar / Yuumi |
| 3bd3cb34-27ea-4c3d-a575-4b2deaff13f0 | CBLOL | 2026-05-10 | FX vs LOS | 2 | 1peel+flex | null | Alistar / Nami |
| 464b64fe-ff6a-4b1b-9baf-3e315c0f6713 | CBLOL | 2026-05-16 | FX vs RED | 4 | 1peel+flex | null | Alistar / Milio |
| 1b11e706-8542-46ba-a7aa-c14c5d3b449b | LPL | 2026-05-16 | TT vs EDG | 1 | 1peel+flex | null | Seraphine / Alistar |
| ca792f93-c2ee-44a1-97cc-28fa96920282 | CBLOL | 2026-05-31 | LOS vs RED | 2 | 1peel+flex | null | Alistar / Milio |
| 7fd1506b-3cb0-494f-b410-b74f047e287f | LPL | 2026-06-08 | AL vs BLG | 2 | 1peel+flex | null | Alistar / Milio |

Todas as 6 têm `expected: null` — o `_archive/analyze_range.cjs` (arquivado, fora de escopo de fix) ainda trata Alistar como FLEX_ENGAGE, gerando `1peel+flex` onde o método atual (sem Alistar desde 2026-05-29) diria "sem trigger". **Fora de escopo de correção desta auditoria** — é bug de pipeline de geração de `results.json`/method_reports, não das bets.

### Fair — SEM lote de correção em massa

**Fair mismatch (fair_formula): 583 findings.** Breakdown:
- 323 com `fair_formula` atual null (nunca fez backfill)
- 39 em ligas tier2 (LFL/LES/LIT) sem fonte de dado comparável no settle
- 221 em majors com valor divergente (~1 linha de diferença)

**Causa raiz (investigada por amostragem — validação #3 do plano):** Divergência em massa (>30%) investigada por amostragem (validação #3): NÃO é bug das bets. (a) LFL/LES/LIT nunca aparecem em cron-data/*-results.json (só as 5 ligas LCK/LPL/LEC/CBLOL/LCS têm histórico ali) — calcFairFormula() cai sempre no fallback pra essas ligas, incomparável ao valor real gravado (que vem de outro pipeline, tier2). (b) cron-data/*-results.json não é imutável na prática — commit eb7514a reescreveu dias já usados por settle antes dele; o snapshot histórico mudou depois do settle original, então o recompute de hoje diverge por ~1 linha do valor travado então. Tratar como limitação da auditoria (fonte histórica mutável), não como erro de dado da bet.

**Recomendação:** NÃO é candidato a correção em massa. Requer revisão de processo separada (decidir se vale backfillar os 323 nulls, e se o pipeline tier2 devia gravar em `cron-data/*-results.json` pra ficar comparável). Item pra `knowledge/pending.md`, não pro lote de fix desta auditoria.

**Fair_pinnacle — 10 findings, ESSES SIM são backfill legítimo** (valor existe em `cron-data/*-fair-pinnacle.json`, só não foi gravado na bet):

| bet_id | Bookmaker | Liga | Times | Data | Atual | Esperado | Fonte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| af922095-1e66-462b-91e7-49c5cb8a4ecb | pinnacle | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 59d18b0d-1b16-4717-aa47-804a0b068435 | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 1aee590c-5525-4dd5-8956-b3892e093d1c | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| f1c51f97-7936-4e34-b3e2-d98a10e639c8 | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 98dbe612-139a-4969-b670-9bbd1032ffc0 | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 6b00943f-a304-4651-b657-130ddcf403f8 | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 2dbc39c4-ca41-49c6-85c2-0be0dd022840 | thunderpick | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 70843fa2-5cd1-453f-bfab-818d6265e91b | pinnacle | LPL | WE vs LNG | 2026-05-23 | null | 27.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 272809e4-7b5f-41e0-b847-9199809994d3 | pinnacle | LCK | Dplus vs FEARX | 2026-05-23 | null | 28.5 | cron-data/2026-05-23-fair-pinnacle.json |
| 7ba60ce4-742b-49ab-8bdc-51c91960f851 | pinnacle | LCK | Dplus vs FEARX | 2026-05-23 | null | 28.5 | cron-data/2026-05-23-fair-pinnacle.json |

---

## 6. method_reports (lote E)

**0 erros de dado** (0 MR_KILLS_MISMATCH, 0 MR_UNDER_HIT_WRONG, 0 MR_PK_DUP, 0 MR_ORPHAN) — a tabela nunca tinha sido auditada antes e os dados que existem batem 100% com a API.

**274 de 418 jogos elegíveis (trigger ativo, frame confiável) SEM row em method_reports** (~66% de lacuna):

| Liga | Jogos faltando (MR_MISSING) |
| --- | --- |
| LPL | 78 |
| LCK | 49 |
| LEC | 45 |
| LCS | 37 |
| LFL | 36 |
| CBLOL | 29 |

Reconciliação: 418 elegíveis = 144 com row existente + 274 faltando. Os 150 rows totais no escopo = 144 elegíveis batendo + 6 rows extras que existem mas apontam pra jogos sem trigger no universo (os 6 MR_TRIGGER_MISMATCH do §5, todos com Alistar).

---

## 7. LOW / INFO

### Bookmaker case (lote F)

| Normalizado | Variantes (valor×contagem) | Total rows |
| --- | --- | --- |
| estrelabet | `estrelabet`×68, `EstrelaBet`×1 | 69 |
| pinnacle | `pinnacle`×110, `Pinnacle`×2 | 112 |

Fix via `normalize-bookmakers.cjs` (existente) — normaliza pra minúsculo. Só 3 rows fora do padrão (`EstrelaBet`×1, `Pinnacle`×2).

### Duplicatas do dedup (lote G) — 8 bets, 7 grupos

Total bets no banco: 756 (sem filtro de data). Bets marcadas p/ deleção (se rodar execute): 8. Lista completa dos 8 bet_ids candidatos a deleção (o script já roda em dry-run, `keep_id` de cada grupo preservado):

| bet_id (candidato a delete) | Liga | Times | Data | Bookmaker | Pick |
| --- | --- | --- | --- | --- | --- |
| 272809e4-7b5f-41e0-b847-9199809994d3 | LCK | Dplus vs FEARX | 2026-05-23 | pinnacle | Under 28.5 |
| 7ba60ce4-742b-49ab-8bdc-51c91960f851 | LCK | Dplus vs FEARX | 2026-05-23 | pinnacle | Under 28.5 |
| 379e7fa2-d076-4eab-a96e-57d83dbf3fd4 | LFL | Solary vs Skillcamp | 2026-04-17 | SIMULATED | Under 29.5 |
| 83f3e13c-1069-4b17-822c-24317b0ba65d | LES | LUA Gaming vs GIANTX ITERO | 2026-04-15 | SIMULATED | Under 29.5 |
| 7f011bec-b506-4182-96bb-07c359f29c8d | LFL | Ici Japon Corp vs Solary | 2026-04-22 | SIMULATED | Under 30.5 |
| 70843fa2-5cd1-453f-bfab-818d6265e91b | LPL | WE vs LNG | 2026-05-23 | pinnacle | Under 28.5 |
| e7544773-e57b-49eb-8410-3faf23502f14 | CBLOL | Los Grandes vs LOUD | 2026-05-25 | pinnacle | Under 27.5 |
| fa0e43d5-04c2-4447-98c5-8fef1481a114 | EMEA Masters | Solary vs Galions | 2026-06-15 | pinnacle | Under 31.5 |

### SIM generations

**SIM generations** (390 bets SIMULATED): 244 exact / 3 fair+1 / 143 sem fair_formula.

### Alias faltando

"Fluxo W7M" → "Fluxo" (15x bets, CBLOL) — falta em lib/team-aliases.json

### Trigger "ewc_unclassified" vazando pra liga não-EWC — 2 bets LPL

| bet_id | Times | Data | Liga (declarada) |
| --- | --- | --- | --- |
| 6740f14f-ebde-4646-ac94-a02831e0af0c | NIP vs EDG | 2026-05-24 | LPL |
| c4eda66d-61bc-4249-93bd-c92f4074dbc8 | NIP vs EDG | 2026-05-24 | LPL |

Mesmo jogo (NIP vs EDG, mapa 5) inserido 2x via backfill manual (`user_bet_backfill_2026-05-29`) sem recalcular trigger_type — herdou o placeholder "ewc_unclassified" que só devia existir em bets `EWC-*`. Ver TRIGGER_MISMATCH no §5 pro valor correto (`null`, Thresh+Yuumi não fecha 2peel nem 1peel+flex).

### TRIGGER_DIVERGENCE_RESULTS — 30 jogos (11 com Alistar)

Divergência entre o trigger gravado em `cron-data/*-results.json` (gerado pelo `_archive/analyze_range.cjs`, ainda usa lista de supports antiga com Alistar) e o trigger recomputado pela auditoria com a lista atual. **Fora de escopo de fix** (código arquivado) — só quantificado.

### RESULTS_JSON_GAP — 4 dias sem arquivo

[
  {
    "check": "RESULTS_JSON_GAP",
    "severity": "INFO",
    "date": "2026-06-08",
    "games_count": 3,
    "leagues": [
      "LPL"
    ]
  },
  {
    "check": "RESULTS_JSON_GAP",
    "severity": "INFO",
    "date": "2026-06-12",
    "games_count": 4,
    "leagues": [
      "LCK"
    ]
  },
  {
    "check": "RESULTS_JSON_GAP",
    "severity": "INFO",
    "date": "2026-06-13",
    "games_count": 11,
    "leagues": [
      "LCK",
      "LCS",
      "LPL"
    ]
  },
  {
    "check": "RESULTS_JSON_GAP",
    "severity": "INFO",
    "date": "2026-06-14",
    "games_count": 11,
    "leagues": [
      "LCK",
      "LCS",
      "LPL"
    ]
  }
]

---

## 8. EWC — 0 findings internos, checklist manual (48 bets)

EWC não está na Riot API (torneio ESL/Saudi) — sem cross-check automático de kills. Checks aritméticos internos (profit = f(status,stake,odd)) passaram 100%. Lista completa pra conferência manual no Leaguepedia/gol.gg:

| bet_id | Liga | Data | Times | Mapa | Pick | Odd | Stake | Status | Profit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ccd0fd6f-39e1-4b3a-a7b1-bb5c0ce9cde8 | EWC-LEC | 2026-04-29 | G2 Esports vs Fnatic | 1 | Under 28.5 | 1.7 | R$ 480,00 | green | R$ 336,00 |
| 05cd494d-b35d-4ec6-9144-8127e6460dd0 | EWC-LEC | 2026-04-29 | G2 Esports vs Fnatic | 1 | Under 27.5 | 1.82 | R$ 600,00 | green | R$ 492,00 |
| 519c9a04-567b-4202-a3ff-88da7699d215 | EWC-LEC | 2026-04-29 | GIANTX vs NAVI | 1 | Under 28.5 | 1.78 | R$ 120,00 | red | -R$ 120,00 |
| fd8b9df4-c4bd-4b95-a29f-e4eebe0c66c2 | EWC-LEC | 2026-04-29 | GIANTX vs NAVI | 1 | Under 28.5 | 1.81 | R$ 482,00 | red | -R$ 482,00 |
| 73dd9aac-bd95-472f-b4b4-3f86c7b34e88 | EWC-LEC | 2026-04-29 | G2 Esports vs Fnatic | 2 | Under 28.5 | 1.71 | R$ 600,00 | green | R$ 426,00 |
| 9b1f1c62-a801-40f3-99a0-32adc984a9a2 | EWC-LEC | 2026-04-29 | GIANTX vs NAVI | 2 | Under 29.5 | 1.8 | R$ 600,00 | red | -R$ 600,00 |
| dd5b6e9c-74eb-40d1-abd2-5323d70bb635 | EWC-LEC | 2026-04-29 | Karmine vs SK Gaming | 1 | Under 29.5 | 1.82 | R$ 600,00 | red | -R$ 600,00 |
| 33e27b58-2f38-4651-8dea-4a825f54e6f7 | EWC-LEC | 2026-04-29 | Karmine vs SK Gaming | 2 | Under 28.5 | 1.89 | R$ 200,00 | green | R$ 178,00 |
| 3f5a1bdc-9fad-4b7c-ba00-1f57b389e1db | EWC-LEC | 2026-04-29 | Karmine vs SK Gaming | 2 | Under 29.5 | 1.72 | R$ 200,00 | green | R$ 144,00 |
| 503554d7-5129-484f-a717-ec67372a6d58 | EWC-LEC | 2026-04-29 | Karmine vs SK Gaming | 2 | Under 30.5 | 1.61 | R$ 200,00 | green | R$ 122,00 |
| 62eb9121-11fd-4828-ab3f-9bac0cd0aadb | EWC-LEC | 2026-04-29 | KOI vs Vitality | 2 | Under 29.5 | 1.82 | R$ 600,00 | green | R$ 492,00 |
| 244bdf2a-382d-452b-a8fd-81aa35663dcd | EWC-LEC | 2026-04-29 | KOI vs Vitality | 3 | Over 28.5 | 1.75 | R$ 400,00 | green | R$ 300,00 |
| db5030a0-1c0f-4d23-83ef-a5d50aaf3462 | EWC-LEC | 2026-04-30 | SK Gaming vs Galions | 1 | Under 31.5 | 1.83 | R$ 600,00 | green | R$ 498,00 |
| d79cac08-acda-47d3-90a9-c318efe0819e | EWC-LEC | 2026-04-30 | Vitality vs Shifters | 1 | Under 28.5 | 1.76 | R$ 600,00 | red | -R$ 600,00 |
| c25fbbf5-1c58-42c0-946d-50724494e186 | EWC-LEC | 2026-04-30 | Vitality vs Shifters | 2 | Under 30.5 | 1.72 | R$ 200,00 | green | R$ 144,00 |
| 09ae31b8-12a8-40d9-8573-7fcc72462014 | EWC-LEC | 2026-04-30 | Vitality vs Shifters | 2 | Under 30.5 | 1.78 | R$ 375,46 | green | R$ 292,86 |
| c40fa405-9f57-49c0-9b41-ffdd266d547d | EWC-LEC | 2026-04-30 | Fnatic vs Solary | 2 | Under 29.5 | 1.73 | R$ 600,00 | green | R$ 438,00 |
| 031d19b7-5833-45c8-a6ac-9a5f3bee70b5 | EWC-LEC | 2026-04-30 | Fnatic vs Solary | 2 | Under 29.5 | 1.61 | R$ 200,00 | green | R$ 122,00 |
| 6ba11baa-5740-4462-97e4-4d829eee7dac | EWC-LEC | 2026-04-30 | Fnatic vs Solary | 2 | Under 28.5 | 1.72 | R$ 200,00 | green | R$ 144,00 |
| 6985e5b8-671f-46a6-9d2a-b2c4e9a261ce | EWC-LEC | 2026-04-30 | Fnatic vs Solary | 2 | Under 27.5 | 1.89 | R$ 200,00 | green | R$ 178,00 |
| 68fb59b1-7469-4485-882a-700040d01e23 | EWC-LEC | 2026-04-30 | GIANTX vs Team Heretics | 2 | Over 25.5 | 1.74 | R$ 600,00 | green | R$ 444,00 |
| 7b1591db-61ba-4842-97ba-e4243f820b96 | EWC-LEC | 2026-04-30 | GIANTX vs Team Heretics | 2 | Under 28.5 | 1.89 | R$ 200,00 | red | -R$ 200,00 |
| 8ed6f8f3-82f8-4b98-b361-60c3f67571cd | EWC-LEC | 2026-04-30 | GIANTX vs Team Heretics | 2 | Under 29.5 | 1.72 | R$ 200,00 | red | -R$ 200,00 |
| bd1a06ce-6437-4a2a-9f7c-b0927e0cb869 | EWC-LEC | 2026-04-30 | GIANTX vs Team Heretics | 2 | Under 30.5 | 1.61 | R$ 200,00 | green | R$ 122,00 |
| e445419f-94e7-41ba-8a03-e73471a58b04 | EWC-LCK | 2026-05-12 | Hanwha vs Dplus | 3 | Under 34.5 | 1.819 | R$ 1.000,00 | red | -R$ 1.000,00 |
| b6ba5e98-674e-407a-b336-754f1931938d | EWC-LEC | 2026-05-14 | G2 Esports vs NAVI | 1 | Under 28.5 | 1.74 | R$ 1.000,00 | green | R$ 740,00 |
| 6541ecd5-9a4b-4d66-a583-e89245680708 | EWC-LEC | 2026-05-14 | Shifters vs Galions | 1 | Menos de 29.5 | 1.85 | R$ 661,76 | green | R$ 562,50 |
| 6d1d7da3-34c3-423c-b506-01fe1b855998 | EWC-LEC | 2026-05-14 | Shifters vs Galions | 1 | Menos de 29.5 | 1.87 | R$ 336,13 | green | R$ 292,43 |
| 199d9081-815b-4e78-86d3-52b71adb0a47 | EWC-LEC | 2026-05-15 | NAVI vs Galions | 1 | Menos de 27.5 | 1.76 | R$ 300,00 | green | R$ 228,00 |
| 672fe7fc-b1fc-4b20-8e5c-85b0101572e4 | EWC-LEC | 2026-05-15 | NAVI vs Galions | 1 | Menos de 28.5 | 1.81 | R$ 694,44 | green | R$ 562,50 |
| 5accc59e-64cd-4d36-8c61-5ea745d54aa7 | EWC-LEC | 2026-05-15 | NAVI vs Galions | 2 | Under 28.5 | 1.746 | R$ 1.000,00 | green | R$ 746,00 |
| 9082f64c-b6f3-452e-b4dc-88e68b37d73e | EWC-LEC | 2026-05-15 | KOI vs GIANTX | 1 | Under 28.5 | 1.8 | R$ 1.000,00 | green | R$ 800,00 |
| cddbd2df-f3f8-4b6f-b85c-a622ee9a68cd | EWC-LEC | 2026-05-16 | G2 Esports vs Karmine | 2 | Menos de 28.5 | 1.87 | R$ 339,48 | red | -R$ 339,48 |
| abeddad0-61c2-4c2d-8a1f-87a26413ab15 | EWC-LEC | 2026-05-16 | G2 Esports vs Karmine | 2 | Under 28.5 | 1.751 | R$ 140,00 | red | -R$ 140,00 |
| 63adddd9-b309-4eab-9152-0894f10e3e65 | EWC-LPL | 2026-05-21 | JDG vs AL | 1 | Under 27.5 | 1.763 | R$ 200,00 | green | R$ 152,60 |
| feabf752-3c67-4793-9a08-87fd96531952 | EWC-LPL | 2026-05-21 | JDG vs AL | 1 | Under 27.5 | 1.769 | R$ 649,75 | green | R$ 499,66 |
| ab7b416d-f752-4379-99a6-b1e497fe5e19 | EWC-LPL | 2026-05-21 | JDG vs AL | 1 | Under 27.5 | 1.813 | R$ 614,77 | green | R$ 499,81 |
| d0125c9c-77bc-47b4-92ef-1990b1e9949d | EWC-LPL | 2026-05-21 | JDG vs AL | 1 | Under 27.5 | 1.854 | R$ 584,78 | green | R$ 499,40 |
| 0753ff3a-def6-4737-ad37-1b1b316b4902 | EWC-LPL | 2026-05-21 | JDG vs AL | 2 | Menos de 27.5 | 1.83 | R$ 1.000,00 | green | R$ 830,00 |
| 34ae764e-abb3-4225-9e52-a070d58e4991 | EWC-LPL | 2026-05-21 | JDG vs AL | 4 | Menos de 28.5 | 1.71 | R$ 500,00 | green | R$ 355,00 |
| f3bd9854-749f-42e9-a801-dcc56912f67c | EWC-LPL | 2026-05-22 | Weibo vs JDG | 1 | Under 28.5 | 1.757 | R$ 1.000,00 | green | R$ 757,00 |
| 52306dfc-5bdb-403b-9b5f-218ab070dfa0 | EWC-LPL | 2026-05-22 | Weibo vs JDG | 3 | Under 28.5 | 1.719 | R$ 1.000,00 | green | R$ 719,00 |
| 928e1162-ce36-4e24-b415-39e99176218b | EWC-LPL | 2026-05-22 | Weibo vs JDG | 4 | Under 27.5 | 1.826 | R$ 1.000,00 | green | R$ 826,00 |
| d756cca8-5c25-43d7-836b-d7da8b4b42f5 | EWC-LPL | 2026-05-22 | Weibo vs JDG | 5 | Menos de 27.5 | 1.75 | R$ 1.000,00 | green | R$ 750,00 |
| 76239e03-0022-420c-9f2b-e5f3ab0c460a | EWC-LCK | 2026-05-26 | Dplus vs Hanwha | 1 | Under 32.5 | 1.751 | R$ 1.500,00 | green | R$ 1.126,50 |
| e375bb88-f8a9-4427-ae08-c9ffcca1b6c4 | EWC-LCK | 2026-05-26 | Dplus vs Hanwha | 1 | Under 32.5 | 1.787 | R$ 2.500,00 | green | R$ 1.967,50 |
| e54e450f-8d30-48fe-b62a-98b6242c4669 | EWC-LCK | 2026-05-26 | Dplus vs Hanwha | 2 | Under 32.5 | 1.704 | R$ 1.000,00 | red | -R$ 1.000,00 |
| 5fc08ab6-ea16-4e1a-b38c-751c49f64352 | EWC-CBLOL | 2026-06-07 | LOUD vs VKS | 1 | Under 28.5 | 1.8 | R$ 1.000,03 | red | -R$ 1.000,03 |

---

## 9. Não-verificáveis via API — 72 MANUAL_CHECK + 4 games LPL sem dado na CDN

Por motivo: {"suspect_frame":22,"fetch_error":1,"no_universe_match":49}

### suspect_frame (22) — frame livestats não confiável (gameState≠finished + gameTime<600s ou kills<5)

| bet_id | Bookmaker | Liga | Times | Data | Status | game_id |
| --- | --- | --- | --- | --- | --- | --- |
| e9144e03-0e8a-4a11-bd80-ff1b772b8192 | estrelabet | LEC | Shifters vs NAVI | 2026-04-26 | red | `115548668059523677` |
| 488b26c1-940b-4a46-9301-b09cec5971b4 | estrelabet | LEC | Karmine vs Fnatic | 2026-04-26 | red | `115548668059589341` |
| 84d7647a-8508-4024-b575-19fb6145e278 | pinnacle | LCK | Nongshim vs T1 | 2026-04-29 | red | `115548128962840657` |
| 23470f2f-a5b6-43d3-8d04-84c53e29d2cb | parimatch | LCK | Nongshim vs T1 | 2026-04-29 | red | `115548128962840657` |
| eb824cd6-e670-41ff-b7f3-26c24334e7e5 | parimatch | LCK | Nongshim vs T1 | 2026-04-29 | red | `115548128962840657` |
| 20d51716-259a-4a2e-8c27-4e7c9f2ee1bd | parimatch | LCK | Nongshim vs T1 | 2026-04-29 | red | `115548128962840657` |
| 8a71bc2d-5aec-4973-8c03-a136c62fec91 | parimatch | LPL | Weibo vs WE | 2026-05-07 | red | `115615926677896700` |
| d797fe6f-8f29-40ac-ba5b-a15a6dde3312 | parimatch | LPL | Weibo vs WE | 2026-05-07 | red | `115615926677896700` |
| e731ba1d-d680-46ad-bdcf-23b7d23763ec | parimatch | LPL | Weibo vs WE | 2026-05-07 | red | `115615926677896700` |
| a3f39f6e-4ef8-4c49-9e11-049bce030750 | pinnacle | LFL | Galions vs Solary | 2026-05-20 | green | `116316789792721712` |
| 238ec1d5-34d4-4803-96c0-f97bb7cf1b96 | SIMULATED | LEC | Karmine vs GIANTX | 2026-05-10 | red | `115548668059523770` |
| 4f626d73-8341-48f1-b223-934a7f6e5768 | SIMULATED | LPL | WE vs Weibo | 2026-05-07 | red | `115615926677896700` |
| d016e696-b0b8-43cb-8cf8-93ce580a74c6 | SIMULATED | LCS | FlyQuest vs C9 | 2026-05-10 | red | `115564793879403677` |
| 31b6caff-37ce-45b7-b99d-e4de1f475396 | SIMULATED | CBLOL | LOUD vs VKS | 2026-05-09 | green | `115565670260181822` |
| 20b41560-027d-4cd7-ac02-3087fa7db931 | SIMULATED | LEC | NAVI vs Karmine | 2026-04-24 | red | `115548668059523697` |
| 80b49e6c-45ad-4725-ad26-ef46fff85d8d | SIMULATED | LCK | T1 vs Nongshim | 2026-04-29 | red | `115548128962840657` |
| 65555eb7-dfbb-46d2-a604-eb7ff31cfe22 | SIMULATED | LEC | NAVI vs Shifters | 2026-04-26 | red | `115548668059523677` |
| 064e9279-eb65-496b-b478-5e455e735c2c | SIMULATED | LEC | Karmine vs Fnatic | 2026-04-26 | green | `115548668059589341` |
| 31f04cda-1557-40ec-9869-48a8242dd08c | pinnacle | LPL | JDG vs THUNDER TALK GAMING | 2026-05-29 | green | `115616219464541908` |
| 7cdcaf0f-068c-496a-948e-e61c2b07ea7c | pinnacle | LPL | JDG vs THUNDER TALK GAMING | 2026-05-29 | green | `115616219464541908` |
| 0cde129c-8460-4276-8d88-4fb018db3026 | pinnacle | LCK | Gen.G vs BRO | 2026-05-29 | green | `115548128963037504` |
| 1fbebd39-578e-483c-9bcc-fd5a26d5c1df | pinnacle | LCK | Gen.G vs BRO | 2026-05-29 | green | `115548128963037504` |

### no_universe_match (49) — bet fora das 6 ligas cobertas ou sem match no universo

| bet_id | Bookmaker | Liga | Times | Data | Status |
| --- | --- | --- | --- | --- | --- |
| 7dc7ec21-5a7b-4528-999e-af140daa0501 | pinnacle | LES | GIANTX ITERO vs FALKE ESPORTS | 2026-05-21 | red |
| 1debd7a1-4e5c-4899-af5d-89ffe4b1a7c5 | SIMULATED | LES | KOI Fénix vs GIANTX ITERO | 2026-05-13 | red |
| b3148c37-f2d3-4bbd-ae24-0bbca4314848 | SIMULATED | LES | LUA Gaming vs GIANTX ITERO | 2026-04-15 | green |
| 1b5014a6-b53d-4a88-9d5d-9a2b085c2595 | SIMULATED | LES | GIANTX ITERO vs UB Alma Mater | 2026-04-09 | green |
| a58e8bc3-6bfd-4ea5-8503-88aa00243a63 | SIMULATED | LES | KOI Fénix vs FALKE ESPORTS | 2026-04-16 | green |
| a4ab0ec5-a5bd-4e5c-9f32-8c6e5d4f63b6 | SIMULATED | LES | LUA Gaming vs Barça Esports | 2026-04-29 | green |
| f2a55a5b-88da-4f13-abd2-938c0072e0c5 | SIMULATED | LES | GIANTX ITERO vs UCAM Esports Club | 2026-04-30 | green |
| 5bfe2bcc-67fe-4424-a18d-a4f003a378dc | SIMULATED | LES | UB Alma Mater vs Barça Esports | 2026-04-16 | green |
| 67062d1c-32d3-42bc-a7d9-0f317a23b9a3 | SIMULATED | LES | GIANTX ITERO vs UCAM Esports Club | 2026-04-30 | red |
| 6ecbbbe7-5607-4cc7-a454-7a36b0a3585e | SIMULATED | LES | FALKE ESPORTS vs UB Alma Mater | 2026-04-22 | green |
| 26b6f903-cbc4-4981-89f7-0fac5adb6ef1 | SIMULATED | LES | UB Alma Mater vs Heretics Academy | 2026-05-14 | green |
| 877f2d27-3336-4530-a947-a1f4b4a55560 | SIMULATED | LES | FALKE ESPORTS vs LUA Gaming | 2026-05-06 | green |
| 1751c0d7-e935-4085-b303-84da785af4cf | SIMULATED | LES | Barça Esports vs Heretics Academy | 2026-05-20 | green |
| 71fa8036-0c3c-4a7c-9522-3462f6274481 | SIMULATED | LES | LUA Gaming vs Heretics Academy | 2026-04-09 | green |
| 91426e40-d078-4e80-9637-cdd603910eab | SIMULATED | LES | LUA Gaming vs UCAM Esports Club | 2026-05-14 | green |
| 687687af-41b7-41f4-889a-a403abd6436a | SIMULATED | LES | KOI Fénix vs UB Alma Mater | 2026-04-30 | red |
| 56511d9c-2f02-4037-a433-f4c67e35aa00 | SIMULATED | LES | LUA Gaming vs Barça Esports | 2026-04-29 | red |
| 2f211a4a-7d99-422b-844f-6de1879d6e12 | SIMULATED | LES | KOI Fénix vs UB Alma Mater | 2026-04-30 | green |
| 907346ad-c933-483c-9fb8-7474f37de69c | SIMULATED | LES | GIANTX ITERO vs Heretics Academy | 2026-04-23 | green |
| 7f011bec-b506-4182-96bb-07c359f29c8d | SIMULATED | LES | Barça Esports vs UCAM Esports Club | 2026-04-22 | green |
| 93faec28-af6b-410a-ac0b-a91876a2d617 | SIMULATED | LES | UCAM Esports Club vs KOI Fénix | 2026-05-21 | green |
| 5bd66f7b-3654-43e0-a5b6-3235feef7627 | SIMULATED | LES | KOI Fénix vs UCAM Esports Club | 2026-05-21 | green |
| 9da6faa6-17e2-4ed1-8f0f-eed895bc83e9 | SIMULATED | LES | KOI Fénix vs Barça Esports | 2026-04-08 | red |
| 9fad7fd2-7e65-4ee9-aa42-20742c9d5f51 | SIMULATED | LES | KOI Fénix vs FALKE ESPORTS | 2026-04-16 | red |
| df48476b-d7a6-421d-bd7c-a1becbd9772f | SIMULATED | LES | KOI Fénix vs LUA Gaming | 2026-04-23 | red |
| 7c782d5c-9a32-48f0-89e7-832c447b4ad1 | SIMULATED | LES | GIANTX ITERO vs LUA Gaming | 2026-04-15 | green |
| 2282e3ab-2ec5-42a8-9578-63fef5d52150 | SIMULATED | LES | Barça Esports vs UB Alma Mater | 2026-04-16 | green |
| 9aae199e-1df9-42f8-8da4-040e4b2ee112 | SIMULATED | LES | LUA Gaming vs FALKE ESPORTS | 2026-05-06 | red |
| 90c8c9f7-3093-4f57-851d-4df95283b08d | SIMULATED | LES | GIANTX ITERO vs Barça Esports | 2026-05-06 | red |
| a203b6bd-5454-4576-b542-51022472abc4 | SIMULATED | LES | UCAM Esports Club vs Barça Esports | 2026-04-22 | green |
| c6605b1b-c4b6-4735-afc5-cc37ec0a2736 | thunderpick | EMEA Masters | MISA Esports vs UCAM Esports Club | 2026-06-11 | green |
| c3e09b1d-dd7e-4e21-8900-168f40e98b11 | thunderpick | EMEA Masters | MISA Esports vs UCAM Esports Club | 2026-06-11 | green |
| 25568b65-4da8-467d-8606-c37fa17a4c34 | thunderpick | EMEA Masters | Solary vs Eintracht Spandau | 2026-06-11 | green |
| 295748fe-b482-48ac-a2ea-fa9e2497195e | pinnacle | EMEA Masters | Heretics Academy vs Forsaken | 2026-06-11 | green |
| 70363073-1148-4391-b708-3bedc9ef5f13 | pinnacle | EMEA Masters | Heretics Academy vs Forsaken | 2026-06-11 | green |
| 2baa0538-bfd4-4837-a310-c13ff29c0b71 | pinnacle | EMEA Masters | HMBLE vs E Wie Einfach E-Sports | 2026-06-11 | red |
| 7f01105f-47af-4a4d-b1a0-d935f8982b84 | pinnacle | EMEA Masters | HMBLE vs E Wie Einfach E-Sports | 2026-06-11 | red |
| 981f5d8a-7789-4540-9323-6f96c56eb125 | thunderpick | EMEA Masters | Partizan Sangal vs WLGaming | 2026-06-11 | red |
| 7bee177f-cdef-4a88-831e-a0da175b9f3b | pinnacle | EMEA Masters | WLGaming vs G2 NORD | 2026-06-12 | red |
| 15d3064c-1891-48ed-9452-5f8c113da36e | pinnacle | EMEA Masters | WLGaming vs G2 NORD | 2026-06-12 | red |
| ead3c187-f4b4-4863-b7de-9a8c62d848f8 | pinnacle | EMEA Masters | Eintracht Spandau vs Heretics Academy | 2026-06-13 | green |
| e7e98a5a-0923-44b8-a95a-c6b1af22591d | pinnacle | EMEA Masters | Eintracht Spandau vs Heretics Academy | 2026-06-13 | green |
| 944d3ca4-267e-4088-acef-324e6e23e86e | pinnacle | EMEA Masters | Eintracht Spandau vs Heretics Academy | 2026-06-13 | green |
| 312267fd-4895-4002-94db-f324b6f11339 | thunderpick | EMEA Masters | Eintracht Spandau vs Galions | 2026-06-14 | red |
| 6ae02cd7-b5e8-442c-acac-c674ba014550 | pinnacle | EMEA Masters | Galions vs Eintracht Spandau | 2026-06-14 | red |
| 9bc9f6aa-ba39-4870-8aee-0279466b9146 | pinnacle | EMEA Masters | Solary vs UCAM Esports Club | 2026-06-14 | green |
| ef8be2ff-5dd1-4d67-8d08-c2304e334df4 | pinnacle | EMEA Masters | Solary vs UCAM Esports Club | 2026-06-14 | green |
| 954e876f-3b36-4d7c-8d22-ad2a5eef0a52 | pinnacle | EMEA Masters | Solary vs Galions | 2026-06-15 | green |
| fa0e43d5-04c2-4447-98c5-8fef1481a114 | pinnacle | EMEA Masters | Solary vs Galions | 2026-06-15 | green |

### fetch_error — 4 games LPL sem dado na CDN lolesports (JSON truncado após 4 tentativas)

| Liga | game_id | Times | Data |
| --- | --- | --- | --- |
| LPL | 115615926685761106 | (times indisponíveis — window nunca respondeu, times vêm do próprio livestats) | 2026-05-08 |
| LPL | 115615926677896682 | (times indisponíveis — window nunca respondeu, times vêm do próprio livestats) | 2026-05-14 |
| LPL | 115615924499588604 | (times indisponíveis — window nunca respondeu, times vêm do próprio livestats) | 2026-04-08 |
| LPL | 115615924499588652 | (times indisponíveis — window nunca respondeu, times vêm do próprio livestats) | 2026-05-03 |

Conferir manualmente no gol.gg os 4 jogos acima — nenhum dos dois lados (bet nem auditoria) tem dado confiável pra essas partidas.

---

## 10. Verificação da própria auditoria

1. **Grupo de controle** — `validate-sim-profit.cjs`: Total bets: 614, Hit global: 59.0% | PASSOU: 66 times (n≥5) verificados — nenhuma violação de invariante hit/profit. | Script audita o banco INTEIRO, sem filtro de data — findings podem cair fora do split 2 (2026-04-01 a 2026-06-30); triagem por escopo fica pro relatório consolidado.
2. **Determinismo** — cache em disco (`audit-cache/`), jogos `completed` são imutáveis; re-rodar as fases 1-3 do cache dá a mesma contagem de findings (não houve nova chamada de API entre as rodadas desta sessão).
3. **Cross-check universo vs results.json** — 697 jogos comparados, 0 fora do universo, 30 divergências de trigger (todas explicadas no §7 — código arquivado com Alistar).
4. **Spot-check externo do achado CRITICAL nº1** (Tarefa 1 do briefing):

| Bet | Fonte | URL | Resultado |
| --- | --- | --- | --- |
| 61507820-8d22-41d4-9f21-aed990f9b678 (real) + 2432691d-b598-4605-82cf-279dcef80321 (SIM) | gol.gg | https://gol.gg/game/stats/78097/page-fullstats/ | CONFIRMADO — blue (LNG) 21 kills, red (LGD) 11 kills, total 32 kills. Idêntico ao valor da API lolesports (kills_blue=21, kills_red=11, total=32). Pick "Menos de 25.5" perde (32 > 25.5) — bet devia ser red, está green. |

5. **Spot-check de 4 bets sem finding** (Tarefa 2 do briefing — 1 LCK, 1 LEC, 1 CBLOL, 1 LFL, mix green/red/real/SIMULATED):

| Liga | bet_id | Bookmaker | Status no banco | Match | Data | Pick | Fonte | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LCK | 1033710f-4202-44ca-8c62-65b0ab212fc4 | pinnacle (real) | green | Dplus KIA vs Kiwoom DRX — LCK 2026 Rounds 1-2 Week 9, Game 2 | 2026-05-29 | Under 29.5 | [gol.gg](https://gol.gg/game/stats/78885/page-fullstats/) | CONFIRMADO |
| LEC | 9aa97a5e-6ffc-4241-b70b-e43cf3044b97 | SIMULATED | red | Movistar KOI vs Karmine Corp — LEC 2026 Spring Week 7, Game 3 | 2026-05-09 | Under 29.5 | [gol.gg](https://gol.gg/game/stats/77797/page-fullstats/) | CONFIRMADO |
| CBLOL | 13cef361-3ad9-4d0f-a0bd-200619e84b8d | thunderpick (real) | green | Fluxo W7M vs LOS (LØS/Los Grandes) — CBLOL 2026 Split 1 Playoffs Round 3, Game 3 | 2026-05-30 | Under 27.5 | [gol.gg](https://gol.gg/game/stats/78907/page-fullstats/) | CONFIRMADO c/ ressalva |
| LFL | 8477bb97-0efb-4e1f-84f1-e7d3ae9a609f | SIMULATED | red | Galions vs TLN Pirates — LFL 2026 Spring Regular Season, Round 1 | 2026-04-17 | Under 29.5 | [ggscore.com (gol.gg não indexou página individual; ggscore usado como alternativa citando KDA)](https://ggscore.com/en/lol/lfl-2026-spring/group-stage/galions-vs-tln-pirates-648125) | CONFIRMADO |

3 de 4 bateram exato com gol.gg/ggscore. 1 (CBLOL) teve discrepância de 1 kill no lado red entre gol.gg (5) e a API lolesports (6) — não muda o status da bet (linha 27.5, ambos os totais ficam abaixo). Não invalida a auditoria, mas registra que gol.gg e a API oficial da Riot nem sempre batem exatamente — quando isso importar pro resultado de uma bet específica, preferir a API lolesports (fonte que o settle real usa) e usar gol.gg só como confirmação independente.

---

## 11. Lotes de fix propostos

**NENHUM fix roda sem aprovação explícita do Elvis, por lote.** Todos os scripts abaixo rodam `--dry-run` por default, com backup em `cron-data/2026-07-20-backup-audit-<lote>.json` antes de qualquer write, e a fase correspondente da auditoria é re-rodada depois de cada lote até dar zero findings novos.

| Lote | O que faz | Rows | Risco | Script | Pré-requisito |
| --- | --- | --- | --- | --- | --- |
| A | Corrige kills/status/profit de bets reais e SIMULATED contra a API (4 bets: 61507820, 2432691d, 0f79cb9e, b0481dab) | 4 rows | ALTO (bet real 61507820: reverte green→red, muda banca declarada em R$1.790) | a criar (fix-kills-status-profit.cjs) | backup cron-data/2026-07-20-backup-audit-A.json |
| B | Corrige trigger_type de 3 bets (TRIGGER_MISMATCH) | 3 rows | BAIXO (não muda profit/status) | a criar (fix-trigger-type.cjs) | backup cron-data/2026-07-20-backup-audit-B.json |
| C | Backfill de campos obrigatórios (lolesports_game_id em 4 bets + fair_pinnacle em 10 bets) | 14 rows | BAIXO/MÉDIO (dados novos, não sobrescreve settle) | backfill-match-id.cjs / backfill-fair-columns.cjs (existentes) | backup cron-data/2026-07-20-backup-audit-C.json |
| D | Insere as 36 bets SIMULATED faltando (MISSING_BET) | 36 rows novas | MÉDIO (aumenta volume do backtest, pode mudar hit% agregado) | insert-missed-bets.cjs (existente) | backup pré-insert do estado atual da tabela |
| E | Preenche method_reports faltando (274 rows) + corrige 6 trigger Alistar | 280 rows | BAIXO (tabela de backtest, não afeta bets reais) | a criar (rerun save_report_to_db.cjs pros jogos faltando) | backup method_reports antes |
| F | Normaliza bookmaker case (3 rows: EstrelaBet→estrelabet, Pinnacle→pinnacle) | 3 rows | BAIXO (só string case, não muda semântica) | normalize-bookmakers.cjs (existente) | backup cron-data/2026-07-20-backup-audit-F.json |
| G | Remove 8 bets duplicadas (dedup) | 8 rows deletadas | MÉDIO (delete é irreversível sem backup) | dedup-bets-execute.cjs (existente, hoje só dry-run rodado) | backup obrigatório antes de qualquer delete |

Ordem sugerida: **C → A → B → F → G → D → E** (backfills e correções pontuais de baixo risco primeiro, depois inserts/deletes de maior volume).
