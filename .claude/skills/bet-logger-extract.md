---
name: bet-logger-extract
description: |
  Use quando o CEO mandar um print de aposta esportiva em LoL — de EstrelaBet, Pinnacle, Parimatch ou Betano — SEM digitar /log-bet. Reconhece pelo visual do print (logo do bookmaker, market, pick, odd, stake, bet ID) + contexto de que o CEO opera apostas em LoL.

  Triggers típicos: imagem anexada que parece comprovante de aposta, mesmo que a mensagem seja curta ("registra aí", "anota", "loga isso", "salva essa") ou só a imagem sem texto nenhum.

  NÃO usar se: (1) o CEO já digitou /log-bet — o slash command tem prioridade e a skill não deve disparar em paralelo; (2) o print é de outra coisa (dashboard, estatística, draft do jogo, conversa, screenshot de código); (3) a aposta é de outro esporte que não LoL.
---

# Quando usar essa skill

Dispara quando TODAS as 3 condições batem:

1. **Imagem anexada na mensagem** (path tipicamente em `/tmp/`, `%TEMP%`, ou path explícito do CEO)
2. **Visual da imagem é de comprovante de aposta** — pistas: logo de bookmaker (EstrelaBet/Pinnacle/Parimatch/Betano), texto tipo "Aposta:", "Stake", "Odd", "Possíveis ganhos", "Bet ID", "Mais de X.5" / "Menos de X.5", "Total Kills", times de LoL (FNC, T1, GenG, JDG, etc)
3. **CEO NÃO digitou `/log-bet`** explicitamente — se digitou, deixa o slash command rodar e ignora

Em geral, se o CEO mandou só "registra" + print, ou nada + print, é caso da skill.

# Quando NÃO usar

- Print é dashboard (Vercel, Supabase, GitHub Actions, etc)
- Print é tela do jogo (draft, in-game, post-game stats)
- Print é conversa/chat/email
- Aposta NÃO é de LoL (futebol, CS, Valorant — bet-logger só lida com LoL)
- CEO já invocou `/log-bet` — não dispara em paralelo
- CEO está pedindo *análise* da aposta (ROI, "essa foi boa?") — aí é Quant Analyst, não bet-logger

Em dúvida, pergunta antes de disparar — falso positivo (registra coisa errada) é pior que perguntar.

# Procedimento

## 1. Confirma intenção em 1 linha curta

Antes de salvar, dispara mensagem rápida pro CEO:

> Identifiquei print de bet (`<bookmaker>`). Vou registrar — quer adicionar contexto (liga, observação) antes?

Se o CEO responder com contexto, passa adiante. Se não responder ou disser "manda" / "vai" / "ok", segue. Se disser "não" / "espera", aborta.

**Exceção:** se o CEO já mandou contexto na mesma mensagem ("registra essa do FNC vs T1"), pula a confirmação e segue direto.

## 2. Salva a imagem em disco

Se a imagem ainda está em path temporário, copia pra:

```
cron-data/bet-screenshots/<YYYY-MM-DD>/<bookmaker_slug>-<timestamp>.png
```

(Mesmo padrão do slash command `/log-bet`.)

Use PowerShell pra mover:
```powershell
$dest = "cron-data\bet-screenshots\$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item <origem> "$dest\<bookmaker>-<timestamp>.png"
```

## 3. Invoca o subagent `bet-logger`

Via Agent tool (`subagent_type: bet-logger`), passando:
- Path da imagem salva
- Contexto adicional do CEO (se houver)
- Instrução: "Registra essa aposta seguindo o procedimento da sua persona. Reporta resumo curto."

## 4. Repassa o resumo do subagent

Sem reescrever, sem adicionar prosa. Se houver ressalva (liga UNKNOWN, match ambíguo, extração com baixa confiança), adiciona uma linha curta perguntando como prosseguir.

# Regras invioláveis

1. **Nunca registra sem 1 confirmação rápida** (passo 1) — exceto quando CEO já mandou contexto explícito.
2. **Nunca dispara junto com `/log-bet`** — se o slash command está rodando, fica fora.
3. **Imagem ambígua → pergunta.** Se não dá pra ter certeza que é bet, pergunta antes de invocar o subagent.
4. **Falha de extração não é desculpa pra inventar dados** — repassa o erro do subagent literal e pede print mais nítido.
