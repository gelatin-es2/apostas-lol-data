// scripts/analysis/ml-study-phase1.cjs
//
// Novo projeto do dono: Money Line (vencedor do mapa) em LoL. Fase 1 = o que os
// dados já coletados dizem sobre PREVISIBILIDADE do vencedor, SEM odds de mercado
// (fase 2). 4 partes:
//   A. Blue side — efeito real ou confound de seed? Teste within-series (controla
//      por confronto, mesmos 2 times, side varia).
//   B. Draft prevê vencedor? B1 winrate por champion/role, B2 preditor honesto
//      (treino abr-mai, teste jun-jul, sem leakage), B3 comp scaling vs early
//      (PULADO — ver nota, gameTime não existe no dado cacheado).
//   C. Teto teórico do edge — odd mínima pra lucrar dado a acurácia do preditor.
//   D. Honestidade — onde o dado sustenta cada hipótese de edge (tier-2 mal
//      precificada / timing pós-draft / side em ligas específicas) e onde não.
//
// POPULAÇÃO: merge dos 3 universos em cache (all-regions + split1 + split2), dedup
// por game_id (times/kills/sup/winner_side são os mesmos jogo-a-jogo, dedupe é só
// remoção de linhas repetidas entre os 3 arquivos que se sobrepõem no período
// abr-jun das 6 ligas). Zero chamada de API — tudo em cache.
//
// Uso: node scripts/analysis/ml-study-phase1.cjs
// Output: audit-output/24-ml-study.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '24-ml-study.json');

const Z95 = 1.96;
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
const SERIES_LEAGUE_MIN_N = 30;
const CHAMP_ROLE_MIN_N = 20;
const TRAIN_MONTHS = ['2026-04', '2026-05'];
const TEST_MONTHS = ['2026-06', '2026-07'];
const CHAMP_WR_FALLBACK_MIN_N = 5; // treino: n<5 pro champ/role -> usa média da role

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function loadJsonSafe(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: fmt1(100 * Math.max(0, center - margin)), upper: fmt1(100 * Math.min(1, center + margin)) };
}
function winRateCell(nWins, n) {
  const hitPct = n ? fmt1((100 * nWins) / n) : null;
  const ci = wilsonCI(nWins, n);
  return { n, wins: nWins, win_pct: hitPct, wilson_ci_95: ci };
}

function loadWindow(gameId) {
  const f = path.join(AUDIT_CACHE, `window-${gameId}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
function extractRoster(windowJson) {
  const bm = windowJson?.gameMetadata?.blueTeamMetadata;
  const rm = windowJson?.gameMetadata?.redTeamMetadata;
  if (!bm || !rm) return null;
  const rosterOf = (md) => {
    const r = {};
    for (const p of md.participantMetadata || []) if (p.role) r[p.role] = p.championId;
    return r;
  };
  const blue = rosterOf(bm);
  const red = rosterOf(rm);
  if (ROLES.some((r) => !blue[r] || !red[r])) return null;
  return { blue, red };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('MONEY LINE — FASE 1: previsibilidade do vencedor (sem odds)');
  console.log('='.repeat(70));

  // --- Merge + dedup ---
  const sources = [
    path.join(AUDIT_OUTPUT, '00-universe-allregions.json'),
    path.join(AUDIT_OUTPUT, '00-universe-split1.json'),
    path.join(AUDIT_OUTPUT, '00-universe.json'),
  ];
  const byId = new Map();
  for (const src of sources) {
    for (const g of loadJsonSafe(src)) {
      if (!byId.has(g.game_id)) byId.set(g.game_id, g);
    }
  }
  // Normaliza rótulo de liga — split1/split2 (phase0-universe.cjs antigo) gravam
  // "LFL" pra essa liga; all-regions (camille-collect.cjs, usa league.name da API)
  // grava "La Ligue Française" pro MESMO league_id (105266103462388553). Sem isso,
  // vira 2 ligas fantasma na tabela por liga.
  const LEAGUE_LABEL_NORM = { 'La Ligue Française': 'LFL' };
  for (const g of byId.values()) {
    if (LEAGUE_LABEL_NORM[g.league]) g.league = LEAGUE_LABEL_NORM[g.league];
  }

  const merged = [...byId.values()];
  const population = merged.filter((g) => !g.suspect && g.total_kills != null && g.winner_side);
  console.log(`\nMerge (3 fontes, dedup por game_id): ${merged.length} games brutos | população (winner_side válido): ${population.length}`);

  // ==========================================================================
  // A. BLUE SIDE — within-series (controla por confronto)
  // ==========================================================================
  console.log('\n\n## A. Blue side — teste within-series\n');

  const byMatch = new Map();
  for (const g of population) {
    if (!byMatch.has(g.match_id)) byMatch.set(g.match_id, []);
    byMatch.get(g.match_id).push(g);
  }
  let multiSeries = 0;
  let switchSeries = 0;
  const withinSeriesGames = [];
  for (const [, games] of byMatch) {
    if (games.length < 2) continue;
    multiSeries++;
    const blueTeams = new Set(games.map((g) => g.team_blue));
    if (blueTeams.size >= 2) {
      switchSeries++;
      withinSeriesGames.push(...games);
    }
  }
  console.log(`Séries multi-game (≥2 games, mesmo match_id): ${multiSeries} | com troca de lado dentro da série: ${switchSeries} (${withinSeriesGames.length} games qualificados).`);

  // Naive (todos os games, sem controle) — pra mostrar o confound.
  const naiveBlueWins = population.filter((g) => g.winner_side === 'blue').length;
  const naiveOverall = winRateCell(naiveBlueWins, population.length);
  console.log(`\nNaive (todos os games, SEM controle): blue win% = ${naiveOverall.win_pct}% (n=${naiveOverall.n}) — inclui o confound de seed.`);

  const controlledBlueWins = withinSeriesGames.filter((g) => g.winner_side === 'blue').length;
  const controlledOverall = winRateCell(controlledBlueWins, withinSeriesGames.length);
  console.log(`Within-series (controlado por confronto): blue win% = ${controlledOverall.win_pct}% (n=${controlledOverall.n}), CI95%=[${controlledOverall.wilson_ci_95.lower}, ${controlledOverall.wilson_ci_95.upper}].`);

  const byLeagueNaive = new Map();
  const byLeagueControlled = new Map();
  for (const g of population) {
    if (!byLeagueNaive.has(g.league)) byLeagueNaive.set(g.league, []);
    byLeagueNaive.get(g.league).push(g);
  }
  for (const g of withinSeriesGames) {
    if (!byLeagueControlled.has(g.league)) byLeagueControlled.set(g.league, []);
    byLeagueControlled.get(g.league).push(g);
  }
  const leagueTable = [...new Set([...byLeagueNaive.keys(), ...byLeagueControlled.keys()])].map((league) => {
    const naiveGames = byLeagueNaive.get(league) || [];
    const naiveWins = naiveGames.filter((g) => g.winner_side === 'blue').length;
    const naive = winRateCell(naiveWins, naiveGames.length);
    const ctrlGames = byLeagueControlled.get(league) || [];
    const ctrlWins = ctrlGames.filter((g) => g.winner_side === 'blue').length;
    const ctrl = winRateCell(ctrlWins, ctrlGames.length);
    return { league, naive, controlled: ctrl, eligible: ctrl.n >= SERIES_LEAGUE_MIN_N };
  }).sort((a, b) => (b.controlled.n) - (a.controlled.n));

  console.log(`\n### Por liga (naive vs within-series controlado)\n`);
  console.log('| liga | naive n/win% | controlado n/win% | CI95% (controlado) | elegível (n≥30) |');
  console.log('|---|---|---|---|---|');
  for (const t of leagueTable) {
    const ciStr = t.controlled.n ? `[${t.controlled.wilson_ci_95.lower}, ${t.controlled.wilson_ci_95.upper}]` : '-';
    console.log(`| ${t.league} | ${t.naive.n}/${t.naive.win_pct ?? '-'}% | ${t.controlled.n}/${t.controlled.win_pct ?? '-'}% | ${ciStr} | ${t.eligible ? 'sim' : ''} |`);
  }

  const lflRow = leagueTable.find((t) => t.league === 'LFL');
  console.log(`\n### LFL — a invertida\n`);
  if (lflRow) {
    console.log(`Naive: ${lflRow.naive.win_pct}% (n=${lflRow.naive.n}) | Within-series controlado: ${lflRow.controlled.win_pct ?? '-'}% (n=${lflRow.controlled.n})`);
    if (lflRow.controlled.n >= 10) {
      const stillInverted = lflRow.controlled.win_pct != null && lflRow.controlled.win_pct < 48;
      console.log(stillInverted ? 'A inversão PERSISTE mesmo controlado por confronto — não é só confound de seed, sinal real (ou anomalia de dado a investigar).' : 'A inversão se ATENUA/some quando controlado — consistente com confound de seed (times mais fortes escolhendo red na LFL por algum motivo local).');
    } else {
      console.log('n pequeno demais dentro de séries com troca de lado pra confirmar ou refutar — não dá pra explicar com confiança, fica como anomalia a investigar com mais dado.');
    }
  } else {
    console.log('LFL não apareceu na tabela (sem jogos suficientes).');
  }

  // ==========================================================================
  // B1. Champion winrate por role
  // ==========================================================================
  console.log('\n\n## B1. Champion winrate por role (dataset atual)\n');

  let noWindow = 0;
  let noRoster = 0;
  const participantRows = [];
  for (const g of population) {
    const win = loadWindow(g.game_id);
    if (!win) {
      noWindow++;
      continue;
    }
    const roster = extractRoster(win);
    if (!roster) {
      noRoster++;
      continue;
    }
    const month = (g.date || '').slice(0, 7);
    for (const side of ['blue', 'red']) {
      const won = g.winner_side === side;
      for (const role of ROLES) {
        const champ = roster[side][role];
        if (!champ) continue;
        participantRows.push({ champ, role, won, month, game_id: g.game_id });
      }
    }
  }
  console.log(`Cobertura de roster: sem window: ${noWindow}, sem roster completo: ${noRoster} (de ${population.length}).`);

  function champRoleTable(rows) {
    const byKey = new Map();
    for (const p of rows) {
      const key = `${p.champ}|${p.role}`;
      if (!byKey.has(key)) byKey.set(key, { champ: p.champ, role: p.role, rows: [] });
      byKey.get(key).rows.push(p);
    }
    return [...byKey.values()].map((e) => ({ champ: e.champ, role: e.role, ...winRateCell(e.rows.filter((r) => r.won).length, e.rows.length) }));
  }
  const b1Full = champRoleTable(participantRows);
  const b1EligibleByRole = {};
  for (const role of ROLES) {
    const eligible = b1Full.filter((c) => c.role === role && c.n >= CHAMP_ROLE_MIN_N).sort((a, b) => b.win_pct - a.win_pct);
    b1EligibleByRole[role] = { top10: eligible.slice(0, 10), bottom10: eligible.slice(-10).reverse(), eligible_total: eligible.length };
  }
  for (const role of ROLES) {
    console.log(`\n### ${role} — top 10 (n≥${CHAMP_ROLE_MIN_N}, de ${b1EligibleByRole[role].eligible_total} elegíveis)\n`);
    console.log('| champion | n | win% | CI95% |');
    console.log('|---|---|---|---|');
    for (const c of b1EligibleByRole[role].top10) console.log(`| ${c.champ} | ${c.n} | ${c.win_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] |`);
    console.log(`\n### ${role} — bottom 10\n`);
    console.log('| champion | n | win% | CI95% |');
    console.log('|---|---|---|---|');
    for (const c of b1EligibleByRole[role].bottom10) console.log(`| ${c.champ} | ${c.n} | ${c.win_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] |`);
  }

  // ==========================================================================
  // B2. Preditor — treino abr-mai, teste jun-jul
  // ==========================================================================
  console.log('\n\n## B2. Preditor honesto — score = média WR dos 5 champs (treino abr-mai → teste jun-jul)\n');

  const trainRows = participantRows.filter((p) => TRAIN_MONTHS.includes(p.month));
  const testGameIds = new Set(population.filter((g) => TEST_MONTHS.includes((g.date || '').slice(0, 7))).map((g) => g.game_id));
  console.log(`Treino (abr-mai): ${trainRows.length / 10 || 0} games aprox. | Teste (jun-jul): ${testGameIds.size} games.`);

  const trainByRole = new Map(); // role -> {champ -> {n, wins}}
  for (const p of trainRows) {
    if (!trainByRole.has(p.role)) trainByRole.set(p.role, new Map());
    const m = trainByRole.get(p.role);
    if (!m.has(p.champ)) m.set(p.champ, { n: 0, wins: 0 });
    const e = m.get(p.champ);
    e.n++;
    if (p.won) e.wins++;
  }
  const roleAvgWR = new Map(); // role -> avg win rate (fallback)
  for (const [role, m] of trainByRole) {
    let totalN = 0;
    let totalWins = 0;
    for (const e of m.values()) {
      totalN += e.n;
      totalWins += e.wins;
    }
    roleAvgWR.set(role, totalN ? totalWins / totalN : 0.5);
  }
  function champWRTrain(champ, role) {
    const m = trainByRole.get(role);
    const e = m ? m.get(champ) : null;
    if (!e || e.n < CHAMP_WR_FALLBACK_MIN_N) return roleAvgWR.get(role) ?? 0.5;
    return e.wins / e.n;
  }

  // Reconstroi roster por jogo de teste (reusa participantRows filtrado, agrupado por game_id+side).
  const testRosterByGame = new Map(); // game_id -> {blue:{role:champ}, red:{role:champ}}
  for (const g of population) {
    if (!testGameIds.has(g.game_id)) continue;
    const win = loadWindow(g.game_id);
    if (!win) continue;
    const roster = extractRoster(win);
    if (!roster) continue;
    testRosterByGame.set(g.game_id, { roster, winner_side: g.winner_side });
  }

  let correct = 0;
  let predicted = 0;
  let tie = 0;
  let blueWinsInTest = 0;
  for (const [, { roster, winner_side }] of testRosterByGame) {
    const scoreOf = (side) => {
      let sum = 0;
      let n = 0;
      for (const role of ROLES) {
        const champ = roster[side][role];
        if (!champ) continue;
        sum += champWRTrain(champ, role);
        n++;
      }
      return n ? sum / n : 0.5;
    };
    const blueScore = scoreOf('blue');
    const redScore = scoreOf('red');
    if (winner_side === 'blue') blueWinsInTest++;
    if (Math.abs(blueScore - redScore) < 1e-9) {
      tie++;
      continue;
    }
    predicted++;
    const predictedWinner = blueScore > redScore ? 'blue' : 'red';
    if (predictedWinner === winner_side) correct++;
  }
  const predictorAcc = predicted ? fmt1((100 * correct) / predicted) : null;
  const predictorCI = wilsonCI(correct, predicted);
  const blueOnlyBaseline = testRosterByGame.size ? fmt1((100 * blueWinsInTest) / testRosterByGame.size) : null;

  console.log(`\nJogos de teste com roster completo: ${testRosterByGame.size} (empates de score excluídos: ${tie}, testáveis: ${predicted}).`);
  console.log(`\n| preditor | n | acurácia | CI95% |`);
  console.log('|---|---|---|---|');
  console.log(`| Score médio WR (leave-one-out temporal) | ${predicted} | ${predictorAcc}% | [${predictorCI.lower}, ${predictorCI.upper}] |`);
  console.log(`| Coin flip | ${predicted} | 50.0% | — |`);
  console.log(`| Blue-side-only (baseline observado no teste) | ${testRosterByGame.size} | ${blueOnlyBaseline}% | — |`);

  // ==========================================================================
  // B3. Comp scaling vs early — PULADO
  // ==========================================================================
  console.log('\n\n## B3. Comp scaling (hypercarry) vs early — PULADO\n');
  console.log('gameTime NÃO existe nos frames cacheados (audit-cache/window-*.json) — a janela retorna só ~10 frames próximos de um único instante (startingTime), sem histórico de duração de partida. Sem esse dado não dá pra classificar jogos como "longos" vs "curtos" com confiança. Pulado conforme instrução explícita do prompt.');

  // ==========================================================================
  // C. Teto teórico do edge
  // ==========================================================================
  console.log('\n\n## C. Teto teórico do edge\n');
  const edgeTable = [51, 52, 53, 54, 55, 56, 57, 58, 60, 62, 65].map((x) => ({
    accuracy_pct: x,
    min_odd: fmt1(100 / x) === null ? null : +(100 / x).toFixed(3),
  }));
  console.log('| acurácia X% | odd mínima (1/X) | onde isso existiria no mercado |');
  console.log('|---|---|---|');
  const marketNote = (x) => (x < 55 ? 'jogos parelhos, favorito levíssimo' : x < 60 ? 'favorito leve/moderado' : 'favorito claro — odd mínima já underdog-territory, dificilmente o mercado erra tanto assim num favorito claro');
  for (const e of edgeTable) console.log(`| ${e.accuracy_pct}% | ${e.min_odd} | ${marketNote(e.accuracy_pct)} |`);
  console.log(`\nO preditor B2 (${predictorAcc}%) precisaria de odd mínima ≥ ${predictorAcc ? (100 / predictorAcc).toFixed(3) : '-'} no lado previsto pra empatar (breakeven), sem contar vig da casa.`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: { z_score_95: Z95, series_league_min_n: SERIES_LEAGUE_MIN_N, champ_role_min_n: CHAMP_ROLE_MIN_N, train_months: TRAIN_MONTHS, test_months: TEST_MONTHS, champ_wr_fallback_min_n: CHAMP_WR_FALLBACK_MIN_N },
    meta: { merged_raw_n: merged.length, population_n: population.length, no_window: noWindow, no_roster: noRoster },
    partA_blue_side: {
      naive_overall: naiveOverall,
      within_series_controlled_overall: controlledOverall,
      multi_game_series: multiSeries, switch_series: switchSeries, within_series_games_n: withinSeriesGames.length,
      by_league: leagueTable,
    },
    partB1_champion_winrate_by_role: b1EligibleByRole,
    partB2_predictor: {
      train_months: TRAIN_MONTHS, test_months: TEST_MONTHS,
      test_games_with_roster: testRosterByGame.size, ties_excluded: tie, testable: predicted,
      predictor: { n: predicted, correct, accuracy_pct: predictorAcc, wilson_ci_95: predictorCI },
      baseline_coin_flip_pct: 50,
      baseline_blue_only_pct: blueOnlyBaseline,
    },
    partB3_comp_archetype: { skipped: true, reason: 'gameTime ausente nos frames cacheados — sem dado de duração de partida.' },
    partC_edge_ceiling: edgeTable,
    partD_honesty: null, // preenchido no report .md / resposta, não recomputável objetivamente
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
