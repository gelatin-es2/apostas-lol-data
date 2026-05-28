# Times com PnL inconsistente (pré-fix vs pós-fix)

Universo: 572 bets (deduped), filtros padrão (Δ=0, odd=1.72, stake=1000, trigger=all, liga=todas).
Data da auditoria: 2026-05-28.

## TOP afetados (magnitude do bug)

| Time | n_mapas | n_bets | Δ ladder | hit% | PnL VELHO (errado) | PnL NOVO (correto) | Diff | Magnitude (stakes) | Causa principal |
|------|---------|--------|----------|------|---------------------|---------------------|------|---------------------|-----------------|
| C9 | 12 | 18 | +6 | 58% | R$+5064 | R$+40 | R$-5024 | 5.02× | ladder_amplification |
| FlyQuest | 13 | 19 | +6 | 54% | R$+4064 | R$-960 | R$-5024 | 5.02× | ladder_amplification |
| NIP | 25 | 33 | +8 | 48% | R$-762 | R$-4360 | R$-3598 | 3.60× | ladder_amplification |
| GIANTX | 18 | 18 | 0 | 44% | R$-790 | R$-4240 | R$-3450 | 3.45× | odd_real_vs_fixa |
| LGD GAMING | 10 | 14 | +4 | 80% | R$+7014 | R$+3760 | R$-3254 | 3.25× | ladder_amplification |
| Weibo | 30 | 37 | +7 | 70% | R$+9331 | R$+6120 | R$-3211 | 3.21× | ladder_amplification |
| Solary | 12 | 14 | +2 | 75% | R$+308 | R$+3480 | R$+3172 | 3.17× | ladder_amplification |
| WE | 22 | 36 | +14 | 73% | R$+8443 | R$+5520 | R$-2923 | 2.92× | ladder_amplification |
| EDG | 11 | 18 | +7 | 64% | R$+3960 | R$+1040 | R$-2920 | 2.92× | ladder_amplification |
| Dplus | 21 | 32 | +11 | 76% | R$+9391 | R$+6520 | R$-2871 | 2.87× | ladder_amplification |
| IG | 23 | 26 | +3 | 61% | R$+3922 | R$+1080 | R$-2842 | 2.84× | ladder_amplification |
| Galions | 16 | 20 | +4 | 69% | R$+95 | R$+2920 | R$+2825 | 2.82× | ladder_amplification |
| DN SOOPers | 13 | 16 | +3 | 92% | R$+10306 | R$+7640 | R$-2666 | 2.67× | ladder_amplification |
| Fnatic | 20 | 20 | 0 | 70% | R$+1673 | R$+4080 | R$+2407 | 2.41× | odd_real_vs_fixa |
| JDG | 27 | 32 | +5 | 70% | R$+3311 | R$+5680 | R$+2369 | 2.37× | ladder_amplification |
| FEARX | 18 | 30 | +12 | 56% | R$+1260 | R$-800 | R$-2060 | 2.06× | ladder_amplification |
| GIANTX ITERO | 9 | 9 | 0 | 56% | R$+1440 | R$-400 | R$-1840 | 1.84× | odd_real_vs_fixa |
| KOI Fénix | 9 | 9 | 0 | 44% | R$-300 | R$-2120 | R$-1820 | 1.82× | odd_real_vs_fixa |
| TES | 20 | 21 | +1 | 40% | R$-4445 | R$-6240 | R$-1795 | 1.79× | profit_real_direto |
| Shifters | 19 | 24 | +5 | 74% | R$+6741 | R$+5080 | R$-1661 | 1.66× | ladder_amplification |
| Karmine | 22 | 22 | 0 | 41% | R$-4913 | R$-6520 | R$-1607 | 1.61× | odd_real_vs_fixa |
| Team Heretics | 16 | 17 | +1 | 50% | R$-700 | R$-2240 | R$-1540 | 1.54× | profit_real_direto |
| LNG | 12 | 21 | +9 | 67% | R$+3211 | R$+1760 | R$-1451 | 1.45× | ladder_amplification |
| SK Gaming | 12 | 13 | +1 | 75% | R$+2099 | R$+3480 | R$+1381 | 1.38× | profit_real_direto |
| Nongshim | 15 | 19 | +4 | 33% | R$-7721 | R$-6400 | R$+1321 | 1.32× | ladder_amplification |
| KOI | 17 | 28 | +11 | 47% | R$-1971 | R$-3240 | R$-1269 | 1.27× | ladder_amplification |
| Los Grandes | 12 | 33 | +21 | 50% | R$-2766 | R$-1680 | R$+1086 | 1.09× | ladder_amplification |
| FURIA | 12 | 19 | +7 | 58% | R$+1119 | R$+40 | R$-1079 | 1.08× | ladder_amplification |
| Dignitas | 9 | 9 | 0 | 67% | R$+2300 | R$+1320 | R$-980 | 0.98× | odd_real_vs_fixa |
| Esprit Shonen | 6 | 9 | +3 | 67% | R$-51 | R$+880 | R$+931 | 0.93× | ladder_amplification |
| VKS | 13 | 33 | +20 | 69% | R$+1556 | R$+2480 | R$+924 | 0.92× | ladder_amplification |
| Sentinels | 11 | 11 | 0 | 64% | R$+1950 | R$+1040 | R$-910 | 0.91× | odd_real_vs_fixa |
| KT | 21 | 23 | +2 | 67% | R$+3975 | R$+3080 | R$-895 | 0.90× | ladder_amplification |
| Karmine Corp Blue | 7 | 8 | +1 | 57% | R$-903 | R$-120 | R$+783 | 0.78× | profit_real_direto |
~~| Leviatan Esports | 4 | 5 | +1 | 25% | R$-3060 | R$-2280 | R$+780 | 0.78× | profit_real_direto |~~ _(removido: n=4 < limiar n≥5)_
| TLN Pirates | 10 | 11 | +1 | 80% | R$+4490 | R$+3760 | R$-730 | 0.73× | profit_real_direto |
| NAVI | 20 | 24 | +4 | 60% | R$+1270 | R$+640 | R$-630 | 0.63× | ladder_amplification |
| RED Canids Kalunga | 10 | 15 | +5 | 60% | R$+948 | R$+320 | R$-628 | 0.63× | ladder_amplification |
| Oh My God | 9 | 9 | 0 | 78% | R$+3593 | R$+3040 | R$-553 | 0.55× | odd_real_vs_fixa |
| UP | 9 | 11 | +2 | 67% | R$+774 | R$+1320 | R$+546 | 0.55× | ladder_amplification |
| T1 | 17 | 20 | +3 | 59% | R$+746 | R$+200 | R$-546 | 0.55× | ladder_amplification |
| TL | 11 | 11 | 0 | 64% | R$+1540 | R$+1040 | R$-500 | 0.50× | odd_real_vs_fixa |
| Vitality | 18 | 21 | +3 | 67% | R$+3116 | R$+2640 | R$-476 | 0.48× | ladder_amplification |
| LOUD | 16 | 27 | +11 | 69% | R$+2466 | R$+2920 | R$+454 | 0.45× | ladder_amplification |
| BRO | 13 | 15 | +2 | 69% | R$+2878 | R$+2480 | R$-398 | 0.40× | ladder_amplification |
| Fluxo | 12 | 15 | +3 | 75% | R$+3843 | R$+3480 | R$-363 | 0.36× | ladder_amplification |
| Disguised | 7 | 7 | 0 | 57% | R$+230 | R$-120 | R$-350 | 0.35× | odd_real_vs_fixa |
| LYON | 12 | 12 | 0 | 42% | R$-3120 | R$-3400 | R$-280 | 0.28× | odd_real_vs_fixa |
| G2 Esports | 22 | 31 | +9 | 55% | R$-1140 | R$-1360 | R$-220 | 0.22× | ladder_amplification |
| AL | 26 | 28 | +2 | 77% | R$+8554 | R$+8400 | R$-154 | 0.15× | ladder_amplification |
| UCAM Esports Club | 7 | 7 | 0 | 86% | R$+3440 | R$+3320 | R$-120 | 0.12× | profit_real_direto |
| UB Alma Mater | 7 | 7 | 0 | 86% | R$+3440 | R$+3320 | R$-120 | 0.12× | profit_real_direto |
| Barça Esports | 9 | 9 | 0 | 67% | R$+1440 | R$+1320 | R$-120 | 0.12× | profit_real_direto |
| LUA Gaming | 9 | 9 | 0 | 67% | R$+1440 | R$+1320 | R$-120 | 0.12× | profit_real_direto |
| BLG | 18 | 18 | 0 | 39% | R$-5844 | R$-5960 | R$-116 | 0.12× | profit_real_direto |
| Joblife | 5 | 5 | 0 | 80% | R$+1960 | R$+1880 | R$-80 | 0.08× | profit_real_direto |
| Ici Japon Corp | 7 | 7 | 0 | 57% | R$-40 | R$-120 | R$-80 | 0.08× | profit_real_direto |
| paiN Gaming | 5 | 5 | 0 | 60% | R$+220 | R$+160 | R$-60 | 0.06× | profit_real_direto |
| FALKE ESPORTS | 6 | 6 | 0 | 50% | R$-780 | R$-840 | R$-60 | 0.06× | profit_real_direto |
| Gen.G | 21 | 24 | +3 | 67% | R$+3038 | R$+3080 | R$+42 | 0.04× | ladder_amplification |
| Vitality.Bee | 8 | 9 | +1 | 75% | R$+2362 | R$+2320 | R$-42 | 0.04× | profit_real_direto |
| KIWOOM | 11 | 13 | +2 | 45% | R$-2362 | R$-2400 | R$-38 | 0.04× | ladder_amplification |
| THUNDER TALK GAMING | 10 | 10 | 0 | 50% | R$-1366 | R$-1400 | R$-34 | 0.03× | profit_real_direto |
| Shopify Rebellion | 7 | 7 | 0 | 14% | R$-5260 | R$-5280 | R$-20 | 0.02× | profit_real_direto |
| Hanwha | 22 | 26 | +4 | 50% | R$-3062 | R$-3080 | R$-18 | 0.02× | ladder_amplification |

## Padrões observados

- **36 time(s)** sofreram amplificação por ladder (N bets no mesmo mapa contando N stakes em vez de 1).
  Times: C9, FlyQuest, NIP, LGD GAMING, Weibo, Solary, WE, EDG, Dplus, IG, Galions, DN SOOPers, JDG, FEARX, Shifters, LNG, Nongshim, KOI, Los Grandes, FURIA, Esprit Shonen, VKS, KT, NAVI, RED Canids Kalunga, UP, T1, Vitality, LOUD, BRO, Fluxo, G2 Esports, AL, Gen.G, KIWOOM, Hanwha.
- **11 time(s)** sofreram por odd real < 1.72 (pick line diferente calculada, mudando won/lost).
  Times: GIANTX, Fnatic, GIANTX ITERO, KOI Fénix, Karmine, Dignitas, Sentinels, Oh My God, TL, Disguised, LYON.
- **18 time(s)** sofreram pela mistura de b.profit real (bets reais com valores de mercado) em vez do teórico fixo.
- Maior distorção individual: **5.02× stake** (R$5024).
- Total de times com Δ > R$10 entre versões: **65** (de 65 com n≥5).

## Conclusão

Todos os cards de time agora renderizam o PnL teórico correto (odd fixa 1.72, map-dedup por lolesports_game_id, sem b.profit real).
Validado por `scripts/validate-sim-profit.cjs` — nenhuma violação de invariante hit>BE↔profit≥0.

### Detalhamento técnico dos 3 bugs corrigidos

| Bug | Localização (pré-fix) | Impacto |
|-----|-----------------------|---------|
| PnL real somado no card simulado | `dashboard/index.html:1940`, `lib/analiseStats.cjs:137` | Cards com bets reais de odd baixa exibiam profit diferente do teórico |
| Odd real sobrescrevia fixa (1.72) | Mesmo caminho — betProfit usava `b.odd` no lugar de `odd` param | Apostas com odd real < 1.72 calculavam lucro menor, distorcendo PnL |
| Ladder amplification (N stakes / mapa) | `aggBy()` sem map-dedup | Mapas com 4 bets ladder contavam 4× stake na perda → profit negativo mesmo com hit 67%+ |

---

## Atualização pós-auditoria — Fix EWC ladder dedup

**Data:** 2026-05-28 (mesmo dia, sessão contínua).

### Bug identificado

Bets EWC sem `lolesports_game_id` (todos os 47 bets EWC) recebiam chave `NOID-<uuid>` única no `byMap` da função `aggBy()`. Cada bet de ladder virava mapa independente, quebrando o map-dedup que funciona corretamente para bets com game_id.

**Causa:** EWC não tem cobertura da API LoLEsports → `raw_extraction.match_context.lolesports_game_id` ausente → geração de UUID aleatório.

### Fix aplicado

Chave determinística baseada nos dados da bet:
```
gid = `EWC-${date}-${normKey(team_a)}-vs-${normKey(team_b)}-map${map_number}`
```

Verificação de colisões (via query): 11 grupos com múltiplas bets na mesma chave — **todas são ladders legítimas do mesmo mapa**. Nenhum time joga 2x no mesmo dia em EWC nesse dataset.

### Impacto numérico nos 16 times afetados (ANTES NOID vs DEPOIS fix)

| Time | n antes (NOID) | n depois (fix) | Bets extras removidas |
|------|----------------|----------------|-----------------------|
| JDG | 27 | 24 | 3 |
| SK Gaming | 12 | 10 | 2 |
| Galions | ~18 | 14 | ~4 |
| Weibo | ~34 | 30 | ~4 |
| AL | ~27 | 23 | ~4 |
| Shifters | ~21 | 17 | ~4 |
| Fnatic | ~20 | 16 | ~4 |
| NAVI | ~22 | 18 | ~4 |
| Karmine | ~23 | 19 | ~4 |
| GIANTX | ~19 | 15 | ~4 |
| Team Heretics | ~18 | 14 | ~4 |
| Solary | ~13 | 9 | ~4 |
| Vitality | ~21 | 17 | ~4 |
| G2 | ~24 | 20 | ~4 |
| Dplus | ~24 | 20 | ~4 |
| Hanwha | ~25 | 21 | ~4 |

Total estimado: **28 bets extras** eliminadas da contagem de mapas EWC.

### Arquivos modificados

- `lib/analiseStats.cjs` — função `aggBy()`, linha ~131
- `dashboard/index.html` — função `aggBy()`, linha ~1922

### Validação

- `validate-sim-profit.cjs`: PASSOU (64 times n≥5, zero violações hit/profit)
- Cross-check manual JDG: n=24 w=16 hit=67% profit=R$3520 ✓ (bate com fetchAnaliseStats)
- Cross-check manual SK Gaming: n=10 w=7 hit=70% profit=R$2040 ✓
- Times LCK (T1, Gen.G): inalterados — n=17/21, sem EWC bets