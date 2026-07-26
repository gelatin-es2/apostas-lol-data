# Revisão Semanal de Domingo — 2026-07-26

**Semana coberta:** 19–25/07 (primeira semana do split 3; jogos a partir de 21/07)
**Fonte:** Supabase `bets` (janela `bet_datetime` 19/07 00:00 → 26/07 00:00 BRT), `method_reports`, `cron-data/*-results.json` (22–25/07, dias 24–25 lidos de `origin/main`), tracker de observação (`--apply` rodado hoje: +1 bet `over_rell_naut`), GitHub Actions, livestats re-fetch.
**Protocolo:** `knowledge/references/revisao-semanal-protocolo.md` (7 ângulos).
**Nota:** auditoria de SISTEMA (dados split 3 + pipeline + config) roda em paralelo — achados de pipeline aqui são referenciados, não corrigidos.

---

## Veredito em 1 linha

🟡 **AMARELO** — semana lucrativa (+R$16.800) e método performando acima do CI, MAS: (1) padrão novo de Over pré-draft custou −R$5.000 em 2 mapas, (2) variantes de OBSERVAÇÃO operadas com dinheiro real (−R$2.000 na rell_naut que está 0/2), (3) três conflitos de regra no playbook sem dono (Milio-tier × skip Rell/Naut; Milio-tier × cautela mapa 2; SKIP Over LEC × janela Camille).

## ⚠️ Achados que contradizem o playbook (topo, sem esperar pergunta)

1. **Over pré-draft** (4 matches: KOI×G2, FLY×LYON, VIT×G2, TES×TT): a janela Camille é condicional ao DRAFT; entrar antes do draft é apostar que a Camille vem. Resultado: quando não veio/não confirmou = 0/2 mapas, −R$5.000; quando veio = 2/2, +R$1.563. Net −R$3.437. Não existe regra no playbook autorizando entrada pré-draft.
2. **Observação ≠ dinheiro real**: `over_rell_naut` (status: observação SIMULADA, 60.6% n=33 no backtest) foi operada real 2× (`ed3ae9ab` −R$1.000, `079ab5a4` −R$1.000). No split 3 a variante está **0/2 nos mesmos mapas** (sim + real concordam). `over_pyke_watch` também foi operada real 1× (+R$746) com n simulado de apenas 4.
3. **Skip Rell/Naut no Under violado 1×**: `cc0c252a` LGD×WE M1 (Naut × Milio), R$1.627 — green +R$1.186. Anedota não revoga a base (−17% ROI, n=128/248). O playbook não define quem vence quando Milio (boost) e Rell/Naut (skip) aparecem juntos — precisa decisão.
4. **Cautela mapa 2 ("stake nunca premium") violada 3× — sempre com Milio** (LGD×EDG M2 2k red, JDG×AL M2 2k green, DIG×SEN M2 2k green). Mesmo conflito: tier Milio × cautela mapa 2, playbook omisso.

---

## Ângulo 1 — Integridade de dados

| Check | Resultado | Severidade |
|---|---|---|
| Pendings órfãs | 0 pending no banco inteiro | ✅ |
| status × profit incoerentes (semana) | 0 | ✅ |
| Under com odd > 1.85 | 0 | ✅ |
| Spot-check settles manuais (bug getEventDetails 25/07) | LOUD×paiN M3 = **14 kills (13×1)** e DIG×SEN M2 = **21 kills (4×17)** re-confirmados em frame `finished` do livestats (cache `audit-cache/window-*.json`, ts 21:45Z/23:25Z) — batem com `settle_source` | ✅ |
| **10 bets de kills sem `total_kills`/picks no match_context** (settles manuais de 24–25/07 + 2 EstrelaBet por print) | `b79d9056, 894ed74f, 628daaa6, a51a6504, 3e0765b2, ab75218d, 10774345, e9ceb50e, d055e307, b470d693` — caem no fallback `fromStatus` do analiseStats (hit ok) mas ficam fora de qualquer análise por kills/champion | 🟡 rodar `enrich-match-context.cjs` (frames já disponíveis — provado no spot-check) |
| **Possível dupla-registro** | `b79d9056` × `894ed74f`: EstrelaBet, G2×KOI M1, Under 35.5 @1.75, R$1.000 cada, criadas com 47s de diferença, **ambas sem screenshot e sem notes**. Se foi 1 slip só, PnL da semana está inflado em +R$750 | 🟡 Elvis confere no histórico da EstrelaBet |
| **ladder_group_id inconsistente** (bug latente conhecido piorou) | 3 formatos na semana (`ladder_SGEvBIG_*`, `ladder-we-jdg-*`, uuid) + ladder KHK×USE (4 pernas) **sem id nenhum** + hedge G2×KOI sem id | 🟡 |
| Fair fórmula early-split | `results` de 22/07 mostram `fair_formula 37.5` vs Pinnacle 32.5 (EDG×LGD com `blue_sample_n=1`, `league_baseline=37` vs kills reais médios LPL 31.0). Fórmula NÃO confiável nas 2 primeiras semanas de split — Pinnacle cobriu as majors, mas observação SIMULATED em tier-2 usa fórmula | 🟡 referenciar auditoria paralela |

## Ângulo 2 — Performance vs esperado

**Total real da semana: 53 bets, stake R$56.6k, P/L +R$16.800** (21/07 +1.240 · 22/07 +2.878 · 23/07 +5.121 · 24/07 +2.065 · 25/07 +5.497).

Por mapa (dedup `lolesports_game_id`), célula n<10 = **não é base**, só leitura da semana:

| Método/classe | Mapas | Hit semana | CI 95% | Referência histórica | Leitura |
|---|---|---|---|---|---|
| Under método (conforme) | 7 | 6/7 = 86% | [48.7–97.4] | 66.2% CI [62.2–70.0] | dentro/acima do CI — sem alarme |
| — só Milio no jogo | 5–7 | 6/7 = 86% | — | 72–75% | consistente |
| Janela Camille (todas) | 15 | 12/15 = 80% | [54.8–93.0] | 67.3% CI [58.2–75.2] | acima da baseline |
| — premium vs Rell/Naut/Leona | 6 | 6/6 | — | 78.3% (18/23) | acumulado ≈ **24/29 = 82.8%** (trava n=35: falta 6) |
| Over discricionário (fora da janela) | 6 | 3/6 = 50% | [18.8–81.2] | Over genérico ≈ BE (reprovado) | confirma a reprovação |
| Over pré-draft | 2 | 0/2 | [0–65.8] | — (padrão novo) | −R$5.000 |

P/L por classe (por bet): Camille conforme +R$10.945 · Under método +R$6.183 · violações/breaches Camille (piso odd, fair+3, teamtotal, overstake) +R$811 · Under skip-violado +R$1.186 · hedge +R$1.500 · ML +R$1.144 · mercados de mapa +R$323 · Over discricionário −R$505 · pré-draft −R$5.000.

**Alerta de volume, não de qualidade:** o Under método gerou só ~7 mapas reais na semana; a Camille carregou 2/3 do lucro. Nenhum hit abaixo do CI → sem alerta amarelo de performance.

## Ângulo 3 — ⭐ Tribunal das regras

| # | Regra ativa | Evidência da semana (n novo) | Evidência base | Veredito |
|---|---|---|---|---|
| 1 | Under 2peel core, 1k, fair+1 @~1.72 | 2 mapas reais 2G + 4 triggers `method_reports` todos under_hit=true | 66.2% n=565 | **MANTÉM** (n da semana minúsculo — volume é o problema, não o hit) |
| 2 | 1peel+flex rebaixado (500 só com sinal extra) | 2 casos, ambos com Milio (sinal extra), 2G | 58.9% n=175 ≈ BE | **MANTÉM** (0 casos sem sinal → sem dado novo) |
| 3 | Milio boost 2k | 7 mapas Milio 6G/1R (86%) | 72% n=132 real | **MANTÉM** |
| 4 | Skip Rell/Naut no Under | violado 1× (green +1.186; n=1 = anedota) | −17% n=128/248 | **MANTÉM** + ⚠️ decidir precedência vs Milio-tier |
| 5 | Skip Bard×Karma, Bard×Lulu; Yuumi peel; ≤fair−2 sem Milio; odd>1.85 | 0 casos na semana | n=25/18 (splits 1+2) | **MANTÉM em observação de idade** — sem re-teste possível; re-checar quando split 3 acumular casos (regra sem evidência re-confirmada em 4 semanas rebaixa) |
| 6 | Cautela mapa 2 (linha ≥fair+1, stake nunca premium) | 3 desvios, todos Milio 2k (2G/1R); WE×JDG M2 na fair (não fair+1) green | 55.9% n=186 | **MANTÉM** + ⚠️ decidir precedência vs Milio-tier |
| 7 | Flags de time = só informação | semana rodou sem flags, sem incidente | contrafactual −R$22k | **MANTÉM (morta — não ressuscitar)** |
| 8 | Janela Camille tiers v3 (2u vs Rell/Naut/Leona; 1u resto; linha ≤fair+1; odd ≥1.80) | 15 mapas 12G (80%); premium 6/6 → acum. 24/29 | 67.3% n=113 | **MANTÉM**; trava premium n=35 segue armada (precisa cair <72% pra reverter — hoje impossível até n=35) |
| 8a | — piso odd ≥1.80 | violado 3–4× (@1.72/1.729): −1.000 red, +1.440 green, pernas LCP | piso vem do backtest @1.80 | **REAFIRMAR ou ajustar** — hoje é regra escrita sendo ignorada; decisão Elvis |
| 8b | — linha máx fair+1 | 1 bet a fair+3 green +507 (`e117ab6a`, a própria nota admite "FORA das regras") | fair+2 = BE no backtest | **REAFIRMAR** |
| 9 | SKIP Over LEC (diretriz 24/07) | AMBÍGUA na prática: Camille-window LEC 2/2 green +R$2.246; prejuízo LEC veio de pré-draft (−R$3.000) | diretriz verbal, sem doc | **DECISÃO ELVIS HOJE** — proposta: "Over LEC só via janela Camille com draft confirmado" |
| 10 | LCP teste (Milio 1k / Camille janela / resto skip) | 1 match Camille +R$1.571 green; Milio: 0 oportunidades; MAS stake 2k vs teto 1k e pernas <1.80 | decisão 25/07, checkpoint 20 settles/4sem | **MANTÉM teste** (4/20 settles) + cobrar teto |
| 11 | Expansão Prime/KCL/EUM (stake 1k, teste 2 sem) | Prime: 3 matches Camille +R$5.167 (ladder KHK 2.965 no mapa ≈ overstake leve); Under Prime 0 triggers; KCL volta 27–29/07 | mineração 21/07 | **MANTÉM teste** (semana 1 de 2) |
| 12 | Trava fair Pinnacle 1ª msg | `fair-pinnacle.json` presente 20→25/07 (6/6 dias) | — | **MANTÉM** ✅ |
| 13 | Variantes de observação = SIMULATED, sem dinheiro real | pyke 4/4 sim (+1 real +746) · rell_naut **0/2** sim (+2 reais −2.000) · shen_top 0/1 | criadas 25/07 | **MANTÉM como observação** + ⚠️ disciplina: real só depois de promoção com critério |
| 14 | Over genérico reprovado (não operar fora da janela) | discricionário 3/6 mapas, −R$505 | 50% n=204 out-of-sample | **MANTÉM reprovado** |
| 15 | Lux na FLEX (adiada 25/07 — não reabrir) | 1 caso Lux-flex (JDG×AL M2, green) — n acum. split 3 = 1 | — | **NÃO REABERTA** (conforme decisão; só contando n) |

## Ângulo 4 — Meta / patch watch

- **Taxa de trigger nas majors: 4/25 mapas = 16.0%** (LPL 4/21, LEC 0/4; LCK sem jogos) — confirma ao vivo o alerta de julho (17.3% vs 43.6% no split 2). Volume Under nas majors segue ~1/3 do split 2.
- **Kills médio:** LPL 31.0, LEC 32.8 — meta de kills alta confirmada (patch de julho +3.9).
- **Patch 26.15 chega TERÇA 29/07**: preview público = rework Bel'Veth, nerfs Riven/Mordekaiser/Locke/Naafiri. **Nenhuma menção a Camille ou Milio no preview** → janela sobrevive por ora. AÇÃO obrigatória: ler notas finais em 29/07 (protocolo: nerf em pick da janela = pausa imediata). Fontes: dotesports.com/league-of-legends/guides/lol-patch-26-15-notes · hotspawn.com/league-of-legends/news/league-of-legends-patch-26-15
- Champion emergindo: nada novo além da própria Camille (72% da amostra da janela é do patch atual). Pyke segue o candidato nº 2 (obs. 4/4).

## Ângulo 5 — Oportunidades

- **Prime League** pagou +R$5.167 na semana 1 do teste (tudo janela Camille). **KCL volta 27–29/07** — garantir fair/briefing.
- **Pyke watch**: 4/4 sim + 1 real green. n=4 = não é base. Proposta de critério de promoção (pra evitar o caminho rell_naut): promover a teste real R$500 só com **n≥20 sim e hit ≥60%**; até lá, zero dinheiro real.
- **LCP**: Pinnacle abre linha (4/4 green no dia 1). Milio LCP ainda 0 casos — o recorte que sustenta o teste (12/13) segue sem dado novo.
- **method_reports não cobre tier-2/LCS/LCP**: com trigger colapsado nas majors, o dado novo do método está exatamente nas ligas que o pipeline NÃO persiste (ex.: KC Blue×TLN M1, Bard/Milio, green real, fora do `method_reports`). Estender `analyze_yesterday`/save pra ligas operadas = a maior alavanca de dado da semana.
- Polymarket (curvas/volume) — ferramenta em avaliação, item já agendado em pending.md (não é regra, não passou por tribunal).

## Ângulo 6 — Higiene operacional

| Item | Estado |
|---|---|
| Cron GitHub Actions | ✅ 7/7 verdes (19→25/07) |
| Fair Pinnacle diária | ✅ 6/6 dias com arquivo |
| Pendings | ✅ 0 |
| Dashboard | ✅ Vercel puxa de origin (cron commitou 24 e 25/07) |
| **Repo local** | 🟡 2 commits atrás de origin + ~93 arquivos modificados/untracked (auditoria de sistema em paralelo — NÃO tocar daqui; sincronizar quando ela fechar) |
| **Settle automático** | 🔴 bug da semana: getEventDetails serviu estado velho 6+× em 25/07 → 10 settles manuais. Fallback no `settle-pending-bets.cjs` (confiar no último frame `finished` do livestats quando eventDetails estiver stale) = fix prioritário — os spot-checks de hoje provam que o frame final estava disponível e correto |
| Enrich pós-settle-manual | 🟡 10 bets sem kills/picks no match_context (lista no Ângulo 1) |
| Rastreador de observação | ✅ rodado hoje com `--apply` (+1 rell_naut red 25/07; 6 dedup; 0 erros) |
| Bets sem registro | Nada detectado na janela (cruzamento com extrato mental do Elvis pendente de ele confirmar) |

## Ângulo 7 — Contrafactual da semana (sem julgamento, só número)

**Real +R$16.800 vs playbook puro ≈ +R$16.912 → discrição custou ≈ −R$112 líquido.**

Decomposição da discrição (por classe):

| Classe fora do playbook | P/L |
|---|---|
| Over pré-draft (0/2 quando Camille não confirmou) | **−R$5.000** |
| Observação rell_naut com dinheiro real (0/2) | −R$2.000 |
| Demais Over discricionários (pyke real +746, M3 fair+2 +169, live "chimpa" +760/−180, rell_naut já contado) | +R$1.495 |
| Breaches da janela Camille (piso odd 1.72 ×2, fair+3, team total) | +R$1.954 |
| Overstake (AL×LGD 2k em tier 1u; LCP 2k vs teto 1k) — excesso líquido | −R$214 |
| Under skip-violado (Naut×Milio) | +R$1.186 |
| ML (4 bets, WE/JDG/KC) | +R$1.144 |
| Mercados de mapa/handicap (3 bets) | +R$323 |
| Hedge live G2×KOI (cortou red da ladder) | +R$1.500 |

Leitura fria: o saldo quase-zero da discrição esconde assimetria — as perdas vieram de **entradas sem sinal** (pré-draft, observação real) e os ganhos de **gestão de posição** (hedge, ML de leitura ao vivo). O hedge live segue sendo a discrição que paga; entrada antecipada segue sendo a que cobra.

---

## Decisões que exigem o Elvis HOJE

1. **SKIP Over LEC**: manter absoluto, ou reformular pra "Over LEC só via janela Camille com draft confirmado"? (dado da semana: janela LEC 2/2 +2.246; pré-draft LEC 0/1 mapa −3.000).
2. **Over pré-draft**: proibir entrada antes do draft em qualquer liga? (0/2 mapas −R$5.000 quando a Camille não confirmou; net −3.437).
3. **Precedência de regras**: (a) Milio-tier × skip Rell/Naut — quem vence? (b) Milio-tier 2k × cautela mapa 2 "nunca premium" — quem vence? Playbook omisso nos dois; esta semana o Elvis operou como se Milio vencesse ambos.
4. **Piso de odd ≥1.80 da janela Camille**: reafirmar (e respeitar) ou revogar oficialmente? Violado 3–4× na semana.
5. **Dupla EstrelaBet** `b79d9056`/`894ed74f` (G2×KOI Under 35.5, 2×R$1.000, 47s de diferença, sem screenshot): foram 2 slips reais ou registro duplicado? (impacto ±R$750 no PnL).
6. *(Já agendados, seguem na fila: Bard flex reconciliação 67.2×58.1; LES doc cleanup; bookmaker Clutch USD; Polymarket como ferramenta.)*

## Ações propostas pra semana (executar só com aprovação)

1. **Fix do settle** (`settle-pending-bets.cjs`): fallback pro último frame `finished` do livestats quando eventDetails vier stale — elimina a raiz dos 10 settles manuais de 25/07. (Coordenar com a auditoria de sistema pra não colidir.)
2. **Backfill de contexto**: rodar `enrich-match-context.cjs` nas 10 bets settladas manualmente (kills/picks disponíveis agora) + padronizar `ladder_group_id` (path + formato únicos).
3. **Cobertura de dados nas ligas novas**: estender `analyze_yesterday`/`method_reports` (ou equivalente) pra LFL/Prime/LCS/LCP — o volume do método migrou pra onde o pipeline não enxerga.
4. **Terça 29/07**: ler notas finais do patch 26.15; qualquer nerf a Camille/Milio = pausa imediata da janela/boost (protocolo do ângulo 4).
5. Disciplina de teto: LCP Camille max 1k, premium Camille max 2k por mapa (ladder inclusa) — reforçar no briefing.

*Relatório gerado pelo rito de domingo. Nenhuma regra foi alterada sem decisão do Elvis; nenhum write em produção além do tracker de observação (`--apply`, SIMULATED, autorizado no briefing da tarefa).*
