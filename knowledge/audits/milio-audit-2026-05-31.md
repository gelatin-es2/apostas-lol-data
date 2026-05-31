# Auditoria do Método Milio — Split 2 2026

**Data:** 2026-05-31
**Dataset:** 105 jogos onde Milio (suporte) apareceu | range 2026-04-01 → 2026-05-30
**Ligas:** LPL 41 · LCK 31 · CBLOL 14 · LEC 12 · LCS 7
**Método:** 5 agentes paralelos (workflow `milio-audit`), ângulos independentes
**Fonte:** `cron-data/_milio_audit_raw.json` (gerado de results.json via analyze_range)

> **Correção de baseline:** rate global real do Milio = **68,6%** under_hit (72/105), NÃO os 70,3% da memória antiga. Atualizar `project_milio_outlier`.

---

## TL;DR — o que mudou na operação

1. **Milio sozinho NÃO é sinal.** Só conta dentro de trigger válido: **71,6% com trigger (n=88)** vs **52,9% sem (n=17)** = coin-flip. Ganho de +18,7pp do trigger.
2. **Matchup vs suporte adversário é o maior diferenciador.** STACK contra Bard (83,3% n=12) e Lulu (80% n=20). EVITAR contra Nautilus (33,3% n=9 — único matchup que PERDE dinheiro).
3. **Edge estrutural é REAL e não está fechando.** Milio fica em média 2,6 kills abaixo do fair; confirmado na linha Pinnacle real (73,3% n=15). Tendência temporal SUBINDO (abril 65,9% → fim maio 73%).
4. **Tail risk assimétrico:** quando o Under fura (31% dos casos), estoura em média +5,7 kills. Stake controlado, não all-in.

---

## 1. Por suporte adversário (opp_sup) — o maior diferenciador

| opp_sup | n | under% | avg kills | avg fair | leitura |
|---|---|---|---|---|---|
| **Bard** | 12 | **83,3%** | 22,3 | 27,7 | 🟢 STACK — peel vs disengage = jogo lento (10G/2R) |
| **Lulu** | 20 | **80,0%** | 24,6 | 28,2 | 🟢 STACK — amostra robusta (16G/4R) |
| Seraphine | 16 | 68,8% | 24,7 | 27,6 | ⚪ baseline, joga normal |
| Nami | 22 | 68,2% | 24,8 | 27,9 | ⚪ maior amostra, baseline |
| Karma | 6 | 66,7% | 22,8 | 27,3 | ⚪ neutro (NÃO é skip pro Milio) |
| Rakan | 5 | 60,0% | 24,2 | 29,1 | ⚠️ amostra fraca |
| Neeko | 5 | 60,0% | 25,0 | 28,5 | ⚠️ amostra fraca |
| **Nautilus** | 9 | **33,3%** | 30,7 | 28,3 | 🔴 EVITAR — kills > fair, 3G/6R |
| Alistar | 3 | 66,7% | 31,3 | 29,8 | ⚠️ n fraco, mas reforça freio engage-tank |
| Lux | 3 | 100% | 19,3 | 27,2 | ⚠️ n fraco, direção positiva |
| Renata | 3 | 66,7% | 30,0 | 28,8 | ⚠️ n fraco, cautela |

**Padrão mecânico:** adversário com peel/utility/poke (Bard, Lulu, Lux) → jogo passivo → Under detona. Adversário engage-tank/hook (Nautilus, Alistar, Renata) → teamfights → Over fura.

**Inversão confirmada:** a regra `Bard vs Lulu/Karma = SKIP` (memória [[feedback_bard_skip_lulu_karma]]) **NÃO se transfere pro Milio**. Milio vs Lulu é dos melhores spots; vs Karma é neutro, não skip.

---

## 2. Por liga

| Liga | n | under% | avg kills | leitura |
|---|---|---|---|---|
| **CBLOL** | 14 | **78,6%** | 23,6 | 🟢 melhor rate, mas n moderado (a confirmar) |
| **LPL** | 41 | 70,7% | 23,3 | 🟢 pilar do sinal, maior margem fair-kills (4,0) |
| LCK | 31 | 67,7% | 27,2 | ⚪ sólido, baseline |
| LEC | 12 | 66,7% | 26,7 | ⚪ margem estreita (1,8) |
| **LCS** | 7 | **42,9%** | 25,9 | 🔴 outlier negativo, n fraco — bandeira amarela |

**Correlação chave:** rate de Under cai conforme avg kills da liga sobe. Priorizar Milio em ligas de baixo kill (CBLOL/LPL). LCS: margem fair-kills colapsa pra 0,4 — reduzir stake ou skip até n≥15.

---

## 3. Por trigger do método

| trigger | n | under% | avg kills | leitura |
|---|---|---|---|---|
| **2peel** | 68 | **70,6%** | 24,8 | 🟢 core, maior amostra |
| **1peel+flex** | 20 | **75,0%** | 24,1 | 🟢 melhor rate, n moderado |
| **DENTRO de trigger** | **88** | **71,6%** | 24,7 | ✅ o número que importa |
| null (sem trigger) | 17 | 52,9% | 27,0 | 🔴 coin-flip, NÃO apostar |

Evidência mecânica: avg fair é quase igual entre os 3 grupos (27,9/28,4/28,1) — o ganho NÃO vem de linha mais alta, vem de **menos kills reais** (24,7 com trigger vs 27,0 sem). Confirma causalidade: trigger válido = jogo passivo de fato. **Regra prática: Milio só conta se o draft fecha 2peel ou 1peel+flex.**

---

## 4. Calibração de fair (edge estrutural)

- **Edge médio = fair − kills = +2,6 kills** sobre os 105 jogos. A casa põe a linha ~2,6 kills acima do que o Milio entrega.
- **Confirmado na linha Pinnacle REAL:** subset `fair_source=pinnacle_manual` (n=15) → 73,3% under, edge +3,3. Edge persiste na linha mais eficiente do mercado = não é artefato da fórmula.
- **Distribuição dos resultados:**
  - Under por 4+ kills (folgado): 45 jogos (43%) — edge médio +7,4
  - Under por 2-3: 16 (15%)
  - Under por 1 (no fio): 11 (10%)
  - Over (furou): 33 (31%) — **estouro médio +5,7 kills** (tail risk)

**Tail risk assimétrico:** os reds são mais "caros" em kills que os greens. Stake fixo sofre drawdown nos overs. Usar stake controlado.

---

## 5. Tendência temporal (o edge está fechando?)

| Bloco | n | under% | avg kills | avg fair |
|---|---|---|---|---|
| Abril (≤30/abr) | 35 | 68,6% | 24,5 | 27,33 |
| Início maio (01-15) | 40 | 62,5% | 26,3 | 28,28 |
| **Fim maio (16-30)** | 30 | **76,7%** | 23,9 | 28,5 |

**O edge NÃO está fechando** — alargou. O fair subiu monotonicamente (27,33→28,5), mas os kills do bloco recente caíram (23,9), então o gap fair−kills ABRIU de 2,8 (abril) para 4,6 (fim maio). A queda de início de maio (62,5%) foi recuperada, não era tendência.
> ⚠️ Confound: a fonte do fair muda entre blocos (abril = livestats puro; maio = mix polymarket/formula/pinnacle). Parte da "subida do fair" pode ser troca de metodologia, não reação das casas.

**Times com Milio (n≥5):**
- **NIP (LPL):** 33,3% n=6, avg 29,3 kills (> fair) — 🔴 PIOR time, joga rápido mesmo com peel. **EVITAR Under quando Milio for da NIP.**
- GEN (LCK): 60% n=5, avg 30,2 kills — pace alto, cautela
- BFX (LCK): 50% n=6 — coin-flip, sem boost
- AL (LPL): 66,7% n=6 — na média, sem edge extra
- WE, BRO (n=4 cada): 100%/100% mas **amostra fraca**, não acionável isolado — vigiar

---

## Matriz de decisão operacional

| Sinal | Ação |
|---|---|
| Milio + 2peel + opp_sup Bard/Lulu | 🟢🟢 STACK premium |
| Milio + trigger válido + liga CBLOL/LPL | 🟢 stake forte |
| Milio + trigger válido (geral) | 🟢 apostar (71,6%) |
| Milio + opp_sup Nautilus (ou engage-tank) | 🔴 EVITAR/skip |
| Milio + trigger=null (sozinho) | 🔴 NÃO é sinal (52,9%) |
| Milio do time NIP | 🔴 EVITAR (33% n=6, time joga rápido) |
| Milio na LCS | ⚠️ reduzir stake/skip até n≥15 |
| Qualquer Milio | ⚠️ stake controlado (tail risk +5,7 nos overs) |

---

## Caveats globais

1. `under_hit` ≠ ROI — é taxa de acerto do mapa, sem odd/stake/PnL. Edge em kills precisa virar lucro via odd (~1,7-1,9).
2. `fair_source` mistura fontes (livestats, polymarket, formula, pinnacle). O subset Pinnacle (n=15) é o mais limpo e confirma o edge.
3. Ângulos não isolam causalidade cruzada (opp_sup × liga × trigger podem se sobrepor). Matchup forte pode estar inflado por liga lenta.
4. Segmentos n<5 (Lux, Alistar, Renata, Yuumi) = não acionáveis isolados, só sinal qualitativo de direção.
