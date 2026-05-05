# Lição: Performance real vs backtest por trigger e liga

**Data do snapshot:** 2026-05-05
**Universo:** 99 bets (período 2026-04-25 a 2026-05-02, 8 dias). 57 enriched (com `match_context.trigger_type` detectado), 25 EWC sem cobertura, 16 skipped.

## Achado 1: 2peel TEM edge real

| Métrica | Backtest | Real (n=32 settled) |
|---------|----------|---------------------|
| Hit | 73% | **84,4%** |
| ROI | +35% | **+32,2%** |
| Profit | (hipotético) | **+R$ 4.336** |

Real bate o backtest. Edge confirmado em produção. **Continuar operando 2peel com confiança.**

## Achado 2: 1peel+flex está SOFRIDO no real

| Métrica | Backtest | Real (n=16 settled) |
|---------|----------|---------------------|
| Hit | 66,2% | **43,8%** |
| ROI | +22,5% | **-24,6%** |
| Profit | (hipotético) | **-R$ 2.212** |

Gap de 47 pp em ROI. Possíveis causas:
- Variância de amostra pequena (n=16 — intervalo de confiança gigante)
- Linhas reais mais agressivas que 29.5 (você opera variadas: 25.5 a 33.5)
- Os 3 flex (Bard/Rakan/Alistar) podem não ser equivalentes — talvez só Bard mereça
- Mistura de critério no entry (você bateu sem ter trigger limpo?)

**Recomendação operacional:** investigar antes de continuar volume em 1peel+flex. Especialmente isolar Bard vs Rakan vs Alistar pra ver se 1 dos 3 está sabotando.

## Achado 3: CBLOL é desastre

| Liga | N | Hit | Profit | ROI |
|------|---|-----|--------|-----|
| LEC | 12 | 91,7% | +R$ 2.230 | +49,2% |
| LCK | 10 | 80% | +R$ 1.904 | +35,3% |
| LPL | 20 | 75% | +R$ 2.511 | +26,3% |
| **CBLOL** | **15** | **26,7%** | **-R$ 4.184** | **-66,4%** |

CBLOL sozinho bateu fora todo o profit das outras 3 ligas. Possíveis causas:
- Meta brasileira diferente (mais kills, jogos mais explosivos por estilo)
- Linhas das casas mal calibradas pra CBLOL → não há edge
- Time específico (LOUD? KaBuM? FURIA?) está performando muito acima da média de kills — não detalhado por time ainda
- Amostra pequena + variância (n=15 num intervalo de 8 dias)

**Recomendação operacional:** considerar pausar CBLOL ou reduzir stakes até entender. Antes de qualquer ação: investigar por time/champion no Quant Analyst (próxima sessão).

## Achado 4: EWC sustenta, sem trigger automático

EWC (25 bets, 68% hit, ROI +14,9%, +R$1.471 profit) é sua segunda maior fatia depois de 2peel. **Mas não temos trigger detectado pra essas bets** (lolesports não cobre EWC). Significa que EWC está sendo apostado **na cabeça**, sem cruzamento com o método. Sem dados pra dizer se é 2peel/1peel+flex ou outra coisa.

**Recomendação:** quando integrar Pandascore (roadmap futuro), recuperamos os triggers retroativamente.

## Bottom line consolidado

| Subset | Profit |
|--------|--------|
| 2peel real | +R$ 4.336 |
| 1peel+flex real | -R$ 2.212 |
| none (fora do método) | +R$ 338 |
| EWC | +R$ 1.471 |
| 16 skipped (não enriquecidos) | ≈ -R$ 3.412 (calculado por diferença) |
| **Total settled** | **+R$ 521** |

O resultado total (+R$521) **mascara** que:
- O edge real (2peel) gerou +R$4.336
- 1peel+flex e CBLOL juntos consumiram quase tudo
- Os 16 skipped em LCK Nongshim-T1 e LPL NIP-JDG (todos do dia 29/04, em vários mapas da mesma série) custaram caro em vermelho — vale investigar

## Próxima ação no roadmap

Implementar Quant Analyst com queries reusáveis: `/analyze 2peel`, `/analyze cblol`, `/analyze 1peel-flex --by flex_engage` etc. Usuário (CEO) chama sob demanda quando quiser cavar.
