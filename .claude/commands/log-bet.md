---
description: Registra aposta esportiva LoL no banco a partir de print + texto opcional
argument-hint: [contexto opcional, ex liga ou observações]
allowed-tools: Read, Write, Bash, Glob, Grep, Agent
---

Você vai registrar uma aposta no Supabase a partir do print que o usuário acabou de enviar (ou que está no contexto recente da conversa).

Contexto adicional do usuário: $ARGUMENTS

## Passos

1. **Identifica a imagem** que o usuário enviou. Se houver várias, pergunta qual é a aposta a registrar.

2. **Salva a imagem em disco** (se ainda não está):
   - Caminho: `cron-data/bet-screenshots/<YYYY-MM-DD>/<bookmaker_slug>-<timestamp>.png`
   - Cria a pasta com `New-Item -ItemType Directory -Force` se não existe
   - Pode usar PowerShell pra mover/copiar a imagem do path temporário

3. **Invoca o subagent `bet-logger`** via Agent tool, passando:
   - Path da imagem salva
   - Contexto adicional do usuário (liga sugerida, notas, etc)
   - Instrução: "Registra essa aposta seguindo o procedimento da sua persona. Reporta resumo curto."

4. **Recebe o resumo do subagent** e relaya pro usuário (sem reescrever — só passa adiante).

5. Se houve **ressalva ou falha**, sugere o que fazer:
   - "Liga não identificada (EWC?)" → pergunta se quer marcar manualmente
   - "Match ambíguo" → mostra os candidatos pra CEO escolher
   - "Falha de extração" → pede pra mandar print mais nítido ou outro ângulo

## Formato de saída

Repassa o resumo do subagent na íntegra. Não adiciona prosa nem comentário próprio. Se houver ressalva, adiciona uma linha curta perguntando como prosseguir.
