# Milio por tipo de parceiro — VEREDITO: manter "Milio = 2u sempre". A proposta "flex=1u, peel=2u" NÃO tem base — se algo, é o CONTRÁRIO (flex levemente melhor), mas a diferença é ruído estatístico.

**Data:** 2026-07-26 · **Pergunta do CEO:** "Milio com 1 flex = 1u e Milio com 1 peel = 2u — faz sentido?" ("melle" interpretado como peel; engage/melee coberto também)
**Fonte:** `scripts/analysis/milio-por-parceiro.cjs` → `audit-output/35-milio-parceiro.json` (reusa coleta de 26/07: split1 + allregions + split3-window, 3.801 mapas com fair LOO; zero chamada de API)
**Régua:** Under fair @1.83 (BE 54,6%) · fair+1 @1.72 (BE 58,1%) · fair leave-one-out por liga · stats por mapa

## 1. As 4 categorias do sup do outro lado (pooled splits 1+2+3, fair+1)

| Milio + ... | n | delta kills | hit @fair+1 [CI95] | ROI @1.72 | leitura |
|---|---|---|---|---|---|
| **peel** (= 2peel c/ Milio) | 237 | −4,0 | **75,9%** [70,1–80,9] | +30,6% | forte, CI inteiro acima do BE |
| **flex** (Bard/Rakan/Lux/Anivia) | 66 | −4,9 | **80,3%** [69,2–88,1] | +38,1% | forte, CI inteiro acima do BE — **melhor ponto, não pior** |
| engage (Rell/Naut/Leona/Alistar...) | 56 | +0,2 | 55,4% [42,4–67,6] | −4,8% | abaixo do BE — **skip atual REVALIDADO** |
| outro (fora das listas; 26/29 = Neeko) | 26 | −3,9 | 73,1% [53,9–86,3] | +25,7% | interessante, mas é quase só Neeko (ver obs.) |

Por split (fair+1): peel — split2 75,9% (n=224), split3 80% (n=5⚠️), julpre 52,6% (n=19, período tier-2/EWC). Flex — split2 78,7% (n=61), split3 100% (n=4⚠️), julpre 71,4% (n=7⚠️). Split 3 ainda não tem amostra (n<10 nas duas células).

Flex individual: Milio×Bard **76,1% (n=46)** — confere com a análise do Bard de hoje (`34-bard-flex.json`, mesma célula, mesmo número) · Milio×Rakan 81% (n=21) · Milio×Lux 100% (n=5⚠️) · Milio×Anivia n=0. Nenhum flex individual é ponto fraco.

## 2. O teste da diferença (a pergunta em si)

| recorte | peel | flex | diff (peel−flex) | CI95 da diff | p (z 2 prop.) |
|---|---|---|---|---|---|
| pooled 1+2+3, fair+1 | 75,9% (237) | 80,3% (66) | **−4,4pp** | [−15,4, +6,7] | 0,46 |
| pooled 1+2+3, fair | 71,7% (237) | 78,8% (66) | −7,1pp | [−18,5, +4,4] | 0,25 |
| split2, fair+1 | 75,9% (224) | 78,7% (61) | −2,8pp | [−14,5, +8,9] | 0,65 |

Todos os CIs cruzam zero, todos os p muito longe de 0,05 → **a diferença peel×flex é ruído**. E o sinal pontual é NEGATIVO (flex MELHOR que peel em todos os recortes e nas 3 réguas de fair — LOO, trailing causal e Pinnacle). Rebaixar flex pra 1u iria na direção errada do próprio dado.

## 3. Dinheiro real do Elvis (Supabase, Under com Milio, 136 bets reais settladas)

| parceiro | bets | mapas | hit/mapa | stake | P/L | ROI |
|---|---|---|---|---|---|---|
| peel | 109 | 46 | 69,6% | R$95,7k | **+R$20,8k** | +21,8% |
| flex | 21 | 16 | 81,3% | R$22,1k | **+R$9,4k** | **+42,6%** |
| engage (era skip) | 6 | 4 | 75% | R$5,1k | +R$0,8k | +14,8% |

O recorte flex é o de MAIOR ROI real do Milio. A regra proposta teria cortado stake justamente na célula mais lucrativa (custo contrafactual: ~metade dos +R$9,4k).

## 4. Decisão recomendada

- **MANTER: Milio no jogo (vs peel OU flex) = 2u.** Sem sub-regra por tipo de parceiro — a diferença não existe estatisticamente e o sinal pontual é o inverso da proposta.
- **MANTER skip: Milio vs engage/outro fora das listas** — engage revalidado em 55,4% (n=56), abaixo do BE 58,1%.
- Não criar regra invertida ("flex=3u") — mesma razão: CI cruza zero, seria over-fitting com n=66.

**Observações (não-aposta):**
- Milio×Neeko sup: 80,8% under fair+1 (n=26, CI [62–91]) — hoje é skip ("outro"). Candidata a observação futura se aparecer de novo; n insuficiente pra regra.
- Julpre (01–20/07, tier-2/EWC) foi o único período fraco do Milio+peel (52,6%, n=19) — coerente com o alerta de julho já registrado; ligas majors de volta normalizam.
- Checkpoint natural: re-olhar as células com ~1 mês de split 3 (hoje n=5/4).
