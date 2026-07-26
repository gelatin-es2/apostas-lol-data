---
description: Briefing diário de bet — agenda do dia com fair line, flags de time e liga. Primeira resposta de bet do dia.
argument-hint: [YYYY-MM-DD]
allowed-tools: Read, Bash
---

Gerar o briefing diário de apostas LoL.

## Argumento
`$ARGUMENTS` — data opcional YYYY-MM-DD. Se omitida, usa hoje (UTC) conforme currentDate do system prompt.

## Passos
1. Rodar `node .claude/scripts/daily_briefing.cjs $ARGUMENTS` na raiz do projeto.
2. Apresentar a tabela do stdout como está (já vem pronta com fair line e flags).
3. Formato canônico de flags (NÃO alterar):
   - Flag de TIME (winrate histórico) → vai na COLUNA Flags da linha do jogo.
   - Flag de LIGA (liga ruim) → vai num RESUMO separado ABAIXO da tabela, nunca na linha.
4. Filtrar ligas operadas: LCK, LPL, LEC, CBLOL, LFL, LCS, LES + EWC qualifiers. Cortar LIT/MSI/Worlds.

## Validação obrigatória
- Se algum jogo aparecer com fair "—", NÃO assumir "fair faltando": abrir `cron-data/<data>-fair-pinnacle.json` e contar `fair_lines` vs jogos da agenda. "—" pode ser bug de matching de nome de time, não fair ausente.
- Se contexto bet e ainda não há fair Pinnacle do dia: este briefing é o passo 1 do desbloqueio da trava de fair — após mostrar, pedir as fair Pinnacle ao Elvis e registrar via `/log-fair`.

## Se o script falhar
Parar e mostrar o erro exato + caminho. Não inventar agenda.
