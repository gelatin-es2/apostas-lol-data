---
description: Analisa performance real de apostas (subset, breakdown, filtro) via subagent quant-analyst
argument-hint: <subset ou filtro> [--by <campo>] [outros filtros]
allowed-tools: Read, Bash, Agent
---

Você vai delegar pro subagent `quant-analyst` a análise quantitativa pedida pelo CEO.

Pedido do CEO: $ARGUMENTS

## Como interpretar

O argumento é livre — pode ser um subset nomeado, um filtro, ou uma frase descritiva. Exemplos:

| Argumento | Interpretação esperada |
|-----------|------------------------|
| `2peel` | `--trigger 2peel` |
| `cblol` | `--league CBLOL` (provavelmente quer breakdown — sugerir `--by team`) |
| `1peel+flex --by flex_engage` | `--trigger 1peel+flex --by flex_engage` |
| `1peel-flex` | alias pra `--trigger 1peel+flex` (sem o `+` que dá problema em shell) |
| `bard` | `--trigger 1peel+flex --flex Bard` |
| `ROI por liga` | `--by league` |
| `pinnacle` | `--bookmaker Pinnacle` |
| `mapa 1 vs mapa 2` | `--by map_number` |
| (vazio) | resumo geral: `--by trigger` |

## Passos

1. **Invoca o subagent `quant-analyst`** via Agent tool, passando:
   - O argumento literal `$ARGUMENTS`
   - Instrução: "Interpreta o pedido em pt-BR, rode `node .claude/scripts/quant-query.cjs` com as flags adequadas, e devolva tabela markdown + insight curto seguindo o procedimento da sua persona."

2. **Recebe a resposta do subagent** e relaya pro usuário sem reescrever — só passa adiante.

3. Se houver erro do script (ex: settings.local.json faltando), reporta o erro literal e sugere passos de correção.

## Formato de saída

Repassa o output do subagent na íntegra. Não adiciona prosa, não comenta os números, não opina sobre estratégia. Só apresenta o relatório.
