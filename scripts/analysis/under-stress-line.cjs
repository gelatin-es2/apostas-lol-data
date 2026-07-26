// scripts/analysis/under-stress-line.cjs
//
// Follow-up do corte A de scripts/analysis/multi-league-mining.cjs: STRESS TEST de
// linha. A análise original usou Under na fair+1 @ 1.72 (a linha que o dono opera
// hoje). Aqui testamos se a liga aguenta linha PIOR (mais difícil de bater):
//   a. fair+1 (referência, já no 18-multi-league-mining.json)
//   b. fair       (1 linha pior)
//   c. fair−1     (2 linhas piores)
//
// Duas óticas de odd, lado a lado:
//   - STRESS PISO: as 3 linhas @ 1.72 flat (BE 58.1%) — conservador de propósito,
//     na vida real linha pior paga odd MELHOR, então isso é o piso, não o realista.
//   - ESCADA REAL do dono (mesma info usada em over-method-v2.cjs, espelhada pro
//     Under): fair+1@1.72 (BE 58.1%) · fair@1.83 (BE 54.6%) · fair−1@1.95 (BE 51.3%).
//
// Fair leave-one-out POR LIGA — MESMA função/critério de camille-sweep.cjs e
// multi-league-mining.cjs (fallback pra média da liga se time tem <5 jogos
// anteriores na MESMA liga). Mesma população trigger peel (2peel/1peel+flex) do 18.
//
// Zero chamada de API — tudo do cache (audit-output/00-universe-allregions.json).
//
// Uso: node scripts/analysis/under-stress-line.cjs
// Output: audit-output/19-under-stress-line.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { LEAGUE_IDS } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '19-under-stress-line.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs / multi-league-mining.cjs
const APPROVAL_MIN_N = 25;

const ORIGINAL_6_IDS = new Set(Object.values(LEAGUE_IDS));

// Rungs — stress (flat 1.72) e escada real (odd sobe conforme a linha piora, ao
// contrário do stress que mantém 1.72 fixo nas 3 pra achar o "piso").
const RUNGS = [
  { key: 'fair_plus_1', offset: 1, stress_odd: 1.72, stress_be: 58.1, realistic_odd: 1.72, realistic_be: 58.1 }, // já é a linha real hoje — stress=realista
  { key: 'fair', offset: 0, stress_odd: 1.72, stress_be: 58.1, realistic_odd: 1.83, realistic_be: 54.6 },
  { key: 'fair_minus_1', offset: -1, stress_odd: 1.72, stress_be: 58.1, realistic_odd: 1.95, realistic_be: 51.3 },
];

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe. Rode scripts/analysis/camille-collect.cjs primeiro.`);
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

// ============================================================================
// Fair leave-one-out POR LIGA — sync: scripts/analysis/camille-sweep.cjs /
// scripts/analysis/multi-league-mining.cjs (mesmo critério, n<5 fallback).
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

function cellFor(rows, offset, odd) {
  const n = rows.length;
  const wins = rows.filter((r) => r.total_kills < r.fair + offset).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd) };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('STRESS TEST DE LINHA — Under por liga em 3 linhas (fair+1/fair/fair-1)');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  console.log(`\nPopulação válida: ${populationAll.length}`);

  const fairMap = computeFairPerLeague(populationAll);
  const rows = populationAll.map((g) => ({
    game_id: g.game_id,
    league: g.league,
    league_id: g.league_id,
    total_kills: g.total_kills,
    trigger_type: g.trigger_type,
    fair: fairMap.get(g.game_id),
    is_original_6: ORIGINAL_6_IDS.has(String(g.league_id)),
  }));

  const triggerRows = rows.filter((r) => r.trigger_type);
  const byLeague = new Map();
  for (const r of triggerRows) {
    if (!byLeague.has(r.league)) byLeague.set(r.league, { league: r.league, league_id: r.league_id, is_original_6: r.is_original_6, rows: [] });
    byLeague.get(r.league).rows.push(r);
  }

  const table = [...byLeague.values()].map((e) => {
    const cells = {};
    for (const rung of RUNGS) {
      const stress = cellFor(e.rows, rung.offset, rung.stress_odd);
      const realisticRoi = rung.realistic_odd === rung.stress_odd ? stress.roi_pct : roiPct(stress.wins, stress.n, rung.realistic_odd);
      cells[rung.key] = { ...stress, realistic_odd: rung.realistic_odd, realistic_be: rung.realistic_be, realistic_roi_pct: realisticRoi };
    }
    return { league: e.league, league_id: e.league_id, is_original_6: e.is_original_6, n: e.rows.length, cells };
  }).sort((a, b) => (b.cells.fair.roi_pct ?? -999) - (a.cells.fair.roi_pct ?? -999));

  console.log('\n### Tabela completa — rankeada por ROI stress @1.72 na linha FAIR\n');
  console.log('| liga | n | fair+1: hit%/CI/ROI | fair: hit%/CI/ROI@1.72/ROI@1.83real | fair-1: hit%/CI/ROI@1.72/ROI@1.95real | benchmark |');
  console.log('|---|---|---|---|---|---|');
  for (const t of table) {
    const fp1 = t.cells.fair_plus_1;
    const f = t.cells.fair;
    const fm1 = t.cells.fair_minus_1;
    const fp1Str = `${fp1.hit_pct ?? '-'}% [${fp1.wilson_ci_95.lower ?? '-'},${fp1.wilson_ci_95.upper ?? '-'}] ROI${fp1.roi_pct ?? '-'}%`;
    const fStr = `${f.hit_pct ?? '-'}% [${f.wilson_ci_95.lower ?? '-'},${f.wilson_ci_95.upper ?? '-'}] ROI${f.roi_pct ?? '-'}%/${f.realistic_roi_pct ?? '-'}%`;
    const fm1Str = `${fm1.hit_pct ?? '-'}% [${fm1.wilson_ci_95.lower ?? '-'},${fm1.wilson_ci_95.upper ?? '-'}] ROI${fm1.roi_pct ?? '-'}%/${fm1.realistic_roi_pct ?? '-'}%`;
    console.log(`| ${t.league} | ${t.n} | ${fp1Str} | ${fStr} | ${fm1Str} | ${t.is_original_6 ? 'BENCHMARK' : ''} |`);
  }

  // --- Aprovações ---
  const stressApproved = table.filter((t) => t.n >= APPROVAL_MIN_N && t.cells.fair.roi_pct != null && t.cells.fair.roi_pct > 0);
  const realisticApproved = table.filter((t) => t.n >= APPROVAL_MIN_N && t.cells.fair.realistic_roi_pct != null && t.cells.fair.realistic_roi_pct > 0);
  const stressRobust = stressApproved.filter((t) => t.cells.fair_minus_1.roi_pct != null && t.cells.fair_minus_1.roi_pct > 0);
  const realisticRobust = realisticApproved.filter((t) => t.cells.fair_minus_1.realistic_roi_pct != null && t.cells.fair_minus_1.realistic_roi_pct > 0);

  console.log(`\n\n### Aprovadas — critério STRESS PISO (linha fair @ 1.72, ROI>0, n≥${APPROVAL_MIN_N})\n`);
  for (const t of stressApproved) console.log(`- ${t.league}: n=${t.n}, hit@fair=${t.cells.fair.hit_pct}%, ROI@1.72=${t.cells.fair.roi_pct}%${stressRobust.includes(t) ? ' — ROBUSTA (também positiva na fair-1@1.72)' : ''}`);
  if (!stressApproved.length) console.log('Nenhuma liga aprovada neste critério.');

  console.log(`\n### Aprovadas — critério ESCADA REAL (linha fair @ 1.83, ROI>0, n≥${APPROVAL_MIN_N})\n`);
  for (const t of realisticApproved) console.log(`- ${t.league}: n=${t.n}, hit@fair=${t.cells.fair.hit_pct}%, ROI@1.83=${t.cells.fair.realistic_roi_pct}%${realisticRobust.includes(t) ? ' — ROBUSTA (também positiva na fair-1@1.95)' : ''}`);
  if (!realisticApproved.length) console.log('Nenhuma liga aprovada neste critério.');

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      z_score_95: Z95,
      fair_fallback_min_n: FALLBACK_MIN_N,
      approval_min_n: APPROVAL_MIN_N,
      rungs: RUNGS,
      note: 'STRESS PISO = 3 linhas todas @ 1.72 (conservador, piso). ESCADA REAL = odd sobe conforme linha piora (fair@1.83, fair-1@1.95) — cenário que a casa realmente paga.',
    },
    meta: { population_n: populationAll.length, trigger_population_n: triggerRows.length },
    table,
    approvals: {
      stress_floor: stressApproved.map((t) => t.league),
      stress_floor_robust_also_fair_minus_1: stressRobust.map((t) => t.league),
      realistic_ladder: realisticApproved.map((t) => t.league),
      realistic_ladder_robust_also_fair_minus_1: realisticRobust.map((t) => t.league),
    },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
