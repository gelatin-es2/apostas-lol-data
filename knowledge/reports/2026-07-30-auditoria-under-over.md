# Auditoria completa — Método Under kill & Over kill — 2026-07-30

**Pedido:** Elvis, 30/07 — "auditoria completa do método de under kill e over kill".
**Como rodou:** workflow multi-agente (7 ângulos de coleta em paralelo + verificação adversarial independente nos 4 ângulos críticos + crítico de completude) + 3 agentes de fechamento de lacunas (baselines primários, higiene do pipeline, LFL/watchlist). 15 agentes no total, tudo READ-ONLY (nenhum write no banco, nenhum arquivo do repo tocado além deste relatório).
**Fontes:** Supabase `bets` (887 rows: 448 reais + 439 SIMULATED) e `method_reports` (436 rows) · `cron-data/*-results.json` (local 22–25/07 + origin/main 26, 29, 30/07) · `audit-output/00-universe-split3-window.json` · livestats/getEventDetails ao vivo · notas oficiais do patch 26.15 (3 fontes) · relatórios e decisões em `knowledge/`.
**Scripts reproduzíveis:** scratchpad da sessão (`.../scratchpad/audit/`), derivação exata registrada em cada número.

---

## Veredito em 1 linha

🔴 **VERMELHO no diagnóstico, verde no núcleo:** o "método Under" como método geral não existe mais — sem Milio ele está ABAIXO do breakeven (52,7%, −R$16.853) e o volume de trigger caiu pra metade estrutural (21% vs 44–50% no split 2); o que segue de pé e pagando é o núcleo **Milio (74,2%) + janela Camille (73,9% real)**, o patch 26.15 não toca em nada do método, MAS a disciplina pré-draft/SKIP-LEC continuou sangrando DEPOIS de flagada na revisão de 26/07 e 41% do split 3 está invisível pra análise (enrich não rodado) — exatamente no período de re-avaliação. Nota que muda a leitura: o gap do hit real (61,5%) vs o baseline 66,2% **não é decaimento do sinal** — é linha praticada + régua de medição (decomposição pareada na seção Baselines); o sinal de draft segue vivo (67,9% nos exatos mapas apostados, na régua do backtest).

---

## Top 5 — o que contradiz o playbook (sem esperar pergunta)

1. **Under sem Milio = prejuízo.** Mapas com Milio: 74,2% CI [62,1–83,4] (n=62), +R$30.240. Sem Milio: 52,7% [42,6–62,5] (n=93), **−R$16.853** — abaixo do BE 57,1%. 2peel sem Milio 56,5% (−R$8.294); 1peel+flex sem Milio 48,9% (−R$8.560). O lucro do método é o Milio; o resto do universo Under perde dinheiro a odd 1,75.
2. **Pré-draft continuou e escalou DEPOIS da revisão** que quantificou −R$5.000: 4 casos novos 26–30/07, incluindo entrada 2u SEM sinal confirmado (TT×JDG, a própria nota admite). E a verificação adversarial derrubou a narrativa que blindava a janela: **a Camille veio em TODAS as 17 bets pré-draft e mesmo assim a classe fechou −R$4.440** — o "quando veio = 2/2" da revisão de 26/07 era erro de fonte (results.json sem o mapa 1; comp real conferida via livestats). Pré-draft perde mesmo quando o sinal confirma.
3. **SKIP Over LEC operado como se já estivesse revogado:** 4 bets Over LEC desde 26/07, −R$2.000 — incluindo a violação quádrupla VIT×KOI M1 (3×R$1.000: liga sob SKIP + fair+2 "NUNCA" + odd 1,70–1,72 abaixo do piso + 3u de exposição, sendo 1 slip por engano), red −R$3.000 um dia depois da revisão. Total desde a diretriz de 24/07: −R$2.754. O único Over LEC lucrativo foi exatamente a janela conforme (G2×KC M3, +R$1.000).
4. **41% do split 3 invisível pra análise de método:** 35 de 86 bets reais settladas desde 21/07 sem `total_kills`, 40 sem picks, 14 de 46 mapas sem kills, 5 bets de método sem trigger — os follow-ups da revisão de 26/07 (enrich das 10 bets + dupla EstrelaBet) estão 0% executados e a lacuna cresceu. Hit global não distorce (fallback por status), mas toda análise por champion/trigger/kills enxerga só ~59% da amostra nova.
5. **Volume colapsado é estrutural, não ruído:** trigger nas majors em julho = 21,2% CI [12,2–34,0] (11/52 mapas) vs 43,6% split 2 — o CI nem encosta no baseline. Share de PEEL_PURE nos slots de support: 51,8% → 18,9%. Trigger virou LPL-only (LEC 1/9, LCK 0/4, CBLOL 0/5, LCS 0/4). EV do Under a 1u: ~R$0,6–1,5k/semana — não paga a operação sozinho.

---

## Estado do método — números verificados

### UNDER (principal)

| Célula | Hit por MAPA (CI 95%) | n mapas | P&L real | Leitura |
|---|---|---|---|---|
| **Global** | **60,2% [52,5–67,5]** (green rate real 61,5%) | 161 | **+R$15.793 (ROI 7,0%)** | acima do BE 57,1%; gap vs baseline 66,2% EXPLICADO na seção Baselines (linha praticada, não decaimento) |
| Com Milio | 74,2% [62,1–83,4] | 62 | +R$30.240 | o método de verdade |
| Sem Milio | 52,7% [42,6–62,5] | 93 | −R$16.853 | 🔴 abaixo do BE |
| 2peel | 65,3% [55,3–74,1] | 95 | +R$18.943 | saudável |
| 1peel+flex | 54,5% [42,6–66,0] | 66 | −R$3.150 | 🔴 rebaixamento justificado; só paga com Milio (81,3% n=16) |
| Split 3 (≥21/07) | 81,8% [52,3–94,9]* | 11 | +R$7.208 | acima do CI; n pequeno |
| Backtest method_reports | 63,8% [59,1–68,1] | 436 | — | pooled reproduzível |
| Backtest split 3 | 91,7% (11/12) | 12 | — | sinal vivo no patch atual |

\* incluindo os 3 mapas das 5 bets sem enrich (todas green); core sem elas: 75,0% n=8.

- **Verificação adversarial:** P&L, stake, odd média (1,752 → BE 57,1%) e n batem **ao centavo** por caminho independente. O hit global reportado como 60,9% caiu pra **60,2% determinístico** — a diferença é 1 mapa que flipa por ordem instável de query em 6 ladders com sim misto (bug real da lib, ver Ações §T4). Split2 59,5% e maio 61,2% nas versões determinísticas.
- **Por liga:** LPL 68,9% (+R$8.857) e CBLOL 63,2% saudáveis · **LCK 57,9% (−R$1.578), LEC 45,0% (−R$5.451), LFL 53,3% (−R$4.020) sangrando** · LCS 87,5% (n=8, inflado por stake).
- **Mensal:** abr 58,3% (−R$2.893) · mai 61,2% (+R$20.505) · jun 53,8% (−R$4.261) · jul 75% (n=8). Maio = 64% dos mapas históricos e mais que todo o lucro líquido. Edge real existiu em 1 de 4 meses.
- **Drawdown:** atual R$3.006 vs máximo histórico R$9.821 (24/05→03/06) — benigno, nada justifica mexer em stake.
- **Variante Map5 underkill:** n=4 mapas (75%, +R$857), ZERO casos novos desde 24/05 — split regular é BO3. Checkpoint n≥30 inalcançável até playoffs → candidata a **arquivar como adormecida**.
- **Skips/regras:** Rell/Naut — 2ª violação encontrada que a revisão perdeu (G2×KOI M1 24/07, Camille/Rell, green +R$1.500 — é a própria dupla EstrelaBet suspeita); desde 26/07, 2 casos do conflito Milio×Rell/Naut operados como SKIP e o skip pagou (~R$560 economizados; AL×TES M2 deu 43 kills). Bard×Karma/Bard×Lulu foram revogados por ANÁLISE em 26/07 (não por idade) — 1 caso pós-revogação, conforme, green. Yuumi: 1 violação (dentro do desvio múltiplo TOG×USE, ver abaixo).
- **Milio mapa 2 (conflito de precedência):** as 3 reds do Milio em julho são TODAS mapa 2 — M2: 2/5 (−R$2.734) vs M1/M3: 7/7 (+R$9.578). Caso novo VIT×KOI M2 operado como Milio-vence (2u, linhas fair/fair−2, odd 1,88) → red −R$2.000. n pequeno, mas o dado novo pende pra **cautela mapa 2 vencer o tier Milio**.

### OVER / JANELA CAMILLE

- **Reprovação do Over geral CONFIRMADA no dinheiro real:** pós-21/07, tudo fora de mapa Camille = **−R$6.134** (11 bets); discricionário puro −R$1.134. Todo o lucro do Over (+R$11.742) está nos mapas Camille.
- **Janela Camille DE PÉ:** real por mapa 17/23 = **73,9%**; universo independente (todos os jogos dos results 22–30/07, com bet ou sem) 10/15 = **66,7%** — colado no backtest 67,3%. A fatia fraca é vs Shen (3 dos 6 reds).
- **Premium (vs Rell/Naut/Leona):** acumulado **27/34 = 79,4%** (a revisão de 26/07 contava 24/29 e tinha perdido o TT×BLG M3, Leona×Camille green, achado via results.json). **Trava n=35 matematicamente decidida na convenção R/N/L: mesmo red no 35º mapa fica 77,1% ≥ 72% → premium 2u CONFIRMA** (formalizar quando o 35º cair). Na leitura estrita só-Rell/Naut: 23/29, ainda aberta.
- **Semana atual (26–30/07): 4/7 = 57,1% — 1ª semana abaixo do CI [58,2–75,2]** (semana passada 80%). n=7 sem significância; pós-patch 1/3. Alerta amarelo armado: 2ª semana consecutiva abaixo = investigação obrigatória.
- **Piso odd ≥1.80 é regra morta:** ignorado em 13 das 18 bets breach do split 3 e em 4 dos 7 mapas da semana — 2ª semana seguida após o tribunal cobrar decisão. Odd média ~1,73 sobe o BE de 55,6% pra 57,8% e come metade do edge da janela.
- **Observação SIMULATED:** disciplina cumprida desde 26/07 (zero dinheiro real). `over_rell_naut` **1/5 morrendo no sim** · `over_pyke_watch` 6/6 mas n=6<20 → **não promove** · `under_shen_top` 0/2.

### PATCH 26.15 & META (protocolo de pausa)

- **Protocolo NÃO acionado — patch limpo:** zero mudanças em Camille, Milio, os 10 PEEL_PURE, os 4 FLEX, Rell/Naut/Leona/Pyke; zero mudança sistêmica de kills. Confirmado em 3 fontes (notas oficiais Riot, wiki V26.15, Dot Esports). Janela e boost seguem operáveis.
- **O risco é o DRAFT, não o patch:** Nami 10,1%→0, Lulu 11,4%→2,3%, Seraphine 11,6%→3,8%; engage/bruiser sups ocupam ~65% dos slots. Kills médios julho +1,8 vs split 2 (esfriou vs o +3,9 do recorte 21–25/07).
- **Emergentes:** **Shen SUP explodiu** (0,5%→14,4%, 19 mapas em 9 dias) e aponta pra UNDER (28,5 kills médios vs fair 31,8) — não é "a próxima Camille", é candidato a variante de observação under. **Alistar** (único buff que toca support no 26.15) já subiu 3,7%→7,6% e rouba slot de peel — vetor extra contra o volume; NÃO re-propor na FLEX (base −26,8% ROI). Pyke: 0 picks nas majors em julho, vivo só em tier-2.

### JANELA NOVA 26–30/07 (o que a revisão de domingo não viu)

- **+R$2.839,51** em 34 bets (stake R$31.398) — positiva, mas 6× menor que a semana anterior. Verificado centavo a centavo por agente independente.
- Núcleo pagou: Under método +R$4.625 (4/5 mapas) · Camille conforme +R$3.236 (3/3). Discrição drenou: breaches Camille −R$2.258 · pré-draft −R$2.063 · **ML discricionário −R$2.159 (9 bets, virou a maior classe negativa — semana passada tinha dado +1.144)** · cautela-M2 violada −R$2.000.
- **Contrafactual: playbook puro ≈ +R$5.954 → discrição custou ≈ −R$3.114** (sensibilidade: −R$4.114 se a janela LEC contar como válida). 3 triggers green ficaram na mesa (≈ +R$1.440 não capturado).
- **Os 2 GREENs de hoje (HLE×DK M3) CONFEREM com 2 sinais independentes:** getEventDetails completed + frame finished do livestats = 30 kills exatos (HLE 13 × DK 17), 2peel real (Milio HLE × Lulu DK), linha 32,5 = fair 31,5+1, odd 1,80, 2u justificado por Milio, +R$800,02 cada. Ressalvas: entrada pré-draft ("2u pendente de justificativa") e `is_method_bet=false` não flipado no settle → **os 2 mapas estão FORA das stats do método** (fetchAnaliseStats filtra `is_method_bet=eq.true`); mesmo caso na TT×JDG (97449c38).

### LIGAS & STAKE

- **Escopo 100% limpo:** 87 bets reais do split 3, todas em 9 ligas do set canônico; LIT/LRS/NACL zero; **KCL zero antes e depois de 27/07** — teste KCL morre com n=0, só formalizar o encerramento.
- **Teste Prime (vence ~04/08): ZERO settles do objeto do teste** (Under trigger). +R$6.410 vieram de janela Camille (3/3), ladder discricionário e ML. A decisão real é: efetivar só a **janela Camille em Prime** (3/3 em 2 semanas) — o Under Prime segue sem dado.
- **Teste LES:** checkpoint correto é ~11/08 (liga voltou 28/07), não 04/08. Única ação foi um ladder pré-draft red (−R$2.063). Sem dado.
- **LCP:** 9 settles por bet / 4 mapas (checkpoint 20) — **recorte Milio segue 0 casos** (o que justifica o teste ainda não aconteceu) e 30/07 operou inteiro FORA do recorte (SHG×DFM: Over pré-draft + 2 MLs, −R$1.350).
- **Overstake desde 26/07:** R$5.380 formal / R$3.680 em mercados de kills. O overstake grande está sempre colado em pré-draft/off-method, nunca no método conforme. Desvio múltiplo premiado TOG×USE M3 (Yuumi + Alistar + odd 1,88 + ~2,6u em liga teste, green +R$2.243) = value de linha desalinhada (Thunderpick 34,5 vs mercado ~29), não método — green que reforça hábito ruim.

### INTEGRIDADE DOS DADOS

- **Núcleo transacional limpo (verificado por reprodução independente do zero):** 0 pendings, 0 green/red sem profit, 0 sem bet_datetime, invariante sim-profit PASSOU (0 violações em 69 times), leagues normalizadas.
- 🔴 **Enrich não rodado e lacuna cresceu** (detalhe no Top 5 #4).
- 🟡 **Dupla EstrelaBet b79d9056×894ed74f segue aberta** (±R$750 no P&L; único par <5min sem ladder_group_id/nota/screenshot). Só o Elvis resolve, no histórico da casa.
- 🟡 **fetchAnaliseStats não aplica team-aliases.json:** 18 times fragmentados na leitura POR TIME (Karmine 37% n=19 vs Karmine Corp 86% n=7; BLG 45% vs BILIBILI 69%...) — não afeta hit global/por liga, afeta briefing/flags por time. +1 alias faltando (Fluxo W7M).
- 🟡 **2 bugs novos da lib achados pela verificação:** (a) parse de linha pega o número do mapa ("Mapa 2 Menos de 26.5" → simLine 2); (b) pick com "Over/Under" no nome do mercado vira isOver=true (under de 38 kills contado como sim-win). + ordem de query sem tie-break flipa 3 mapas.
- ladder_group_id: 3 paths × 3 formatos (bug conhecido, sem conflito de valores; migração D5 pendente).
- 48 bets EWC sem match_id: limitação conhecida da fonte (Liquipedia), fallback funcionando, sem caso novo.

---

## Baselines-mãe re-derivados da fonte primária

Os 3 números contra os quais tudo compara foram **recomputados do zero por implementação independente** (não só re-leitura dos JSONs):

| Baseline | Reproduzido? | Fonte primária real |
|---|---|---|
| Under pooled 66,2% [62,2–70,0] n=565 | ✅ **exato** (374/565; split1 92/147 + split2 282/418) | `audit-output/12-over-v2.json` via `over-method-v2.cjs` — régua LOO fair+1 @1.72. **Não vem do dashboard_stats.json** (que é uma 3ª régua: só 2peel, n=272, 65,1% @1.85) |
| Over reprovado 50,0% n=204 / pooled 51,9% | ✅ exato (102/204; 140/270) | universo split1 + arquétipos do `split2-over-method.cjs` |
| Camille 67,3% [58,2–75,2] n=113 | ✅ exato (76/113, ROI +21,1% @1.80) | `17-camille-sweep.json`, universo 30 ligas; ressalva: 72% da amostra é julho (janela de patch, não método) |

**A pergunta central — o Under real (60,2–61,5%) degradou vs o baseline 66,2%? NÃO. O gap decompõe quase inteiro e o sinal está vivo:**

| Fator | Efeito no hit |
|---|---|
| Seleção de mapas do Elvis (131/161 mapas estão DENTRO do universo do backtest) | **+1,7pp a favor** — nos exatos mapas apostados, a régua do backtest dá **67,9%**; zero seleção adversa |
| **Linha real da casa ~1 kill pior que a LOO fair+1 assumida** | **−5,3pp (fator dominante)** — pareado nos mesmos 131 mapas: backtest-ganha/linha-perde 10×, o inverso 0× (p≈0.001) |
| 30 mapas fora do universo (EMEA, LPL pós-jun, EWC) | −1,1pp |
| Artefato da régua da lib (odd<1.72 → linha−1 em 96/288 bets) | −0,6 a −1,3pp — o green rate real por mapa é **61,5%** (99/161) |

- De onde vem o −1 kill: só 32% das entradas foram a fair+1 ou melhor; 30% na fair; 38% abaixo da fair. **Comportamento documentado e autorizado** (decisão 26/07: sem regra de linha mínima) e parcialmente compensado por odd melhor nos degraus baixos (1,79 vs 1,71).
- **Leitura de edge justa:** real 61,5% vs BE 57,1% = **+4,4pp de margem (ROI 7,0%)** — positivo, mas metade da margem do backtest (+8,1pp, ROI 13,9%). A metade perdida é preço/linha de mercado, não decaimento do sinal de draft.
- **Referência honesta de acompanhamento daqui pra frente: ~62–63% na linha real (ou method_reports 63,8%), não 66,2%** — o 66,2% é verdadeiro na régua dele, mas descreve outra operação.
- A degradação real que existe é de **VOLUME** (trigger 21,2% vs 43,6%) e de **concentração** (Milio) — confirmadas, não contraditas, por este ângulo.

## Higiene operacional / pipeline (ângulo 6 do protocolo)

- 🟢 **Cron 5/5 success 26–30/07**; 27–28/07 foram dias SEM jogos de majors (confirmado por 2 vias: Actions success + getSchedule com 0 matches) — o gap de results.json não é falha.
- 🟢 **Pendência #2 do CLAUDE.md está RESOLVIDA — o doc é que está velho.** Os fixes de método de 21/07 foram commitados em f7a3374 (22/07, analisador real `_archive/scripts/analyze_range.cjs`) e d0efdf4+ffdf1cc (26/07, rebuild + cópias). Diff local×origin nos scripts = vazio; origin roda a definição correta (PEEL 10, FLEX sem Alistar). **→ os results/method_reports usados nesta auditoria (21–30/07) foram gerados com a definição CERTA** (o único arquivo gerado com definição velha, 22/07, foi regenerado pelo cron de 23/07). Atualizar CLAUDE.md (pendência #2, linha "definição autoritativa em analyze_yesterday.cjs", "2x/dia").
- 🔴 **Fair Pinnacle 27–30/07 NUNCA subiu pro origin** — os 4 `fair-pinnacle.json` estão untracked no local; o cron caiu na fórmula. Concreto: HLE×DK M3 (30/07) gravado no method_reports com fair 30.5 (fórmula) quando o Pinnacle do Elvis era 31.5; 29/07 coincidiu no valor mas `fair_source` errado. Viola a hierarquia "Pinnacle primário" em qualquer análise por régua de fair sobre dados do origin de 27/07+. Causa estrutural: `/log-fair` salva local e nada commita diariamente.
- 🟡 **6 triggers falsos de Alistar no histórico** (mai–jun, upsert nunca deleta): afeta análises que leem `trigger_type` cru de method_reports/results antigos — incl. a aba Milio do dashboard (3 mapas Alistar/Milio contados como trigger). Não afeta dashboard_stats (rebuild reclassifica). Fix barato: delete 6 rows + regenerar 5 results antigos (write, precisa aprovação).
- 🟡 `tier2_dashboard_stats.json` parado desde 22/05 (rebuild fora do workflow); demais JSONs do dashboard regenerados hoje 13:30Z — dashboard público principal está fresco.
- 🔴 **getEventDetails stale segue ABERTO** (lote B não implementado; bug ativo em 30/07 — getSchedule marcou NIP×WBG completed com jogo ao vivo). Settles manuais continuam sendo necessários.
- Menor: snapshots diários ≈ 2,45 MB/dia inflando o repo (~75 MB/mês) — vale rotação.

## LFL & watchlist (arbitragem de conflito entre agentes)

Dois agentes divergiram sobre a LFL; arbitrado com query direta no banco:

- **Os dois estavam certos em janelas diferentes.** LFL Under-método HISTÓRICO: 27 bets / 15 mapas, 53,3%, **−R$4.019,73** (reproduzido exato) — mas o rombo é de **junho (0/3, −R$5.703)**; maio ficou no zero (+R$57) e julho tem 1 única bet de método (green +R$1.626). O +R$4,1k de julho na LFL veio de **Over/janela Camille**, não do Under.
- **Diagnóstico correto: não é liga sangrando hoje, é prejuízo histórico + volume zerado.** Trigger em julho na LFL: 1 em 15 mapas (21–23/07) — meta virou engage (Rell/Naut/Leona/Alistar/Shen em 12/15 mapas, 33,7 kills médios).
- **Backtest LFL (arquivos de 26/07, atualizados):** 2peel 68–75% (conforme a régua) sustenta; **1peel+flex 55,0% n=20 na linha 29.5 = abaixo do BE real 57,1%** — só o 2peel segura a liga no OPERA. `tier2_dashboard_stats.json` (21/05) é obsoleto, ignorar.
- **LES (TESTE) tem backtest igual/melhor que LFL (OPERA)**: 69,4% n=36 fair+1 vs empate 61,5% na régua comum — o status veio do set de 26/07, não de gap de dado.
- **Watchlist do protocolo: MF, Aurora, Sylas, Yasuo como support = ZERO em 560 mapas / 23 ligas em julho.** Sem dado, sem ação.
- **Shen SUP: NÃO abrir variante de observação.** A proposta do ângulo patch-meta conflita com hipótese já testada e REFUTADA em `2026-07-25-shen-under.md` (Shen sup 48,1% under pooled n=54, ROI −10,8% @1.72; 74% da amostra é counter de meta engage — 18 jogos vs Camille são a própria janela Over). O recorte under-lean de julho (12/19) é leitura, não reverte o pooled. Só `under_shen_top` (obs. simulada, 0/2) segue.
- Nota: `2026-07-26-under-engage-fade.md` (variante SIMULADA under fair+3 vs duplo engage, 64,2% n=316) já cobre o fenômeno "meta engage" — trava de promoção n≥20 sim + hit ≥60% + validação da premissa de mercado.

---

## Decisões que exigem o Elvis

| # | Decisão | Dado que pressiona |
|---|---|---|
| 1 | **SKIP Over LEC** (agendada 02/08): manter absoluto ou "só janela com draft confirmado" | violada 4× desde 26/07 (−R$2.000); única classe LEC lucrativa foi a janela conforme |
| 2 | **Pré-draft: proibir formalmente?** | −R$4.440 acumulado e a verificação provou que perde MESMO quando a Camille vem; escalou pra 2u sem sinal |
| 3 | **Piso odd ≥1.80 da janela: reafirmar ou revogar** | 2ª semana seguida ignorado (13/18 breaches; 4/7 mapas da semana) |
| 4 | **Precedência: cautela mapa 2 × Milio-tier** | Milio M2 julho 2/5 (−R$2.734) vs M1/M3 7/7; caso novo red −R$2.000 |
| 5 | **Precedência: skip Rell/Naut × Milio-tier → formalizar skip vence** | 2 casos novos operados como skip, skip pagou (+R$560 economizados) |
| 6 | **Under LEC: criar skip/observação?** | 45,0% n=20, −R$5.451 — sangra igual ao Over LEC, e não tem regra |
| 7 | **Dupla EstrelaBet** b79d9056/894ed74f | conferir no histórico da casa (±R$750) |
| 8 | **Map5 underkill: arquivar como adormecida** | 0 casos em 2+ meses; checkpoint n≥30 inalcançável até playoffs |
| 9 | **Prime: efetivar só a janela Camille; Under Prime segue sem dado** | 3/3 Camille vs 0 settles do objeto do teste |
| 10 | **KCL: formalizar encerramento (n=0)** | zero bets antes e depois da inoperância |
| 11 | **Adotar 62–63% (linha real) como referência de acompanhamento do Under** — o 66,2% é régua de backtest, não da operação | decomposição pareada da seção Baselines; evita alarme falso de "degradação" toda semana |
| 12 | **LFL: manter OPERA?** | prejuízo é histórico (junho −R$5.703 no 1peel+flex fraco: 55% @29.5); hoje o problema é volume (1 trigger em 15 mapas); 2peel backtest 68–75% sustenta |

## Ações técnicas propostas (executar só com aprovação — nada foi tocado)

1. **Rodar `enrich-match-context.cjs` nas 35 bets do split 3 sem kills** — prioridade máxima: desbloqueia a re-avaliação do método no período que importa.
2. **Flip `is_method_bet=true`** nas 3 bets confirmadas no settle (c04b1e3a, 40722eab, 97449c38) + definir no playbook quem flipa (o settle) daqui pra frente.
3. **Aplicar team-aliases.json na leitura** (fetchAnaliseStats/normTeamName) + adicionar alias "Fluxo W7M"→"Fluxo".
4. **Fix lib:** tie-break determinístico no aggBy (order bet_datetime,created_at) + parse de linha ignorar "Mapa N" + isOver não casar com o nome do mercado "Over/Under".
5. **Estender pipeline** (analyze_yesterday/method_reports) pra LFL/Prime/LCS/LCP — o volume do método migrou pra onde o pipeline não enxerga (cobrado pela 2ª revisão consecutiva).
6. Padronizar `ladder_group_id` (path + formato únicos, decisão D5 de 25/07).
7. Exigir na note o momento da entrada vs draft (pré-draft real × draft visto na stream com API atrasada — hoje inauditável).
8. **Commitar/pushar `fair-pinnacle.json` diariamente** (ou passo no cron) — 27–30/07 nunca subiram e o origin caiu na fórmula, violando a hierarquia "Pinnacle primário" no method_reports.
9. **Atualizar CLAUDE.md do projeto:** pendência #2 já resolvida (fixes commitados 22 e 26/07); definição autoritativa vive em `_archive/scripts/analyze_range.cjs` (não em analyze_yesterday.cjs:20-24); cron é 1x/dia.
10. **Limpar 6 triggers falsos de Alistar** no method_reports (mai–jun) + regenerar os 5 results antigos — hoje contaminam a aba Milio do dashboard (3 mapas).

## Limitações desta auditoria

- Amostras do split 3/patch 26.15 são pequenas (n<12 na maioria das células) — leitura, não base.
- `method_reports` cobre só as 5 majors; volume real do método em ligas teste segue não medido pelo pipeline.
- Spot-check externo (gol.gg) de kills históricos não foi feito (só os 2 greens de hoje verificados por 2 sinais); 48 bets EWC settladas por fonte manual seguem sem conferência externa.
- Cruzamento banco × extratos das casas pendente desde 26/07 (só o Elvis).
- Contrafactuais dependem da resolução das decisões #1 e #3 (reportadas as sensibilidades).
- Divergência menor não fechada: 87 bets (contagem ligas) vs 86 settladas (contagem integridade) no split 3 — 1 bet de timing/estado, sem impacto material.
- CLV/qualidade de preço (Polymarket reativado 25/07) não medido — candidato a estudo separado.

*Auditoria gerada em 30/07/2026. Nenhuma regra alterada, nenhum write em produção. Verificação adversarial: integridade CONFIRMADO · under-perf PARCIAL (hit 60,2% vs 60,9%, causa identificada e corrigida no texto) · over-camille PARCIAL (split pré-draft corrigido: Camille veio em TODAS) · janela-nova CONFIRMADO. Fechamento de lacunas do crítico: baselines reproduzidos exatos + gap decomposto · higiene operacional rodada (pendência #2 já resolvida; fair 27–30/07 não pushada) · LFL arbitrada com query direta (os dois agentes certos em janelas diferentes) · watchlist zero · Shen sup refutado (não reabrir).*
