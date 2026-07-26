// scripts/analysis/champion-over-table.cjs
//
// Follow-up do dono: existe OUTRO boneco além da Camille dando 70%+ de Over hit?
// Tabela de champions (TODAS as roles, via windows cacheados — os 10 picks de cada
// jogo) ordenada por Over hit na fair.
//
// Duas tabelas:
//   1. PATCH ATUAL (só julho/2026) — n≥8, top 20.
//   2. PERÍODO COMPLETO (abr-jul) — n≥20, top 15 — quem sustenta sinal além do patch.
// + Camille support como referência direta (mesma régua) nas duas.
// + Comparações múltiplas: quantos champions testados, quantos passariam por acaso.
// + Quebra por role (n≥8) quando o champion não é ~100% de 1 role só.
//
// Fair leave-one-out POR LIGA — MESMA função de camille-sweep.cjs / multi-league-
// mining.cjs / under-stress-line.cjs / camille-context-scan.cjs (fallback n<5).
//
// Zero chamada de API — universo + windows 100% em cache.
//
// Uso: node scripts/analysis/champion-over-table.cjs
// Output: audit-output/21-champion-over-table.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '21-champion-over-table.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs e demais
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];

const JULY_MIN_N = 8;
const JULY_TOP_N = 20;
const FULL_MIN_N = 20;
const FULL_TOP_N = 15;
const ROLE_BREAKDOWN_MIN_N = 8;
const ROLE_PREDOMINANT_MAX_PCT = 90; // abaixo disso, quebra por role

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
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
function roiPct(wins, n, odd) {
  if (!n) return null;
  const profit = wins * (odd - 1) - (n - wins);
  return fmt1((100 * profit) / n);
}
function cellStats(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, OVER_ODD), pass: ci.lower != null && ci.lower >= OVER_BE };
}

// ============================================================================
// Fair leave-one-out POR LIGA — sync: demais scripts desta família.
// ============================================================================
function computeFairPerLeague(populationAll) {
  const byLeague = new Map();
  for (const g of populationAll) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map();
  for (const [, games] of byLeague) {
    const teamHist = new Map();
    for (const g of games) {
      for (const raw of [g.team_blue, g.team_red]) {
        const t = normalizeTeam(raw);
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
      }
    }
    const leagueAvgTotal = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const avgFor = (team) => {
        const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvgTotal;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(normalizeTeam(g.team_blue)) + avgFor(normalizeTeam(g.team_red))) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return fairMap;
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

function buildChampTable(participantRows, minN, topN) {
  const byChamp = new Map();
  for (const p of participantRows) {
    if (!byChamp.has(p.champ)) byChamp.set(p.champ, []);
    byChamp.get(p.champ).push(p);
  }
  const eligible = [...byChamp.entries()].filter(([, rs]) => rs.length >= minN);
  const table = eligible
    .map(([champ, rs]) => {
      const stats = cellStats(rs);
      const byRole = new Map();
      for (const r of rs) byRole.set(r.role, (byRole.get(r.role) || 0) + 1);
      const roleEntries = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
      const predominantRole = roleEntries[0][0];
      const predominantPct = fmt1((100 * roleEntries[0][1]) / rs.length);
      let roleBreakdown = null;
      if (predominantPct < ROLE_PREDOMINANT_MAX_PCT) {
        roleBreakdown = roleEntries
          .filter(([, n]) => n >= ROLE_BREAKDOWN_MIN_N)
          .map(([role]) => ({ role, ...cellStats(rs.filter((r) => r.role === role)) }));
      }
      return { champ, predominant_role: predominantRole, predominant_role_pct: predominantPct, role_distribution: Object.fromEntries(roleEntries), ...stats, role_breakdown: roleBreakdown };
    })
    .sort((a, b) => (b.hit_pct ?? -1) - (a.hit_pct ?? -1));
  return { eligible_total: table.length, top: table.slice(0, topN), full: table };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CHAMPION OVER TABLE — existe outro boneco 70%+ além da Camille?');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  const fairMap = computeFairPerLeague(populationAll);
  console.log(`\nPopulação válida: ${populationAll.length}`);

  let noWindow = 0;
  let noRoster = 0;
  const participantRows = [];
  for (const g of populationAll) {
    const fair = fairMap.get(g.game_id);
    const overHit = g.total_kills > fair;
    const month = (g.date || '').slice(0, 7);
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
    for (const side of ['blue', 'red']) {
      for (const role of ROLES) {
        const champ = roster[side][role];
        if (!champ) continue;
        participantRows.push({ champ, role, game_id: g.game_id, month, over_hit: overHit });
      }
    }
  }
  console.log(`Cobertura de roster: sem window: ${noWindow}, sem roster completo: ${noRoster} (de ${populationAll.length}).`);

  const julyRows = participantRows.filter((p) => p.month === '2026-07');
  const fullRows = participantRows.filter((p) => ['2026-04', '2026-05', '2026-06', '2026-07'].includes(p.month));

  const julyTable = buildChampTable(julyRows, JULY_MIN_N, JULY_TOP_N);
  const fullTable = buildChampTable(fullRows, FULL_MIN_N, FULL_TOP_N);

  const camilleJuly = julyRows.filter((p) => p.champ === 'Camille' && p.role === 'support');
  const camilleFull = fullRows.filter((p) => p.champ === 'Camille' && p.role === 'support');
  const camilleJulyStats = cellStats(camilleJuly);
  const camilleFullStats = cellStats(camilleFull);

  const julyExpectedByChance = fmt1(julyTable.eligible_total * 0.05);
  const fullExpectedByChance = fmt1(fullTable.eligible_total * 0.05);

  console.log(`\n\n## Tabela 1 — PATCH ATUAL (julho/2026), n≥${JULY_MIN_N}, top ${JULY_TOP_N}\n`);
  console.log(`Champions testados (n≥${JULY_MIN_N} em julho): ${julyTable.eligible_total}. Esperado passando por acaso a 95%: ~${julyExpectedByChance}.`);
  console.log('\n| champion | role predom. (%) | n | hit% | CI95% | PASSA? |');
  console.log('|---|---|---|---|---|---|');
  for (const c of julyTable.top) {
    console.log(`| ${c.champ} | ${c.predominant_role} (${c.predominant_role_pct}%) | ${c.n} | ${c.hit_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] | ${c.pass ? '**SIM**' : 'observação'} |`);
    if (c.role_breakdown) {
      for (const rb of c.role_breakdown) console.log(`|   ↳ ${c.champ} (${rb.role}) | | ${rb.n} | ${rb.hit_pct} | [${rb.wilson_ci_95.lower}, ${rb.wilson_ci_95.upper}] | ${rb.pass ? '**SIM**' : 'observação'} |`);
    }
  }
  console.log(`\n### Referência — Camille support (julho)\n`);
  console.log(`n=${camilleJulyStats.n}, hit=${camilleJulyStats.hit_pct}%, CI95%=[${camilleJulyStats.wilson_ci_95.lower}, ${camilleJulyStats.wilson_ci_95.upper}], PASSA=${camilleJulyStats.pass}`);
  const julyRank = julyTable.full.findIndex((c) => c.champ === 'Camille' && c.predominant_role === 'support');
  console.log(`Posição da Camille no ranking completo de julho: ${julyRank >= 0 ? `#${julyRank + 1} de ${julyTable.eligible_total}` : 'não elegível (n<8) ou não é predominant_role=support'}`);

  console.log(`\n\n## Tabela 2 — PERÍODO COMPLETO (abr-jul), n≥${FULL_MIN_N}, top ${FULL_TOP_N}\n`);
  console.log(`Champions testados (n≥${FULL_MIN_N} no período): ${fullTable.eligible_total}. Esperado passando por acaso a 95%: ~${fullExpectedByChance}.`);
  console.log('\n| champion | role predom. (%) | n | hit% | CI95% | PASSA? |');
  console.log('|---|---|---|---|---|---|');
  for (const c of fullTable.top) {
    console.log(`| ${c.champ} | ${c.predominant_role} (${c.predominant_role_pct}%) | ${c.n} | ${c.hit_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] | ${c.pass ? '**SIM**' : 'observação'} |`);
    if (c.role_breakdown) {
      for (const rb of c.role_breakdown) console.log(`|   ↳ ${c.champ} (${rb.role}) | | ${rb.n} | ${rb.hit_pct} | [${rb.wilson_ci_95.lower}, ${rb.wilson_ci_95.upper}] | ${rb.pass ? '**SIM**' : 'observação'} |`);
    }
  }
  console.log(`\n### Referência — Camille support (período completo)\n`);
  console.log(`n=${camilleFullStats.n}, hit=${camilleFullStats.hit_pct}%, CI95%=[${camilleFullStats.wilson_ci_95.lower}, ${camilleFullStats.wilson_ci_95.upper}], PASSA=${camilleFullStats.pass}`);
  const fullRank = fullTable.full.findIndex((c) => c.champ === 'Camille' && c.predominant_role === 'support');
  console.log(`Posição da Camille no ranking completo do período: ${fullRank >= 0 ? `#${fullRank + 1} de ${fullTable.eligible_total}` : 'não elegível (n<20) ou não é predominant_role=support'}`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD, over_be_pct: OVER_BE, z_score_95: Z95,
      fair_fallback_min_n: FALLBACK_MIN_N,
      july_min_n: JULY_MIN_N, july_top_n: JULY_TOP_N,
      full_min_n: FULL_MIN_N, full_top_n: FULL_TOP_N,
      role_breakdown_min_n: ROLE_BREAKDOWN_MIN_N, role_predominant_threshold_pct: ROLE_PREDOMINANT_MAX_PCT,
      pass_rule: `CI95% inferior ≥ BE (${OVER_BE}%)`,
    },
    meta: { population_n: populationAll.length, no_window: noWindow, no_roster: noRoster },
    table1_july: {
      champions_tested: julyTable.eligible_total,
      expected_pass_by_chance: julyExpectedByChance,
      top: julyTable.top,
      camille_reference: { ...camilleJulyStats, rank: julyRank >= 0 ? julyRank + 1 : null },
    },
    table2_full_period: {
      champions_tested: fullTable.eligible_total,
      expected_pass_by_chance: fullExpectedByChance,
      top: fullTable.top,
      camille_reference: { ...camilleFullStats, rank: fullRank >= 0 ? fullRank + 1 : null },
    },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
