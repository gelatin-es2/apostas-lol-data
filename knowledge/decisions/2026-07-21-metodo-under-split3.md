# Método Under Kill — playbook operacional Split 3

> ## 🔴 REGIME DE STAKE VIGENTE (decisão Elvis 2026-07-26) — SOBRESCREVE TUDO ABAIXO
> **1u em TUDO. 2u só com Milio ou Camille. Fim.**
>
> | Situação | Stake |
> |---|---|
> | Qualquer entrada do método (2peel, 1peel+flex, janela Camille) | **1u** |
> | **Milio** no jogo (Under) | **2u** |
> | **Camille** sup (janela Over) | **2u** |
>
> - **Sem stake por liga.** Toda liga usa o mesmo tier — inclusive as em teste (LES/Prime/KCL/LCP). Liga em teste se controla por CHECKPOINT (n de settles), não por stake menor.
> - **Sem meia-stake, sem premium, sem tier por trigger/mapa/contexto.** 1peel+flex vale o mesmo que 2peel.
> - Stake = exposição TOTAL do mapa, dividida entre casas se for ladder (ladder divide, NUNCA soma).
> - **Motivo (Elvis):** matriz de stake com muitas exceções é impossível de lembrar no calor da operação; 2 bonecos ele decora, o resto tem que ser igual. Simplicidade > micro-otimização de EV.
> - **NÃO EXISTE regra de "linha mínima".** Elvis sempre busca a melhor linha disponível — proibir linha abaixo da fair está DESCARTADO (decisão dele 2026-07-26). Linha é oportunidade de mercado, não regra.


**Data:** 2026-07-21 (véspera da volta das ligas majors) · **Base:** splits 1+2 validados (565 mapas com trigger, Under fair+1 @1.72: 66.2% hit, CI [62.2–70.0], BE 58.1%) + auditoria completa do banco + análises `10-improve` / `12-over-v2` / `13`–`15`.

## O que aposta (gatilho — atualizado 2026-07-21 noite)

- **2peel:** os dois supports em PEEL_PURE (soraka, sona, janna, lulu, yuumi*, karma, seraphine, renata, nami, milio) — **core do método, stake cheia**
- **1peel+flex:** 1 peel + flex (bard, rakan, lux, anivia) — **entrada normal, 1u** (rebaixamento REVOGADO 2026-07-26). O 58.9% que motivou o rebaixamento media só os mapas que viraram bet, na linha registrada; na régua do método (fair+1) o Bard dá **68,7% (n=361)**, melhor dos 4 flex e empatado com o 2peel (67,7%). Ranking: Bard 68,7 > Rakan 64,5 > Anivia 64,1 > Lux 61,1. Relatório: `knowledge/reports/2026-07-26-bard-flex-definitivo.md`.
- *Yuumi: exceção — ver skips.

## Entrada

- **Under na fair+1 @ ~1.72** (padrão validado nos 2 splits: +13.9% ROI pooled).
- Linha na fair (@1.83) ok; fair−1/−2 só com Milio.
- **Teto de odd: 1.85.** Acima disso, fora (bets reais >1.85: 40% hit, −17.5% ROI).

## Skips (nunca entrar)

| Skip | Evidência |
|---|---|
| Odd > 1.85 | 40% hit real, n=40 |
| **Rell ou Nautilus de support em qualquer lado** | peel×engage ≈ 50-53.6%; Rell/Naut no Under: −17% (n=128/248) |
| ~~Bard vs Karma~~ | ⛔ **REVOGADO 2026-07-26** — análise definitiva: Karma 69,1% (n=97), Lulu 63,8% (n=58), as duas ACIMA do BE. O 44%/50% era n=25/18 e não sobreviveu out-of-sample. Bard flex é entrada normal contra qualquer peel. |
| ~~Bard vs Lulu~~ | ⛔ **REVOGADO 2026-07-26** (mesma análise) |
| Yuumi como peel | +5.4 kills vs fair (controlado por time); observar no split 3 |
| Linha ≤ fair−2 sem Milio | matriz antiga, segue |

## Cautelas (entra, mas com pé atrás)

- **Mapa 2:** 55.9% vs 65.1% do mapa 1 (n=186/212). Só com linha ≥ fair+1; stake nunca premium.
- **LEC:** −7.4% no split 2 (maio 37.5%). Stake mínima até mostrar vida.
- **Primeiras 2 semanas de split:** meta/roster novos, stats velhas — stake conservadora sempre.

## Stake (matriz split 3 — decisão 2026-07-21)

| Setup | Stake |
|---|---|
| 2peel, sem skip, odd ≤1.85 | **1k** |
| 1peel+flex COM sinal extra (Milio como peel, ou linha ≥ fair+1 e odd ≤1.75) | **500** |
| 1peel+flex SEM sinal extra | **SKIP** |
| **Milio no jogo** (único boost validado: 75.3% pooled n=150 sim; 72% n=132 real) | **2k** |
| ~~4k~~ | **APOSENTADO** — dependia de "2 verdes ≥75%", que caiu no teste out-of-sample |

- Stake = exposição TOTAL do match/mapa, dividida entre casas (ladder, mesmo `ladder_group_id`) — inalterado.
- Reavaliar tiers com ~1 mês de split 3: se Milio confirmar no patch novo, 3k volta pra mesa; premium novo só se algum filtro PROVAR base estatística.

## Flags de time: rebaixadas a informação

Verde/vermelho **não entram mais na decisão** (nem boost, nem skip). Três testes independentes (splits 1+2): flag de time não prevê o próximo jogo — vermelho presente até performou levemente MELHOR no Under (62.0% vs 60.4%). Motivo estrutural: a fair já absorve o pace do time; o edge é do DRAFT, não da camisa. Continuam no briefing como contexto.

## Over: não operar (exceto janela Camille)

**Refinos da janela (scan de contexto 2026-07-22, `20-camille-context.json`, 33 células):** NENHUM contexto justifica stake 2x (nenhum CI inferior acima da baseline 67.3%; as células "bonitas" são subconjuntos majoritários ou n<15). Stake segue 500-1k flat; upgrade só pela trava de 15 settles com hit ≥60%. Linha: ≤ fair ideal · **fair+1 aceitável** (60.2% hit, ainda acima do BE 55.6%) · fair+2 NUNCA (54% ≈ BE). Observação (não-aposta): Camille+Nocturne 81.8% n=11 · Camille+Varus 81.8% n=11 · Camille+Sylas 87.5% n=8 — reavaliar com dado do split 3.

**DECISÃO ELVIS 2026-07-22:** Camille sup **vs Rell ou Naut** (sup inimigo) = **stake premium 2k** (78.3%, 18/23). Ressalva do COO registrada: n=23 abaixo do limiar estatístico (recomendação era esperar n=35); trava de revisão: se em n=35 o hit desse recorte cair abaixo de 72%, premium volta pra 1k.

Investigação completa 2026-07-21 (4 análises, ~30 regras, 2 splits): tudo reprovado exceto **Rell+Naut juntos** (60.6%, n=33 — em observação SIMULADA no split 3, `method_variant='over_rell_naut'`). Ver `knowledge/reports/2026-07-21-metodo-over-v1.md`.

## Rotina diária (inalterada)

1. Fair Pinnacle do dia antes de qualquer coisa (trava); dia 100% tier-2 = fórmula.
2. Briefing com agenda + gatilhos.
3. Bets registradas com print; settle via script.

## Pendências operacionais

- Lotes de fix da auditoria (A–G) aguardando aprovação — lote A corrige −R$1.790 na banca declarada.
- `insert-missed-bets` pro cron (36 jogos com trigger ficaram sem simulada no split 2).
- ~~Rastreador `over_rell_naut`~~ **ENTREGUE 2026-07-25** — ver seção abaixo. Re-scan Over com ~2 meses de split 3 segue pendente.

### Rastreador de variantes de observação (entregue 2026-07-25)

`scripts/track-observation-variants.cjs` — SIMULATED stake R$100, `is_method_bet=false` (não polui stats do método Under), `raw_extraction.method_variant`, dedup por (game_id + variante), fair operacional Pinnacle byMatchId > fórmula > skip. Ligas operadas (incl. Prime/KCL/EUM) + LCP. Backfill 21/07→24/07 rodado 2026-07-25 (6 bets).

- `over_pyke_watch` — Pyke SUP qualquer lado → Over na fair @1.80 (base: 62.1% n=103 período completo + 65% n=20 julho, tabela 21).
- `over_rell_naut` — Rell sup de um lado E Nautilus sup do outro → Over na fair @1.80 (base: 60.6% n=33, relatório Over 21/07).
- `under_shen_top` — Shen TOP qualquer lado → Under na fair+1 @1.72 (base: 67.1% n=79 pooled, relatório Shen 25/07; reprovou coerência split 3 → observação, não método).

Uso diário (idempotente — re-scan 2026-07-21→D-1, insere só o novo): `node scripts/track-observation-variants.cjs --apply` (sem `--apply` = dry-run). Frames suspeitos e mapas sem fair são pulados com log, nunca settlados.

## UPDATE 2026-07-25 — LCP entra em teste (recorte Elvis: só Milio + Camille)

**Contexto:** viabilidade completa em `knowledge/reports/2026-07-25-lcp-viabilidade.md` (199 mapas 2026). Pinnacle abre linha de kills pra LCP (confirmado 25/07 — ladder real do Elvis, 4/4 green com 37 kills). Recorte proposto pelo Elvis e validado nos dados: o edge do Under na LCP é quase todo do Milio (delta −6.5 kills vs fair).

**REGRA LCP (decisão Elvis 2026-07-25 "bora"):**

| Situação | Ação | Stake |
|---|---|---|
| **Milio vs peel ou flex** (Under) | OPERA | **R$1k** (tier Milio a 50% — teste) |
| Milio vs engage/outro | SKIP (global ~50%) | — |
| **Camille sup** (Over) | OPERA — regras globais da janela (linha ≤ fair ideal, fair+1 aceitável, odd ≥1.80) | R$500–1k |
| 2peel SEM Milio | **SKIP** (63.6% fair+1, CI [43.0–80.3] — não sustenta sozinho) | — |
| 1peel+flex sem Milio | **SKIP** (ROI −4.4% na LCP) | — |
| Qualquer outra coisa na LCP | SKIP | — |

Números do recorte: Milio vs peel/flex **12/13 under fair+1 (92.3%, CI [66.7–98.6])** — único CI da LCP que passa o BE 58.1% com folga. Camille LCP 5/5 over (n<10 local; opera pela janela global 67.3% n=113).

**Checkpoint: 20 settles OU 4 semanas** (volume esperado baixo: ~2–4 entradas/semana) → stake cheia, mantém teste ou corta. Operacional: `LEAGUE_IDS.LCP='113476371197627891'` já no find-match (linka por CÓDIGO de time); jogos 06:00/08:30 BRT qui–dom, colide com LPL.
