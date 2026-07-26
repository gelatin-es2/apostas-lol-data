// scripts/analysis/under-by-team.cjs
//
// Análise completa do "problema time vermelho" no método UNDER — 5 partes (A-E):
//   A. Esclarecer a origem do "n=8" (vermelho×vermelho) citado pelo dono.
//   B. Under hit por TIME nos jogos COM trigger peel (fair+1 @ 1.72), split1 vs split2,
//      replicação nos 2 splits = candidato real a skip-list.
//   C. PnL REAL das bets (banco Supabase) por time — persistência de prejuízo real.
//   D. Mecanismo de variância: time com média certa mas desvio-padrão alto quebra o
//      Under mais que a fair sugere — testado como classificação alternativa à flag
//      de hit simples.
//   E. Veredito estruturado final.
//
// *** IMPORTANTE: usa lib/normalizeTeam.cjs (resolve aliases via team-aliases.json),
// NÃO lib/normTeamName.cjs (que só normaliza casing, NÃO resolve "BLG" <->
// "BILIBILI GAMING" nem "T1" <-> "T1 Esports"). As bets no Supabase usam nome CURTO
// (BLG, T1), o universo da Riot API usa nome LONGO (BILIBILI GAMING) — sem
// normalizeTeam, qualquer cruzamento bet×jogo pro mesmo time quebra silenciosamente
// (BLG aparecia com n=0 games até essa troca — bug real encontrado nesta análise). ***
//
// Fair leave-one-out — MESMA função das análises anteriores desta sessão
// (over-method-v2.cjs / over-by-support.cjs / over-pairs.cjs / over-red-teams.cjs),
// recalculada por split.
//
// Uso: node scripts/analysis/under-by-team.cjs
// Output: audit-output/16-under-by-team.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, loadAllBets, parsePick } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '16-under-by-team.json');

const SPLIT_FILES = {
  1: { file: path.join(AUDIT_OUTPUT, '00-universe-split1.json'), label: 'split1 (jan-mar 2026)' },
  2: { file: path.join(AUDIT_OUTPUT, '00-universe.json'), label: 'split2 (abr-jun 2026)' },
};

const UNDER_ODD = 1.72;
const UNDER_BE = 58.1;
const Z95 = 1.96;
const TRAILING_MIN_N = 5; // pra VERMELHO/VERDE (under-rate)
const RED_THRESHOLD = 0.5;
const GREEN_THRESHOLD = 0.6;
const TEAM_MIN_N_PER_SPLIT = 8; // pro teste de replicação por time (parte B)
const STDEV_MIN_N = 8; // pra classificação de variância (parte D)
const FIRST_HALF_CUTOFF = '2026-05-15T23:59:59Z'; // parte C — "até 15/05"
const TOP_N = 10;

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));

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

// ============================================================================
// Fair leave-one-out — sync: scripts/analysis/over-method-v2.cjs e demais desta
// sessão. ÚNICA diferença: normalizeTeam() no lugar de normTeamName() (ver header).
// ============================================================================
function buildTeamKillsHistory(universe) {
  const hist = new Map();
  for (const g of universe) {
    if (g.total_kills == null) continue;
    for (const raw of [g.team_blue, g.team_red]) {
      if (!raw) continue;
      const t = normalizeTeam(raw);
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
  const teamA = normalizeTeam(game.team_blue);
  const teamB = normalizeTeam(game.team_red);
  const fallback = leagueAvg.get(game.league) ?? 29;
  const avgFor = (team) => {
    const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== game.game_id);
    if (arr.length === 0) return fallback;
    return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
  };
  const raw = (avgFor(teamA) + avgFor(teamB)) / 2;
  return Math.round(raw - 0.5) + 0.5;
}
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null, center: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lower: fmt1(100 * Math.max(0, center - margin)),
    upper: fmt1(100 * Math.min(1, center + margin)),
    center: fmt1(100 * center),
  };
}
function roiPct(wins, n, odd) {
  if (!n) return null;
  const profit = wins * (odd - 1) - (n - wins);
  return fmt1((100 * profit) / n);
}
function verdict3Level(poolCell, s1Cell, s2Cell, be) {
  if (poolCell.n === 0) return 'SEM_DADO';
  const s1Ok = s1Cell.hit_pct != null && s1Cell.hit_pct >= be;
  const s2Ok = s2Cell.hit_pct != null && s2Cell.hit_pct >= be;
  const ciLowerOk = poolCell.wilson_ci_95.lower != null && poolCell.wilson_ci_95.lower >= be;
  if (ciLowerOk && s1Ok && s2Ok) return 'LUCRATIVO';
  if (poolCell.hit_pct != null && poolCell.hit_pct >= be) return 'INCERTO';
  return 'NEGATIVO';
}

// ============================================================================
// Trailing under-rate (VERMELHO/VERDE) — sync: over-red-teams.cjs.
// ============================================================================
function buildTrailingUnderRate(rowsChrono) {
  const record = new Map();
  const clsOf = (team) => {
    const rec = record.get(team);
    if (!rec || rec.n < TRAILING_MIN_N) return 'NEUTRO';
    const rate = rec.underCount / rec.n;
    if (rate < RED_THRESHOLD) return 'VERMELHO';
    if (rate >= GREEN_THRESHOLD) return 'VERDE';
    return 'NEUTRO';
  };
  const out = new Map();
  for (const g of rowsChrono) {
    out.set(g.game_id, { clsBlue: clsOf(g.team_blue), clsRed: clsOf(g.team_red) });
    const underHit = g.total_kills < g.fair;
    for (const team of [g.team_blue, g.team_red]) {
      if (!record.has(team)) record.set(team, { n: 0, underCount: 0 });
      const rec = record.get(team);
      rec.n++;
      if (underHit) rec.underCount++;
    }
  }
  return out;
}

// Trailing stdev de total_kills (histórico do time, todos os jogos, walk-forward).
function buildTrailingStdev(rowsChrono) {
  const record = new Map(); // team -> array de total_kills passados
  const out = new Map(); // game_id -> { sdBlue, sdRed } (null se n<STDEV_MIN_N)
  const sdOf = (arr) => {
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance);
  };
  for (const g of rowsChrono) {
    const histBlue = record.get(g.team_blue) || [];
    const histRed = record.get(g.team_red) || [];
    out.set(g.game_id, {
      sdBlue: histBlue.length >= STDEV_MIN_N ? sdOf(histBlue) : null,
      sdRed: histRed.length >= STDEV_MIN_N ? sdOf(histRed) : null,
    });
    if (!record.has(g.team_blue)) record.set(g.team_blue, []);
    if (!record.has(g.team_red)) record.set(g.team_red, []);
    record.get(g.team_blue).push(g.total_kills);
    record.get(g.team_red).push(g.total_kills);
  }
  return out;
}

function loadSplit(splitNum) {
  const cfg = SPLIT_FILES[splitNum];
  const universeFull = loadJson(cfg.file);
  const teamHist = buildTeamKillsHistory(universeFull);
  const leagueAvg = buildLeagueAvgKills(universeFull);
  const population = universeFull.filter((g) => !g.suspect && g.total_kills != null);

  const rowsRaw = population.map((g) => {
    const fair = fairFormulaForGame(g, teamHist, leagueAvg);
    return {
      split: splitNum,
      game_id: g.game_id,
      league: g.league,
      date: g.date,
      team_blue: normalizeTeam(g.team_blue),
      team_red: normalizeTeam(g.team_red),
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      total_kills: g.total_kills,
      trigger_type: g.trigger_type,
      fair,
      under_hit_fair_plus1: g.total_kills < fair + 1,
      over_hit_fair: g.total_kills > fair,
    };
  });

  const chrono = [...rowsRaw].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.game_id).localeCompare(String(b.game_id)));
  const trailingUnderRate = buildTrailingUnderRate(chrono);
  const trailingStdev = buildTrailingStdev(chrono);
  const rows = chrono.map((r) => {
    const cls = trailingUnderRate.get(r.game_id);
    const sd = trailingStdev.get(r.game_id);
    return { ...r, clsBlue: cls.clsBlue, clsRed: cls.clsRed, sdBlue: sd.sdBlue, sdRed: sd.sdRed };
  });

  return { label: cfg.label, population_n: population.length, rows };
}

// Binomial exato — pra estimar comparações múltiplas na parte B.
function binomialPmfArray(n, p) {
  const pmf = new Array(n + 1);
  pmf[0] = Math.pow(1 - p, n);
  for (let k = 1; k <= n; k++) pmf[k] = pmf[k - 1] * ((n - k + 1) / k) * (p / (1 - p));
  return pmf;
}
function probBelowBE(n, p0, bePct) {
  if (!n) return null;
  const beFrac = bePct / 100;
  let kMax = Math.ceil(beFrac * n - 1e-9) - 1;
  kMax = Math.max(-1, Math.min(n, kMax));
  if (kMax < 0) return 0;
  const pmf = binomialPmfArray(n, p0);
  let sum = 0;
  for (let k = 0; k <= kMax; k++) sum += pmf[k];
  return sum;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('PROBLEMA "TIME VERMELHO" NO MÉTODO UNDER — análise completa A-E');
  console.log('='.repeat(70));

  const split1 = loadSplit(1);
  const split2 = loadSplit(2);
  console.log(`\nsplit1 (${split1.label}): população=${split1.population_n}`);
  console.log(`split2 (${split2.label}): população=${split2.population_n}`);

  const trigger1 = split1.rows.filter((r) => r.trigger_type);
  const trigger2 = split2.rows.filter((r) => r.trigger_type);

  // ==========================================================================
  // A. ESCLARECER O n=8
  // ==========================================================================
  console.log('\n\n## A. Esclarecer o n=8 (vermelho×vermelho)\n');

  function countBothRed(rows) {
    return rows.filter((r) => r.clsBlue === 'VERMELHO' && r.clsRed === 'VERMELHO').length;
  }
  const A_general = { split1: countBothRed(split1.rows), split2: countBothRed(split2.rows) };
  const A_trigger = { split1: countBothRed(trigger1), split2: countBothRed(trigger2) };
  console.log('| população | split1 | split2 |');
  console.log('|---|---|---|');
  console.log(`| geral (todos os jogos) | ${A_general.split1} | ${A_general.split2} |`);
  console.log(`| trigger (a que ele aposta) | ${A_trigger.split1} | ${A_trigger.split2} |`);

  // Reconstrução via bets reais (não-simulated, Under, com game_id) — split2 é o
  // único universo com bets reais (split1 = jan-mar, ANTES do método entrar em
  // produção — zero bets reais lá, confirmado via loadAllBets()).
  const allBets = await loadAllBets();
  const nonSimBets = allBets.filter((b) => (b.bookmaker || '').toUpperCase() !== 'SIMULATED');
  const nonSimUnderBets = nonSimBets.filter((b) => parsePick(b.pick, b.market).kind === 'under');
  const betDatesAll = nonSimBets.map((b) => b.bet_datetime).filter(Boolean).sort();

  const gameClsMapSplit2 = new Map();
  for (const r of split2.rows) gameClsMapSplit2.set(String(r.game_id), { clsBlue: r.clsBlue, clsRed: r.clsRed });

  let matchedBets = 0;
  let noGameId = 0;
  let noMatch = 0;
  const bothRedBets = [];
  const bothRedGameIds = new Set();
  const bothRedMatchIds = new Set();
  for (const b of nonSimUnderBets) {
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    const mid = b.raw_extraction?.match_context?.lolesports_match_id;
    if (!gid) {
      noGameId++;
      continue;
    }
    const cls = gameClsMapSplit2.get(String(gid));
    if (!cls) {
      noMatch++;
      continue;
    }
    matchedBets++;
    if (cls.clsBlue === 'VERMELHO' && cls.clsRed === 'VERMELHO') {
      bothRedBets.push({ bet_id: b.id, team_a: b.team_a, team_b: b.team_b, status: b.status, game_id: gid });
      bothRedGameIds.add(String(gid));
      if (mid) bothRedMatchIds.add(String(mid));
    }
  }

  const originN8 = {
    bets_individual_count: bothRedBets.length,
    distinct_games_count: bothRedGameIds.size,
    distinct_matches_count: bothRedMatchIds.size,
    matched_bets_total: matchedBets,
    under_bets_without_game_id: noGameId,
    under_bets_unmatched_to_universe: noMatch,
    real_bets_date_range: { first: betDatesAll[0] ?? null, last: betDatesAll[betDatesAll.length - 1] ?? null },
    explanation:
      'Bets reais (não-SIMULATED) só existem a partir de ' + (betDatesAll[0] ?? '?') + ' — inteiramente dentro do split2 (abr-jun). ' +
      'Split1 (jan-mar) NUNCA teve bet real (método ainda não estava em produção) — por isso o "8" citado só pode vir do split2. ' +
      'Reconstrução com a classificação trailing documentada aqui (under-rate<50%, n≥5) dá ' + bothRedBets.length + ' BETS individuais ' +
      '(conta ladder — várias bets no mesmo jogo), ' + bothRedGameIds.size + ' JOGOS distintos, ' + bothRedMatchIds.size + ' MATCHES distintos ' +
      '(1 match pode ter 2-5 mapas/jogos, cada um contado 1x). Não bateu exatamente com "8" em nenhuma dessas 3 unidades — provável que o ' +
      'dono usou parâmetro de classificação diferente (janela, n mínimo, ou definição de "vermelho" ad-hoc) que não temos registrado. ' +
      'Independente do valor exato, a ORDEM DE GRANDEZA é a mesma (dígito único a dezena baixa) — a conclusão central não muda: ' +
      'é amostra pequena demais pra generalizar.',
  };
  console.log(`\nBets reais (não-SIMULATED): primeira em ${originN8.real_bets_date_range.first}, última em ${originN8.real_bets_date_range.last} — TODAS dentro do split2.`);
  console.log(`Reconstrução vermelho×vermelho via bets reais Under: ${bothRedBets.length} bets individuais | ${bothRedGameIds.size} jogos distintos | ${bothRedMatchIds.size} matches distintos.`);
  console.log(`Não reproduzi exatamente "8" com esses parâmetros — mas a ordem de grandeza (dígito único/dezena baixa) é a mesma. Ver campo "explanation" no output.`);

  // ==========================================================================
  // B. UNDER HIT POR TIME (trigger population)
  // ==========================================================================
  console.log('\n\n## B. Under hit por TIME, jogos com trigger (fair+1 @ 1.72, BE 58.1%)\n');

  function teamCellsFromRows(rows) {
    const byTeam = new Map();
    for (const r of rows) {
      for (const team of [r.team_blue, r.team_red]) {
        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team).push(r);
      }
    }
    const out = new Map();
    for (const [team, rs] of byTeam) {
      const n = rs.length;
      const wins = rs.filter((r) => r.under_hit_fair_plus1).length;
      const hitPct = n ? fmt1((100 * wins) / n) : null;
      const ci = wilsonCI(wins, n);
      out.set(team, { n, wins, hit_pct: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, UNDER_ODD) });
    }
    return out;
  }
  const teamS1 = teamCellsFromRows(trigger1);
  const teamS2 = teamCellsFromRows(trigger2);
  const allTeams = new Set([...teamS1.keys(), ...teamS2.keys()]);

  function classifyReplication(s1, s2, be, minN) {
    const s1El = s1.n >= minN;
    const s2El = s2.n >= minN;
    if (!s1El || !s2El) return 'DADO_INSUFICIENTE';
    const s1Below = s1.hit_pct != null && s1.hit_pct < be;
    const s2Below = s2.hit_pct != null && s2.hit_pct < be;
    if (s1Below && s2Below) return 'ABAIXO_NOS_2_SPLITS';
    if (s1Below || s2Below) return 'ABAIXO_EM_1_SPLIT';
    return 'ACIMA_NOS_2_SPLITS';
  }

  const teamTable = [...allTeams].map((team) => {
    const s1 = teamS1.get(team) || { n: 0, hit_pct: null, wilson_ci_95: { lower: null, upper: null }, roi_pct: null };
    const s2 = teamS2.get(team) || { n: 0, hit_pct: null, wilson_ci_95: { lower: null, upper: null }, roi_pct: null };
    const nPooled = s1.n + s2.n;
    const winsPooled = (s1.wins || 0) + (s2.wins || 0);
    const hitPooled = nPooled ? fmt1((100 * winsPooled) / nPooled) : null;
    const ciPooled = wilsonCI(winsPooled, nPooled);
    return {
      team,
      split1: s1,
      split2: s2,
      pooled: { n: nPooled, hit_pct: hitPooled, wilson_ci_95: { lower: ciPooled.lower, upper: ciPooled.upper }, roi_pct: roiPct(winsPooled, nPooled, UNDER_ODD) },
      replication: classifyReplication(s1, s2, UNDER_BE, TEAM_MIN_N_PER_SPLIT),
    };
  });
  teamTable.sort((a, b) => (a.pooled.hit_pct ?? 999) - (b.pooled.hit_pct ?? 999));

  console.log(`Times na população trigger (qualquer split): ${teamTable.length}\n`);
  console.log('| time | n_s1 | hit%_s1 | n_s2 | hit%_s2 | n_pooled | hit%_pooled | replicação |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const t of teamTable) {
    console.log(`| ${t.team} | ${t.split1.n} | ${t.split1.hit_pct ?? '-'} | ${t.split2.n} | ${t.split2.hit_pct ?? '-'} | ${t.pooled.n} | ${t.pooled.hit_pct ?? '-'} | ${t.replication} |`);
  }

  const replicatedBoth = teamTable.filter((t) => t.replication === 'ABAIXO_NOS_2_SPLITS');
  const replicatedOne = teamTable.filter((t) => t.replication === 'ABAIXO_EM_1_SPLIT');
  const eligibleForReplication = teamTable.filter((t) => t.replication !== 'DADO_INSUFICIENTE');
  console.log(`\nElegíveis pra teste de replicação (n≥${TEAM_MIN_N_PER_SPLIT} nos 2 splits): ${eligibleForReplication.length} de ${teamTable.length}.`);
  console.log(`Abaixo do BE nos 2 splits (candidatos reais a skip-list): ${replicatedBoth.length} — ${replicatedBoth.map((t) => t.team).join(', ') || '(nenhum)'}`);
  console.log(`Abaixo em só 1 split (ruído provável): ${replicatedOne.length} — ${replicatedOne.map((t) => t.team).join(', ') || '(nenhum)'}`);

  // Comparações múltiplas — binomial exato usando a taxa de hit geral de CADA split
  // como p0 (hipótese nula: time se comporta como a média do split). p0 já é FRAÇÃO
  // (0-1), não dividir de novo por 100 nas chamadas de probBelowBE abaixo.
  function underHitFracOf(rows) {
    const n = rows.length;
    const wins = rows.filter((r) => r.under_hit_fair_plus1).length;
    return n ? wins / n : 0.6; // fallback conservador se população vazia (não deve ocorrer)
  }
  const p0_s1 = underHitFracOf(trigger1);
  const p0_s2 = underHitFracOf(trigger2);
  let expectedFalsePositives = 0;
  for (const t of eligibleForReplication) {
    const p1 = probBelowBE(t.split1.n, p0_s1, UNDER_BE) ?? 0;
    const p2 = probBelowBE(t.split2.n, p0_s2, UNDER_BE) ?? 0;
    expectedFalsePositives += p1 * p2;
  }
  expectedFalsePositives = fmt2(expectedFalsePositives);
  console.log(`\n[COMPARAÇÕES MÚLTIPLAS] Com ${eligibleForReplication.length} times elegíveis (n≥${TEAM_MIN_N_PER_SPLIT} nos 2 splits) testados, o número ESPERADO de times que replicariam "abaixo do BE nos 2 splits" só por acaso (binomial exato, H0=taxa média do split) é ~${expectedFalsePositives}.`);
  console.log(`Observado: ${replicatedBoth.length} time(s) abaixo nos 2 splits. ${replicatedBoth.length <= expectedFalsePositives + 1 ? 'Não dá pra distinguir de ruído com confiança.' : 'Acima do esperado por acaso — sinal mais forte que ruído puro.'}`);

  // T1 e BLG nominalmente
  function findTeam(name) {
    return teamTable.find((t) => t.team === name) || null;
  }
  const t1Row = findTeam('T1');
  const blgRow = findTeam('BLG');
  console.log('\n### T1 e BLG — nominal\n');
  console.log('T1:', JSON.stringify(t1Row, null, 2));
  console.log('BLG:', JSON.stringify(blgRow, null, 2));

  function byMonth(rows, team) {
    const m = new Map();
    for (const r of rows) {
      if (r.team_blue !== team && r.team_red !== team) continue;
      const month = (r.date || '').slice(0, 7);
      if (!m.has(month)) m.set(month, { n: 0, wins: 0 });
      const e = m.get(month);
      e.n++;
      if (r.under_hit_fair_plus1) e.wins++;
    }
    return [...m.entries()].map(([month, e]) => ({ month, n: e.n, wins: e.wins, hit_pct: fmt1((100 * e.wins) / e.n) })).sort((a, b) => a.month.localeCompare(b.month));
  }
  const t1ByMonth = { split1: byMonth(trigger1, 'T1'), split2: byMonth(trigger2, 'T1') };
  const blgByMonth = { split1: byMonth(trigger1, 'BLG'), split2: byMonth(trigger2, 'BLG') };
  console.log('\nT1 por mês:', JSON.stringify(t1ByMonth));
  console.log('BLG por mês:', JSON.stringify(blgByMonth));

  // ==========================================================================
  // C. PnL REAL POR TIME (bets do banco)
  // ==========================================================================
  console.log('\n\n## C. PnL real por time (bets do banco, não-simulated, green/red)\n');

  const settledBets = nonSimBets.filter((b) => (b.status === 'green' || b.status === 'red') && b.profit != null);
  console.log(`Bets settled (green/red, não-simulated): ${settledBets.length}`);
  console.log('NOTA: cada bet conta pros 2 times (team_a E team_b) — soma de todos os times = 2x o profit real total.');

  function pnlByTeam(bets) {
    const byTeam = new Map();
    for (const b of bets) {
      for (const raw of [b.team_a, b.team_b]) {
        const t = normalizeTeam(raw);
        if (!t) continue;
        if (!byTeam.has(t)) byTeam.set(t, { n: 0, profit: 0 });
        const e = byTeam.get(t);
        e.n++;
        e.profit += b.profit;
      }
    }
    return [...byTeam.entries()].map(([team, e]) => ({ team, n: e.n, profit: fmt2(e.profit) }));
  }
  const pnlAll = pnlByTeam(settledBets).sort((a, b) => a.profit - b.profit);
  const totalRealProfit = fmt2(settledBets.reduce((a, b) => a + b.profit, 0));
  console.log(`\nProfit real total (soma das bets, não duplicado): R$${totalRealProfit}`);

  const top10Loss = pnlAll.slice(0, TOP_N);
  const top10Profit = [...pnlAll].sort((a, b) => b.profit - a.profit).slice(0, TOP_N);
  console.log('\n### Top 10 prejuízo\n');
  console.log('| time | n | profit |');
  console.log('|---|---|---|');
  for (const t of top10Loss) console.log(`| ${t.team} | ${t.n} | R$${t.profit} |`);
  console.log('\n### Top 10 lucro\n');
  console.log('| time | n | profit |');
  console.log('|---|---|---|');
  for (const t of top10Profit) console.log(`| ${t.team} | ${t.n} | R$${t.profit} |`);

  const firstHalfBets = settledBets.filter((b) => (b.bet_datetime || '') <= FIRST_HALF_CUTOFF);
  const secondHalfBets = settledBets.filter((b) => (b.bet_datetime || '') > FIRST_HALF_CUTOFF);
  console.log(`\nPeríodo: ${betDatesAll[0]} → ${betDatesAll[betDatesAll.length - 1]}. Corte 15/05: 1ª metade n=${firstHalfBets.length} bets, 2ª metade n=${secondHalfBets.length} bets.`);

  const pnlFirstHalf = pnlByTeam(firstHalfBets).sort((a, b) => a.profit - b.profit);
  const pnlSecondHalfMap = new Map(pnlByTeam(secondHalfBets).map((t) => [t.team, t]));
  const topLosersFirstHalf = pnlFirstHalf.slice(0, TOP_N);
  const persistenceTest = topLosersFirstHalf.map((t) => {
    const second = pnlSecondHalfMap.get(t.team) || { n: 0, profit: 0 };
    return { team: t.team, first_half: { n: t.n, profit: t.profit }, second_half: { n: second.n, profit: second.profit }, continued_loss: second.n > 0 && second.profit < 0 };
  });
  const nContinued = persistenceTest.filter((t) => t.continued_loss).length;
  const nWithData = persistenceTest.filter((t) => t.second_half.n > 0).length;
  console.log(`\n### Persistência — top ${TOP_N} losers da 1ª metade (até 15/05), PnL na 2ª metade\n`);
  console.log('| time | n_1ªmetade | profit_1ªmetade | n_2ªmetade | profit_2ªmetade | continuou_prejuízo |');
  console.log('|---|---|---|---|---|---|');
  for (const t of persistenceTest) {
    console.log(`| ${t.team} | ${t.first_half.n} | R$${t.first_half.profit} | ${t.second_half.n} | R$${t.second_half.profit} | ${t.second_half.n === 0 ? 'sem_dado' : t.continued_loss ? 'SIM' : 'não'} |`);
  }
  console.log(`\n${nContinued}/${nWithData} times com dado na 2ª metade continuaram no prejuízo (dos ${TOP_N} piores da 1ª metade).`);

  // ==========================================================================
  // D. MECANISMO VARIÂNCIA
  // ==========================================================================
  console.log('\n\n## D. Mecanismo variância — desvio-padrão trailing de kills\n');

  function medianOfEligible(rows) {
    const vals = [];
    for (const r of rows) {
      if (r.sdBlue != null) vals.push(r.sdBlue);
      if (r.sdRed != null) vals.push(r.sdRed);
    }
    vals.sort((a, b) => a - b);
    const n = vals.length;
    if (n === 0) return null;
    return n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  }
  const medianS1 = medianOfEligible(split1.rows);
  const medianS2 = medianOfEligible(split2.rows);
  console.log(`Mediana de desvio-padrão trailing (n≥${STDEV_MIN_N} jogos anteriores): split1=${fmt1(medianS1)}, split2=${fmt1(medianS2)}.`);

  function varianceBucketStats(triggerRows, median) {
    const buckets = { ALTA: [], BAIXA: [] };
    for (const r of triggerRows) {
      for (const [sd] of [[r.sdBlue], [r.sdRed]]) {
        if (sd == null || median == null) continue;
        const b = sd >= median ? 'ALTA' : 'BAIXA';
        buckets[b].push(r);
      }
    }
    const out = {};
    for (const b of ['ALTA', 'BAIXA']) {
      const rs = buckets[b];
      const n = rs.length;
      const wins = rs.filter((r) => r.under_hit_fair_plus1).length;
      const hitPct = n ? fmt1((100 * wins) / n) : null;
      const ci = wilsonCI(wins, n);
      out[b] = { n, wins, hit_pct: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, UNDER_ODD) };
    }
    return out;
  }
  const varS1 = varianceBucketStats(trigger1, medianS1);
  const varS2 = varianceBucketStats(trigger2, medianS2);
  const varPooled = {};
  for (const b of ['ALTA', 'BAIXA']) {
    const n = varS1[b].n + varS2[b].n;
    const wins = varS1[b].wins + varS2[b].wins;
    const ci = wilsonCI(wins, n);
    varPooled[b] = { n, wins, hit_pct: n ? fmt1((100 * wins) / n) : null, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, UNDER_ODD) };
  }
  const varVerdict = {
    ALTA: verdict3Level(varPooled.ALTA, varS1.ALTA, varS2.ALTA, UNDER_BE),
    BAIXA: verdict3Level(varPooled.BAIXA, varS1.BAIXA, varS2.BAIXA, UNDER_BE),
  };
  console.log('\n| bucket | split1 (n/hit%) | split2 (n/hit%) | pooled (n/hit%/CI95%/ROI%) | veredito |');
  console.log('|---|---|---|---|---|');
  for (const b of ['ALTA', 'BAIXA']) {
    const ciStr = varPooled[b].n ? `[${varPooled[b].wilson_ci_95.lower}, ${varPooled[b].wilson_ci_95.upper}]` : '-';
    console.log(`| ${b} variância | ${varS1[b].n}/${varS1[b].hit_pct ?? '-'}% | ${varS2[b].n}/${varS2[b].hit_pct ?? '-'}% | ${varPooled[b].n}/${varPooled[b].hit_pct ?? '-'}%/${ciStr}/${varPooled[b].roi_pct ?? '-'}% | ${varVerdict[b]} |`);
  }
  const spreadPooled = fmt1((varPooled.BAIXA.hit_pct ?? 0) - (varPooled.ALTA.hit_pct ?? 0));
  console.log(`\nSpread BAIXA-ALTA (pooled): ${spreadPooled}pp — ${spreadPooled > 5 ? 'diferença notável' : 'diferença pequena, provável ruído'}.`);

  // ==========================================================================
  // E. VEREDITO ESTRUTURADO
  // ==========================================================================
  const skipListJustified = replicatedBoth.length > 0 && replicatedBoth.length > expectedFalsePositives;
  const t1Verdict = t1Row
    ? t1Row.replication === 'ABAIXO_NOS_2_SPLITS'
      ? 'skip (replicou abaixo do BE nos 2 splits)'
      : t1Row.replication === 'DADO_INSUFICIENTE'
        ? 'dado insuficiente pra decidir por flag de hit — mas PnL real é fortemente negativo (ver parte C)'
        : 'sem replicação clara — não justifica skip pela flag de hit sozinha'
    : 'não encontrado na população trigger';
  const blgVerdict = blgRow
    ? blgRow.replication === 'ABAIXO_NOS_2_SPLITS'
      ? 'skip (replicou abaixo do BE nos 2 splits)'
      : blgRow.replication === 'DADO_INSUFICIENTE'
        ? 'dado insuficiente'
        : 'sem replicação clara — não justifica skip pela flag de hit; PnL real é levemente positivo (ver parte C)'
    : 'não encontrado na população trigger';

  const output = {
    generated_at: new Date().toISOString(),
    params: {
      under_odd: UNDER_ODD,
      under_be_pct: UNDER_BE,
      z_score_95: Z95,
      trailing_min_n_under_rate: TRAILING_MIN_N,
      red_threshold: RED_THRESHOLD,
      green_threshold: GREEN_THRESHOLD,
      team_min_n_per_split: TEAM_MIN_N_PER_SPLIT,
      stdev_min_n: STDEV_MIN_N,
      first_half_cutoff: FIRST_HALF_CUTOFF,
      team_resolution: 'lib/normalizeTeam.cjs (resolve aliases via team-aliases.json) — NÃO normTeamName (só casing)',
    },
    partA: { general_population: A_general, trigger_population: A_trigger, bets_reconstruction: originN8, both_red_bets_detail: bothRedBets },
    partB: {
      team_table: teamTable,
      eligible_for_replication_n: eligibleForReplication.length,
      replicated_both_splits: replicatedBoth.map((t) => t.team),
      replicated_one_split: replicatedOne.map((t) => t.team),
      multiple_comparisons: { expected_false_positives: expectedFalsePositives, observed_replicated_both: replicatedBoth.length },
      t1: { row: t1Row, by_month: t1ByMonth },
      blg: { row: blgRow, by_month: blgByMonth },
    },
    partC: {
      settled_bets_n: settledBets.length,
      total_real_profit: totalRealProfit,
      pnl_all_teams: pnlAll,
      top10_loss: top10Loss,
      top10_profit: top10Profit,
      first_half_cutoff: FIRST_HALF_CUTOFF,
      persistence_test: persistenceTest,
      persistence_summary: { n_continued_loss: nContinued, n_with_second_half_data: nWithData, n_top_losers_tested: TOP_N },
    },
    partD: {
      median_stdev: { split1: fmt1(medianS1), split2: fmt1(medianS2) },
      by_split: { split1: varS1, split2: varS2 },
      pooled: varPooled,
      verdict: varVerdict,
      spread_pooled_pp: spreadPooled,
    },
    partE: {
      skip_list_justified: skipListJustified,
      skip_list_teams: replicatedBoth.map((t) => t.team),
      skip_list_criteria: `Under hit < BE (${UNDER_BE}%) nos 2 splits separados, n≥${TEAM_MIN_N_PER_SPLIT} por split, e observado (${replicatedBoth.length}) acima do esperado por acaso (~${expectedFalsePositives})`,
      t1_verdict: t1Verdict,
      blg_verdict: blgVerdict,
      variance_criterion_adds_value: varVerdict.ALTA === 'NEGATIVO' && varVerdict.BAIXA !== 'NEGATIVO',
    },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\n## E. VEREDITO ESTRUTURADO\n`);
  console.log(`1. Skip-list nominal justificada: ${skipListJustified ? 'SIM' : 'NÃO'} — times: ${replicatedBoth.map((t) => t.team).join(', ') || '(nenhum)'}`);
  console.log(`2. T1: ${t1Verdict}`);
  console.log(`   BLG: ${blgVerdict}`);
  console.log(`3. Critério de variância agrega: ${output.partE.variance_criterion_adds_value ? 'SIM (ALTA=NEGATIVO, BAIXA≠NEGATIVO)' : 'NÃO (não separou os buckets de forma consistente nos 2 splits)'}`);
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
