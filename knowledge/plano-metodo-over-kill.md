# Plano — Buscar o método OVER kills (espelho do Under)

**Data:** 2026-06-05
**Base:** [anatomia do método Under](audits/2026-06-05-anatomia-metodo-under-kill.md)
**Decisões travadas com o CEO:**
- Fair line = MESMA fórmula do Under (`(blueAvgTotal+redAvgTotal)/2` round `.5`, leave-one-out, Pinnacle manual quando existe).
- **Odd 1.83 → breakeven 54,6%** (`100/1.83`).
- Ligas: TODAS cobertas pela API (LCK, LPL, LEC, CBLOL, LCS, LFL, LES, LIT).
- Janela: **só Split 2** (`≥ 2026-04-01`).
- Gatilho: **NÃO definir ainda.** Entregar planilha de TODOS os supports → CEO analisa e decide a lista.

---

## Princípio do espelho

O edge do Under vem do **gatilho selecionar jogos mais FRIOS que a média que define a fair** (trigger → 24,7 kills vs fair ~27,9). O Over é o inverso: achar gatilhos que selecionam jogos **mais QUENTES que a fair** (kills > fair). A fair é a mesma régua; só muda o lado da aposta e o tipo de boneco que dispara.

---

## Guardrails anti-erro (o que o CEO pediu: "não errar informação")

| # | Guardrail | Por quê |
|---|---|---|
| G1 | **Script ISOLADO.** Criar `.cjs` novo só-leitura; NÃO tocar `rebuild_dashboard_stats_cron.cjs` (Under hardcoded) nem o cron/dashboard de produção. | Zero risco de quebrar o método Under que está rodando. |
| G2 | **Mesma fair, mesmo leave-one-out, mesmo split.** Copiar a função `fairForGame()` verbatim, só trocar o lado do hit. | Comparabilidade direta; não introduzir viés novo. |
| G3 | **Teste de calibração da fair ANTES de tudo.** Rodar Over-hit em TODOS os mapas do split 2 (sem filtro de support). Baseline esperado ~50%. | Se baseline ≫50% ou ≪50%, a fair tem viés sistemático e qualquer "edge" de support é artefato. Define a linha-base contra a qual todo support é medido. |
| G4 | **Wilson CI 95% + n mínimo em CADA linha** da planilha. n≥15 confiável · 10-14 marginal · <10 ruído (não declarar edge). | Regra do quant-analyst; evita repetir o erro "Bard sangrador n=9". |
| G5 | **Reconfirmar dados contra Supabase/API atual**, não usar os números snapshot de 2026-05 da fase 1. | Dados mudam; fase 1 é mapa, não verdade atual. |
| G6 | **Over ≠ complemento do Under.** ROI Over não é `100% − ROI Under` (odd diferente + linha `.5`). Nunca inferir Over a partir do Under sem rodar. | Erro conceitual fácil de cometer. |
| G7 | **Cross-check manual de 3 supports** (puxar os mapas crus, conferir kills vs fair na mão) antes de confiar na planilha inteira. | Pega bug de agregação antes de virar decisão. |
| G8 | **Bug Over invertido (#6)** no `dashboard/index.html` (`getBetSim`) fica fora do caminho do backtest (uso script próprio), mas tem que ser corrigido ANTES de exibir/registrar bets Over reais. Item separado, não bloqueia o estudo. | Senão bets Over reais aparecem invertidas no tracker. |

---

## Fases

### Fase 0 — Blindagem de dados (read-only)
1. Contar universo real no Supabase `method_reports` + API: nº de mapas split 2 por liga, quantos têm `total_kills` e supports preenchidos.
2. Confirmar cobertura de supports (precisamos do support dos 2 times em cada mapa — vem de `picks()` na livestats).
3. Rodar **G3 (calibração)**: Over-hit% global do split 2. Registrar baseline.

### Fase 1 — Motor Over isolado
4. Criar `analyze_over_supports.cjs` (novo, read-only):
   - Reusa captura de jogos + `fairForGame()` idêntica (G2).
   - Filtra split 2, todas as ligas.
   - Hit Over = `total_kills > fair_line`.
   - Odd 1.83, breakeven 54,6%.

### Fase 2 — Planilha de TODOS os supports (ENTREGÁVEL principal)
5. Para cada champion que apareceu como support no split 2, calcular:
   - `n` (mapas em que foi support, qualquer time)
   - **Over-hit%** + Wilson CI 95%
   - **ROI @ 1.83**
   - avg kills · avg fair · **delta (kills − fair)** ← quão "quente" o boneco é
   - flag de amostra (✅ n≥15 / ⚠️ 10-14 / ❌ <10)
   - delta vs baseline global (G3)
6. Saída: **CSV** (`cron-data/over-supports-split2.csv`, abre no Excel/Sheets) + tabela markdown ordenada por Over-hit% desc.
7. **G7:** cross-check manual de 3 supports do topo.
8. **PARA AQUI → CEO analisa a planilha e decide a lista de supports gatilho.**

### Fase 3 — (após decisão do CEO) definir e validar o gatilho Over
9. Com a lista escolhida, definir trigger espelho (`2engage` / `1engage+flex` análogo ao Under).
10. Backtest do gatilho: hit%, ROI, n, por liga.
11. Refinamentos espelho: times "quentes" (winrate Over), exclusões de matchup, ligas de alto kill.
12. Validação anti-overfitting: cross-check vs bets Over reais (se houver no banco), Wilson CI, breakeven 54,6%.

### Fase 4 — (opcional, após método validado) produtização
13. Corrigir bug #6 (Over invertido) no dashboard.
14. Integrar ao briefing/dashboard como método paralelo.

---

## Entregável imediato (o que executo ao receber luz verde)
Fases 0 → 1 → 2: a **planilha de todos os supports** com Over-hit%, ROI @1.83, delta vs fair, n e CI, sobre todo o Split 2 e todas as ligas. Depois paro pra você decidir o gatilho.
