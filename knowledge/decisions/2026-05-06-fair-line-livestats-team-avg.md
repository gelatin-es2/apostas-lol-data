# Decisão: Fair line dinâmica via livestats team avg (reverte fair fixa 29.5)

**Data:** 2026-05-06
**Confirmado por:** CEO
**Status:** Vigente
**Substitui (parcialmente):** `2026-05-05-oracle-csv-deprecated.md` — Oracle CSV continua deprecated, mas a fair fixa 29.5 foi revertida.

## Contexto

Decisão de 2026-05-05 fixou fair line em 29.5 universal por falta de fonte de dados de avg de kills por time. CEO pediu hoje (2026-05-06) reverter — fair customizada por jogo, "do jeito que mais condiz com a realidade".

Análise das Under bets settled (100 amostras) mostrou que o problema da linha 29.5 universal é variância entre ligas:

| Liga | Real avg/jogo (21d) | Erro da fair fixa 29.5 |
|------|--------------------|-----------------------|
| LCK  | 29.03 | ~ok |
| LPL  | 27.87 | superestimando 1.6 |
| LEC  | 27.96 | superestimando 1.5 |
| CBLOL | 28.71 | superestimando 0.8 |

ROI da Under em CBLOL caiu pra **-66.4%** (15 bets). Linha fixa não calibra com o ritmo de cada liga.

## Decisão

Fair line é calculada **por jogo** via:

```
raw      = avg_kills_próprios_team_blue + avg_kills_próprios_team_red
adjusted = raw - 1                                  # ajuste fixo (calibração CEO)
fair     = round(adjusted - 0.5) + 0.5              # arredonda pra .5 mais próximo
```

- **Janela:** últimos 21 dias da liga (rolling)
- **Fonte:** lolesports livestats em tempo real (não Oracle CSV)
- **Fallback:** se sample do time `< 5 jogos`, usa média da liga
- **Ajuste -1:** subtraído ANTES do round; calibração baseada em experiência do CEO (composições peel-puro tendem a -1 kill vs avg agregado dos times). Aplicado a todos os jogos, não só 2peel.
- **Média da liga:** mostrada como `league_baseline` e `vs_league` no output mas **NÃO entra no cálculo** da fair — só serve como referência/contexto pro CEO.
- **`fair_source`:** `livestats_team_avg(team+team)-1` ou `livestats_team_avg(league+team)-1` quando uma das pontas caiu pro fallback

## Por que essa fórmula

- **Soma de avgs próprios** captura o ritmo real do confronto (time agressivo + time agressivo = mais kills esperados)
- **Não considera champion individual:** variância alta, sample fraco. Composição já é capturada pelo `trigger_type` (2peel/1peel+flex) — não duplica sinal.
- **Não considera "média da liga" como termo separado:** o ritmo da liga **já está implícito** na média de cada time (times de LPL têm avgs maiores naturalmente).
- **Round pra `.5`:** mantém formato padrão de bookmakers (linhas X.5 evitam push).
- **Janela 21 dias:** captura tendências do split atual sem ruído de meta antiga; sample suficiente pra times principais.

## Implementação

- Script: `analyze_range.cjs` (novo, aceita `--from --to`)
- Cobre: LCK, LPL, LEC, CBLOL (EWC fora — não disponível na lolesports API; LCS fora — não está no escopo do método)
- Output: 1 arquivo por dia em `cron-data/YYYY-MM-DD-results.json` (mesmo schema de `analyze_yesterday.cjs`)
- Persistência: `save_report_to_db.cjs` faz upsert em `method_reports` (on_conflict `game_id,map_number`)

## Pendências

1. **Migrar `analyze_yesterday.cjs` pra mesma lógica** — ainda usa Oracle CSV + fallback 29.5. Refatorar pro mesmo modelo do `analyze_range.cjs` antes do próximo cron diário, ou deixar `analyze_range` ser o novo script de produção.
2. **Adicionar LCS opcionalmente** se voltar ao escopo (hoje fora).
3. **Validar fair_raw vs total_kills** após acumular ~50+ jogos: se a previsão do modelo erra muito (RMSE alto), considerar pesos por recência ou matrix-up histórico head-to-head.
4. **Times com sample < 5 jogos** (rookies/promovidos) — fallback pra liga é razoável mas merece review periódico.

## Como reverter

Editar `analyze_range.cjs` e voltar pra `const fair = 29.5;` em `fairForGame()`. Marcar essa decisão como Substituída.
