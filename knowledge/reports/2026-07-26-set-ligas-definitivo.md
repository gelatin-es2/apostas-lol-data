# Set definitivo de ligas — LES: **ENTRA EM TESTE (1k, 2 semanas, mesmo regime de Prime/KCL)** + tabela-mestra pro martelo do Elvis

**Data:** 2026-07-26 · **Fontes:** `scripts/analysis/les-update.cjs` → `audit-output/33-les-update.json` (LES atualizada até 26/07: universo allregions até 21/07 + fetch novo 22–26/07, fair leave-one-out por liga, critérios idênticos ao relatório de expansão `2026-07-21-expansao-ligas-meta-julho.md`) · `18-multi-league-mining.json` · `19-under-stress-line.json` · `26-les-complete.json` · `29-polymarket-volume-2026.json` · `28-lcp-viability.json` · Supabase `bets` (read-only) · lolesports API (schedules 26/07).

---

## 1. LES — a contradição 64% × 43.5% resolvida

Três números diferentes circularam sobre a MESMA liga. Não é mistério estatístico — são três réguas diferentes:

| Número | Origem | O que media | Status |
|---|---|---|---|
| **64% n=25, ROI +18.4%** (2026-05-20) | análise da entrada da LES | **trigger-only**, split 2 até maio, fair da época | direção certa, amostra menor |
| **43.5% — SKIP, sangra** (CLAUDE.md) | `tier2_dashboard_stats` (cron) | **ALL GAMES** (sem filtro de trigger) com **fair trailing 21 dias** do cron | régua errada pra decidir método: o método não aposta all-games |
| **69.4% n=36, CI [53.1–82.0], ROI +19.4%** (hoje) | `33-les-update.json` | trigger-only, abr→26/07, fair LOO canônica | **número vigente** |

O que aconteceu: em maio alguém comparou o método (trigger) com o número all-games do cron e escreveu o SKIP. O recompute de 23/07 (`26-les-complete.json`) tentou reproduzir 43.5% em TODAS as variações de período/linha e **nenhuma chega perto** (all-games recalculado dá 56.7–59.2%) — a fonte provável é a fair diferente do cron (trailing 21d vs LOO). **O valor exato 43.5% nunca foi reconciliado; a direção foi:** trigger filtra pra melhor (69.4% vs 59.2% all-games, +10pp). A regra "LES 43.5% skip" do CLAUDE.md fica **revogada** — era comparação de métrica errada.

### LES atualizada até 26/07 (n=98 mapas válidos, 36 com trigger)

| Linha | Hit | CI 95% | ROI stress @1.72 | ROI odd real | BE |
|---|---|---|---|---|---|
| **fair+1 @1.72** | **69.4%** (25/36) | **[53.1–82.0]** | **+19.4%** | +19.4% | 58.1% |
| fair @1.83 | 66.7% | [50.3–79.8] | +14.7% | +22.0% | 54.6% |
| fair−1 @1.95 | 63.9% | [47.6–77.5] | +9.9% | +24.6% | 51.3% |

**Critérios da expansão (mesma régua das 5 aprovadas em 21/07):** candidata (hit ≥58.1, n≥25, CI inferior ≥50) ✅ 69.4 / 36 / **53.1** · piso stress (ROI>0 na fair @1.72 travada) ✅ +14.7% · escada real ✅ +22.0/+24.6%. Em 21/07 a LES reprovava por 0.8pp de CI (49.2); com os jogos de 22–23/07 e o trigger green de 23/07, **passa os 3 critérios** — hoje está no nível de Prime (68.5) e KCL (69.0), acima de LCK/LPL.

| Recorte | n | Hit fair+1 | Leitura |
|---|---|---|---|
| 2peel | 22 | 68.2% | core ok |
| 1peel+flex | 14 | 71.4% | n<25 — segue regra GLOBAL (500 só com sinal extra) |
| Milio no jogo (trigger) | 6 | 66.7% | **n<10 = não é base** — boost Milio é regra global |
| 2peel sem Milio | 17 | 70.6% | edge não depende do Milio (≠ LCP) |

**Os poréns (por que TESTE e não OPERA direto):**

1. **Volume no patch atual ≈ zero.** Trigger rate mensal: abr 54% → mai 42% → jun 36% → **jul 4.3% (1 trigger em 23 mapas)** — pior que as majors (16%). Kills médio subiu 29.5→33.7. O edge existe QUANDO dispara; quase não dispara.
2. **O pass é carregado por abr–mai** (22/30 = 73%); jun–jul é 3/6 (n=6, sem leitura). Mesmo padrão que fez a LCP entrar como teste.
3. **Fair = fórmula, sem Pinnacle histórica.** Calibração ok (mediana |kills−fair| 5.5, igual LCK/LEC; média 7.1, caudas gordas — desvio 9.3, perfil Barça 35.4 avg). Pinnacle abriu linha de kills na LES pelo menos 1× (bet real de 21/05), mas cobertura por jogo no split atual não está confirmada.
4. **Bets "reais" da LES eram quase todas simuladas.** No banco: 29 simuladas do cron (abr–mai, 20G/9R = 69%, +R$7.4k simulado — bate com o backtest) e **apenas 1 bet real** (Pinnacle 21/05, red −R$1.000). O +R$5.167 da semana passada foi **Prime League**, não LES. A LES nunca foi operada de verdade em volume.

**Meta LES em julho:** Camille sup chegou — 7 mapas com Camille, TODOS em julho (4/7 over fair; n<10, opera pela janela global). Milio: 10 mapas no total (2 em julho).

**Horário/volume:** ter–qui **12:00 e 14:30 BRT**, ~6 matches Bo3/semana (12–14 mapas); volta **terça 28/07**; playoffs 18/08+. Overlap de horário: **97% com Prime League** e 44% com LFL (e EUM quando ativa) — terça 28/07 já tem LES 12:00 + LFL 13:00 juntas. É acúmulo de atenção na tarde EU, não impeditivo.

**Liquidez:** Polymarket ~US$154k/evento em 2026 (57 eventos, US$8.8M — MAIOR que Prime ~100k e LFL ~98k); Pinnacle já abriu linha (1 bet real). Suficiente pra stake 1k.

### Veredito LES

**TESTE — mesmo regime das 3 ligas da expansão de 21/07:** Under trigger, **stake 1k flat, SEM premium** (Milio fica 1k durante o teste), 1peel+flex pela regra global (500 só com sinal extra), janela Camille liberada com regras globais (500–1k; premium 2k vs Rell/Naut/Leona conta na trava global n=35). Checkpoint: **15 settles OU 2 semanas**. Fair fórmula (padrão EMEA); se Pinnacle abrir linha no dia, Pinnacle manda (plano A). Expectativa honesta de volume Under: **0–2 triggers/semana** no patch atual — a LES vale mais pela janela Camille (que chegou no meta de lá) do que pelo Under agora.

---

## 2. Tabela-mestra — set definitivo proposto

Under = trigger fair+1 @1.72 (abr→jul, fair LOO, mining 21/07 + updates LES/LCP). Célula **n<10 = não é base**. Milio 2k e janela Camille são regras GLOBAIS — coluna indica exceção local. BE Under 58.1% (fair+1 @1.72) / 54.6% (fair @1.83).

| Liga | Under n | Hit | CI 95% | Julho (trigger rate) | Horário BRT | Liquidez confirmada | **Veredito proposto** |
|---|---|---|---|---|---|---|---|
| **LCK** (volta 29/07) | 91 | 68.1% | [58.0–76.8] | sem jogos jul | 05–07h qua–dom | Pinnacle + casas (65 bets reais) | **OPERA** — 1k / Milio 2k |
| **LPL** | 134 | 67.9% | [59.6–75.2] | 4/21 = 19% | 05–08h diário | Pinnacle + casas (99 bets) | **OPERA** — 1k / Milio 2k |
| **LEC** | 70 | 68.6% | [57.0–78.2] | 0/4 | 12–14h | Pinnacle + casas | **OPERA** Under — 1k / Milio 2k · Over: SKIP fora da janela (decisão pendente: "só janela Camille com draft confirmado") |
| **CBLOL** | 41 | 63.4% | [48.1–76.4] | ativa | 13–16h | Pinnacle + casas | **OPERA** — 1k (a mais fraca das originais: CI cruza o BE; monitorar no split 3) |
| **LCS** | 46 | 65.2% | [50.8–77.3] | ativa | 17–20h | Pinnacle + casas | **OPERA** — 1k / Milio 2k |
| **LFL** (volta 28/07) | 36 | 69.4% | [53.1–82.0] | — | 13–16h ter–sex | Pinnacle + casas | **OPERA** — 1k / Milio 2k |
| **Prime League** (volta 29/07) | 54 | 68.5% | [55.3–79.3] | 9.8% | 12–15h qua–qui | **Pinnacle real** (+R$5.167 sem 1) | **TESTE semana 2/2** — 1k sem premium → efetivar se fechar limpo |
| **KCL** (volta 27/07!) | 84 | 69.0% | [58.5–77.9] | sem jogos | **05h seg–qui** | ⚠️ ZERO bets reais; sem Polymarket listada | **TESTE** — 1k sem premium; 1ª missão: confirmar linha de kills na volta |
| **EUM** (EMEA Masters) | 41 | 80.5% | [66.0–89.8] | sem jogos | 12–15h | Pinnacle+Thunderpick reais (18 bets, +R$2.9k) | **APROVADA — DORMENTE** (edição spring acabou 15/06; nada na API; reativa automático quando abrir calendário) |
| **LES** (volta 28/07) | **36** | **69.4%** | **[53.1–82.0]** | **1/23 = 4.3%** | 12:00/14:30 ter–qui | Pinnacle 1 bet real; Polymarket $154k/evento | **TESTE** — 1k sem premium, 15 settles/2 semanas (ver seção 1) |
| **LCP** (teste desde 25/07) | 56 | 64.3% | [51.2–75.5] | Swiss começou | 06/08:30 qui–dom | Pinnacle real (4/4 green) | **MANTÉM TESTE** — SÓ Milio vs peel/flex (1k) + janela Camille; resto skip; checkpoint 20 settles/4 sem |
| **NACL** | 49 | 69.4% | [55.5–80.5] | 1/9 | 18–21h qua–qui | Polymarket $129k/evento; sem bet real | **FORA (reserva nº 1)** — passou nos critérios, ficou fora na decisão de 21/07; entra se o volume Under do set seguir seco |
| **LIT** | 18 | 83.3% | [60.8–94.2] | ativa | 13–16h | Polymarket $41k/evento (baixa) | **FORA** — n<25 (não é base) + decisão Elvis; watchlist |
| **LRS** | 31 | 77.4% | [60.2–88.6] | 19% | 17–20h | **SEM linha de kills nas casas** (nem Polymarket lista) | **FORA — documentada** (estatística boa, inoperável; decisão 21/07 mantida) |
| MSI / EWC / Worlds | 14 / 6 / — | 64.3 / 50 | — | — | evento | evento | **Por evento** — EWC reprovou no stress; MSI foi skip; Worlds decide quando vier |

**Split 3 ao vivo (semana 19–25/07, referência):** Under método real 6/7 mapas; janela Camille 12/15 (80%); trigger rate majors 16% — o alerta de julho segue valendo em TODAS as ligas.

---

## 3. Proposta de lista canônica (pro Elvis bater o martelo)

**OPERA (stake normal — Under 2peel 1k / Milio 2k / 1peel+flex 500 só com sinal extra / Camille 500–1k, premium 2k vs Rell-Naut-Leona):**
LCK · LPL · LEC · CBLOL · LCS · LFL

**TESTE (1k flat, sem premium, fair fórmula, checkpoint 15 settles ou 2 semanas):**
Prime League (semana 2/2) · KCL (começa 27/07 — confirmar linha) · **LES (nova — começa 28/07)**

**TESTE COM RECORTE (regra própria):**
LCP — só Milio vs peel/flex (Under 1k) + janela Camille; resto skip

**DORMENTE (aprovada, sem calendário):** EUM — reativa quando a edição summer aparecer na API

**FORA:** NACL (reserva nº 1) · LIT (n<25) · LRS (sem mercado) · internacionais decididos por evento

**O que muda vs hoje:** (1) LES sai do limbo "skip no CLAUDE.md mas na memória como operada" e vira TESTE formal com regra escrita; (2) EUM ganha status explícito de dormente (hoje consta como "expansão" mas não tem jogo); (3) NACL ganha status de reserva formal; (4) nada muda nas 6 originais nem na LCP. Se aprovado: atualizar tabela de cobertura do `CLAUDE.md` (linha LES), memória `project_ligas_ativas_periodo` e briefing/cron (LES já está em `LEAGUE_IDS`; conferir se o briefing puxa a liga).

---

## 4. O que NÃO dá pra afirmar

1. **O 43.5% exato nunca foi reproduzido** — hipótese forte (fair trailing 21d do cron) mas não provada; a revogação se apoia no recompute canônico, não na arqueologia do número velho.
2. **Volume Under na LES no patch atual** — 1 trigger em 23 mapas de julho; o teste pode terminar com 3 settles em 2 semanas. Não dá pra prometer que a LES repõe volume.
3. **Milio/Camille locais da LES** (n=6/n=7) e da LCP — não são base; as regras aplicadas são as globais.
4. **Cobertura de linha Pinnacle por jogo** em LES (1 bet histórica) e KCL (zero) — só a operação ao vivo confirma.
5. **Quando a EUM volta** — sem calendário na API.
6. **ROI nas odds reais** — análises usam 1.72/1.83/1.95; odd média real do CEO ~1.75–1.82 → ~3pp a menos de margem que o backtest.
7. **Monitoramento automático**: `method_reports` só persiste LCK/LPL/LEC/CBLOL — **tier-2/LCS/LCP/expansão ficam fora do pipeline** (flagrado na revisão semanal). Este relatório precisou de re-fetch ad-hoc. Enquanto `analyze_yesterday`/save não cobrir as ligas operadas, o checkpoint dos testes vai ser sempre manual — é a maior alavanca de dado pendente.
8. **Patch 26.15 (terça 29/07)** — preview sem nerf a Camille/Milio, mas as notas finais saem no mesmo dia em que LCK/Prime voltam; protocolo de pausa imediata segue armado.

*Read-only: nenhuma regra alterada, nenhum write em produção. Script novo: `scripts/analysis/les-update.cjs` (re-rodável, idempotente).*
