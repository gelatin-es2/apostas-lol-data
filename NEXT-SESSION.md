# Próxima sessão — ponto de retomada

> Atualizado em: 2026-05-05 ao final da sessão de bootstrap do COO
> Esse arquivo é a "tela de boas-vindas" da próxima sessão. Mantém atualizado ao final de cada rodada.

---

## 🚨 Antes de qualquer coisa — pendência de segurança

**ROTACIONAR a `service_role key` do Supabase.** Vazou 2x no chat na sessão anterior. Passos:

1. Supabase Dashboard → `https://supabase.com/dashboard/project/yxhpopkxlupdpqkdaffg/settings/api` → Reset/regenerar a JWT `service_role`
2. Atualizar em 3 lugares:
   - GitHub → `https://github.com/gelatin-es2/apostas-lol-data/settings/secrets/actions` → secret `SUPABASE_SECRET_KEY`
   - Vercel (dashboard `apostas-lol-dashboard`) → env vars
   - Local: `.claude/settings.local.json`
3. Validar: `gh workflow run daily-cron.yml` (Actions pegando) + `node .claude/scripts/settle-pending-bets.cjs --dry-run` (local pegando)

---

## Estado da operação (snapshot 2026-05-05)

99 bets reais (período 2026-04-25 a 2026-05-02, 8 dias). Performance:

| Subset | N | Hit | Profit | ROI |
|--------|---|-----|--------|-----|
| 2peel | 32 | 84,4% | +R$ 4.336 | **+32,2%** ← edge real |
| 1peel+flex | 16 | 43,8% | -R$ 2.212 | **-24,6%** ← investigar |
| none (fora método) | 9 | 44,4% | +R$ 338 | +10,2% |
| EWC (sem trigger) | 25 | 68% | +R$ 1.471 | +14,9% |
| **TOTAL** | 99 | 60,8% | **+R$ 521** | **+1,3%** |

**Por liga:** LEC +49% | LCK +35% | LPL +26% | **CBLOL -66%** ← desastre

Detalhes: [`knowledge/lessons/2026-05-05-real-vs-backtest-trigger-performance.md`](knowledge/lessons/2026-05-05-real-vs-backtest-trigger-performance.md)

---

## Top 5 próximos passos (priorizado)

### 1. Quant Analyst (P0)
Subagent + slash commands `/analyze 2peel`, `/analyze cblol`, `/analyze 1peel-flex --by flex_engage` etc. Pra cavar de onde vem o sangramento de CBLOL e 1peel+flex sob demanda. Reusa scripts existentes em `.claude/scripts/`.

### 2. Hook UserPromptSubmit pra auto-settle (P1)
Toda mensagem do CEO → script `settle-pending-bets.cjs` roda em background → atualiza bets `pending` automaticamente sem precisar de `/settle`. Configurar em `.claude/settings.json` (versionado).

### 3. Skill `bet-logger-extract` pra autodisparo (P1)
Quando CEO mandar print no chat sem `/log-bet`, skill detecta contexto e dispara o subagent `bet-logger`. Define em `.claude/skills/bet-logger-extract.md`.

### 4. Re-rodar enrich nos 16 skipped (P2)
Bets de 29/04 (Nongshim-T1, NIP-JDG) deram `game_window_in_game`. Ajustar janela temporal no `enrich-match-context.cjs` ou tentar com `startingTime` mais distante. Comando: `node .claude/scripts/enrich-match-context.cjs` (já tem filtro `match_context.lolesports_match_id IS NULL`, vai pegar só esses 16).

### 5. Money Line settle (P3)
Atualmente `decideOutcome` retorna `skip_reason: 'moneyline_settle_not_implemented_yet'`. Implementar lookup do team_pick contra `winner_side` capturado.

---

## Componentes do sistema (status atual)

### Bet Logger
| Componente | Status | Path |
|-----------|--------|------|
| Subagent | ✅ | `.claude/agents/bet-logger.md` |
| Slash command | ✅ | `.claude/commands/log-bet.md` |
| Helper config | ✅ | `.claude/scripts/_load-config.cjs` |
| Find match | ✅ testado | `.claude/scripts/lolesports-find-match.cjs` |
| Save bet | ✅ testado em prod | `.claude/scripts/supabase-save-bet.cjs` |
| Settle | ✅ testado em prod | `.claude/scripts/settle-pending-bets.cjs` |
| Enrich retroativo | ✅ rodou em 99 bets | `.claude/scripts/enrich-match-context.cjs` |
| Hook auto-settle | ❌ próximo |
| Skill autodisparo | ❌ próximo |
| Money Line settle | ❌ stubbed |

### Sistema de produção (`*.cjs` na raiz)
| Componente | Status |
|-----------|--------|
| `capture_fair_lines.cjs` | ✅ rodando em GitHub Actions, CBLOL ID corrigido |
| `analyze_yesterday.cjs` | ✅ rodando, CBLOL ID corrigido |
| `save_report_to_db.cjs` | ✅ rodando |
| `rebuild_dashboard_stats_cron.cjs` | ✅ rodando, agora produz `by_trigger` (2peel + 1peel+flex + all) |
| Workflow `.github/workflows/daily-cron.yml` | ✅ idempotente, 06:30 + 14:00 UTC |

### Dashboard (Vercel)
- URL: `https://apostas-lol-dashboard.vercel.app/`
- **Pendente:** atualizar frontend pra ler novo formato `dashboard_stats.json.by_trigger` (3 colunas: 2peel | 1peel+flex | all). Hoje frontend lê só top-level (= 2peel).

---

## Como começar a próxima sessão

**Modo fácil (1 clique):**
1. Vai em `C:\Users\Elvis\projects\apostas-lol-data\` no Explorer
2. **Duplo-clique em `start-session.cmd`** — ele faz git pull, mostra status + próximos passos, abre o VS Code
3. Dentro do VS Code, abre Claude Code (Ctrl+Esc ou ícone na sidebar)
4. Digita `/resume` — eu (Claude) leio esse arquivo + git log + reporto estado
5. Confirma a direção e a gente segue

**Modo manual (se preferir):**
1. Abre o VS Code direto na pasta `C:\Users\Elvis\projects\apostas-lol-data`
2. Abre Claude Code, digita `/resume`

---

## Memórias persistentes carregadas automaticamente

Ao abrir Claude Code, o índice em `C:\Users\Elvis\.claude\projects\C--Users-Elvis\memory\MEMORY.md` é lido. Inclui: perfil CEO, papel COO, anti-perda, permissões nativas, e projeto LoL com esse snapshot.

Doutrina operacional completa em `~/.claude/docs/setup-guide.md` (consulta antes de criar config nova).
