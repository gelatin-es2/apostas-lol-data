# Estudo Money Line — Fase 1 (previsibilidade)

**Data:** 2026-07-23 · **Fonte:** `scripts/analysis/ml-study-phase1.cjs` → `audit-output/24-ml-study.json` (3.616 games, 3 universos dedup).

## Achados

1. **"Blue side advantage" é ILUSÃO de seed.** Naive: blue 54,2%. Controlado dentro da mesma série (mesmos 2 times): **46,1%** (CI [43,8–48,4]). O que parecia vantagem de lado é "time forte escolhe blue". CBLOL 64%/Prime 62% = artefato. E há um 2º confound não-resolvível com o dado atual: em muitas ligas o PERDEDOR do mapa escolhe o lado seguinte (loser-picks-side) — contamina o próprio teste controlado. **Veredito: side NÃO é bet.**
2. **Draft prevê o vencedor um pouco:** preditor score-de-WR-dos-5-champs = **55,3%** out-of-sample (treino abr-mai → teste jun-jul; CI [51,6–58,9], bate coin flip). Mas exige odd ≥1,81 pra empatar — apertado após vig. Sinal real, fraco demais pra operar sozinho.
3. **Champion WR por role** recomputado (ml_picks do cron tava de junho): destaques TF top 73,5%, Lux sup 71,9%; piores Yasuo top 33%, Mel 38%. Tabela completa no JSON.
4. **Hipóteses vivas** (dependem da FASE 2 — odds reais): (a) tier-2 mal precificada; (b) **timing pós-draft na odd pré-draft** — o draft carrega 55%+ de informação que a odd pré-draft não tem; se a casa não mover rápido, é o edge do Elvis transplantado. (c) side: morta.

## Próximos passos

- **Fase 2 (gargalo):** coletar odds ML reais 2-3 semanas — Elvis fotografa a tela de ML junto com a de kills. Sem preço real, nada avança.
- Fase 3: settle de Money Line no sistema (winner_side já extraído) — implementar quando fase 2 confirmar interesse.
- Piloto: só simulado até um sinal passar a régua (mesma disciplina Camille).

**Regra de ouro mantida:** nenhum real em ML até um edge sobreviver out-of-sample COM odds reais na conta.
