// scripts/analysis/counterfactual-flags.cjs
//
// Contrafactual completo: "quanto fiz seguindo minha lógica de flags vs quanto teria
// feito apostando em TODO jogo do método" — pedido do dono, máximo detalhe.
//
// *** ACHADO PRÉ-REQUISITO (documentado, não escondido) ***
// audit-cache/schedule-{leagueId}-p0.json (a página MAIS RECENTE do schedule) fica em
// cache indefinidamente — correto pra jogos completed antigos (imutáveis), mas ERRADO
// pra "página mais nova", que muda conforme mais jogos terminam. As 6 ligas operadas
// tinham page-0 cacheada de 2026-07-20; bets reais existiam (LFL) pra jogos de
// 2026-07-21 que não apareciam no universo coletado antes. Documentado no header, os
// arquivos de cache page-0 foram apagados e recoletados (`00-universe-6leagues-window.
// json`, via phase0-universe.cjs --from=2026-04-25 --to=2026-07-22) especificamente
// pra esta análise, cobrindo o período pedido sem esse gap. Ver notes.cache_staleness
// no output.
//
// POPULAÇÃO: jogos com trigger peel (2peel/1peel+flex) nas 6 ligas operadas, 2026-04-25
// (1ª bet real) → 2026-07-21 (fim do dataset all-regions). EWC fica FORA da simulação
// (kills não confiáveis fora da Riot API) — bets reais de EWC entram só no cenário REAL,
// reportadas à parte.
//
// FLAG (walk-forward, sem leakage) — MESMA técnica de over-red-teams.cjs (script 15) /
// under-by-team.cjs (script 16): under-rate trailing do time (kills<fair nos jogos
// ANTERIORES, TODOS os jogos não só trigger) — VERDE≥60% (n≥5), VERMELHO<50% (n≥5),
// NEUTRO=resto (50-60%), SEM_AMOSTRA=n<5. Não achei um script "red_team_real_bets" no
// repo (busquei) — segui a técnica descrita explicitamente aqui, documentando a
// diferença caso o dono tenha uma referência externa não versionada.
//
// 5 CENÁRIOS por jogo com trigger — pra jogos que ele apostou de verdade, SEMPRE usa o
// resultado real (linha/odd/profit reais), em TODOS os cenários; só simula (fair+1 ou
// fair @ 1.72, stake flat 1000) os jogos que ele NÃO apostou.
//
// Uso: node scripts/analysis/counterfactual-flags.cjs
// Output: audit-output/22-counterfactual.json +
//         knowledge/reports/2026-07-23-contrafactual-flags.md

'use strict';

const fs = require('fs');
const path = require('path');

const { LEAGUE_IDS, loadAllBets, parsePick } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '22-counterfactual.json');
const REPORT_MD_FILE = path.join(ROOT, 'knowledge', 'reports', '2026-07-23-contrafactual-flags.md');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-6leagues-window.json');

const WINDOW_FROM = '2026-04-25';
const WINDOW_TO = '2026-07-22'; // exclusivo — cobre até 07-21 inclusive

const UNDER_ODD = 1.72;
const UNDER_BE = 58.1;
const STAKE_SIM = 1000;
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // fair leave-one-out por liga (n<5 -> média da liga)
const TRAIL_MIN_N = 5; // flag walk-forward
const RED_THRESHOLD = 0.5;
const GREEN_THRESHOLD = 0.6;
const TOP_N_LISTS = 15;

const SIX_LEAGUES = new Set(['LCK', 'LPL', 'LEC', 'CBLOL', 'LFL', 'LCS']);

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function fmt2(n) {
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}
function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: fmt1(100 * Math.max(0, center - margin)), upper: fmt1(100 * Math.min(1, center + margin)) };
}

// ============================================================================
// 1. Carrega universo (6 ligas, período dedicado — ver header) + monta fair
//    leave-one-out por liga (sobre TODOS os jogos, não só trigger).
// ============================================================================
const universeRaw = loadJson(UNIVERSE_FILE);
const allGames = universeRaw.filter((g) => !g.suspect && g.total_kills != null);

function buildFairPerLeague(games) {
  const byLeague = new Map();
  for (const g of games) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map();
  const teamHistByLeague = new Map(); // exposto pra usar no fallback de bets órfãs
  for (const [key, gms] of byLeague) {
    const teamHist = new Map();
    for (const g of gms) {
      for (const raw of [g.team_blue, g.team_red]) {
        const t = normalizeTeam(raw);
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
      }
    }
    const leagueAvgTotal = gms.reduce((a, g) => a + g.total_kills, 0) / gms.length;
    teamHistByLeague.set(key, { teamHist, leagueAvgTotal });
    for (const g of gms) {
      const avgFor = (team) => {
        const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvgTotal;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(normalizeTeam(g.team_blue)) + avgFor(normalizeTeam(g.team_red))) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return { fairMap, teamHistByLeague };
}
const { fairMap, teamHistByLeague } = buildFairPerLeague(allGames);

const allRows = allGames.map((g) => ({
  game_id: g.game_id,
  league: g.league,
  league_id: String(g.league_id),
  date: g.date,
  team_blue: normalizeTeam(g.team_blue),
  team_red: normalizeTeam(g.team_red),
  total_kills: g.total_kills,
  trigger_type: g.trigger_type,
  fair: fairMap.get(g.game_id),
  under_hit_at_fair: g.total_kills < fairMap.get(g.game_id), // pra construir a flag
}));

// ============================================================================
// 2. Flag walk-forward (VERDE/VERMELHO/NEUTRO/SEM_AMOSTRA) — sync: over-red-
//    teams.cjs / under-by-team.cjs, mesma técnica, agora com 4º estado explícito
//    SEM_AMOSTRA (n<5) separado de NEUTRO (n≥5, rate 50-60%).
// ============================================================================
const chrono = [...allRows].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.game_id).localeCompare(String(b.game_id)));
const trailRecord = new Map(); // team -> {n, underCount}
function clsOfTeam(team) {
  const rec = trailRecord.get(team);
  if (!rec || rec.n < TRAIL_MIN_N) return 'SEM_AMOSTRA';
  const rate = rec.underCount / rec.n;
  if (rate < RED_THRESHOLD) return 'VERMELHO';
  if (rate >= GREEN_THRESHOLD) return 'VERDE';
  return 'NEUTRO';
}
const clsMap = new Map(); // game_id -> {clsBlue, clsRed}
for (const g of chrono) {
  clsMap.set(g.game_id, { clsBlue: clsOfTeam(g.team_blue), clsRed: clsOfTeam(g.team_red) });
  for (const team of [g.team_blue, g.team_red]) {
    if (!trailRecord.has(team)) trailRecord.set(team, { n: 0, underCount: 0 });
    const rec = trailRecord.get(team);
    rec.n++;
    if (g.under_hit_at_fair) rec.underCount++;
  }
}
// Função auxiliar pra classificar um time numa data arbitrária (usada só pros 3
// jogos "órfãos" — bets reais sem game correspondente no universo coletado).
function clsOfTeamAsOfDate(team, asOfDateISO) {
  const priorGames = chrono.filter((g) => (g.date || '') < asOfDateISO && (g.team_blue === team || g.team_red === team));
  const n = priorGames.length;
  if (n < TRAIL_MIN_N) return 'SEM_AMOSTRA';
  const underCount = priorGames.filter((g) => g.under_hit_at_fair).length;
  const rate = underCount / n;
  if (rate < RED_THRESHOLD) return 'VERMELHO';
  if (rate >= GREEN_THRESHOLD) return 'VERDE';
  return 'NEUTRO';
}

const CLS_RANK = { VERDE: 0, NEUTRO: 1, VERMELHO: 2, SEM_AMOSTRA: 3 };
function comboOf(clsBlue, clsRed) {
  if (clsBlue === 'SEM_AMOSTRA' || clsRed === 'SEM_AMOSTRA') return 'sem-amostra';
  return [clsBlue, clsRed].sort((a, b) => CLS_RANK[a] - CLS_RANK[b]).map((c) => c.toLowerCase()).join('×');
}
function rulePass(clsBlue, clsRed) {
  const greens = (clsBlue === 'VERDE' ? 1 : 0) + (clsRed === 'VERDE' ? 1 : 0);
  const reds = (clsBlue === 'VERMELHO' ? 1 : 0) + (clsRed === 'VERMELHO' ? 1 : 0);
  return greens >= 1 && reds < 2;
}

// ============================================================================
// 3. Trigger population (o que interessa pro contrafactual).
// ============================================================================
const triggerRows = allRows.filter((r) => r.trigger_type);
const triggerGameIds = new Set(triggerRows.map((r) => r.game_id));

// ============================================================================
// 4. Bets reais — não-simulated, Under, dentro da janela e das 6 ligas.
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CONTRAFACTUAL — regra de flags vs "tudo" vs "nada"');
  console.log('='.repeat(70));
  console.log(`\nUniverso 6 ligas (janela dedicada): ${allGames.length} games | trigger: ${triggerRows.length}`);

  const allBets = await loadAllBets();
  const nonSim = allBets.filter((b) => (b.bookmaker || '').toUpperCase() !== 'SIMULATED');
  const inWindow = nonSim.filter((b) => (b.bet_datetime || '') >= WINDOW_FROM && (b.bet_datetime || '') < WINDOW_TO);
  const underBetsSixLeagues = inWindow.filter((b) => SIX_LEAGUES.has(b.league) && parsePick(b.pick, b.market).kind === 'under');

  // EWC real (fora da simulação, reportado à parte)
  const ewcBets = inWindow.filter((b) => (b.league || '').toUpperCase().includes('EWC') && (b.status === 'green' || b.status === 'red' || b.status === 'cashout'));
  const ewcRealProfit = fmt2(ewcBets.reduce((a, b) => a + (b.profit || 0), 0));
  const ewcRealStake = fmt2(ewcBets.reduce((a, b) => a + (b.status === 'void' ? 0 : parseFloat(b.stake) || 0), 0));

  // Agrupa bets por game_id (ladder).
  const betsByGameId = new Map();
  for (const b of underBetsSixLeagues) {
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    if (!gid) continue;
    if (!betsByGameId.has(String(gid))) betsByGameId.set(String(gid), []);
    betsByGameId.get(String(gid)).push(b);
  }

  // Órfãs: bet com trigger_type no raw_extraction mas SEM game correspondente no
  // universo coletado — sintetiza um row mínimo usando os dados crus da própria bet.
  let orphanCount = 0;
  const syntheticRows = [];
  for (const [gid, bets] of betsByGameId) {
    if (triggerGameIds.has(gid) || allRows.some((r) => r.game_id === gid)) continue;
    const b = bets[0];
    const mc = b.raw_extraction?.match_context;
    const comp = b.raw_extraction?.compositions;
    if (!mc || !mc.trigger_type || mc.total_kills == null) continue; // sem dado suficiente, vira "sem_dado" reportado
    orphanCount++;
    const teamBlueRaw = comp?.team_a?.side === 'blue' ? comp.team_a.name : comp?.team_b?.side === 'blue' ? comp.team_b.name : null;
    const teamRedRaw = comp?.team_a?.side === 'red' ? comp.team_a.name : comp?.team_b?.side === 'red' ? comp.team_b.name : null;
    const teamBlue = normalizeTeam(teamBlueRaw || b.team_a);
    const teamRed = normalizeTeam(teamRedRaw || b.team_b);
    const league = b.league;
    const leagueKey = String(LEAGUE_IDS[league] || league);
    const th = teamHistByLeague.get(leagueKey) || teamHistByLeague.get(league);
    let fair;
    if (th) {
      const avgFor = (team) => {
        const arr = th.teamHist.get(team) || [];
        if (arr.length < FALLBACK_MIN_N) return th.leagueAvgTotal;
        return arr.reduce((a, x) => a + x.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(teamBlue) + avgFor(teamRed)) / 2;
      fair = Math.round(raw - 0.5) + 0.5;
    } else {
      fair = mc.fair_line ?? 29.5;
    }
    syntheticRows.push({
      game_id: gid,
      league,
      league_id: leagueKey,
      date: b.bet_datetime,
      team_blue: teamBlue,
      team_red: teamRed,
      total_kills: mc.total_kills,
      trigger_type: mc.trigger_type,
      fair,
      synthetic: true,
    });
  }
  console.log(`Bets órfãs (sem game no universo coletado, reconstruídas via raw_extraction): ${orphanCount}`);

  const fullTriggerPop = [...triggerRows.map((r) => ({ ...r, synthetic: false })), ...syntheticRows];

  // ==========================================================================
  // 5. Monta o objeto por jogo — flag, regra, real, simulações.
  // ==========================================================================
  const games = fullTriggerPop.map((r) => {
    const cls = r.synthetic
      ? { clsBlue: clsOfTeamAsOfDate(r.team_blue, r.date), clsRed: clsOfTeamAsOfDate(r.team_red, r.date) }
      : clsMap.get(r.game_id);
    const combo = comboOf(cls.clsBlue, cls.clsRed);
    const pass = rulePass(cls.clsBlue, cls.clsRed);

    const bets = betsByGameId.get(r.game_id) || [];
    const settledBets = bets.filter((b) => b.status === 'green' || b.status === 'red' || b.status === 'cashout' || b.status === 'void');
    const isReal = settledBets.length > 0;
    const realProfit = settledBets.reduce((a, b) => a + (b.status === 'void' ? 0 : b.profit || 0), 0);
    const realStake = settledBets.reduce((a, b) => a + (b.status === 'void' ? 0 : parseFloat(b.stake) || 0), 0);
    const realHit = realProfit > 0;

    const simFairPlus1Hit = r.total_kills < r.fair + 1;
    const simFairPlus1Profit = simFairPlus1Hit ? STAKE_SIM * (UNDER_ODD - 1) : -STAKE_SIM;
    const simFairHit = r.total_kills < r.fair;
    const simFairProfit = simFairHit ? STAKE_SIM * (UNDER_ODD - 1) : -STAKE_SIM;

    return {
      game_id: r.game_id, league: r.league, date: r.date, month: (r.date || '').slice(0, 7),
      team_blue: r.team_blue, team_red: r.team_red, total_kills: r.total_kills, fair: r.fair,
      synthetic: r.synthetic, cls_blue: cls.clsBlue, cls_red: cls.clsRed, combo, rule_pass: pass,
      is_real: isReal, real_profit: fmt2(realProfit), real_stake: fmt2(realStake), real_hit: isReal ? realHit : null, real_bets_n: settledBets.length,
      sim_fair_plus_1: { hit: simFairPlus1Hit, profit: simFairPlus1Profit },
      sim_fair: { hit: simFairHit, profit: simFairProfit },
    };
  });
  console.log(`População trigger completa (universo + órfãs reconstruídas): ${games.length}`);
  console.log(`Jogos com bet real: ${games.filter((g) => g.is_real).length}`);

  // ==========================================================================
  // 6. Cenários S1-S5.
  // ==========================================================================
  function scenarioAcc() {
    return { n: 0, wins: 0, staked: 0, profit: 0, n_real: 0, n_sim: 0, staked_real: 0, profit_real: 0, staked_sim: 0, profit_sim: 0 };
  }
  function addContribution(acc, stake, profit, hit, source) {
    if (stake === 0 && profit === 0 && source == null) return; // skip (contribuição nula, jogo fora do escopo do cenário)
    acc.n++;
    if (hit) acc.wins++;
    acc.staked += stake;
    acc.profit += profit;
    if (source === 'real') {
      acc.n_real++;
      acc.staked_real += stake;
      acc.profit_real += profit;
    } else if (source === 'sim') {
      acc.n_sim++;
      acc.staked_sim += stake;
      acc.profit_sim += profit;
    }
  }
  function finalizeAcc(acc) {
    const hitPct = acc.n ? fmt1((100 * acc.wins) / acc.n) : null;
    const ci = wilsonCI(acc.wins, acc.n);
    const roi = acc.staked ? fmt1((100 * acc.profit) / acc.staked) : null;
    return {
      n: acc.n, wins: acc.wins, hit_pct: hitPct, wilson_ci_95: ci,
      staked: fmt2(acc.staked), profit: fmt2(acc.profit), roi_pct: roi,
      split_real: { n: acc.n_real, staked: fmt2(acc.staked_real), profit: fmt2(acc.profit_real) },
      split_sim: { n: acc.n_sim, staked: fmt2(acc.staked_sim), profit: fmt2(acc.profit_sim) },
    };
  }

  // --- S1: real ---
  const s1Acc = scenarioAcc();
  for (const g of games) {
    if (!g.is_real) continue;
    addContribution(s1Acc, g.real_stake, g.real_profit, g.real_hit, 'real');
  }
  const s1 = finalizeAcc(s1Acc);

  // --- S2: tudo @ fair+1 @ 1.72 ---
  const s2Acc = scenarioAcc();
  for (const g of games) {
    if (g.is_real) addContribution(s2Acc, g.real_stake, g.real_profit, g.real_hit, 'real');
    else addContribution(s2Acc, STAKE_SIM, g.sim_fair_plus_1.profit, g.sim_fair_plus_1.hit, 'sim');
  }
  const s2 = finalizeAcc(s2Acc);

  // --- S3: tudo @ fair @ 1.72 (stress, real fica igual) ---
  const s3Acc = scenarioAcc();
  for (const g of games) {
    if (g.is_real) addContribution(s3Acc, g.real_stake, g.real_profit, g.real_hit, 'real');
    else addContribution(s3Acc, STAKE_SIM, g.sim_fair.profit, g.sim_fair.hit, 'sim');
  }
  const s3 = finalizeAcc(s3Acc);

  // --- S4: regra dele aplicada a tudo ---
  const s4Acc = scenarioAcc();
  for (const g of games) {
    if (!g.rule_pass) continue; // skip
    if (g.is_real) addContribution(s4Acc, g.real_stake, g.real_profit, g.real_hit, 'real');
    else addContribution(s4Acc, STAKE_SIM, g.sim_fair_plus_1.profit, g.sim_fair_plus_1.hit, 'sim');
  }
  const s4 = finalizeAcc(s4Acc);

  // --- S5: anti-regra (só o que a regra skipava) ---
  const s5Acc = scenarioAcc();
  for (const g of games) {
    if (g.rule_pass) continue;
    if (g.is_real) addContribution(s5Acc, g.real_stake, g.real_profit, g.real_hit, 'real');
    else addContribution(s5Acc, STAKE_SIM, g.sim_fair_plus_1.profit, g.sim_fair_plus_1.hit, 'sim');
  }
  const s5 = finalizeAcc(s5Acc);

  console.log('\n### Tabela-resumo dos 5 cenários\n');
  console.log('| cenário | n | hit% | CI95% | apostado | lucro | ROI% |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, s] of [['S1 REAL', s1], ['S2 TUDO@fair+1', s2], ['S3 TUDO@fair(stress)', s3], ['S4 REGRA DELE', s4], ['S5 ANTI-REGRA', s5]]) {
    const ciStr = s.n ? `[${s.wilson_ci_95.lower}, ${s.wilson_ci_95.upper}]` : '-';
    console.log(`| ${name} | ${s.n} | ${s.hit_pct ?? '-'} | ${ciStr} | R$${s.staked} | R$${s.profit} | ${s.roi_pct ?? '-'} |`);
  }
  console.log(`\nEWC real (fora da simulação): profit=R$${ewcRealProfit}, staked=R$${ewcRealStake} (${ewcBets.length} bets) — NÃO incluído em S1-S5 acima.`);

  // ==========================================================================
  // 7. S1 por combo de flag.
  // ==========================================================================
  // comboOf() sempre ordena por CLS_RANK (VERDE=0 < NEUTRO=1 < VERMELHO=2) — a chave
  // gerada é sempre "verde×X" antes de "X×verde", nunca o contrário.
  const COMBO_ORDER = ['verde×verde', 'verde×neutro', 'verde×vermelho', 'neutro×neutro', 'neutro×vermelho', 'vermelho×vermelho', 'sem-amostra'];
  const s1ByCombo = {};
  for (const combo of COMBO_ORDER) {
    const acc = scenarioAcc();
    for (const g of games) {
      if (!g.is_real || g.combo !== combo) continue;
      addContribution(acc, g.real_stake, g.real_profit, g.real_hit, 'real');
    }
    s1ByCombo[combo] = finalizeAcc(acc);
  }
  console.log('\n### S1 REAL por combo de flag\n');
  console.log('| combo | n | hit% | apostado | lucro | ROI% |');
  console.log('|---|---|---|---|---|---|');
  for (const combo of COMBO_ORDER) {
    const s = s1ByCombo[combo];
    console.log(`| ${combo} | ${s.n} | ${s.hit_pct ?? '-'} | R$${s.staked} | R$${s.profit} | ${s.roi_pct ?? '-'} |`);
  }
  const verdeVerde = s1ByCombo['verde×verde'];
  const restoLucro = fmt2(s1.profit - (verdeVerde.profit ?? 0));
  console.log(`\nCheck contra número já reportado: verde×verde real = R$${verdeVerde.profit} (esperado ~-R$7.6k) | resto = R$${restoLucro} (esperado ~+R$25.7k).`);

  // ==========================================================================
  // 8. Dinheiro na mesa / salvos pela regra.
  // ==========================================================================
  const skippedGames = games.filter((g) => !g.rule_pass);
  const skippedWithContribution = skippedGames.map((g) => {
    const contrib = g.is_real ? { stake: g.real_stake, profit: g.real_profit, source: 'real' } : { stake: STAKE_SIM, profit: g.sim_fair_plus_1.profit, source: 'sim' };
    return { ...g, contrib_profit: contrib.profit, contrib_source: contrib.source };
  });
  const moneyOnTable = skippedWithContribution.filter((g) => g.contrib_profit > 0).sort((a, b) => b.contrib_profit - a.contrib_profit).slice(0, TOP_N_LISTS);
  const savedByRule = skippedWithContribution.filter((g) => g.contrib_profit < 0).sort((a, b) => a.contrib_profit - b.contrib_profit).slice(0, TOP_N_LISTS);

  console.log(`\n### Top ${TOP_N_LISTS} "dinheiro na mesa" (skipados pela regra, teriam pago)\n`);
  console.log('| jogo | liga | data | combo | fonte | profit perdido |');
  console.log('|---|---|---|---|---|---|');
  for (const g of moneyOnTable) console.log(`| ${g.team_blue} vs ${g.team_red} | ${g.league} | ${(g.date || '').slice(0, 10)} | ${g.combo} | ${g.contrib_source} | R$${g.contrib_profit} |`);

  console.log(`\n### Top ${TOP_N_LISTS} "salvos pela regra" (skipados, teriam perdido)\n`);
  console.log('| jogo | liga | data | combo | fonte | profit evitado |');
  console.log('|---|---|---|---|---|---|');
  for (const g of savedByRule) console.log(`| ${g.team_blue} vs ${g.team_red} | ${g.league} | ${(g.date || '').slice(0, 10)} | ${g.combo} | ${g.contrib_source} | R$${g.contrib_profit} |`);

  const totalMoneyOnTable = fmt2(skippedWithContribution.filter((g) => g.contrib_profit > 0).reduce((a, g) => a + g.contrib_profit, 0));
  const totalSaved = fmt2(-skippedWithContribution.filter((g) => g.contrib_profit < 0).reduce((a, g) => a + g.contrib_profit, 0));
  console.log(`\nTotal dinheiro na mesa (todos os skipados que teriam pago): R$${totalMoneyOnTable}`);
  console.log(`Total salvo pela regra (todos os skipados que teriam perdido): R$${totalSaved}`);
  console.log(`Líquido do filtro (S4 - S2, restrito à parte skipada): R$${fmt2(totalSaved - totalMoneyOnTable)}`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: { under_odd: UNDER_ODD, under_be_pct: UNDER_BE, stake_sim: STAKE_SIM, fair_fallback_min_n: FALLBACK_MIN_N, trail_min_n: TRAIL_MIN_N, red_threshold: RED_THRESHOLD, green_threshold: GREEN_THRESHOLD, window_from: WINDOW_FROM, window_to: WINDOW_TO },
    notes: {
      cache_staleness: 'audit-cache schedule page-0 das 6 ligas estava desatualizada (fetched 2026-07-20, faltava LFL 2026-07-21). Recoletado especificamente pra esta análise em audit-output/00-universe-6leagues-window.json.',
      orphan_bets: `${orphanCount} bets reais sem game correspondente no universo coletado, reconstruídas via raw_extraction.match_context da própria bet (compositions.team_x.side pra side, trigger_type, total_kills, fair_line/fórmula como fallback).`,
      ewc_excluded: 'EWC fora da simulação (kills não confiáveis fora da Riot API) — bets reais de EWC reportadas à parte, não somadas em S1-S5.',
      flag_source: 'Não encontrei um script "red_team_real_bets" versionado no repo — segui a técnica walk-forward descrita explicitamente no pedido (mesma de over-red-teams.cjs/under-by-team.cjs), documentado pra caso a referência do dono seja outra.',
      combo_divergence_investigation: `verde×verde real aqui diverge do valor citado como referência (~-R$7.6k esperado). Testei 4 escopos alternativos: sem limite de data (Under+trigger+6 ligas)=R$8656 total; qualquer mercado nas 6 ligas=R$5563; Under sem exigir trigger=R$3557; TODAS as bets settled sem limite de liga/mercado/data=R$19266 (único perto de -7.6k+25.7k=18.1k). Hipótese mais provável: a referência usa população mais ampla que "Under+trigger+6 ligas" definida literalmente neste pedido. Não force-fitado.`,
    },
    meta: { all_games_n: allGames.length, trigger_population_n: games.length, real_games_n: games.filter((g) => g.is_real).length, orphan_games_n: orphanCount },
    ewc_real: { profit: ewcRealProfit, staked: ewcRealStake, n_bets: ewcBets.length },
    scenarios: { s1_real: s1, s2_tudo_fair_plus_1: s2, s3_tudo_fair_stress: s3, s4_regra_dele: s4, s5_anti_regra: s5 },
    s1_by_combo: s1ByCombo,
    money_on_table_top15: moneyOnTable.map((g) => ({ game_id: g.game_id, teams: `${g.team_blue} vs ${g.team_red}`, league: g.league, date: g.date, combo: g.combo, source: g.contrib_source, profit: g.contrib_profit })),
    saved_by_rule_top15: savedByRule.map((g) => ({ game_id: g.game_id, teams: `${g.team_blue} vs ${g.team_red}`, league: g.league, date: g.date, combo: g.combo, source: g.contrib_source, profit: g.contrib_profit })),
    totals: { total_money_on_table: totalMoneyOnTable, total_saved_by_rule: totalSaved, net_filter_effect_on_skipped: fmt2(totalSaved - totalMoneyOnTable) },
    all_games_detail: games,
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nOutput JSON: ${OUTPUT_FILE}`);

  // ==========================================================================
  // Report .md
  // ==========================================================================
  const md = buildMarkdownReport(output);
  const reportsDir = path.dirname(REPORT_MD_FILE);
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(REPORT_MD_FILE, md);
  console.log(`Report .md: ${REPORT_MD_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});

function buildMarkdownReport(o) {
  const s = o.scenarios;
  const line = (name, x) => `| ${name} | ${x.n} | ${x.hit_pct ?? '-'}% | [${x.wilson_ci_95.lower ?? '-'}, ${x.wilson_ci_95.upper ?? '-'}] | R$${x.staked} | R$${x.profit} | ${x.roi_pct ?? '-'}% |`;
  const comboLine = (name, x) => `| ${name} | ${x.n} | ${x.hit_pct ?? '-'}% | R$${x.staked} | R$${x.profit} | ${x.roi_pct ?? '-'}% |`;

  return `# Contrafactual — flags vs "tudo" vs "nada"

**Data:** 2026-07-23 · **Fonte:** \`scripts/analysis/counterfactual-flags.cjs\` → \`audit-output/22-counterfactual.json\` (dataset: ${o.meta.all_games_n} games, 6 ligas operadas, ${o.params.window_from}→${o.params.window_to.replace(/T.*/, '')} exclusivo, fair leave-one-out por liga, flag walk-forward sem leakage).

## Sumário executivo

- **Fiz de verdade:** R$${s.s1_real.profit} de lucro real (n=${s.s1_real.n} jogos com bet, hit ${s.s1_real.hit_pct}%, ROI ${s.s1_real.roi_pct}%).
- **Teria feito apostando em TUDO (fair+1 @ 1.72):** R$${s.s2_tudo_fair_plus_1.profit} (n=${s.s2_tudo_fair_plus_1.n}, ROI ${s.s2_tudo_fair_plus_1.roi_pct}%).
- **Teria feito apostando em TUDO numa linha 1 pior (fair @ 1.72, stress):** R$${s.s3_tudo_fair_stress.profit} (ROI ${s.s3_tudo_fair_stress.roi_pct}%).
- **Teria feito seguindo a MINHA REGRA (≥1 verde, nunca 2 vermelhos) em TODO jogo do método:** R$${s.s4_regra_dele.profit} (n=${s.s4_regra_dele.n}, ROI ${s.s4_regra_dele.roi_pct}%).
- **Anti-regra (só o que a regra pulava):** R$${s.s5_anti_regra.profit} (n=${s.s5_anti_regra.n}, ROI ${s.s5_anti_regra.roi_pct}%).
- **O filtro (regra de flag), restrito aos jogos que ele pulou:** salvou R$${o.totals.total_saved_by_rule} em perdas evitadas, mas deixou R$${o.totals.total_money_on_table} na mesa em jogos que teriam pago — líquido de **R$${o.totals.net_filter_effect_on_skipped}** só na parte que a regra decidiu pular.
- EWC real (fora da simulação): R$${o.ewc_real.profit} em ${o.ewc_real.n_bets} bets — não somado nos números acima.

## 1. Tabela-resumo dos 5 cenários

| Cenário | n | Hit% | CI95% | Apostado | Lucro | ROI% |
|---|---|---|---|---|---|---|
${line('S1 REAL', s.s1_real)}
${line('S2 TUDO @ fair+1 (1.72)', s.s2_tudo_fair_plus_1)}
${line('S3 TUDO @ fair (stress, 1 pior)', s.s3_tudo_fair_stress)}
${line('S4 REGRA DELE em tudo', s.s4_regra_dele)}
${line('S5 ANTI-REGRA', s.s5_anti_regra)}

Split real vs simulado dentro de cada cenário está no JSON (\`scenarios.*.split_real\` / \`.split_sim\`).

## 2. S1 REAL por combo de flag

| Combo | n | Hit% | Apostado | Lucro | ROI% |
|---|---|---|---|---|---|
${Object.entries(o.s1_by_combo).map(([k, v]) => comboLine(k, v)).join('\n')}

## 3. Dinheiro na mesa / salvos pela regra (top ${o.money_on_table_top15.length}/${o.saved_by_rule_top15.length})

### Dinheiro na mesa (regra pulou, teria pago)

| Jogo | Liga | Data | Combo | Fonte | Profit perdido |
|---|---|---|---|---|---|
${o.money_on_table_top15.map((g) => `| ${g.teams} | ${g.league} | ${(g.date || '').slice(0, 10)} | ${g.combo} | ${g.source} | R$${g.profit} |`).join('\n')}

### Salvos pela regra (regra pulou, teria perdido)

| Jogo | Liga | Data | Combo | Fonte | Profit evitado |
|---|---|---|---|---|---|
${o.saved_by_rule_top15.map((g) => `| ${g.teams} | ${g.league} | ${(g.date || '').slice(0, 10)} | ${g.combo} | ${g.source} | R$${g.profit} |`).join('\n')}

## 4. Caveats honestos

1. **Odd 1.72 assumida em toda simulação** — jogos sem bet real usam odd flat 1.72 (fair+1) ou 1.72 (fair, stress) independente da odd de mercado real naquele momento, que pode ter variado por casa/timing.
2. **Disponibilidade de linha assumida** — a simulação assume que dava pra apostar QUALQUER jogo com trigger na linha calculada; na prática, liquidez/mercado pode não existir pra todas as ligas/casas o tempo todo.
3. **Flag depende do histórico de bets/jogos dele** — early-days (abril) tem times classificados SEM_AMOSTRA (n<5 jogos anteriores) por definição — a regra não discrimina nesse período, vira quase-sempre "aposta" ou "não decide" dependendo de como SEM_AMOSTRA é tratado (aqui: SEM_AMOSTRA sempre implica pular na regra, já que não tem nenhum VERDE confirmado).
4. **Cache do schedule estava desatualizado** (page-0 de 2026-07-20) — recoletei especificamente pra esta análise; ver \`notes.cache_staleness\` no JSON.
5. **${o.meta.orphan_games_n} bets reais órfãs** (sem game no universo coletado) foram reconstruídas a partir dos dados crus da própria bet (\`raw_extraction\`) — fair recalculado com o mesmo histórico de time da liga, não é 100% idêntico a estar no universo original.
6. **"Hit" de jogos com múltiplas bets (ladder)** é definido aqui pelo sinal do profit agregado (lucro líquido>0 = hit) — não é o hit de uma bet individual.
7. EWC fica fora de TODOS os cenários simulados (S2-S5) — só aparece como número informativo à parte, porque não há fair confiável fora da Riot API pra simular contrafactual.
8. **DIVERGÊNCIA INVESTIGADA — verde×verde real aqui = R$${o.s1_by_combo['verde×verde'].profit} (esperado ~-R$7,6k), resto = R$${fmt2(o.scenarios.s1_real.profit - o.s1_by_combo['verde×verde'].profit)} (esperado ~+R$25,7k).** Não bateu. Testei 4 escopos alternativos de população pra reconciliar: (a) sem limite de data — Under+trigger+6 ligas dá R$8.656 total (quase igual ao valor aqui, R$8.012); (b) qualquer mercado nas 6 ligas (não só Under) — R$5.563 total, mais baixo ainda; (c) só Under nas 6 ligas sem exigir trigger — R$3.557; (d) TODAS as bets settled, qualquer liga/mercado, sem limite de data — R$19.266, que é o único valor perto da soma -7,6k+25,7k=18,1k citada. **Hipótese mais provável: a referência do dono usa uma população mais ampla (todas as bets reais, não só Under+trigger+6-ligas) — este script seguiu literalmente a população definida no pedido ("jogos com TRIGGER peel nas 6 ligas operadas"), que é mais restrita.** Não force-fitei o número — reportando a divergência como está.

---

Sem recomendação — a conclusão de negócio é do orquestrador/dono.
`;
}
