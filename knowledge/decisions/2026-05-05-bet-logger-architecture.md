# Decisão: Arquitetura do Bet Logger (Agente #1)

**Data:** 2026-05-05
**Status:** Rabisco — pendente alinhamento com CEO antes de implementar
**Substitui:** o agente OCR Claude Code anterior (perdido junto com a config)

---

## 1. Contexto

CEO opera trading próprio em LoL com método "2-peel Under" + "1peel+flex". Apostas reais ficam em `bets` (Supabase). O fluxo histórico era:

1. CEO bate aposta em casa de aposta → tira print
2. Manda print no chat → agente Claude Code anterior fazia OCR → salvava em `bets` com status `pending`
3. Próxima mensagem do CEO → agente verificava bets `pending`, buscava resultado via lolesports API, atualizava

Esse agente foi perdido. **Sem ele, registro de bets vira manual e a operação perde rastreabilidade.** Recriar é P0.

## 2. Fluxo geral em 2 etapas

```
ETAPA 1 — PLACEMENT (síncrona, no momento do print)
─────────────────────────────────────────────────────
[CEO] manda print no chat
   ↓
[Bet Logger] identifica bookmaker (EstrelaBet | Pinnacle | Parimatch | Betano)
   ↓
[Bet Logger] extrai campos mínimos via Claude vision
   ↓
[Bet Logger] busca match no lolesports schedule (teams + data próxima)
   ↓
[Bet Logger] grava em bets com status='pending'
   ↓
[Bet Logger] reporta: "registrado: <bookmaker> <pick> R$<stake> @ <odd>"


ETAPA 2 — SETTLE (assíncrona, gatilhada por hook ou comando)
─────────────────────────────────────────────────────────────
Toda mensagem do CEO → hook UserPromptSubmit dispara verificação
   ↓
[Bet Logger] SELECT * FROM bets WHERE status='pending'
   ↓
Para cada pending:
   ├─ busca livestats lolesports (gameMetadata + último frame)
   ├─ se gameState != 'finished' → continua pending
   ├─ se finished:
   │   ├─ extrai kills total, comp completa (5 champs × 2 times), winner
   │   ├─ detecta trigger (2peel | 1peel+flex | none) usando PEEL_PURE/FLEX_ENGAGE
   │   ├─ calcula under_hit (kills < linha do pick)
   │   └─ UPDATE bets SET status, profit, settled_at, settle_source, raw_extraction.match_context
   ↓
[Bet Logger] reporta consolidado se houve atualização: "X bets settled, Y green, Z red"
```

## 3. Schema de campos extraídos por bookmaker

Decisão CEO (2026-05-05): **bet_datetime sempre = horário do jogo no schedule** (não do print). Cashout, live score, tabs de estado — não precisa capturar.

| Campo | EstrelaBet | Pinnacle | Parimatch | Betano | Notas |
|-------|------------|----------|-----------|--------|-------|
| `bookmaker` | logo "EstrelaBet" rodapé | identifica por design (azul) | identifica por design | identifica por design | Claude vision detecta |
| `team_a`, `team_b` | "Fnatic 1:2 Team Vitality" | "Gen.G - Nongshim Redforce" | "Karmine Corp" + adversário | "X - Y" | mesma extração visual |
| `market` | "Total Kills" | "Money Line - Match - LCK" | "Vencedor" | "Resultado Final" | só Total Kills entra no método; outros mercados ainda registrados pra histórico |
| `pick` | "Menos de 27.5" | "Gen.G" / "Under 27.5" | "Karmine Corp" / "Total Menos 27.5" | nome do time / "Total - Menos X.5" | string literal preservada |
| `odd` | topo direito | card body laranja | "2.22" | "1.42" | número decimal |
| `stake` | "R$600.00" (ponto) | "BRL 1.00" | "1.00 BRL" | "R$8,00" (vírgula!) | normalizar pra decimal |
| `is_map_bet` | true se "Mapa" no card | "Match" = false | varia | varia | infere de string |
| `map_number` | "Segundo Mapa" → 2 | "Map X" se houver | varia | varia | inteiro |
| `bet_id_bookmaker` | "ID: 4911527990" | "#3040996209" | "Nº205" | não visto no exemplo | string, vai pra `raw_extraction` |

**Liga** (`league`): só Pinnacle mostra direto. Pra outros, infere via lolesports schedule no momento do settle.

## 4. APIs externas usadas

Reaproveita as keys e endpoints já em uso por `capture_fair_lines.cjs` / `analyze_yesterday.cjs`:

| Endpoint | Uso no Bet Logger |
|----------|-------------------|
| `esports-api.lolesports.com/persisted/gw/getSchedule?leagueId=X` | Etapa 1: linkar print → match. Itera ligas operadas (LCK, LPL, LEC, CBLOL, EWC) buscando match com teams próximos da data |
| `esports-api.lolesports.com/persisted/gw/getEventDetails?id=X` | Etapa 2: pegar lista de games da match, identificar mapa específico |
| `feed.lolesports.com/livestats/v1/window/{gameId}?startingTime=X` | Etapa 2: kills total, comp completa, winnerSide |

Key pública: `0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z` (em `analyze_yesterday.cjs:11`).

**EWC EMEA** ainda **não** está no `LEAGUE_IDS` — precisa adicionar (commit separado, ver `knowledge/references/lolesports-league-ids.md`).

## 5. Estrutura `raw_extraction.match_context`

Já que `raw_extraction` é JSONB no schema da `bets`, não criar colunas novas — empilhar dentro:

```json
{
  "bookmaker_native": {
    "bet_id": "4911527990",
    "raw_pick_text": "Menos de 27.5",
    "raw_stake_text": "R$600,00"
  },
  "match_context": {
    "lolesports_match_id": "...",
    "lolesports_game_id": "...",
    "league_full_name": "LEC 2026 Spring Season",
    "league_short": "LEC",
    "blue_team_code": "FNC",
    "red_team_code": "VIT",
    "blue_picks": {
      "top": "...", "jungle": "...", "mid": "...", "adc": "...", "support": "Milio"
    },
    "red_picks": {
      "top": "...", "jungle": "...", "mid": "...", "adc": "...", "support": "Lulu"
    },
    "trigger_type": "2peel",
    "fair_line": 29.5,
    "fair_source": "default_29.5",
    "winner_side": "red",
    "extracted_at": "2026-05-05T12:00:00Z"
  }
}
```

Permite query SQL com JSONB operators sem quebrar o schema atual.

## 6. Detecção de trigger

Reusa as constantes já definidas (não duplicar):

- `PEEL_PURE` em `analyze_yesterday.cjs:20`
- `FLEX_ENGAGE` em `analyze_yesterday.cjs:21`
- Lógica em `analyze_yesterday.cjs:201-205`

**Decisão técnica:** o Bet Logger NÃO inline essas listas. Importa do arquivo (Node `require` direto) ou faz query a uma constante exportada. Se PEEL_PURE mudar, a detecção do agente continua coerente com o backtest.

## 7. Implementação proposta

Dividida em 4 componentes do Claude Code:

### a) Subagent `bet-logger`
- Localização: `.claude/agents/bet-logger.md` (versionado no repo)
- Tools restritas: `Read`, `Write`, `Bash` (pra `node -e` chamando lolesports), Supabase REST via `Bash`/PowerShell
- Persona: "extrator de dados de apostas esportivas com OCR vision"
- Modelo: sonnet 4.6 (suficiente; opus seria desperdício)

### b) Skill `bet-logger-extract`
- Localização: `.claude/skills/bet-logger-extract.md`
- Trigger: quando contexto da mensagem tem imagem de aposta (regex no texto + presença de imagem)
- Procedimento: invoca subagent `bet-logger` com prompt fixo

### c) Slash command `/log-bet`
- Localização: `.claude/commands/log-bet.md`
- Invocação manual: `/log-bet` (com imagem anexada)
- Útil quando skill não disparou ou quando re-rodar registro

### d) Hook `UserPromptSubmit` — settle
- Script Node em `.claude/hooks/check-pending-bets.cjs`
- Roda a cada prompt do CEO
- Se houver bets `pending`: query lolesports → atualiza Supabase → printa resumo em stdout
- Output limitado a 1KB pra não inflar contexto

## 8. Pendências e perguntas em aberto

| # | Item | Status |
|---|------|--------|
| 1 | ~~Singles vs combinadas/duplas~~ | ✅ **Resolvido (CEO 2026-05-05): singles only, nunca combinadas. Schema atual basta.** |
| 2 | EWC EMEA não mapeada nos `LEAGUE_IDS` — 25% do volume real fora de cobertura | Pendente — commit separado, urgente |
| 3 | `screenshot_path` — onde salvar a imagem original? Local? Supabase Storage? | Pendente — propor `cron-data/bet-screenshots/` no `.gitignore` |
| 4 | Mapping team_short_code → team_full_name — usar o `TEAM_CODE_TO_ORACLE` já existente | Baixo — refator quando tocar |
| 5 | Como identificar o mapa exato dentro da série quando o print não tem map_number explícito? | Baixo — registrar como bet de match (não-map) |
| 6 | Hook UserPromptSubmit: e se rodar antes do jogo terminar? | Baixo — script já checa `gameState='finished'` antes de atualizar |

## 9. Próximos passos

1. ~~Confirmar singles vs combinadas~~ ✅ Resolvido (singles only)
2. **CEO confirma:** OK em salvar screenshots em `cron-data/bet-screenshots/` (no `.gitignore`)?
3. **Commit separado:** adicionar EWC EMEA ao `LEAGUE_IDS` em `capture_fair_lines.cjs` + `analyze_yesterday.cjs` + `rebuild_dashboard_stats_cron.cjs`
4. **Implementar componentes** na ordem:
   - (i) script Node standalone que recebe imagem por path + chama OCR + grava no Supabase — testar manualmente
   - (ii) embrulha em subagent + slash command
   - (iii) skill pra autodisparo
   - (iv) hook UserPromptSubmit pra settle
5. **Teste end-to-end:** registrar 1 bet real, esperar jogo, verificar settle automático.

---

## Resumo executivo

Recriar o agente OCR perdido como **Bet Logger** = subagent + skill + slash command + hook. Fluxo simplificado em 2 etapas (placement + settle). Reusa código existente (PEEL_PURE, FLEX_ENGAGE, lolesports endpoints). Não mexe no schema da `bets` — info nova vai em `raw_extraction.match_context` (JSONB). Pendências críticas pra confirmar antes: **combinadas sim/não** e **storage de screenshots**.
