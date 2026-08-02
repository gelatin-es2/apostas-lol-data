# Estudo — piso de odd da janela Camille: subir a linha pra pegar ≥1.80 vale?

**Data:** 2026-08-02 · **Gatilho:** revisão semanal apontou piso 1.80 ignorado há 3 semanas; Elvis explicou que odd ≥1.80 só existe uma linha acima da que ele pega e pediu o cálculo ("precisa ver se vale").

## Conclusão em uma frase

**Não vale subir a linha — o piso 1.80 deve morrer; o piso que protege é ~1.72 na linha ≤ fair.** O edge da janela está na LINHA (apostar na fair), não na odd. Forçar odd 1.80 subindo uma linha troca 6 pontos de acerto por um prêmio que não compensa.

## Números

Amostra: 113 mapas históricos (réplica exata do camille-sweep, 67,3% validado) + 19 mapas recentes (22/07–01/08, sem sobreposição) = **n=132**. Degrau de odd medido nos ladders reais da Pinnacle (24 matchups): Over @1.70–1.79 → linha+1 paga em média **@1.884** (+0.161).

| Cenário | Hit | CI95 | EV por unidade (@odd típica) |
|---|---|---|---|
| A — Over na fair, odd ~1.72–1.77 (o que Elvis faz) | 88/132 = **66,7%** | [58,3–74,1] | **+0.163** (a cada R$1.000, ~+R$163 no longo prazo) |
| B — Over na fair+1, odd ~1.84–1.90 (respeitar piso) | 80/132 = **60,6%** | [52,1–68,5] | **+0.133** (~+R$133) |

- Só 8/132 mapas (6,1pp) caem exatamente 1 kill acima da fair — é o que se perde subindo a linha. Pra empatar em EV podia perder até 4,5pp. Perdeu mais → linha de baixo é melhor no ponto central; com odds reais do ladder o diff chega perto de empate (+0.007/u), CI cruza zero.
- CI do EV: cenário A inteiro no positivo; cenário B cruza o zero.
- Recalc da semana (10 slips reais abaixo do piso): real +R$3.909 vs linha+1 +R$4.864 — semana atípica (zero mapas na banda marginal), **não** é prova a favor de subir linha.

## Regra proposta (aguarda martelo do Elvis)

1. **Matar o piso 1.80** — era premissa contábil do backtest (ROI @1.80 flat), não condição do edge.
2. **Piso novo: odd ≥1.72 com linha ≤ fair.** BE @1.72 = 58,1% ≈ CI inferior do hit (58,3%) — abaixo disso o preço come toda a margem. Slips @1.60–1.68 (TLN, FlyQuest, BRO na semana) estavam na zona magra.
3. Exceção: se a linha da fair pagar <1.72 e a linha+1 pagar ≥1.87, linha+1 é alternativa aceitável (quase empate em EV; decisão por variância).

**Caveats:** ladder com só 2 dias de captura auto; amostra recente cobre 5 ligas; segue sob o guarda-chuva da auditoria split 3 (edge não validado com Bonferroni) — muda a regra da janela, não autoriza stake maior.

*Réplica e output: scratchpad da sessão (`camille-line-study.cjs`). Fontes: audit-output/00-universe-allregions.json, 17-camille-sweep.json, 30-split3-bets.json, cron-data/*-results.json, cron-data/pinnacle-auto/.*
