# Lição: EWC não está na API oficial do lolesports

**Data:** 2026-05-05
**Contexto:** Tentativa de adicionar EWC EMEA aos `LEAGUE_IDS` dos scripts pra cobrir 25% do volume real de apostas.

## Sintoma

`getLeagues` da `esports-api.lolesports.com` não retorna EWC / "Esports World Cup". Internacionais retornados: apenas Worlds, MSI, First Stand, TFT Esports, Worlds Qualifying Series.

## Causa raiz

EWC (Esports World Cup, em Riyadh) é torneio organizado pela ESL/Saudi, **não pela Riot Games**. Riot patrocina mas o evento não faz parte do ecossistema oficial dela. Por isso não aparece nas APIs do lolesports.

## Implicação operacional

- Scripts `capture_fair_lines.cjs`, `analyze_yesterday.cjs`, `rebuild_dashboard_stats_cron.cjs` **não conseguem cobrir EWC** com a infra atual.
- Bets de EWC entram normal na tabela `bets`, mas ficam **sem trigger detectado automaticamente** (`raw_extraction.match_context.trigger_type` fica null).
- Dashboard ignora EWC nas agregações (não aparece em `ligas`, `supports`, `teams`, `champs`).
- 25% do volume real do CEO (25 das 99 bets em 8 dias) fica fora do método automatizado.

## Fix imediato (2026-05-05)

Nenhum. Decisão: **deixar EWC fora do automatizado por enquanto**. O Bet Logger ainda registra a bet, marca como `trigger_type=null` (com flag `lolesports_not_covered: true`), e settla manualmente via input do CEO ou checagem manual.

## Como evitar repetir

Antes de adicionar liga ao `LEAGUE_IDS`, sempre validar primeiro com `getLeagues` da API. Se não estiver lá, é torneio fora do Riot ecosystem.

## Fontes alternativas pra cobrir EWC no futuro

| Fonte | Custo | Trabalho |
|-------|-------|----------|
| **Pandascore** | API paga (~$50-200/mês dependendo do plano) | Médio — schema da `bets` já tem `pandascore_match_id` e `pandascore_match_name` (foi planejado antes mas nunca integrado) |
| **Bayes Esports** | API enterprise (caro) | Médio |
| **Grid Esports** | API paga | Médio |
| **Liquipedia scraping** | Grátis | Alto — wiki, parsing de tabelas, fragilidade |
| **Site oficial EWC + scraping** | Grátis | Alto — frágil |

## Próximo passo (futuro)

Quando volume de EWC justificar, integrar **Pandascore** (caminho mais limpo: schema já preparado pra ele). Tarefa adicionada ao roadmap.
