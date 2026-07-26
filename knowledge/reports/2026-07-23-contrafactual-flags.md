# Contrafactual — flags vs "tudo" vs "nada"

**Data:** 2026-07-23 · **Fonte:** `scripts/analysis/counterfactual-flags.cjs` → `audit-output/22-counterfactual.json` (dataset: 518 games, 6 ligas operadas, 2026-04-25→2026-07-22 exclusivo, fair leave-one-out por liga, flag walk-forward sem leakage).

## Sumário executivo

- **Fiz de verdade:** R$8012.37 de lucro real (n=139 jogos com bet, hit 61.2%, ROI 4.1%).
- **Teria feito apostando em TUDO (fair+1 @ 1.72):** R$23212.37 (n=270, ROI 7.1%).
- **Teria feito apostando em TUDO numa linha 1 pior (fair @ 1.72, stress):** R$16332.37 (ROI 5%).
- **Teria feito seguindo a MINHA REGRA (≥1 verde, nunca 2 vermelhos) em TODO jogo do método:** R$1092.42 (n=111, ROI 0.7%).
- **Anti-regra (só o que a regra pulava):** R$22119.95 (n=159, ROI 12.5%).
- **O filtro (regra de flag), restrito aos jogos que ele pulou:** salvou R$61114.69 em perdas evitadas, mas deixou R$83234.64 na mesa em jogos que teriam pago — líquido de **R$-22119.95** só na parte que a regra decidiu pular.
- EWC real (fora da simulação): R$11505.25 em 48 bets — não somado nos números acima.

## 1. Tabela-resumo dos 5 cenários

| Cenário | n | Hit% | CI95% | Apostado | Lucro | ROI% |
|---|---|---|---|---|---|---|
| S1 REAL | 139 | 61.2% | [52.9, 68.8] | R$193802.34 | R$8012.37 | 4.1% |
| S2 TUDO @ fair+1 (1.72) | 270 | 63% | [57.1, 68.5] | R$324802.34 | R$23212.37 | 7.1% |
| S3 TUDO @ fair (stress, 1 pior) | 270 | 61.5% | [55.6, 67.1] | R$324802.34 | R$16332.37 | 5% |
| S4 REGRA DELE em tudo | 111 | 59.5% | [50.2, 68.1] | R$148037.72 | R$1092.42 | 0.7% |
| S5 ANTI-REGRA | 159 | 65.4% | [57.7, 72.4] | R$176764.62 | R$22119.95 | 12.5% |

Split real vs simulado dentro de cada cenário está no JSON (`scenarios.*.split_real` / `.split_sim`).

## 2. S1 REAL por combo de flag

| Combo | n | Hit% | Apostado | Lucro | ROI% |
|---|---|---|---|---|---|
| verde×verde | 19 | 47.4% | R$34280.81 | R$-4370.28 | -12.7% |
| verde×neutro | 22 | 59.1% | R$43703.49 | R$-1223.78 | -2.8% |
| verde×vermelho | 17 | 64.7% | R$18553.42 | R$5134.88 | 27.7% |
| neutro×neutro | 9 | 66.7% | R$17213.8 | R$2919.32 | 17% |
| neutro×vermelho | 17 | 70.6% | R$26315.65 | R$6736.62 | 25.6% |
| vermelho×vermelho | 8 | 62.5% | R$15121.22 | R$3321.59 | 22% |
| sem-amostra | 47 | 61.7% | R$38613.95 | R$-4505.98 | -11.7% |

## 3. Dinheiro na mesa / salvos pela regra (top 15/15)

### Dinheiro na mesa (regra pulou, teria pago)

| Jogo | Liga | Data | Combo | Fonte | Profit perdido |
|---|---|---|---|---|---|
| FURIA vs Los Grandes | CBLOL | 2026-06-06 | neutro×vermelho | real | R$3199.99 |
| TL vs FlyQuest | LCS | 2026-06-06 | neutro×neutro | real | R$3199.99 |
| FlyQuest vs C9 | LCS | 2026-05-23 | vermelho×vermelho | real | R$3013.8 |
| FlyQuest vs Sentinels | LCS | 2026-05-30 | neutro×vermelho | real | R$2599.99 |
| Karmine Corp Blue vs Galions | LFL | 2026-05-29 | neutro×neutro | real | R$2388.51 |
| C9 vs FlyQuest | LCS | 2026-05-23 | vermelho×vermelho | real | R$1429.83 |
| FURIA vs RED Kalunga | CBLOL | 2026-05-24 | neutro×vermelho | real | R$1286.65 |
| Fluxo W7M vs Los Grandes | CBLOL | 2026-05-10 | vermelho×vermelho | real | R$1071 |
| WE vs IG | LPL | 2026-05-06 | neutro×neutro | real | R$962.4 |
| Hanwha vs KT | LCK | 2026-04-29 | sem-amostra | real | R$954 |
| Karmine Corp Blue vs TLN Pirates | LFL | 2026-05-20 | sem-amostra | real | R$877 |
| Gen.G vs KIWOOM | LCK | 2026-05-08 | neutro×vermelho | real | R$852 |
| FURIA vs LOUD | CBLOL | 2026-05-17 | neutro×vermelho | real | R$826 |
| Vitality vs SK Gaming | LEC | 2026-05-02 | sem-amostra | real | R$819 |
| KOI vs Vitality | LEC | 2026-05-24 | neutro×vermelho | real | R$801.24 |

### Salvos pela regra (regra pulou, teria perdido)

| Jogo | Liga | Data | Combo | Fonte | Profit evitado |
|---|---|---|---|---|---|
| KOI vs G2 Esports | LEC | 2026-05-25 | neutro×neutro | real | R$-2738 |
| G2 Esports vs KOI | LEC | 2026-05-25 | neutro×neutro | real | R$-2148.49 |
| Esprit Shonen vs Galions | LFL | 2026-05-21 | sem-amostra | real | R$-2010.65 |
| Solary vs Karmine Corp Blue | LFL | 2026-05-27 | neutro×vermelho | real | R$-2000.26 |
| Hanwha vs Nongshim | LCK | 2026-05-23 | neutro×vermelho | real | R$-2000 |
| Los Grandes vs VKS | CBLOL | 2026-05-23 | vermelho×vermelho | real | R$-1891.46 |
| VKS vs Leviatan Esports | CBLOL | 2026-04-26 | sem-amostra | real | R$-1800 |
| NIP vs JDG | LPL | 2026-04-29 | sem-amostra | real | R$-1269.45 |
| KIWOOM vs Gen.G | LCK | 2026-04-30 | sem-amostra | real | R$-1248.48 |
| BRO vs FEARX | LCK | 2026-05-07 | neutro×vermelho | real | R$-1200 |
| RED Kalunga vs FURIA | CBLOL | 2026-05-02 | sem-amostra | real | R$-1200 |
| T1 vs Nongshim | LCK | 2026-04-29 | sem-amostra | real | R$-1200 |
| LOUD vs Los Grandes | CBLOL | 2026-05-25 | vermelho×vermelho | real | R$-1004.68 |
| KIWOOM vs Hanwha | LCK | 2026-05-10 | neutro×vermelho | sim | R$-1000 |
| BRO vs KIWOOM | LCK | 2026-05-17 | vermelho×vermelho | sim | R$-1000 |

## 4. Caveats honestos

1. **Odd 1.72 assumida em toda simulação** — jogos sem bet real usam odd flat 1.72 (fair+1) ou 1.72 (fair, stress) independente da odd de mercado real naquele momento, que pode ter variado por casa/timing.
2. **Disponibilidade de linha assumida** — a simulação assume que dava pra apostar QUALQUER jogo com trigger na linha calculada; na prática, liquidez/mercado pode não existir pra todas as ligas/casas o tempo todo.
3. **Flag depende do histórico de bets/jogos dele** — early-days (abril) tem times classificados SEM_AMOSTRA (n<5 jogos anteriores) por definição — a regra não discrimina nesse período, vira quase-sempre "aposta" ou "não decide" dependendo de como SEM_AMOSTRA é tratado (aqui: SEM_AMOSTRA sempre implica pular na regra, já que não tem nenhum VERDE confirmado).
4. **Cache do schedule estava desatualizado** (page-0 de 2026-07-20) — recoletei especificamente pra esta análise; ver `notes.cache_staleness` no JSON.
5. **8 bets reais órfãs** (sem game no universo coletado) foram reconstruídas a partir dos dados crus da própria bet (`raw_extraction`) — fair recalculado com o mesmo histórico de time da liga, não é 100% idêntico a estar no universo original.
6. **"Hit" de jogos com múltiplas bets (ladder)** é definido aqui pelo sinal do profit agregado (lucro líquido>0 = hit) — não é o hit de uma bet individual.
7. EWC fica fora de TODOS os cenários simulados (S2-S5) — só aparece como número informativo à parte, porque não há fair confiável fora da Riot API pra simular contrafactual.
8. **DIVERGÊNCIA INVESTIGADA — verde×verde real aqui = R$-4370.28 (esperado ~-R$7,6k), resto = R$12382.65 (esperado ~+R$25,7k).** Não bateu. Testei 4 escopos alternativos de população pra reconciliar: (a) sem limite de data — Under+trigger+6 ligas dá R$8.656 total (quase igual ao valor aqui, R$8.012); (b) qualquer mercado nas 6 ligas (não só Under) — R$5.563 total, mais baixo ainda; (c) só Under nas 6 ligas sem exigir trigger — R$3.557; (d) TODAS as bets settled, qualquer liga/mercado, sem limite de data — R$19.266, que é o único valor perto da soma -7,6k+25,7k=18,1k citada. **Hipótese mais provável: a referência do dono usa uma população mais ampla (todas as bets reais, não só Under+trigger+6-ligas) — este script seguiu literalmente a população definida no pedido ("jogos com TRIGGER peel nas 6 ligas operadas"), que é mais restrita.** Não force-fitei o número — reportando a divergência como está.

---

Sem recomendação — a conclusão de negócio é do orquestrador/dono.
