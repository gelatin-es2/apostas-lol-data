# Shen é boneco under kill? — análise completa

**VEREDITO: NÃO. Shen SUPPORT não é under — roda ABAIXO do baseline nos 3 splits (48% Under na fair vs 54% do universo; ROI −11% @1.72). Hipótese refutada. A surpresa é o Shen TOP: 67% Under fair+1 (n=79, ROI +15%), mas falha a coerência no split 3 (45.5%, n=11) — não entra no método, fica em observação.**

**Data:** 2026-07-25 · **Pedido:** Elvis 2026-07-24 ("to achando que o boneco e under kill") · **Fonte:** `scripts/analysis/shen-under.cjs` → `audit-output/27-shen-under.json` (100% cache, zero API) · **Base:** 3.633 mapas válidos — split 1 (jan–mar, 6 ligas, n=667) + split 2 (abr–jun, ~30 ligas, n=2.613) + split 3 (jul até 21/07, n=353). Fair leave-one-out por liga (mesmo padrão do camille-sweep). Régua: Under na fair @1.83 (BE 54.6%) · fair+1 @1.72 (BE 58.1%).

---

## 1. Shen SUPPORT (qualquer lado) — o número que mata a hipótese

| Célula | n | kills méd | delta (kills−fair) | Under@fair [CI95] | Under@fair+1 [CI95] | ROI@1.72 |
|---|---|---|---|---|---|---|
| Shen sup — split 1 | 4 ⚠️ | 30.5 | 0.00 | 50% | 50% | −14% |
| Shen sup — split 2 | 18 | 31.3 | +0.11 | 50% | 50% [29–71] | −14% |
| Shen sup — split 3 (jul) | 32 | 33.7 | +0.25 | 46.9% | 53.1% [36–69] | −8.6% |
| **Shen sup — POOLED** | **54** | **32.7** | **+0.19** | **48.1% [35–61]** | **51.9% [39–65]** | **−10.8%** |
| Baseline (universo sem Shen sup) | 3.579 | 31.8 | −0.01 | 54.0% [52–56] | 58.7% [57–60] | +1.0% |

- Jogo com Shen sup mata **acima** da fair (+0.19) e hitta Under **menos** que um jogo qualquer — nos 3 splits, sem exceção. Não é ruído de um período.
- Nos dois degraus da escada, CI inteiro abaixo do BE de referência. Apostar Under "porque tem Shen sup" teria sido −11% de ROI.
- Amostra pooled n=54 é decente (>30), mas o pré-julho é só n=22 — mesmo assim, a direção é consistente: nunca ficou acima do baseline.

**Timeline (chegada de meta, tipo Camille):** jan–fev 4 · abr 4 · mai 5 · jun 9 · **jul 32**. Shen sup é fenômeno do patch atual — 59% da amostra é de julho.

## 2. Por que a intuição engana

O ult global do Shen até segura kills — mas o **contexto de draft em que ele aparece** anula o efeito:

| Sup do outro lado | n | delta | Under@fair+1 | Leitura |
|---|---|---|---|---|
| ENGAGE (Naut, Leona, Rell, Camille...) | 40 (74%!) | +1.15 | 50.0% [35–65] | Shen sup é counter-pick de meta engage — cai em jogo sangrento |
| → sendo **vs Camille sup** | 18 | +1.61 | 44.4% [25–66] | 1/3 da amostra é contra a janela Camille (Over!) |
| PEEL (lista do método) | 7 ⚠️ | −2.21 | 57.1% [25–84] | única direção under — mas n<10 |
| FLEX (Bard/Rakan/Lux/Anivia) | 4 ⚠️ | −1.75 | 50% | n<10 |
| OUTRO | 3 ⚠️ | −4.50 | 66.7% | n<10 |

Cross-check independente: no scan da janela Camille (`20-camille-context.json`), Shen como sup inimigo foi o **pior recorte** da Camille (61.1% Over, n=18, vs 67.3% da janela). Ou seja: o boneco **amortece** kills em relação ao contexto — mas não o suficiente pra virar o jogo pra Under. Amortecedor ≠ under.

## 3. Candidato "1peel+shen" no trigger — reprovado por amostra

Shen sup + PEEL_PURE do outro lado: **n=7 no total dos 3 splits** (todos no split 2, zero em julho). 57.1% fair+1, delta −2.21. Pela regra do Elvis, **n<10 não é base de dados** — não dá nem pra começar a discutir entrada no trigger. E o volume não vem: em julho o Shen sup só apareceu contra engage.

## 4. Shen lado a lado com os FLEX_ENGAGE atuais

Formato do trigger (champ sup + peel do outro lado), pooled 1+2+3:

| Célula | n | delta | Under@fair | Under@fair+1 [CI95] | ROI@1.72 |
|---|---|---|---|---|---|
| 1peel+bard | 356 | −2.09 | 65.2% | 68.0% [63–73] | +16.9% |
| 1peel+rakan | 139 | −1.26 | 59.7% | 64.0% [56–72] | +10.1% |
| 1peel+anivia | 38 | −2.61 | 63.2% | 65.8% [50–79] | +13.2% |
| 1peel+lux | 17 | +3.44 | 52.9% | 58.8% [36–78] | +1.2% |
| **1peel+shen** | **7 ⚠️** | −2.21 | 57.1% | 57.1% [25–84] | −1.7% |
| benchmark 2peel (core) | 797 | −2.14 | 63.0% | 66.6% [63–70] | +14.6% |

E como presença solta (qualquer lado): Bard 60.2% fair+1 · Rakan 61.0% · Anivia 60.0% · Lux 56.3% · **Shen 51.9%** — o pior dos cinco. **Shen NÃO se comporta como flex válido.** (Nota à parte: Lux, que ESTÁ na lista, é a segunda pior e com delta +2.5 — candidata a revisão fora deste escopo.)

## 5. Shen TOP — a surpresa da análise

Shen na top lane (via role dos windows cacheados, 100% de cobertura):

| Célula | n | delta | Under@fair | Under@fair+1 [CI95] | ROI@1.72 |
|---|---|---|---|---|---|
| Shen top — splits 1+2 | 68 | −2.49 | 66.2% | **70.6% [58.9–80.1]** | +21.4% |
| Shen top — split 3 (jul) | 11 | −0.14 | 45.5% | 45.5% [21–72] | −21.8% |
| **Shen top — POOLED** | **79** | **−2.16** | **63.3%** | **67.1% [56.1–76.4]** | **+15.4%** |
| Shen top + ≥1 peel sup | 44 | −3.91 | 72.7% | 75.0% [60.6–85.4] | +29.0% |
| Shen top DENTRO do trigger vigente | 31 | −2.92 | 67.7% | 67.7% [50–81] | +16.5% |
| Shen top FORA do trigger (incremental) | 48 | −1.67 | 60.4% | 66.7% [52.5–78.3] | +14.7% |

Leitura honesta, pelo critério formal (CI inferior > BE 58.1% no pooled 1+2 **+ coerência no split 3**):

- Splits 1+2: **passa por 0.8pp** (CI inferior 58.9 vs BE 58.1).
- Split 3: **45.5% — reprova.** n=11 é pequeno e julho tá mais sangrento pra todo mundo (baseline de julho com delta +1.15), mas o critério existe exatamente pra isso: sinal que só vive no passado foi o que matou o método Over engage.
- Valor incremental limitado: da célula mais bonita (Shen top + peel, 75%), **31 dos 44 jogos já são trigger do método vigente** — e dentro do trigger o Shen top rende 67.7%, igual ao 2peel core (66.6%). Não é boost.
- A célula genuinamente nova (Shen top fora do trigger, n=48, 66.7% fair+1) tem CI inferior 52.5 < BE e caiu pra 50% em julho (n=10).

## 6. O que NÃO dá pra afirmar (n<10 — não é base de dados)

- **Toda célula por liga.** Maior é EWC n=8 (75% fair+1); MSI n=5, LJL n=6, LPL n=6... Nenhuma liga tem amostra própria de Shen sup. Os "80% no MSI" e afins são anedota.
- **1peel+shen** (n=7) — direção simpática, base inexistente.
- **Shen sup vs FLEX / vs OUTRO** (n=4 / n=3).
- **Shen top no split 1** (n=2) e o split 3 do Shen top (n=11) mal passa do piso — a reprovação da coerência vem com essa ressalva, por isso "observar" e não "enterrar".
- Nada aqui usa fair Pinnacle (universo API + fair fórmula leave-one-out) — os hits reais na linha da casa podem divergir 1–2pp.

## 7. Decisão operacional (3 níveis do pedido)

| Nível | Resposta |
|---|---|
| (a) Entra como FLEX no trigger 1peel+flex? | **NÃO.** Números de flex não aparecem (52% fair+1 vs 60–61% de Bard/Rakan) e a célula 1peel+shen tem n=7. |
| (b) Vira sinal próprio (tipo janela Camille)? | **NÃO como sup.** Como TOP: sinal real nos splits 1+2 (70.6%) mas reprovado na coerência de julho → **observação simulada** `under_shen_top` no split 3; reavaliar quando o split 3 acumular n≥30 de Shen top. Sem dinheiro real até lá. |
| (c) Só informação? | **SIM, com um uso prático:** Shen sup NÃO é motivo de Under — e jogo Shen sup vs Camille sup segue sendo jogo da **janela Camille Over** (61% Over, acima do BE 55.6%; foi só o pior recorte da janela, não um skip). Não criar "Under do Shen" que aposta contra a própria janela. |

**Uma linha pro CEO:** o boneco que você viu segurar kill é o Shen **top** (−2.5 kills vs fair no pré-julho); o Shen **support** aparece justamente nos jogos sangrentos de engage/Camille e morre acima da fair — under nele teria sido −11% de ROI.

## Reprodução

```
node scripts/analysis/shen-under.cjs
```
- Output: `audit-output/27-shen-under.json`
- Universos: `audit-output/00-universe-split1.json` + `audit-output/00-universe-allregions.json` (coleta camille-collect, 04-01→07-21; julho 22–24 ainda sem coleta — ligas voltaram 24/07, impacto ~0 na amostra Shen)
- Roles top/sup: `audit-cache/window-{gameId}.json` (3.633/3.633 em cache)
