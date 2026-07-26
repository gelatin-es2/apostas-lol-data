# Planilha de supports — método OVER (Fase 2)

**Data:** 2026-06-05
**Script:** `.claude/scripts/analyze_over_supports.cjs` (read-only, isolado)
**CSV:** `cron-data/over-supports-split2.csv`
**Universo:** 928 mapas Split 2 (≥2026-04-01), 8 ligas (LEC/LCK/LPL/CBLOL/LCS/LFL/LES/LIT)
**Fair:** Pinnacle > fórmula `(blueAvg+redAvg)/2` round .5 (leave-one-out) > 29.5. SEM override de bet do Elvis.
**Odd 1.83 → breakeven 54,6%.** Over-hit = `total_kills > fair`.

---

## G3 — Calibração da fair (o achado estrutural)

| Universo | n | Over-hit% |
|---|---|---|
| **TOTAL** (todos os mapas) | 928 | **45,9%** |
| **nonUnder** (exclui 2peel + 1peel+flex) | 469 | **54,8%** |
| Jogos pulados (trigger Under) | 459 | — |

**Leitura:**
1. Global 45,9% < 50% → a fair-fórmula fica levemente ACIMA da mediana (distribuição de kills é assimétrica à direita: jogos com blowout puxam a média). Não é bug — é skew. Efeito: pro Over, a régua já é exigente; quem fura ela muito é genuinamente quente.
2. **Tirar os jogos de Under já leva o Over pra 54,8% — em cima do breakeven 54,6%.** Ou seja: "não ser setup de Under" já é, sozinho, um sinal Over ~breakeven. O complemento do método Under é levemente lucrativo no Over. Validação forte da tese-espelho.
3. Os 459 jogos de Under são quase metade do universo — bate com o método Under existir mesmo.

---

## Candidatos com amostra confiável (n≥15) + Wilson lower bound ≥ breakeven

Só **2 supports** têm n≥15 E limite inferior do CI95 acima do breakeven 54,6% — os mais sólidos:

| champ | n | over% | CI95 | ROI@1.83 | Δ(kills−fair) | tese |
|---|---|---|---|---|---|---|
| **Rell** | 53 | 71,7% | **58**–82 | +31,2% | +4,48 | engage/tank — vanguard, teamfight |
| **Nautilus** | 145 | 63,4% | **55**–71 | +16,1% | +2,96 | hook/engage — o "anti-Milio" já mapeado |

Estes dois são o coração do espelho: engage puro, amostra grande, CI inteiro acima do breakeven.

## Segundo escalão (n≥15, over% acima do BE mas CI cruza o breakeven)

| champ | n | over% | CI95 | ROI@1.83 | Δ | nota |
|---|---|---|---|---|---|---|
| Leona | 24 | 58,3% | 39–76 | +6,8% | +3,92 | engage clássico, n médio |
| Pyke | 21 | 57,1% | 37–76 | +4,6% | +2,98 | roam/engage |
| Nami | 38 | 63,2% | 47–77 | +15,6% | +3,97 | ⚠️ é PEEL — surpresa, investigar (comps agressivas?) |
| Anivia | 16 | 62,5% | 39–82 | +14,4% | +1,88 | flex mago |
| Alistar | 73 | 54,8% | 43–66 | +0,3% | +1,51 | engage, mas só baseline (foi cortado do Under por −26,8%) |

## Confirmações da mecânica (peel = frio, como esperado)

Milio 46,2% (n=26, −15,5% ROI) · Lulu 50,0% (n=56) · Karma 50,0% (n=44) · Seraphine 55,8% (n=52). Os peel puro ficam no breakeven ou abaixo no Over — exatamente o previsto. **Milio confirmado frio até em jogos non-Under** (não é só efeito do trigger).

## Outliers a notar
- **Neeko** n=161 (maior amostra) só 49,1% → neutro apesar de engage-flex. Amostra grande = real.
- **Bard** 53,1% (n=98) → abaixo do BE mesmo no Over (consistente com ser o "sangrador" do Under).
- **Thresh** 22,2% mas n=9 (ruído).
- Topo da tabela (Soraka/TahmKench/Amumu 100%) é tudo n≤2 = ruído puro, ignorar.

---

## Caveats
- Over vs NOSSA fair ≠ Over vs linha da casa. A casa pode precificar bem; ROI real depende da linha ofertada (mesma limitação do backtest Under).
- CI95 Wilson em cada linha — n<15 não declara edge.
- Cross-check G7 (3 jogos crus de Rell) bateu: kills vs fair corretos, trigger=none confirmado.

## Decisão pendente do CEO
Escolher quais supports compõem o gatilho Over a partir desta planilha. Recomendação técnica (não vinculante): começar por **Rell + Nautilus** (os 2 sólidos), avaliar segundo escalão como expansão. Depois disso → Fase 3 (definir trigger, refinar por liga/time, validar).
