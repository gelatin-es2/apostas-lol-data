# lolesports — League IDs (referência canônica)

**Fonte:** `https://esports-api.lolesports.com/persisted/gw/getLeagues?hl=en-US` (key pública, em `analyze_yesterday.cjs:11`)
**Última verificação:** 2026-05-05

## Ligas operadas pelo método

| Liga | ID | Region |
|------|-----|--------|
| **LCK** | `98767991310872058` | Korea |
| **LPL** | `98767991314006698` | China |
| **LEC** | `98767991302996019` | EMEA |
| **CBLOL** | `98767991332355509` | Brazil |
| **LCS** | `98767991299243165` | North America |

## Torneios internacionais (relevantes pro EWC)

| Torneio | ID | Region |
|---------|-----|--------|
| **MSI** | `98767991325878492` | International |
| **Worlds** | `98767975604431411` | International |
| **Worlds Qualifying Series** | `110988878756156222` | International |

## Tier 2

| Liga | ID | Region |
|------|-----|--------|
| LCK Challengers | `98767991335774713` | Korea |

## ⚠️ Bug histórico

Até **2026-05-05**, os scripts `capture_fair_lines.cjs` e `analyze_yesterday.cjs` tinham `cblol: '98767991325878492'` no mapping `LEAGUE_IDS`. Esse ID é **MSI**, não CBLOL.

**Sintoma:** quando o cron rodava com `lec,cblol`, capturava na verdade LEC + MSI. `analyze_yesterday.cjs` analisava todos os jogos de ambas as ligas e os enviava ao Supabase com `league: 'CBLOL'` (string hardcoded em `LEAGUE_IDS`).

**Confirmado pela API oficial:**
```
$ getSchedule?leagueId=98767991325878492
events: 2023-05-06 GG vs R7, PSG vs LOUD, ... → MSI 2023

$ getLeagues  
{"id":"98767991325878492","name":"MSI","region":"INTERNATIONAL","slug":"msi"}
{"id":"98767991332355509","name":"CBLOL","region":"BRAZIL","slug":"cblol-brazil"}
```

**Fix aplicado:** `98767991325878492` → `98767991332355509` em ambos scripts.

**Cleanup pendente:** entries em `method_reports` onde `league='CBLOL'` mas `game_id` na verdade é de MSI. Investigar via Supabase quando o MCP estiver configurado.
