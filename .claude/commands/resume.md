---
description: Mostra estado atual do projeto + próximos passos a partir do NEXT-SESSION.md
allowed-tools: Read, Bash, Glob, Grep
---

Você está retomando o trabalho neste projeto após uma pausa. Faça o seguinte:

## Passos

1. **Lê `NEXT-SESSION.md`** na raiz do repo. Esse é o ponto de retomada oficial.

2. **Verifica estado do git:**
   - `git log --oneline -10` (últimos commits)
   - `git status --short` (mudanças não commitadas, se houver)
   - Se houver commits do cron (autor `github-actions[bot]`) recentes que não pegou ainda, sugere `git pull`

3. **Verifica último cron run** (opcional — se gh CLI disponível):
   - `gh run list --workflow=daily-cron.yml --limit 3` pra ver se rodadas recentes passaram

4. **Reporta resumo** em formato denso:

```
## Estado atual

[1-2 linhas do contexto principal do NEXT-SESSION.md]

## Últimos commits
[git log condensado]

## Pendência crítica
[se houver — ex: rotação de key]

## Top 3 próximos passos sugeridos
[do NEXT-SESSION.md]

## Pergunta pro CEO
Qual dos próximos passos atacar agora? Ou outra coisa?
```

5. **NÃO comece a trabalhar** sem CEO confirmar a direção. `/resume` é leitura + apresentação, não execução.

## Output esperado

Texto curto e estruturado. Sem prosa. Tabelas e bullets quando couber. Ao final, espera resposta do CEO sobre qual frente atacar.
