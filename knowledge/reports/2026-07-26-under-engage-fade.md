# Under fade do duplo engage — **VEREDITO: PROPOR VARIANTE SIMULADA `under_engage_fade`** (kills-side passa na fair+3 com folga de CI; a premissa do movimento de mercado segue NÃO validada — n=3 observável)

**Data:** 2026-07-26 · **Fontes:** `scripts/analysis/under-engage-fade.cjs` → `audit-output/36-under-engage-fade.json` · universos `00-universe-split1.json` (jan–mar, 667 mapas) + `00-universe-allregions.json` (abr–21/07, 2.966 mapas, 30 ligas) + `00-universe-split3-window.json` (21–26/07, 168 após dedup) · fair leave-one-out por liga (mesma função de `under-stress-line.cjs`) · Supabase `bets` read-only · `cron-data/*-fair-pinnacle.json`. Zero coleta nova.

**Tese do Elvis (literal):** "o mercado sobe 4 linhas todo jogo que tá tendo Rell vs Leona, Rell vs Naut, Leona vs Naut etc — se o over kill desses drafts não se paga, vamos de under [na linha inflada]".

---

## 1. A descoberta central (leia isso antes dos números)

A escada confirma o lado dos kills: **em duplo engage, kills ficam perto da fair** (delta médio +0.91, mediana −0.5) — exatamente o que o Over reprovado (51.9% pooled) já dizia. Under na fair+3 ganha 64.2% das vezes, bem acima do break-even de qualquer odd realista (52.6–54.6%).

**Mas o controle muda a leitura do edge:** no universo geral (3.801 mapas), Under na fair+3 ganha **66.9%** — MAIS que nos mapas de duplo engage (64.2%). Ou seja: o draft de engage **não ajuda** o fade pelo lado dos kills; esses mapas correm ~1 kill ACIMA da fair (a inflação do mercado é parcialmente justificada). **Todo o edge da tese vem de UMA coisa só: o mercado supostamente OFERECER fair+3/+4 nesses mapas** — coisa que ele não oferece num mapa qualquer. Se essa premissa for verdade, o fade paga. Se o mercado subir só 1–2 linhas, não paga (fair+2 = 58.5%, CI inferior 53.0, abaixo do BE).

E a premissa das "4 linhas" **não tem validação sistemática** — não existe histórico de linha de mercado por mapa. O que temos é anedótico (seção 4, n=3).

---

## 2. A escada — P(kills < fair+k), Wilson CI 95%

**Duplo engage** = ambos os sups em {Rell, Nautilus, Leona, Alistar, Thresh}. Sem Rakan/Bard (FLEX do método), sem Pyke (perfil over próprio), sem Camille (janela Over — **80 mapas Camille×engage excluídos do fade**).

| grupo | n | delta kills−fair | k=0 | k=+1 | k=+2 | **k=+3** | k=+4 |
|---|---|---|---|---|---|---|---|
| **DUPLO ENGAGE pooled** | **316** | **+0.91** | 50.6% | 56.6% | 58.5% [53.0–63.8] | **64.2% [58.8–69.3]** | 67.7% [62.4–72.6] |
| — split1 (jan–mar) | 100 | +0.19 | 51% | 57% | 61% | **67%** | 71% |
| — split2 (abr–21/07) | 180 | +1.92 | 47.8% | 54.4% | 55.6% | **60.6%** | 63.9% |
| — split3 (21–26/07) | 36 | −2.08 | 63.9% | 66.7% | 66.7% | **75%** | 77.8% |
| Relaxada (≥1 engage, sem Camille) | 1.499 | +1.06 | 48% | 53.4% | 56.9% | 62.0% | 65.8% |
| Controle 2peel (método) | 803 | −2.16 | 63.1% | 66.7% | 71.9% | 76.0% | 79.0% |
| **Controle universo geral** | 3.801 | −0.01 | 53.7% | 58.4% | 62.6% | **66.9%** | 70.7% |
| Só ligas operadas/teste (dbl) | 190 | +0.66 | — | — | — | 65.8% [58.8–72.2] | — |

**Régua de BE** (Under na linha inflada, juice dos 2 lados pós-movimento): @1.83 → 54.6% · @1.85 → 54.1% · @1.90 → 52.6%.

- **Célula operável: fair+3** — CI inferior pooled 58.8 > todos os BEs, e os 3 splits ≥ BE (67 / 60.6 / 75).
- **fair+2 NÃO opera sozinha** — CI inferior 53.0 fica abaixo do BE de 1.83/1.85.
- Desvio dos kills em engage: 9.4 (vs 8.2 no 2peel) — cauda direita mais gorda, mas não mata a fair+3.

## 3. Pares e recortes pré-declarados

| par | n | delta média | under fair | **under fair+3** |
|---|---|---|---|---|
| Nautilus+Rell | 107 | +0.92 | 49.5% | 64.5% [55.1–72.9] |
| Alistar+Nautilus | 59 | +1.75 | 47.5% | 55.9% |
| **Leona+Nautilus** | 52 | **−1.17** | 67.3% | **80.8% [68.1–89.2]** |
| Alistar+Leona | 35 | +1.50 | 57.1% | 65.7% |
| Alistar+Rell | 32 | +2.53 | 31.3% | 53.1% |
| Leona+Rell | 14 | −0.43 | 42.9% | 71.4% |
| pares com Thresh | 17 total | — | n<10, sem leitura | — |

Os 3 pares que o Elvis citou têm n≥10 e todos passam o BE na fair+3. Recortes que a própria tese já separava (não é garimpo pós-hoc):

| recorte | n | delta média | under fair+3 |
|---|---|---|---|
| **TRIO literal do Elvis (Rell/Naut/Leona dos dois lados)** | 173 | +0.18 | **69.9% [62.7–76.3]** |
| Alistar em qualquer lado (dentro do duplo engage) | 131 | **+1.82** | 58.0% [49.5–66.1] |

**Alistar arrasta.** Mapas com Alistar correm ~2 kills acima da fair e a fade cai pra 58% (CI cruza o BE). Coerente com o histórico: Alistar foi removido do FLEX_ENGAGE em 2026-05-29 por ROI −26.8%. O trio literal é o núcleo do sinal.

## 4. Validação da premissa de mercado — LIMITADA E HONESTA

Não temos histórico de linha de mercado por mapa; a tese das "4 linhas" vem da observação do Elvis em tela. O observável hoje: bets reais em mapas de duplo engage (linhas que ele ACEITOU — amostra enviesada) vs fair pré-match do dia.

| | n | delta linha−fair (média / mediana) |
|---|---|---|
| Bets em duplo engage | **3** | **+1.33 / +2** (só fair Pinnacle: n=2, +0.5) |
| Baseline: bets não-engage | 156 | −0.61 / 0 |

As 3 bets: IG×Weibo M2 Over 32.5 vs fair 30.5 (**+2, red**) · TLN×IJC M1 Over 32.5 vs fair-fórmula 29.5 (**+3, red**) · LOUD×paiN M2 Over 28.5 vs fair 29.5 (−1, green). Detalhe que dói: as duas bets na linha inflada eram **Over do próprio Elvis — e as duas perderam**. É literalmente a tese acontecendo contra ele. Mas **n=3 é anedota, não evidência**. Direção consistente (+1.3 vs −0.6), magnitude não confirmada (as "4 linhas" não aparecem nos casos observáveis; o máximo visto foi +3).

Polymarket não resolve: o coletor reativado 25/07 pega **moneyline**, não linha de kills. A validação real exige registro manual: **quando o Elvis vir duplo engage em tela, mandar 1 linha no chat com a linha ofertada + fair do dia** ("fade-watch: casa X, linha Y, fair Z"). Com ~15–20 desses, a premissa fecha ou morre.

## 5. Simulação operacional (condicional à premissa)

ROI% histórico SE a casa ofertasse Under fair+k nesses 316 mapas — só vale onde o mercado realmente subir a linha:

| linha | @1.75 (BE 57.1) | @1.80 (BE 55.6) | **@1.85 (BE 54.1)** | @1.90 (BE 52.6) |
|---|---|---|---|---|
| fair+2 (hit 58.5%) | +2.5% | +5.4% | +8.3% | +11.2% |
| **fair+3 (hit 64.2%)** | +12.4% | +15.6% | **+18.8%** | +22.1% |
| fair+4 (hit 67.7%) | +18.5% | +21.9% | +25.3% | +28.7% |

## 6. Proposta — variante de observação SIMULADA `under_engage_fade`

Regra do projeto: variante nova NUNCA nasce com dinheiro real. Config pra `scripts/track-observation-variants.cjs` (bloco `VARIANTS` — só especificação, script não foi alterado):

```js
under_engage_fade: {
  side: 'under',
  lineDelta: 3,
  odd: 1.85,
  detect: (c) => {
    const ENG = new Set(['rell', 'nautilus', 'leona', 'alistar', 'thresh']);
    return ENG.has(normChamp(c.supBlue)) && ENG.has(normChamp(c.supRed));
  },
  basis: 'Fade da linha inflada em duplo engage: P(kills<fair+3)=64.2% n=316 [58.8-69.3] pooled 3 splits; trio Rell/Naut/Leona 69.9% n=173 (36-under-engage-fade)',
},
```

- Camille nunca colide com o detect (duplo engage exige os DOIS sups no set) — a exclusão da janela é estrutural.
- Sem overlap com o método Under (engage não está em PEEL/FLEX → trigger nulo nesses mapas).
- **Trava de promoção (padrão):** n≥20 settles simulados E hit ≥60% (mesma régua da janela Camille). **Sub-regra pré-declarada JÁ:** se no checkpoint os mapas com Alistar estiverem abaixo da régua, o set restringe pro trio Rell/Naut/Leona — decidido agora pra não ser pós-hoc depois.
- **Se promovida a dinheiro real, o gatilho NÃO é o draft — é o movimento:** entrada só quando a linha OFERTADA ≥ fair Pinnacle +3 (aí toma o Under na linha ofertada). O rastreador simulado testa o lado dos kills; o lado do mercado se valida com o fade-watch da seção 4.

### Ressalvas (onde a tese pode morrer)

1. **Premissa de mercado não validada** — se a subida típica for +1/+2 e não +3/+4, o fade não paga (fair+2 = CI abaixo do BE). É a ressalva nº 1 por margem larga.
2. Split2 é o elo fraco do kills-side (60.6% na fair+3, delta +1.92) — num split o mercado teria "acertado" em inflar.
3. Amostra do split3 é pequena (n=36) e o meta de julho muda rápido.
4. **Flag lateral pro tribunal das regras:** a base da variante `over_rell_naut` (60.6% over fair, n=33) NÃO generaliza no pool all-regions — Rell×Naut over fair = **50.5% n=107**. Reavaliar essa observação na próxima revisão de domingo.
