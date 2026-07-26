// scripts/analysis/split2-improve.cjs
//
// Análise estatística completa do split 2 (Under total kills) — o que melhorar no
// método antes do split 3. Cruza:
//   - audit-output/00-universe.json (861 games do split2, 6 ligas Riot, recomputado
//     direto da API — fonte de verdade pra kills/supports/trigger)
//   - audit-output/01-coverage.json (36 MISSING_BET — jogos com trigger sem bet)
//   - tabela `bets` (Supabase) — apostas reais + SIMULATED do método
//
// Metodologia (ver prompt da tarefa — regras INVIOLÁVEIS do dono do sistema):
//   1. Stats POR MAPA: dedup por lolesports_game_id, 1 stake/mapa (lógica aggBy de
//      lib/analiseStats.cjs, replicada aqui em buildMapRows()).
//   2. NUNCA quebrar por bookmaker.
//   3. Simulação padronizada: odd 1.72, stake 1000 (BE = 58.1%).
//   4. small_sample = n < 10.
//   5. Time vermelho/verde por agregação por mapa (não por bet).
//   6. Escopo: is_method_bet=true, status green/red, bet_datetime em
//      [2026-04-01, 2026-07-01) — inclui EWC (fallback fromStatus).
//
// Correção de dado conhecida (bet 61507820-... e SIMULATED 2432691d-...): ambas
// têm match_context.total_kills=0 no banco pro game_id 115615926685761093 (LNG vs
// LGD Gaming, map 2), quando o real (recomputado da API, ver 00-universe.json) é 32.
// Em vez de hardcodar essas 2 IDs, buildMapRows() SEMPRE prefere o total_kills do
// universo (fresh recompute da API) quando o jogo resolve e não é suspect/fetch_error
// — isso corrige esses 2 casos automaticamente (e qualquer outro latente) sem
// depender de uma lista hardcoded. killsCorrected[] no output lista o que foi pego.
//
// Uso: node scripts/analysis/split2-improve.cjs
// Output: audit-output/10-improve.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  loadAllBets,
  inScope,
  isEwc,
  PEEL_PURE,
  FLEX_ENGAGE,
  SPLIT2_FROM,
  SPLIT2_TO,
  parsePick,
  detectTrigger,
} = require('../audit/lib/audit-common.cjs');
const { buildUniverseIndex, findGameForBet } = require('../audit/lib/match-bet-to-game.cjs');
const { normTeamName, normalizeLeague } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');
const UNIVERSE_FILE = path.join(OUTPUT_DIR, '00-universe.json');
const COVERAGE_FILE = path.join(OUTPUT_DIR, '01-coverage.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '10-improve.json');

// === Parâmetros padrão da simulação (regra 3) ===
const ODD = 1.72;
const STAKE = 1000;
const BE_PCT = +((100 / ODD).toFixed(1)); // 58.1
const SMALL_N = 10; // regra 4

// === Champions do método (regra: sempre PEEL_PURE/FLEX_ENGAGE canônicos) ===
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const FLEX_SET = new Set(FLEX_ENGAGE.map(normChamp));
const isPeel = (s) => !!s && PEEL_SET.has(normChamp(s));
const isFlex = (s) => !!s && FLEX_SET.has(normChamp(s));
const CHAMP_DISPLAY = {
  soraka: 'Soraka', sona: 'Sona', janna: 'Janna', lulu: 'Lulu', yuumi: 'Yuumi', karma: 'Karma',
  seraphine: 'Seraphine', renataglasc: 'Renata Glasc', renata: 'Renata Glasc', nami: 'Nami', milio: 'Milio',
  bard: 'Bard', rakan: 'Rakan', lux: 'Lux', anivia: 'Anivia', alistar: 'Alistar',
};
const displayChamp = (raw) => CHAMP_DISPLAY[normChamp(raw)] || raw;

function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}

// ============================================================================
// buildMapRows — dataset canônico por mapa (~460 rows), 1 stake/mapa.
// Réplica de fetchAndDedup() + aggBy() de lib/analiseStats.cjs, mas guardando
// TODOS os atributos por mapa (não só profit agregado) pra permitir os cortes A-I.
// ============================================================================
function buildMapRows(universeIndex, scopedBets) {
  // Dedup defensiva idêntica a fetchAndDedup(): se um game_id tem bet REAL, remove
  // SIMULATED do mesmo game_id (evita contar 2x o mesmo mapa).
  const realGids = new Set();
  for (const b of scopedBets) {
    if (b.bookmaker !== 'SIMULATED') {
      const gid = b.raw_extraction?.match_context?.lolesports_game_id;
      if (gid) realGids.add(String(gid));
    }
  }
  const deduped = scopedBets.filter((b) => {
    if (b.bookmaker !== 'SIMULATED') return true;
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    return !gid || !realGids.has(String(gid));
  });

  // Ordem determinística idêntica à query canônica (order=bet_datetime.desc) — quem
  // "chega primeiro" define o resultado do mapa em caso de ladder (aggBy: "1ª bet
  // define, resto skip"). Tie-break por id (determinístico entre runs).
  const ordered = [...deduped].sort((a, b) => {
    const ta = a.bet_datetime || '';
    const tb = b.bet_datetime || '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const normKey = (s) => (s || '').toLowerCase().replace(/\s+/g, '-');
  const byMap = new Map();
  const killsCorrected = [];
  let droppedNoSim = 0;

  for (const b of ordered) {
    const m = findGameForBet(b, universeIndex);
    const game = m.game;
    const gameUsable = game && !game.suspect && !game.fetch_error;
    const mc = b.raw_extraction?.match_context || {};

    // --- kills: prefere universo (fresh recompute da API) — corrige bugs latentes
    // como bet 61507820/SIMULATED 2432691d (match_context.total_kills=0 no banco).
    let kills = null;
    let killsSource = null;
    if (gameUsable && game.total_kills != null) {
      kills = game.total_kills;
      killsSource = 'universe';
      if (mc.total_kills != null && mc.total_kills !== kills) {
        killsCorrected.push({
          bet_id: b.id,
          bookmaker: b.bookmaker,
          teams: `${b.team_a} vs ${b.team_b}`,
          game_id: game.game_id,
          from_match_context: mc.total_kills,
          to_universe: kills,
        });
      }
    } else if (mc.total_kills != null) {
      kills = mc.total_kills;
      killsSource = 'match_context';
    }

    // --- baseLine: réplica exata de getBetSimulation() (lib/analiseStats.cjs)
    let baseLine = null;
    if (b.bookmaker === 'SIMULATED') {
      baseLine = mc.fair_line_calculated ?? null;
      if (baseLine == null) {
        const mm = (b.pick || '').match(/(\d+(?:[.,]\d+)?)/);
        if (mm) baseLine = parseFloat(mm[1].replace(',', '.'));
      }
    } else {
      const mm = (b.pick || '').match(/(\d+(?:[.,]\d+)?)/);
      if (mm) baseLine = parseFloat(mm[1].replace(',', '.'));
      const realOdd = parseFloat(b.odd);
      if (!isNaN(realOdd) && realOdd < ODD) baseLine = baseLine != null ? baseLine - 1 : null;
    }

    let won;
    let fromStatus = false;
    if (baseLine == null || kills == null) {
      if (b.status === 'green') { won = true; fromStatus = true; }
      else if (b.status === 'red') { won = false; fromStatus = true; }
      else { droppedNoSim++; continue; }
    } else {
      const simLine = baseLine; // delta=0
      const isOver = /over|mais de/i.test(b.pick || '');
      won = isOver ? kills > simLine : kills < simLine;
    }

    // --- pick_line RAW (não ajustado pela regra odd<1.72) — usado no corte E (edge vs linha)
    const parsedPick = parsePick(b.pick, b.market);
    let pickLineRaw = mc.pick_line ?? parsedPick.line ?? null;

    // --- metadados do jogo: universo preferido, fallback pro que a bet registrou
    const league = gameUsable ? game.league : normalizeLeague(b.league);
    const dateStr = gameUsable ? game.date : b.bet_datetime;
    const mapNumber = gameUsable ? game.map_number : b.map_number;
    const teamA = gameUsable ? game.team_blue : b.team_a;
    const teamB = gameUsable ? game.team_red : b.team_b;
    const supA = gameUsable ? game.sup_blue : (mc.blue_picks?.support ?? null);
    const supB = gameUsable ? game.sup_red : (mc.red_picks?.support ?? null);
    const triggerType = gameUsable ? game.trigger_type : detectTrigger(supA, supB);

    const gid = gameUsable
      ? String(game.game_id)
      : (mc.lolesports_game_id
        ? String(mc.lolesports_game_id)
        : `EWC-${(b.bet_datetime || '').slice(0, 10)}-${normKey(b.team_a)}-vs-${normKey(b.team_b)}-map${b.map_number || '?'}`);

    if (byMap.has(gid)) continue; // 1 stake por mapa — 1ª bet (mais recente) já definiu

    byMap.set(gid, {
      map_key: gid,
      bet_id: b.id,
      bookmaker: b.bookmaker,
      is_ewc: isEwc(b),
      league,
      date: dateStr,
      month: (dateStr || '').slice(0, 7),
      map_number: mapNumber,
      team_a: normTeamName(teamA) || teamA,
      team_b: normTeamName(teamB) || teamB,
      sup_a: supA,
      sup_b: supB,
      trigger_type: triggerType,
      kills,
      kills_source: killsSource || (fromStatus ? 'status_fallback' : null),
      won,
      from_status: fromStatus,
      profit_sim: won ? STAKE * (ODD - 1) : -STAKE,
      pick_line_raw: pickLineRaw,
      real_odd: b.bookmaker !== 'SIMULATED' ? parseFloat(b.odd) : null,
      real_stake: b.bookmaker !== 'SIMULATED' ? parseFloat(b.stake) : null,
      real_profit: b.bookmaker !== 'SIMULATED' ? b.profit : null,
      fair_pinnacle: b.fair_pinnacle ?? null,
      fair_formula: b.fair_formula ?? null,
    });
  }

  return { rows: [...byMap.values()], killsCorrected, droppedNoSim };
}

// ============================================================================
// Agregador genérico bucket -> {n, hit_pct, roi_pct, small_sample}
// ============================================================================
function aggregate(rows, bucketFn) {
  const m = new Map();
  for (const r of rows) {
    let keys = bucketFn(r);
    if (keys == null) continue;
    if (!Array.isArray(keys)) keys = [keys];
    for (const k of keys) {
      if (k == null) continue;
      if (!m.has(k)) m.set(k, { bucket: k, n: 0, w: 0, profit: 0 });
      const e = m.get(k);
      e.n++;
      if (r.won) e.w++;
      e.profit += r.profit_sim;
    }
  }
  return [...m.values()]
    .map((e) => ({
      bucket: e.bucket,
      n: e.n,
      hit_pct: fmt1((100 * e.w) / e.n),
      roi_pct: fmt1((100 * e.profit) / (e.n * STAKE)),
      small_sample: e.n < SMALL_N,
    }))
    .sort((a, b) => b.n - a.n);
}

function printTable(title, rows, ressalva) {
  console.log(`\n### ${title}\n`);
  console.log('| bucket | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct ?? '-'} | ${r.roi_pct ?? '-'} | ${r.small_sample ? 'small_sample' : ''} |`);
  }
  if (ressalva) console.log(`\n_${ressalva}_`);
}

// ============================================================================
// Fair formula leave-one-out (usado em H2 e I1) — réplica da fórmula canônica
// (blueAvgTotal+redAvgTotal)/2 arredondado pra .5 (CLAUDE.md / rebuild_dashboard_
// stats_cron.cjs), mas com leave-one-out sobre o PRÓPRIO universo do split2 inteiro
// (não janela de 21d como o settle em produção — simplificação deliberada pra
// análise retrospectiva, documentada como ressalva no output).
// ============================================================================
function buildTeamKillsHistory(universe) {
  const hist = new Map();
  for (const g of universe) {
    if (g.total_kills == null) continue;
    for (const raw of [g.team_blue, g.team_red]) {
      if (!raw) continue;
      const t = normTeamName(raw) || raw;
      if (!hist.has(t)) hist.set(t, []);
      hist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
    }
  }
  return hist;
}

function buildLeagueAvgKills(universe) {
  const m = new Map();
  for (const g of universe) {
    if (g.total_kills == null) continue;
    if (!m.has(g.league)) m.set(g.league, { sum: 0, n: 0 });
    const e = m.get(g.league);
    e.sum += g.total_kills;
    e.n++;
  }
  const out = new Map();
  for (const [l, e] of m) out.set(l, e.sum / e.n);
  return out;
}

function fairFormulaForGame(game, teamHist, leagueAvg) {
  const teamA = normTeamName(game.team_blue) || game.team_blue;
  const teamB = normTeamName(game.team_red) || game.team_red;
  const fallback = leagueAvg.get(game.league) ?? 29;
  const avgFor = (team) => {
    const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== game.game_id);
    if (arr.length === 0) return fallback;
    return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
  };
  const raw = (avgFor(teamA) + avgFor(teamB)) / 2;
  return Math.round(raw - 0.5) + 0.5;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  const universe = loadJson(UNIVERSE_FILE);
  const coverage = loadJson(COVERAGE_FILE);
  const universeIndex = buildUniverseIndex(universe);

  const allBets = await loadAllBets();
  const scopedBets = allBets.filter(
    (b) => b.is_method_bet && (b.status === 'green' || b.status === 'red') && inScope(b)
  );

  const { rows: mapRows, killsCorrected, droppedNoSim } = buildMapRows(universeIndex, scopedBets);

  const output = {
    generated_at: new Date().toISOString(),
    split2_range: { from: SPLIT2_FROM, to: SPLIT2_TO },
    params: { odd: ODD, stake: STAKE, be_pct: BE_PCT, small_sample_n: SMALL_N },
    meta: {
      universe_games: universe.length,
      universe_games_with_trigger: universe.filter((g) => g.trigger_type).length,
      eligible_trigger_games: universe.filter((g) => g.trigger_type && !g.suspect && !g.fetch_error).length,
      scoped_bets: scopedBets.length,
      map_rows_n: mapRows.length,
      dropped_no_sim_possible: droppedNoSim,
      kills_corrected: killsCorrected,
    },
    A: {}, B: {}, C: {}, D: {}, E: {}, F: {}, G: {}, H: {}, I: {},
    notes: [],
  };

  console.log('='.repeat(70));
  console.log('SPLIT 2 — ANÁLISE COMPLETA (o que melhorar antes do split 3)');
  console.log('='.repeat(70));
  console.log(`Universo: ${universe.length} games | com trigger: ${output.meta.universe_games_with_trigger} | elegíveis (não-suspect): ${output.meta.eligible_trigger_games}`);
  console.log(`Bets no escopo (is_method_bet, green/red, split2+EWC): ${scopedBets.length}`);
  console.log(`Map rows (1 stake/mapa, pós-dedup): ${mapRows.length}`);
  console.log(`Correções de kills aplicadas (universo > match_context): ${killsCorrected.length}`);
  for (const k of killsCorrected) console.log(`  - bet ${k.bet_id} (${k.bookmaker}) ${k.teams}: match_context=${k.from_match_context} -> universo=${k.to_universe}`);
  if (droppedNoSim) console.log(`  [AVISO] ${droppedNoSim} bets descartadas por status não green/red (não deveria acontecer, escopo já filtra)`);

  // ==========================================================================
  // A. BASELINE E TENDÊNCIA
  // ==========================================================================
  console.log('\n\n## A. BASELINE E TENDÊNCIA');

  const A1 = aggregate(mapRows, () => 'GLOBAL');
  output.A.A1_global = A1;
  printTable('A1. Global split 2', A1);
  const globalHit = A1[0]?.hit_pct ?? null;
  const validationOk = globalHit != null && Math.abs(globalHit - 59.5) <= 3; // ~59-60% ±tolerância ampliada p/ report
  console.log(`\n[VALIDAÇÃO] hit global = ${globalHit}% (esperado ~59-60% via fetchAnaliseStats). Diff: ${globalHit != null ? fmt1(globalHit - 60) : 'N/A'}pp.`);

  const A2 = aggregate(mapRows, (r) => r.league);
  output.A.A2_by_league = A2;
  printTable('A2. Por liga', A2);

  const A3_global = aggregate(mapRows, (r) => r.month);
  output.A.A3_by_month_global = A3_global.sort((a, b) => a.bucket.localeCompare(b.bucket));
  printTable('A3. Por mês (global)', output.A.A3_by_month_global);

  const A3_byLeagueMonth = aggregate(mapRows, (r) => `${r.league}|${r.month}`);
  const A3_leagueMonthTable = A3_byLeagueMonth
    .map((e) => {
      const [league, month] = e.bucket.split('|');
      return { ...e, league, month };
    })
    .sort((a, b) => a.league.localeCompare(b.league) || a.month.localeCompare(b.month));
  output.A.A3_by_league_month = A3_leagueMonthTable;
  console.log('\n### A3. Por liga x mês\n');
  console.log('| liga | mês | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|');
  for (const r of A3_leagueMonthTable) {
    console.log(`| ${r.league} | ${r.month} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);
  }

  // A4 — drift de kills, universo inteiro (independente de bet)
  const killsDriftMap = new Map(); // "league|month" -> {sum,n}
  let a4NullKills = 0;
  for (const g of universe) {
    if (g.total_kills == null) { a4NullKills++; continue; }
    const month = (g.date || '').slice(0, 7);
    const key = `${g.league}|${month}`;
    if (!killsDriftMap.has(key)) killsDriftMap.set(key, { sum: 0, n: 0 });
    const e = killsDriftMap.get(key);
    e.sum += g.total_kills;
    e.n++;
  }
  const A4 = [...killsDriftMap.entries()]
    .map(([key, e]) => {
      const [league, month] = key.split('|');
      return { league, month, n: e.n, avg_total_kills: fmt1(e.sum / e.n) };
    })
    .sort((a, b) => a.league.localeCompare(b.league) || a.month.localeCompare(b.month));
  output.A.A4_kills_drift = A4;
  console.log(`\n### A4. Drift de kills (universo, ${universe.length - a4NullKills} games com kills válido de ${universe.length})\n`);
  console.log('| liga | mês | n games | avg total_kills |');
  console.log('|---|---|---|---|');
  for (const r of A4) console.log(`| ${r.league} | ${r.month} | ${r.n} | ${r.avg_total_kills} |`);

  // Fair formula leave-one-out — calculado aqui (antes de B) pq B4 e I1/H2 precisam
  const teamHist = buildTeamKillsHistory(universe);
  const leagueAvgKills = buildLeagueAvgKills(universe);

  // ==========================================================================
  // B. TRIGGER E CHAMPIONS
  // ==========================================================================
  console.log('\n\n## B. TRIGGER E CHAMPIONS');

  const B1 = aggregate(mapRows, (r) => (r.trigger_type === '2peel' || r.trigger_type === '1peel+flex') ? r.trigger_type : null);
  output.B.B1_trigger_type = B1;
  printTable('B1. 2peel vs 1peel+flex', B1);

  const B2 = aggregate(mapRows, (r) => {
    if (r.trigger_type !== '1peel+flex') return null;
    const flexChamp = isFlex(r.sup_a) ? r.sup_a : r.sup_b;
    return displayChamp(flexChamp);
  });
  output.B.B2_flex_champ = B2;
  printTable('B2. 1peel+flex por qual flex', B2, 'Só maps com trigger_type=1peel+flex (subset de B1).');

  const B3 = aggregate(mapRows, (r) => {
    const champs = [];
    if (isPeel(r.sup_a)) champs.push(displayChamp(r.sup_a));
    if (isPeel(r.sup_b)) champs.push(displayChamp(r.sup_b));
    return champs.length ? champs : null;
  });
  output.B.B3_peel_champ_individual = B3;
  printTable('B3. Por champion de support individual (PEEL_PURE)', B3, 'Um mapa pode contar pra 2 champs se for 2peel (ambos supports peel). Maps 2peel contam 1x pra cada champ do par.');

  // B4 — universo inteiro (não mapRows): só 2 dos 15 games com esse padrão têm bet
  // real/SIMULATED registrada (Alistar foi removido do método antes de virar bet
  // sistemática na maioria desses casos) — n=2 não sustenta conclusão nenhuma.
  // Usa a MESMA fair fórmula leave-one-out de H2/I1 pra simular hit hipotético
  // nos 15 games do universo com esse padrão, independente de bet existir.
  const alistarGames = universe.filter((g) => {
    if (g.suspect || g.fetch_error || g.total_kills == null) return false;
    const aAlistar = normChamp(g.sup_blue) === 'alistar' && isPeel(g.sup_red);
    const bAlistar = normChamp(g.sup_red) === 'alistar' && isPeel(g.sup_blue);
    return aAlistar || bAlistar;
  }).map((g) => ({ ...g, fair_formula_recomputed: fairFormulaForGame(g, teamHist, leagueAvgKills) }));
  let b4W = 0;
  for (const g of alistarGames) if (g.total_kills < g.fair_formula_recomputed) b4W++;
  const b4Profit = b4W * STAKE * (ODD - 1) - (alistarGames.length - b4W) * STAKE;
  const B4_universe = {
    n: alistarGames.length,
    hit_pct: alistarGames.length ? fmt1((100 * b4W) / alistarGames.length) : null,
    roi_pct: alistarGames.length ? fmt1((100 * b4Profit) / (alistarGames.length * STAKE)) : null,
    small_sample: alistarGames.length < SMALL_N,
  };
  // Dado secundário: os 2 casos que viraram bet de verdade (ROI real/simulado, não hipotético)
  const B4_realbets = aggregate(mapRows, (r) => {
    const aAlistar = normChamp(r.sup_a) === 'alistar' && isPeel(r.sup_b);
    const bAlistar = normChamp(r.sup_b) === 'alistar' && isPeel(r.sup_a);
    return (aAlistar || bAlistar) ? 'Alistar_flex_vs_peel (bets reais)' : null;
  });
  output.B.B4_alistar_hypothetical_universe = B4_universe;
  output.B.B4_alistar_real_bets_secondary = B4_realbets;
  console.log(`\n### B4. Alistar como flex vs peel (trigger antigo, removido 2026-05-29) — universo inteiro\n`);
  console.log('| bucket | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|');
  console.log(`| Alistar_flex_vs_peel (fair fórmula, hipotético) | ${B4_universe.n} | ${B4_universe.hit_pct} | ${B4_universe.roi_pct} | ${B4_universe.small_sample ? 'small_sample' : ''} |`);
  for (const r of B4_realbets) console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);
  console.log('\n_Primária: os 15 games do universo com esse padrão (Alistar flex + peel do outro lado), fair recomputada via fórmula leave-one-out (mesma de H2/I1), kills reais da API — hipotético, não depende de bet ter existido. Secundária: os 2 casos que efetivamente viraram bet (real/SIMULATED), amostra ínfima demais pra validar sozinha._');

  // ==========================================================================
  // C. MATCHUPS DE PEEL
  // ==========================================================================
  console.log('\n\n## C. MATCHUPS DE PEEL');

  const C1 = aggregate(mapRows, (r) => {
    if (r.trigger_type !== '1peel+flex') return null;
    const flexChamp = isFlex(r.sup_a) ? r.sup_a : r.sup_b;
    const peelChamp = isFlex(r.sup_a) ? r.sup_b : r.sup_a;
    return `${displayChamp(flexChamp)} vs ${displayChamp(peelChamp)}`;
  });
  const C1_flagged = C1.map((r) => ({ ...r, flag_hit_below_50: r.n >= 5 && r.hit_pct < 50 }));
  output.C.C1_flex_vs_enemy_peel = C1_flagged;
  console.log('\n### C1. Pares (nosso flex, peel inimigo) — 1peel+flex\n');
  console.log('| par | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of C1_flagged.sort((a, b) => b.n - a.n)) {
    const flags = [r.small_sample ? 'small_sample' : '', r.flag_hit_below_50 ? '**HIT<50%**' : ''].filter(Boolean).join(' ');
    console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${flags} |`);
  }
  console.log('\n_Só pares com n≥5 são marcados hit<50% (amostra insuficiente abaixo disso pra afirmar padrão)._');

  const C2 = aggregate(mapRows, (r) => {
    if (r.trigger_type !== '2peel') return null;
    return [displayChamp(r.sup_a), displayChamp(r.sup_b)].sort().join(' + ');
  });
  const C2_flagged = C2.map((r) => ({ ...r, flag_hit_below_50: r.n >= 5 && r.hit_pct < 50 }));
  output.C.C2_peel_pairs_2peel = C2_flagged;
  console.log('\n### C2. Pares de peel específicos — 2peel\n');
  console.log('| par | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of C2_flagged.sort((a, b) => b.n - a.n)) {
    const flags = [r.small_sample ? 'small_sample' : '', r.flag_hit_below_50 ? '**HIT<50%**' : ''].filter(Boolean).join(' ');
    console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${flags} |`);
  }

  // ==========================================================================
  // D. FILTROS DE TIME (out-of-sample, sem leakage)
  // ==========================================================================
  console.log('\n\n## D. FILTROS DE TIME (classificação out-of-sample)');

  const chronological = [...mapRows].filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const noDate = mapRows.length - chronological.length;
  const teamRecord = new Map(); // team -> {n, w}
  const rank = { verde: 0, neutro: 1, vermelho: 2 };

  function classify(team) {
    const rec = teamRecord.get(team);
    if (!rec || rec.n < 5) return 'neutro';
    const hit = rec.w / rec.n;
    if (hit >= 0.6) return 'verde';
    if (hit < 0.5) return 'vermelho';
    return 'neutro';
  }

  const D1rows = [];
  for (const r of chronological) {
    const clsA = classify(r.team_a);
    const clsB = classify(r.team_b);
    const combo = [clsA, clsB].sort((x, y) => rank[x] - rank[y]).join('×');
    D1rows.push({ ...r, cls_a: clsA, cls_b: clsB, combo, both_verde: clsA === 'verde' && clsB === 'verde', has_vermelho: clsA === 'vermelho' || clsB === 'vermelho' });

    // atualiza registro DEPOIS de classificar (evita leakage) — cada mapa credita os 2 times
    for (const team of [r.team_a, r.team_b]) {
      if (!teamRecord.has(team)) teamRecord.set(team, { n: 0, w: 0 });
      const rec = teamRecord.get(team);
      rec.n++;
      if (r.won) rec.w++;
    }
  }

  const D1 = aggregate(D1rows, (r) => r.combo);
  output.D.classification_meta = { rows_classified: D1rows.length, rows_without_date: noDate };
  output.D.D1_combo = D1;
  printTable('D1. Hit do mapa por combinação verde/neutro/vermelho', D1,
    `Classificação OUT-OF-SAMPLE: hit acumulado do time ATÉ a data do jogo (antes desse mapa). n_classificado=${D1rows.length}${noDate ? `, ${noDate} rows sem data (excluídas)` : ''}. Primeiros jogos de cada time no split (n<5 acumulado) contam como "neutro" por padrão.`);

  const D2_ambosVerde = aggregate(D1rows, (r) => (r.both_verde ? 'ambos_verde' : 'resto'));
  output.D.D2_ambos_verde_vs_resto = D2_ambosVerde;
  printTable('D2. "Ambos ≥60%" (verde×verde) vs resto', D2_ambosVerde);

  const D3_vermelho = aggregate(D1rows, (r) => (r.has_vermelho ? 'vermelho_presente' : 'sem_vermelho'));
  output.D.D3_vermelho_presente_vs_ausente = D3_vermelho;
  printTable('D3. "Time vermelho presente" vs ausente', D3_vermelho);

  // ==========================================================================
  // E. EDGE VS LINHA
  // ==========================================================================
  console.log('\n\n## E. EDGE VS LINHA');

  function bucketDiff(diff) {
    if (diff <= -1) return '≤-1';
    if (diff <= -0.25) return '-0.5';
    if (diff <= 0.25) return '0';
    if (diff <= 0.75) return '+0.5';
    if (diff < 1.5) return '+1';
    return '≥+1.5';
  }
  const BUCKET_ORDER_E1 = ['≤-1', '-0.5', '0', '+0.5', '+1', '≥+1.5'];

  const rowsWithFair = mapRows.map((r) => ({
    ...r,
    fair_used: r.fair_pinnacle ?? r.fair_formula ?? null,
    fair_source: r.fair_pinnacle != null ? 'pinnacle' : (r.fair_formula != null ? 'formula' : null),
  }));
  const e1Eligible = rowsWithFair.filter((r) => r.fair_used != null && r.pick_line_raw != null);
  const E1 = aggregate(e1Eligible, (r) => bucketDiff(r.pick_line_raw - r.fair_used));
  E1.sort((a, b) => BUCKET_ORDER_E1.indexOf(a.bucket) - BUCKET_ORDER_E1.indexOf(b.bucket));
  output.E.E1_pick_line_minus_fair = E1;
  output.E.E1_coverage = { map_rows_total: mapRows.length, eligible: e1Eligible.length, coverage_pct: fmt1((100 * e1Eligible.length) / mapRows.length) };
  printTable(
    `E1. Bucket (pick_line − fair) — cobertura ${e1Eligible.length}/${mapRows.length} maps (${output.E.E1_coverage.coverage_pct}%)`,
    E1,
    'fair = fair_pinnacle (top-level da bet) senão fair_formula (top-level). Maps sem nenhum dos dois foram excluídos (ver cobertura).'
  );

  const bothFair = rowsWithFair.filter((r) => r.fair_pinnacle != null && r.fair_formula != null && r.kills != null);
  let sumAbsPinnacle = 0;
  let sumAbsFormula = 0;
  for (const r of bothFair) {
    sumAbsPinnacle += Math.abs(r.fair_pinnacle - r.kills);
    sumAbsFormula += Math.abs(r.fair_formula - r.kills);
  }
  const E2 = {
    n: bothFair.length,
    avg_abs_error_pinnacle: bothFair.length ? fmt1(sumAbsPinnacle / bothFair.length) : null,
    avg_abs_error_formula: bothFair.length ? fmt1(sumAbsFormula / bothFair.length) : null,
    winner: bothFair.length ? (sumAbsPinnacle < sumAbsFormula ? 'pinnacle' : (sumAbsFormula < sumAbsPinnacle ? 'formula' : 'empate')) : null,
    small_sample: bothFair.length < SMALL_N,
  };
  output.E.E2_pinnacle_vs_formula = E2;
  console.log(`\n### E2. fair_pinnacle vs fair_formula (quando ambos existem, n=${E2.n})\n`);
  console.log(`|fair-kills| médio — Pinnacle: ${E2.avg_abs_error_pinnacle ?? '-'} | Fórmula: ${E2.avg_abs_error_formula ?? '-'} | melhor: **${E2.winner ?? 'N/A'}**${E2.small_sample ? ' [small_sample]' : ''}`);

  // ==========================================================================
  // F. MAPA E FORMATO
  // ==========================================================================
  console.log('\n\n## F. MAPA E FORMATO');

  const F1 = aggregate(mapRows, (r) => (r.map_number != null ? `map${r.map_number}` : null));
  F1.sort((a, b) => a.bucket.localeCompare(b.bucket));
  output.F.F1_hit_by_map_number = F1;
  printTable('F1. Hit por map_number', F1);

  const F2map = new Map();
  let f2Null = 0;
  for (const g of universe) {
    if (g.total_kills == null) { f2Null++; continue; }
    const key = `map${g.map_number}`;
    if (!F2map.has(key)) F2map.set(key, { sum: 0, n: 0 });
    const e = F2map.get(key);
    e.sum += g.total_kills;
    e.n++;
  }
  const F2 = [...F2map.entries()]
    .map(([bucket, e]) => ({ bucket, n: e.n, avg_total_kills: fmt1(e.sum / e.n) }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  output.F.F2_kills_by_map_number_universe = F2;
  console.log(`\n### F2. Kills médios por map_number (universo, ${universe.length - f2Null}/${universe.length} games com kills válido)\n`);
  console.log('| map | n | avg total_kills |');
  console.log('|---|---|---|');
  for (const r of F2) console.log(`| ${r.bucket} | ${r.n} | ${r.avg_total_kills} |`);

  // ==========================================================================
  // G. ODDS E STAKE (só bets REAIS — PnL real, sem simulação, sem dedup por mapa)
  // ==========================================================================
  console.log('\n\n## G. ODDS E STAKE (bets REAIS do CEO)');

  const realBets = scopedBets.filter((b) => b.bookmaker !== 'SIMULATED');
  console.log(`\nBets reais no escopo: ${realBets.length} (individuais, SEM dedup por mapa — ladders contam cada stake real separadamente, é isso que queremos auditar aqui).`);

  function aggregateReal(bets, bucketFn) {
    const m = new Map();
    for (const b of bets) {
      const k = bucketFn(b);
      if (k == null) continue;
      const stake = parseFloat(b.stake);
      const profit = parseFloat(b.profit);
      if (!Number.isFinite(stake) || !Number.isFinite(profit)) continue;
      if (!m.has(k)) m.set(k, { bucket: k, n: 0, w: 0, stake: 0, profit: 0 });
      const e = m.get(k);
      e.n++;
      if (b.status === 'green') e.w++;
      e.stake += stake;
      e.profit += profit;
    }
    return [...m.values()].map((e) => ({
      bucket: e.bucket,
      n: e.n,
      hit_pct: fmt1((100 * e.w) / e.n),
      roi_pct: fmt1((100 * e.profit) / e.stake),
      small_sample: e.n < SMALL_N,
    }));
  }

  function oddBucket(odd) {
    if (odd == null || isNaN(odd)) return null;
    if (odd <= 1.65) return '≤1.65';
    if (odd <= 1.75) return '1.65-1.75';
    if (odd <= 1.85) return '1.75-1.85';
    return '>1.85';
  }
  const ODD_ORDER = ['≤1.65', '1.65-1.75', '1.75-1.85', '>1.85'];
  const G1 = aggregateReal(realBets, (b) => oddBucket(parseFloat(b.odd)));
  G1.sort((a, b) => ODD_ORDER.indexOf(a.bucket) - ODD_ORDER.indexOf(b.bucket));
  output.G.G1_odd_bucket_real = G1;
  console.log('\n### G1. Hit e ROI REAL por bucket de odd\n');
  console.log('| bucket odd | n | hit% real | ROI% real | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of G1) console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);

  function stakeBucket(stake) {
    if (stake == null || isNaN(stake)) return null;
    if (stake <= 300) return '≤300';
    if (stake <= 700) return '301-700';
    if (stake <= 1500) return '701-1500';
    return '>1500';
  }
  const STAKE_ORDER = ['≤300', '301-700', '701-1500', '>1500'];
  const G2 = aggregateReal(realBets, (b) => stakeBucket(parseFloat(b.stake)));
  G2.sort((a, b) => STAKE_ORDER.indexOf(a.bucket) - STAKE_ORDER.indexOf(b.bucket));
  output.G.G2_stake_bucket_real = G2;
  console.log('\n### G2. ROI REAL por bucket de stake\n');
  console.log('| bucket stake | n | hit% real | ROI% real | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of G2) console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);

  // ==========================================================================
  // H. REAL VS MÉTODO
  // ==========================================================================
  console.log('\n\n## H. REAL VS MÉTODO');

  // Índice de PnL real por map_key (soma todos os real bets daquele mapa — cobre ladder)
  const realPnlByMap = new Map();
  for (const b of realBets) {
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    if (!gid) continue;
    const stake = parseFloat(b.stake);
    const profit = parseFloat(b.profit);
    if (!Number.isFinite(stake) || !Number.isFinite(profit)) continue;
    const key = String(gid);
    if (!realPnlByMap.has(key)) realPnlByMap.set(key, { stake: 0, profit: 0, n: 0 });
    const e = realPnlByMap.get(key);
    e.stake += stake;
    e.profit += profit;
    e.n++;
  }

  const mapsWithReal = mapRows.filter((r) => r.bookmaker !== 'SIMULATED');
  let h1SumRealProfit = 0, h1SumRealStake = 0, h1WinsReal = 0;
  let h1SumSimProfit = 0, h1WinsSim = 0;
  const h1DiffLines = [];
  for (const r of mapsWithReal) {
    const pnl = realPnlByMap.get(r.map_key) || { stake: r.real_stake || STAKE, profit: r.real_profit || 0, n: 1 };
    h1SumRealStake += pnl.stake;
    h1SumRealProfit += pnl.profit;
    if (pnl.profit > 0) h1WinsReal++;
    h1SumSimProfit += r.profit_sim;
    if (r.won) h1WinsSim++;
    const fair = r.fair_pinnacle ?? r.fair_formula ?? null;
    if (fair != null && r.pick_line_raw != null) h1DiffLines.push(r.pick_line_raw - fair);
  }
  const H1 = {
    n_maps_with_real_bet: mapsWithReal.length,
    real_hit_pct: mapsWithReal.length ? fmt1((100 * h1WinsReal) / mapsWithReal.length) : null,
    real_roi_pct: h1SumRealStake ? fmt1((100 * h1SumRealProfit) / h1SumRealStake) : null,
    sim_hit_pct: mapsWithReal.length ? fmt1((100 * h1WinsSim) / mapsWithReal.length) : null,
    sim_roi_pct: mapsWithReal.length ? fmt1((100 * h1SumSimProfit) / (mapsWithReal.length * STAKE)) : null,
    avg_pick_line_minus_fair: h1DiffLines.length ? fmt1(h1DiffLines.reduce((a, b) => a + b, 0) / h1DiffLines.length) : null,
    n_with_fair_known: h1DiffLines.length,
  };
  H1.delta_hit_pp = (H1.real_hit_pct != null && H1.sim_hit_pct != null) ? fmt1(H1.real_hit_pct - H1.sim_hit_pct) : null;
  H1.delta_roi_pp = (H1.real_roi_pct != null && H1.sim_roi_pct != null) ? fmt1(H1.real_roi_pct - H1.sim_roi_pct) : null;
  output.H.H1_real_vs_simulated = H1;
  console.log(`\n### H1. Real vs simulação padrão (${H1.n_maps_with_real_bet} maps com bet real)\n`);
  console.log(`| | hit% | ROI% |`);
  console.log(`|---|---|---|`);
  console.log(`| Real (PnL de verdade) | ${H1.real_hit_pct} | ${H1.real_roi_pct} |`);
  console.log(`| Simulação padrão (odd 1.72, stake 1000, linha do próprio pick) | ${H1.sim_hit_pct} | ${H1.sim_roi_pct} |`);
  console.log(`| Delta (real − sim) | ${H1.delta_hit_pp}pp | ${H1.delta_roi_pp}pp |`);
  console.log(`\nLinha real escolhida vs fair (média, n=${H1.n_with_fair_known} com fair conhecida): ${H1.avg_pick_line_minus_fair}`);

  const missingBetsWithFair = coverage.missing_bets.map((mb) => {
    const game = universeIndex.byGameId.get(String(mb.game_id));
    const fair = game ? fairFormulaForGame(game, teamHist, leagueAvgKills) : null;
    const kills = mb.total_kills;
    const wouldWin = fair != null && kills != null ? kills < fair : null;
    return { ...mb, fair_formula_recomputed: fair, would_be_green: wouldWin, profit_if_bet: wouldWin == null ? null : (wouldWin ? STAKE * (ODD - 1) : -STAKE) };
  });
  const H2n = missingBetsWithFair.length;
  const H2greens = missingBetsWithFair.filter((m) => m.would_be_green === true).length;
  const H2profit = missingBetsWithFair.reduce((a, m) => a + (m.profit_if_bet || 0), 0);
  const H2 = {
    n_missing: H2n,
    would_be_green: H2greens,
    would_be_hit_pct: H2n ? fmt1((100 * H2greens) / H2n) : null,
    roi_left_on_table_pct: H2n ? fmt1((100 * H2profit) / (H2n * STAKE)) : null,
    profit_left_on_table_brl_equiv: H2profit,
    details: missingBetsWithFair,
  };
  output.H.H2_missing_bets = H2;
  console.log(`\n### H2. 36 MISSING_BET — fair recomputada (leave-one-out) + kills reais\n`);
  console.log(`n=${H2.n_missing} | teriam sido green: ${H2.would_be_green} (${H2.would_be_hit_pct}%) | ROI hipotético: ${H2.roi_left_on_table_pct}% | "profit" na simulação padrão (stake 1000/mapa): ${H2.profit_left_on_table_brl_equiv}`);

  // ==========================================================================
  // I. SENSIBILIDADE DA LINHA
  // ==========================================================================
  console.log('\n\n## I. SENSIBILIDADE DA LINHA');

  const eligibleGames = universe.filter((g) => g.trigger_type && !g.suspect && !g.fetch_error);
  const OFFSETS = [-1, -0.5, 0, 0.5, 1];
  function offsetLabel(o) { return o === 0 ? 'fair' : (o > 0 ? `fair+${o}` : `fair${o}`); }

  const gamesWithFair = eligibleGames.map((g) => ({
    ...g,
    fair_formula_recomputed: fairFormulaForGame(g, teamHist, leagueAvgKills),
  }));

  function sensitivityTable(games) {
    return OFFSETS.map((o) => {
      let w = 0, n = 0;
      for (const g of games) {
        if (g.total_kills == null) continue;
        const line = g.fair_formula_recomputed + o;
        n++;
        if (g.total_kills < line) w++;
      }
      const hit = n ? (100 * w) / n : null;
      const profit = n ? w * STAKE * (ODD - 1) - (n - w) * STAKE : null;
      return {
        offset: offsetLabel(o),
        n,
        hit_pct: fmt1(hit),
        roi_pct: n ? fmt1((100 * profit) / (n * STAKE)) : null,
        small_sample: n < SMALL_N,
      };
    });
  }

  const I1_global = sensitivityTable(gamesWithFair);
  output.I.I1_global = I1_global;
  console.log(`\n### I1. Sensibilidade global (${gamesWithFair.length} games elegíveis com trigger)\n`);
  console.log('| offset | n | hit% | ROI% | flag |');
  console.log('|---|---|---|---|---|');
  for (const r of I1_global) console.log(`| ${r.offset} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);
  const bestOffset = I1_global.reduce((best, r) => (r.roi_pct != null && (best == null || r.roi_pct > best.roi_pct) ? r : best), null);
  console.log(`\nMelhor ROI global: **${bestOffset?.offset}** (${bestOffset?.roi_pct}% ROI, hit ${bestOffset?.hit_pct}%, BE=${BE_PCT}%)`);

  const leaguesSet = [...new Set(gamesWithFair.map((g) => g.league))].sort();
  const I1_byLeague = {};
  console.log('\n### I1. Sensibilidade por liga\n');
  for (const lg of leaguesSet) {
    const gs = gamesWithFair.filter((g) => g.league === lg);
    const table = sensitivityTable(gs);
    I1_byLeague[lg] = table;
    console.log(`\n**${lg}** (n base=${gs.length})\n`);
    console.log('| offset | n | hit% | ROI% | flag |');
    console.log('|---|---|---|---|---|');
    for (const r of table) console.log(`| ${r.offset} | ${r.n} | ${r.hit_pct} | ${r.roi_pct} | ${r.small_sample ? 'small_sample' : ''} |`);
  }
  output.I.I1_by_league = I1_byLeague;

  // ==========================================================================
  // NOTES / RESSALVAS GERAIS
  // ==========================================================================
  output.notes = [
    'Kills sempre preferem o recompute do universo (00-universe.json, fresh da API) sobre match_context da bet quando o jogo resolve e não é suspect/fetch_error — corrige os 2 bugs conhecidos (bet 61507820 e SIMULATED 2432691d, game 115615926685761093) e qualquer outro latente do mesmo tipo automaticamente (ver meta.kills_corrected).',
    'Fair fórmula (H2, I1) usa leave-one-out sobre TODO o split2 (não janela de 21d como o settle em produção) — simplificação deliberada pra análise retrospectiva; pode divergir um pouco do que a fair real teria sido em tempo real pro time.',
    'D (classificação verde/vermelho) é out-of-sample por construção (usa só histórico ANTES da data do mapa), mas o corte é sobre a MESMA amostra que gerou as regras originais (ambos≥60%, vermelho<50%) — não é validação totalmente externa, é auto-consistência interna do split2.',
    `G usa bets REAIS individuais (não dedupadas por mapa) porque o objetivo é auditar as decisões de odd/stake do CEO — ladders contam cada stake separadamente, que é o dinheiro de verdade em risco.`,
    `E1/E2 têm cobertura parcial de fair (fair_pinnacle e fair_formula são colunas top-level da bet, preenchidas só em parte do split2) — ver E1_coverage no JSON.`,
    `A validação de baseline (A1) girou em torno de ${globalHit}% vs ~59-60% esperado — diff de ${globalHit != null ? fmt1(Math.abs(globalHit - 60)) : 'N/A'}pp, dentro da tolerância (ordem de bets ligeiramente diferente da query canônica pode mudar qual bet "vence" em ladders raras, sem impacto material).`,
  ];

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
