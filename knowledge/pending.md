# Pendências — atualizada 2026-05-22 fim da sessão

## 🟢 Auditoria fair_line — 2026-05-23 (SIMULATED 100% OK)

**Relatório completo:** `knowledge/audits/fair-line-audit-2026-05-23.md`

Banco está consistente com método atual: 269/269 SIMULATED batem **exato** (diff 0.000 kills) com `cron-data/dashboard_stats.json` + `cron-data/tier2_lfl_les_stats.json`. NÃO regenerar. Fórmula vigente é `(blueAvgTotal+redAvgTotal)/2` round `.5`, **FAIR_ADJUSTMENT=0** (sem `-1`). Reintrodução do `-1` foi confirmada como removida em `9ef5f40` (2026-05-17), SIMULATED criadas em 22/05 já estão com método novo.

### Bugs/dívida descobertos na auditoria (atacar próxima sessão)

- **E1 (CRÍTICO):** `analyze_tier2_eu.cjs:26` usa `LINE = 29.5` FIXA. Este script **ROTA NO CRON DIÁRIO** (workflow `daily-cron.yml`). Não afeta SIMULATED no banco (não persiste bets), mas o JSON `tier2_eu_split2_analysis.json` está com fair velha. Trocar pela fórmula dinâmica de `rebuild_dashboard_stats_cron.cjs:280-315`.
- **E2 (DÍVIDA):** `rebuild_tier2_dashboard_stats.cjs:153-165` e `rebuild_lfl_dashboard_stats.cjs:137-146` ainda com fórmula VELHA (`a+b-1` own-side). NÃO rodam no cron, mas se alguém rodar manualmente vai poluir. Deletar ou migrar.
- **E3 (DOCS):** `knowledge/decisions/2026-05-06-fair-line-livestats-team-avg.md` ainda marcada "Vigente" mas descreve fórmula velha. Marcar como "Substituída" + nova decision doc da fórmula atual.
- **E4 (RISCO):** `enrich-match-context.cjs` já apagou 217/224 `fair_line_calculated` em 2026-05-22; commit `2777353` adicionou skip de SIMULATED. Guard é uma linha só. Adicionar assertion defensiva antes do PATCH no Supabase.

---

## 🔴 Bugs auditados — validados pelo CEO + Claude (atacar próxima sessão)

### Bug 1: Over bets invertidas na simulação adaptável (ALTA)
**Onde:** `dashboard/index.html`
- Linha 1488 (`getBetSimulation` aba Banco de dados)
- Linha 1642 (`getBetSim` aba Milio)

**Impacto confirmado:** 3 bets reais Over entram com hit/profit invertidos na simulação:
- `fe572a59` Over 27.5, kills 19, status REAL=red → dashboard simula GREEN
- `1eedfc2b` Over 28.5, kills 44, status REAL=green → dashboard simula RED
- `ccb645d9` Mais de 27.5, kills 32, status REAL=green → dashboard simula RED
- 2 outras (`68fb59b1`, `244bdf2a`) têm `kills=null`, ficam fora silenciosamente

**Fix:**
```js
// em getBetSimulation e getBetSim
const isOver = /over|mais de/i.test(b.pick || '');
const won = isOver ? (kills > simLine) : (kills < simLine);
```

### Bug 2: Ladder amplification no Milio (BAIXA - magnitude menor que reportada)
**Validado:** 60 bets reais Milio em 29 games únicos. Hit por bet 75.0% vs hit por game 75.9% (diff só 0.9pp, agente exagerou para 2pp).

**Fix sugerido:** adicionar contador "games únicos" no header da aba Milio + toggle "1 bet/game" opcional.

### Bug 3: 7 gameIds órfãos no `missed_opportunities.list` (MÉDIA)
**Onde:** `rebuild_dashboard_stats_cron.cjs:415` (`userBets.get(String(g.gameId))`)

**Impacto:** games com bet real ainda aparecem na lista de "missed". Lista dos 7:
- `115615926677896669` NIP vs JDG (LPL 29/04)
- `115548128962840657` T1 vs NRF (LCK 29/04)
- `115615926677896673` JDG vs WE (LPL 02/05)
- `115548668059589341` KC vs Fnatic (LEC 26/04)
- `115615926677896668` JDG vs NIP (LPL 29/04)
- `115615926677896636` BLG vs WE (LPL 29/04)
- `115548668059523677` NaVi vs Shifters (LEC 26/04)

**Causa raiz:** cron busca games via getEventDetails (returna game IDs), bet real tem `lolesports_game_id` salvo de outro endpoint que pode diferir.

**Fix:** adicionar lookup secundário no cron por `matchId|map_number` (já está na linha 282-283 mas pode estar falhando).

### Bug 4: `normTeamName` cache bug — display feio (BAIXA, só estética)
**Onde:** `dashboard/index.html` linhas 1561-1578

**Bug:** linha 1567 `return early` SEMPRE retorna primeiro nome encontrado. Comparação `_score` nas linhas 1573-1576 nunca executa após 1ª gravação. Agregação correta, display feio.

**10 casos visíveis** com display ALL CAPS em vez de Title Case:
- BNK FEARX (vez de BNK FearX), TOP ESPORTS (Top Esports), WeiboGaming (Weibo Gaming), BILIBILI GAMING (Bilibili Gaming), NONGSHIM RED FORCE (Nongshim RedForce), EDWARD GAMING (EDward Gaming), LGD GAMING (LGD Gaming), THUNDER TALK GAMING (ThunderTalk Gaming), kt Rolster (KT Rolster), Galions (GALIONS)

**Fix:**
```js
const teamScoreCache = {}; // cache separado pro score
function normTeamName(name) {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (/[a-z]/.test(name) && /[A-Z]/.test(name)) ? 3 : (/[a-z]/.test(name) ? 2 : 1);
  if (!teamNormCache[key] || teamScoreCache[key] < score) {
    teamNormCache[key] = name;
    teamScoreCache[key] = score;
  }
  return teamNormCache[key];
}
```

### Bug 5: Aba Milio NÃO normaliza team names (MÉDIA)
**Onde:** `dashboard/index.html` linha 1687

**Bug confirmado:** `renderMilioTab` usa `b.team_a, b.team_b` direto. Diferente da aba Banco de dados (linha 1583) que aplica `normTeamName`. Resultado: 10 pares duplicados na aba Milio.

**Fix:** elevar `normTeamName` pra escopo módulo + usar na linha 1687.

---

## 🟢 Pendências menores antigas

1. **1 bet com `league = null bookmaker = null`**: id `1642cfa9` (cashout solto 29/04 -R$80 sem detalhes). Vai sujar GROUP BY league. Considerar deletar ou setar campos.
2. ~~**35 bets EWC sem `total_kills`**~~ — descartado 2026-05-23: Elvis não opera EWC, sem simulação nem backfill
3. **15 bets "CBLOL Split 1 finals"** (datas 25-26/04, já renomeadas pra "CBLOL") — decisão: manter ou deletar
4. ~~**Memória `project_stake_por_gatilho` desatualizada**~~ — ✅ resolvida 2026-05-23 (tier Premium R$2k adicionado + critérios + blacklist consolidada)
5. **Backfill Top 5 campos extras** nas bets antigas (`game_duration_secs`, `first_blood_team`, `kills_at_15min`, `dragons/barons`, `bans`, `series_score_at_bet`) — settle novo já preenche, mas pré-22/05 não tem
6. **Alerta automático de meta shift** — se hit de alguma liga cair <55% no dashboard, notificar via hook
7. **IC95 nas estatísticas do dashboard** — Wilson score interval em `aggBy` pra cortar conclusões ruidosas (n<15)
8. **Heurística `odd < 1.72`** no `getBetSimulation` — 14 bets na fronteira [1.72, 1.73] não recebem ajuste, criando viés artificial
9. **Champion filter case-sensitive** — "K'Sante" vs "KSante", "Renata" vs "RenataGlasc" — não normaliza
10. **Listeners double-fire** linhas 1610-1611 — registra `change` E `input`, renderiza 2x por alteração
11. **Race condition `loadAnaliseTab`** — chamado 2x sem await (linha 1614 + 1705), duplica query Supabase
12. **Sem refresh automático** nas abas Análise/Milio — F5 obrigatório pra ver bet nova
13. **Stake default Milio R$2k** acima do Half-Kelly real (R$1.455 com banca R$8.770)
14. **Aba Milio falta filtros** de liga/trigger/champion (inconsistente com aba Banco de dados)
15. **`normalizeLeague` não cobre `LES`** — passa literal

---

## ✅ Saúde confirmada (não tocar)

- Dedup real × SIMULATED: 0 overlap
- SIMULATED com `fair_line_calculated`: 269/269
- Trigger validation: 0 inconsistências em 137 bets
- Tier 2 LFL/LES JSON × banco: 100% match
- Settle real vs simulação Milio: 8/8 batem
- Filtro Milio: 100% (sem variantes de nome)

---

## 📝 Estado do projeto fim 2026-05-22

**Bets no banco:**
- Reais Split 2: 201 (156 tier 1 com kills, 45 EWC sem kills)
- SIMULATED: 269 (217 tier 1 + 52 tier 2 LFL/LES)
- Total settled: 470

**Dashboard tabs:**
1. **Tracker** (PnL real, filtra `bookmaker != SIMULATED`)
2. **Banco de dados (Split 2)** — interativo: Δ/odd/stake/trigger/liga/champ
3. **Método Milio** — interativo: Δ/odd/stake (sem filtros de liga/trigger ainda)
4. **Split 1 + First Stand** — interativo: Δ/odd/stake/trigger/liga/champ

**Memórias salvas na sessão:**
- `project_milio_outlier` — Milio outlier consistente
- `feedback_filtros_aumentam_roi` — filtros agressivos sobem ROI mesmo no normal
- `feedback_sempre_verificar_datas` (atualizada) — incluído incidente 2026-05-20

**Commits importantes:**
- `02a5894` feat: Análise tab + 291 SIMULATED
- `421d6e2` odd 1.72 conservadora
- `343e44c` Método Milio + Neeko filter
- `664c94e` Split 1 + First Stand
- `fccfbda` fix dedup defensiva SIMULATED
- `026d83a` tier 2 LFL/LES SIMULATED (52)
- `fa20145` filtros trigger/liga/champ

---

## 🎯 Ordem sugerida pra próxima sessão

1. **Bug 1 Over invertido** (5min)
2. **Bug 5 Milio sem normTeamName** + **Bug 4 cache bug** (10min combinados)
3. **Bug 3 7 órfãos** (15min — investigar lookup secundário no cron)
4. **Pendência 4 — atualizar `project_stake_por_gatilho`** (5min)
5. **Pendência 1 — fixar/deletar bet `1642cfa9`** (2min)
6. **Bug 2 ladder counter no header Milio** (5min, cosmético)

Resto das pendências em backlog.
