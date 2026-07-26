// scripts/audit/phase1-coverage.cjs
//
// Fase 1: cruza universo (fase 0) × bets. Responde 3 perguntas:
//   a) todo jogo do split2 que disparou o método (trigger_type != null, não-suspect,
//      sem fetch_error) tem pelo menos 1 bet (real ou SIMULATED)? (MISSING_BET)
//   b) toda bet do método (is_method_bet=true) aponta pra um jogo real do universo?
//      (ORPHAN_BET, exceto ligas fora das 6 operadas → OUT_OF_UNIVERSE)
//   c) o results.json do cron (fonte do method_reports/dashboard) bate com o trigger
//      recomputado agora contra a API? (TRIGGER_DIVERGENCE_RESULTS — quantifica bug
//      do Alistar no script arquivado)
//
// Uso: node phase1-coverage.cjs
// Output: audit-output/01-coverage.json

'use strict';

const fs = require('fs');
const path = require('path');

const {
  loadAllBets,
  inScope,
  isEwc,
  SPLIT2_FROM,
  SPLIT2_TO,
  LEAGUE_IDS,
} = require('./lib/audit-common.cjs');
const { buildUniverseIndex, findGameForBet } = require('./lib/match-bet-to-game.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');
const CRON_DIR = path.join(ROOT, 'cron-data');
const UNIVERSE_FILE = path.join(OUTPUT_DIR, '00-universe.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '01-coverage.json');

const UNIVERSE_LEAGUES = new Set(Object.keys(LEAGUE_IDS)); // as 6 ligas operadas na fase 0

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_FILE)) {
    console.error(`FATAL: ${UNIVERSE_FILE} não existe. Rode fase 0 primeiro.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
}

function listResultsFiles() {
  if (!fs.existsSync(CRON_DIR)) return [];
  return fs
    .readdirSync(CRON_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-results\.json$/.test(f))
    .map((f) => ({ file: f, date: f.slice(0, 10) }))
    .filter((r) => r.date >= SPLIT2_FROM && r.date < SPLIT2_TO)
    .sort((a, b) => a.date.localeCompare(b.date));
}

(async () => {
  const universe = loadUniverse();
  const universeIndex = buildUniverseIndex(universe);

  const allBets = await loadAllBets();
  const scopedBets = allBets.filter((b) => inScope(b) && !isEwc(b));

  // === (a) MISSING_BET ===
  // Games elegíveis: trigger_type setado, não-suspect, sem fetch_error.
  const eligibleTriggerGames = universe.filter((g) => g.trigger_type && !g.suspect && !g.fetch_error);
  const manualVerificationGames = universe.filter((g) => g.trigger_type && (g.suspect || g.fetch_error));

  // Set de game_ids cobertos por QUALQUER bet do escopo (real ou SIMULATED), casada
  // por qualquer uma das 4 camadas de match-bet-to-game.cjs.
  const coveredGameIds = new Set();
  const betMatches = new Map(); // bet.id -> { game, tier, ambiguous, candidateCount }
  for (const bet of scopedBets) {
    const m = findGameForBet(bet, universeIndex);
    betMatches.set(bet.id, m);
    if (m.game) coveredGameIds.add(String(m.game.game_id));
  }

  const missingBets = eligibleTriggerGames
    .filter((g) => !coveredGameIds.has(String(g.game_id)))
    .map((g) => ({
      check: 'MISSING_BET',
      severity: 'HIGH',
      game_id: g.game_id,
      match_id: g.match_id,
      league: g.league,
      date: g.date,
      map_number: g.map_number,
      team_blue: g.team_blue,
      team_red: g.team_red,
      trigger_type: g.trigger_type,
      kills_blue: g.kills_blue,
      kills_red: g.kills_red,
      total_kills: g.total_kills,
    }));

  // === (b) ORPHAN_BET / OUT_OF_UNIVERSE ===
  // Só bets do MÉTODO (is_method_bet=true) — bet manual fora do método não é escopo
  // de cobertura do método.
  const orphanBets = [];
  const outOfUniverseBets = [];
  for (const bet of scopedBets) {
    if (!bet.is_method_bet) continue;
    const leagueKey = (bet.league || '').toUpperCase();
    if (!UNIVERSE_LEAGUES.has(leagueKey)) {
      outOfUniverseBets.push({
        check: 'OUT_OF_UNIVERSE',
        severity: 'INFO',
        bet_id: bet.id,
        league: bet.league,
        team_a: bet.team_a,
        team_b: bet.team_b,
        bet_datetime: bet.bet_datetime,
        map_number: bet.map_number,
        note: 'Liga fora das 6 operadas na fase 0 (LCK/LPL/LEC/CBLOL/LFL/LCS) — sem cobertura de universo, não é órfã.',
      });
      continue;
    }
    const m = betMatches.get(bet.id);
    if (!m.game) {
      orphanBets.push({
        check: 'ORPHAN_BET',
        severity: 'HIGH',
        bet_id: bet.id,
        league: bet.league,
        team_a: bet.team_a,
        team_b: bet.team_b,
        bet_datetime: bet.bet_datetime,
        map_number: bet.map_number,
        market: bet.market,
        pick: bet.pick,
        ambiguous_candidates: m.ambiguous ? m.candidateCount : undefined,
        note: m.ambiguous
          ? `${m.candidateCount} candidatos ambíguos no universo (nomes/data/map_number não desempataram)`
          : 'nenhum jogo do universo casou (game_id/match_id/nomes+data+map)',
      });
    }
  }

  // === (c) TRIGGER_DIVERGENCE_RESULTS ===
  const resultsFiles = listResultsFiles();
  const triggerDivergences = [];
  let resultsGamesCompared = 0;
  let resultsGamesNotInUniverse = 0;
  for (const { file, date } of resultsFiles) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(CRON_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    for (const r of data.results || []) {
      if (!r.game_id) continue;
      const g = universeIndex.byGameId.get(String(r.game_id));
      if (!g) {
        resultsGamesNotInUniverse++;
        continue;
      }
      resultsGamesCompared++;
      const resultsTrigger = r.trigger_type || null;
      const universeTrigger = g.trigger_type || null;
      if (resultsTrigger !== universeTrigger) {
        triggerDivergences.push({
          check: 'TRIGGER_DIVERGENCE_RESULTS',
          severity: 'MEDIUM',
          report_only: true,
          date,
          game_id: r.game_id,
          match_id: g.match_id,
          league: g.league,
          team_blue: g.team_blue,
          team_red: g.team_red,
          sup_blue_results: r.sup_blue,
          sup_red_results: r.sup_red,
          sup_blue_universe: g.sup_blue,
          sup_red_universe: g.sup_red,
          results_trigger: resultsTrigger,
          universe_trigger: universeTrigger,
          alistar_involved: r.sup_blue === 'Alistar' || r.sup_red === 'Alistar',
          game_suspect: g.suspect,
          game_fetch_error: !!g.fetch_error,
        });
      }
    }
  }

  // === (d) RESULTS_JSON_GAP ===
  const resultsDates = new Set(resultsFiles.map((r) => r.date));
  const gamesByDate = new Map();
  for (const g of universe) {
    const d = (g.date || '').slice(0, 10);
    if (!d) continue;
    if (!gamesByDate.has(d)) gamesByDate.set(d, []);
    gamesByDate.get(d).push(g);
  }
  const resultsJsonGap = [];
  for (const [date, games] of [...gamesByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (resultsDates.has(date)) continue;
    resultsJsonGap.push({
      check: 'RESULTS_JSON_GAP',
      severity: 'INFO',
      date,
      games_count: games.length,
      leagues: [...new Set(games.map((g) => g.league))].sort(),
    });
  }

  // === Contagens pra stdout ===
  const countBy = (arr, field) => {
    const out = {};
    for (const x of arr) out[x[field]] = (out[x[field]] || 0) + 1;
    return out;
  };

  const output = {
    generated_at: new Date().toISOString(),
    split2_range: { from: SPLIT2_FROM, to: SPLIT2_TO },
    universe_summary: {
      total_games: universe.length,
      games_with_trigger: universe.filter((g) => g.trigger_type).length,
      eligible_trigger_games: eligibleTriggerGames.length,
      manual_verification_games_with_trigger: manualVerificationGames.length,
    },
    scoped_bets_total: scopedBets.length,
    missing_bets: missingBets,
    orphan_bets: orphanBets,
    out_of_universe_bets: outOfUniverseBets,
    manual_verification_games: manualVerificationGames.map((g) => ({
      game_id: g.game_id,
      match_id: g.match_id,
      league: g.league,
      date: g.date,
      map_number: g.map_number,
      team_blue: g.team_blue,
      team_red: g.team_red,
      trigger_type: g.trigger_type,
      reason: g.fetch_error ? 'fetch_error' : 'suspect_frame',
      fetch_error_detail: g.fetch_error || null,
      note: 'Verificar manual no gol.gg/Leaguepedia — frame não confiável, nunca vira MISSING_BET/finding contra bet.',
    })),
    trigger_divergence_results: triggerDivergences,
    results_json_gap: resultsJsonGap,
    counts: {
      missing_bets_by_league: countBy(missingBets, 'league'),
      orphan_bets_by_league: countBy(orphanBets, 'league'),
      out_of_universe_by_league: countBy(outOfUniverseBets, 'league'),
      trigger_divergence_by_league: countBy(triggerDivergences, 'league'),
      trigger_divergence_alistar_count: triggerDivergences.filter((d) => d.alistar_involved).length,
      trigger_divergence_total: triggerDivergences.length,
      results_games_compared: resultsGamesCompared,
      results_games_not_in_universe: resultsGamesNotInUniverse,
      results_json_gap_days: resultsJsonGap.length,
    },
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('=== FASE 1 — COBERTURA ===');
  console.log(`Universo: ${universe.length} games | com trigger: ${output.universe_summary.games_with_trigger} | elegíveis p/ MISSING_BET: ${eligibleTriggerGames.length} | manual (suspect/fetch_error c/ trigger): ${manualVerificationGames.length}`);
  console.log(`Bets no escopo (non-EWC): ${scopedBets.length}`);
  console.log('');
  console.log(`MISSING_BET (HIGH): ${missingBets.length}`);
  console.log('  por liga:', JSON.stringify(output.counts.missing_bets_by_league));
  console.log(`ORPHAN_BET (HIGH): ${orphanBets.length}`);
  console.log('  por liga:', JSON.stringify(output.counts.orphan_bets_by_league));
  console.log(`OUT_OF_UNIVERSE (INFO): ${outOfUniverseBets.length}`);
  console.log('  por liga:', JSON.stringify(output.counts.out_of_universe_by_league));
  console.log(`TRIGGER_DIVERGENCE_RESULTS (MEDIUM, report-only): ${triggerDivergences.length} de ${resultsGamesCompared} comparados (${resultsGamesNotInUniverse} results games não achados no universo)`);
  console.log(`  dos quais com Alistar envolvido: ${output.counts.trigger_divergence_alistar_count}`);
  console.log('  por liga:', JSON.stringify(output.counts.trigger_divergence_by_league));
  console.log(`RESULTS_JSON_GAP (INFO): ${resultsJsonGap.length} dias sem results.json (de ${gamesByDate.size} dias com jogos no universo)`);
  console.log('');
  console.log(`Output: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
