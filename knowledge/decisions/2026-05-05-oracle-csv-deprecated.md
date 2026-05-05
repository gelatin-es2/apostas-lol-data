# Decisão: Oracle CSV descontinuado, fair fixo em 29.5

**Data:** 2026-05-05
**Confirmado por:** CEO
**Status:** Vigente

## Contexto

Os scripts `capture_fair_lines.cjs` e `analyze_yesterday.cjs` referenciam um CSV histórico do Oracle's Elixir (`../year_backtest/datasets/2026_oracle.csv`) pra calcular fair lines como `avg(team_A_kills) + avg(team_B_kills)`. O CSV mora fora do repo (em outro projeto local não-versionado).

Em GitHub Actions, esse arquivo nunca está disponível: o workflow não injeta `ORACLE_CSV` env var, e `..` no checkout é o root do runner, não do projeto. O `process.exit(1)` na ausência do CSV é mascarado por `continue-on-error: true` no workflow.

## Decisão

**O CEO descontinuou o uso do Oracle's Elixir intencionalmente.** O sistema opera apenas com fair fixo `29.5`, conforme fallback em `analyze_yesterday.cjs:199`:

```js
const fair = fairFromOracle != null ? fairFromOracle : 29.5;
```

## Alternativas consideradas

- **Manter Oracle como fonte de fair customizada** — descartado. CSV exigia atualização manual (download semanal do Oracle's Elixir), e a granularidade (avg de kills por time no ano inteiro) ficou ruim conforme metas de patches e splits avançam.
- **Buscar fonte alternativa de avg kills (Bayes/Grid/Pandascore)** — descartado por enquanto. Custo de API + complexidade de integração não justifica vs operar com linha fixa.

## Consequências

- `capture_fair_lines.cjs` e `analyze_yesterday.cjs` têm bloco morto de "carregar CSV" + "exit 1 se ausente" — pode/deve ser removido em refatoração futura.
- `fair_source` no Supabase fica sempre `'default_29.5'` em prod.
- Backtest do dashboard usa LINE=29.5 hardcoded — coerente com a operação real.
- Time mapping `TEAM_CODE_TO_ORACLE` (50+ entradas) também vira dead code se Oracle não voltar.

## Como reverter

Se quiser reativar:
1. Criar action que baixa CSV semanalmente do Oracle's Elixir
2. Commitar o CSV em `cron-data/datasets/` (ou usar artifact storage)
3. Setar `ORACLE_CSV` env var no workflow apontando pro path correto
4. Remover o fallback default de `analyze_yesterday.cjs`
