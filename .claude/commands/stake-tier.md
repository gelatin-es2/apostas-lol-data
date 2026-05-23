---
description: Classifica o stake tier recomendado pra uma bet baseado em Milio × times verdes × linha vs fair. Output curto com tier, stake e justificativa.
argument-hint: [descrição do setup ou dados do print]
allowed-tools: Read, Bash
---

Você vai recomendar o stake tier ótimo pra uma bet com base na matriz canônica em [[stake-tier-playbook-2026-05-23]] (memória global).

## Argumentos

`$ARGUMENTS`

Pode ser:
- Descrição livre do setup: `"WE vs LNG, milio no LNG, WE verde 90%, linha 27.5 fair 28.5"`
- Dados extraídos de print que o CEO mandou junto
- Match identifier (ex: `"DK vs BNK map 1"`) — você lookup no banco

## Passos

### 1. Identificar Milio
Procura "milio" no draft do match (blue_picks.support ou red_picks.support). Se NÃO tem Milio, marca `milio: false`. Se TEM, qual lado (blue/red/qualquer).

### 2. Identificar status dos times
Pra cada um dos 2 times, consulta hit rate histórico:
- Arquivo `cron-data/dashboard_stats.json` → `missed_opportunities.list` → calcular hit por time
- OU consultar Supabase `bets` table → hit por time real (preferido se sample > 10)
- Classificar cada time:
  - **≥75%** = "verde forte"
  - **60-74%** = "verde fraco"
  - **50-59%** = "neutro"
  - **<50%** = "vermelho" → **SKIP automático, não recomendar stake**

### 3. Identificar linha vs fair Pinnacle
- Lê `cron-data/YYYY-MM-DD-fair-pinnacle.json` do dia da bet
- Acha fair pelo match_id ou team anchor
- Calcula diff: `linha_bet - fair_pinnacle`
  - `0` (ou positivo) → "linha fair"
  - `-1` → "linha -1"
  - `-2` → "linha -2"
  - `≤ -3` → SKIP

### 4. Cruzar com matriz canônica

| Setup Milio + (filtro time) | Linha fair | Linha -1 | Linha -2 |
|---|---|---|---|
| Milio sozinho (sem filtro) | 3k | 3k | 2k |
| Milio + 1 verde ≥60% | 3k | 3k | 2k |
| Milio + 2 verdes ≥60% | 4k | 4k | 3k |
| Milio + 1 verde ≥75% | 4k | 4k | 3k |
| **Milio + 2 verdes ≥75%** | **4k** | **4k** | **4k** |
| Sem Milio + 2 verdes ≥75% | 2k | 1k | SKIP |
| Sem Milio + outros | 1k | SKIP | SKIP |
| **Time vermelho qualquer** | **SKIP** | **SKIP** | **SKIP** |

### 5. Output

Formato compacto:

```
🎯 STAKE TIER: <X>k

Setup: <Milio sim/não> + <times: WE verde 90%, LNG neutro 55%>
Linha: <27.5 (fair 28.5 = -1 abaixo)>
Filtro aplicado: <Milio + 1 verde ≥75%>

EV histórico desse setup (n=<X>):
- Hit obs: <X%>
- ROI real: <+X%>
- Pior caso 95% CI: <+X%>

Confirmação: stake total = <X>k = exposição no match (dividir em N bets pelas casas).
```

## Regras importantes

- **NÃO incluir tilt-stop** no output. CEO removeu (decisão 2026-05-23).
- **Time vermelho qualquer = SKIP imediato.** Não recomenda stake mesmo com Milio.
- **Sample pequeno (n<10) = adicionar warning** "⚠️ sample baixo, variância alta"
- **Stake é total do match**, não bet individual. Dividir em N bets é problema das casas com limite.
- **Linha pega ≥ fair** = aplica regra "linha fair" (não há "bonus" por pegar acima da fair)
- **Sem Milio + sem time verde forte** = stake mínimo (1k) ou SKIP
- **Se conseguir resolver match_id via lolesports-find-match.cjs, usa pra puxar dados específicos do banco. Senão, opera com hit histórico genérico do time.**

## Caveat de execução

Se `cron-data/YYYY-MM-DD-fair-pinnacle.json` não existe pro dia da bet, AVISA o CEO: "fair Pinnacle não logada hoje, manda primeiro via /log-fair antes de eu recomendar stake". Não chuta.
