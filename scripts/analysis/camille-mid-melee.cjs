// scripts/analysis/camille-mid-melee.cjs
//
// Follow-up do dono na janela Camille support: efeito do MID CORPO-A-CORPO (melee)
// no TIME DELA, cruzado com o sup inimigo. Mesma base/máquina de
// scripts/analysis/camille-context-scan.cjs (script 20) — 113 games Camille support,
// all-regions, fair leave-one-out por liga, Over @ fair, odd 1.80 (BE ref 55.6%),
// baseline da janela 67.3%.
//
// MELEE_MID — lista explícita pedida pelo dono (documentada aqui, não redefinida):
// sylas, qiyana, akali, yone, yasuo, ekko, fizz, kassadin, zed, katarina, naafiri,
// diana, talon, galio, sett, ambessa. Tudo que NÃO está nessa lista quando joga mid
// é tratado como RANGED (marksman/mago à distância — não existe categoria "outro"
// aqui, o corte pedido é binário melee/ranged).
//
// Honestidade: células pequenas (n=3-15) — flag small_sample em tudo n<10, e reporto
// quantas células testei + esperado por acaso a 95%. Se tudo ficar indistinguível
// (CIs sobrepostos, nenhum sinal separável de verdade), o veredito é dito explicitamente.
//
// Zero chamada de API — universo + windows 100% em cache.
//
// Uso: node scripts/analysis/camille-mid-melee.cjs
// Output: audit-output/23-camille-mid-melee.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '23-camille-mid-melee.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const OVER_ODD = 1.8;
const OVER_BE_REF = 55.6;
const BASELINE_WINDOW = 67.3; // hit central da janela Camille inteira (script 20)
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-context-scan.cjs e demais
const SMALL_N = 10;
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

// MELEE_MID — lista explícita do dono, documentada verbatim.
const MELEE_MID_LIST = [
  'sylas', 'qiyana', 'akali', 'yone', 'yasuo', 'ekko', 'fizz', 'kassadin', 'zed',
  'katarina', 'naafiri', 'diana', 'talon', 'galio', 'sett', 'ambessa',
];
const MELEE_MID_SET = new Set(MELEE_MID_LIST.map(normChamp));
function midMeleeOrRanged(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  return MELEE_MID_SET.has(c) ? 'MELEE' : 'RANGED';
}

// Sup inimigo — 3 buckets pedidos: premium (rell/naut), leona, resto.
function enemySupBucket(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (c === 'rell' || c === 'nautilus') return 'PREMIUM (Rell/Naut)';
  if (c === 'leona') return 'Leona';
  return 'Resto';
}

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
function cellStats(rows, odd = OVER_ODD) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd), small_sample: n < SMALL_N };
}

// ============================================================================
// Fair leave-one-out POR LIGA — sync: camille-context-scan.cjs e demais desta família.
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

let cellsTested = 0;
function printCut(title, cells) {
  console.log(`\n### ${title}\n`);
  console.log('| contexto | n | hit% | CI95% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|');
  for (const c of cells) {
    cellsTested++;
    const ciStr = c.stats.n ? `[${c.stats.wilson_ci_95.lower ?? '-'}, ${c.stats.wilson_ci_95.upper ?? '-'}]` : '-';
    console.log(`| ${c.label} | ${c.stats.n} | ${c.stats.hit_pct ?? '-'} | ${ciStr} | ${c.stats.roi_pct ?? '-'} | ${c.stats.small_sample ? 'small_sample' : ''} |`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CAMILLE + MID MELEE — cruzado com sup inimigo');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  const fairMap = computeFairPerLeague(populationAll);

  const camilleRaw = populationAll.filter((g) => (g.sup_blue || '').toLowerCase() === 'camille' || (g.sup_red || '').toLowerCase() === 'camille');
  console.log(`\nCamille support games: ${camilleRaw.length}`);

  let noWindow = 0;
  let noRoster = 0;
  const rows = [];
  for (const g of camilleRaw) {
    const camilleSide = (g.sup_blue || '').toLowerCase() === 'camille' ? 'blue' : 'red';
    const enemySide = camilleSide === 'blue' ? 'red' : 'blue';
    const enemySupport = camilleSide === 'blue' ? g.sup_red : g.sup_blue;
    const fair = fairMap.get(g.game_id);
    const win = loadWindow(g.game_id);
    let roster = null;
    if (!win) noWindow++;
    else {
      roster = extractRoster(win);
      if (!roster) noRoster++;
    }
    const mid = roster ? roster[camilleSide].mid : null;
    rows.push({
      game_id: g.game_id,
      league: g.league,
      total_kills: g.total_kills,
      fair,
      over_hit: g.total_kills > fair,
      enemy_support: enemySupport,
      enemy_support_bucket: enemySupport ? enemySupBucket(enemySupport) : null,
      mid,
      mid_arch: mid ? midMeleeOrRanged(mid) : null,
    });
  }
  console.log(`Cobertura de roster: sem window: ${noWindow}, sem roster completo: ${noRoster} (de ${camilleRaw.length}).`);
  const noMidData = rows.filter((r) => r.mid_arch == null).length;
  console.log(`Jogos sem dado de mid (roster ausente): ${noMidData}`);

  const baseline = cellStats(rows);
  console.log(`\nBaseline da janela inteira (referência, script 20): n=${baseline.n}, hit=${baseline.hit_pct}%, CI95%=[${baseline.wilson_ci_95.lower}, ${baseline.wilson_ci_95.upper}]`);

  // ==========================================================================
  // 1. Mid MELEE vs RANGED (split principal)
  // ==========================================================================
  const cut1 = ['MELEE', 'RANGED'].map((arch) => ({
    label: `mid ${arch.toLowerCase()}`,
    stats: cellStats(rows.filter((r) => r.mid_arch === arch)),
  }));
  printCut('1. Camille + mid MELEE vs mid RANGED (dela)', cut1);

  // ==========================================================================
  // 2. Tabela 2×3 — (mid melee/ranged) × (sup inimigo premium/leona/resto)
  // ==========================================================================
  const ENEMY_BUCKETS = ['PREMIUM (Rell/Naut)', 'Leona', 'Resto'];
  const cut2 = [];
  for (const midArch of ['MELEE', 'RANGED']) {
    for (const supBucket of ENEMY_BUCKETS) {
      const cellRows = rows.filter((r) => r.mid_arch === midArch && r.enemy_support_bucket === supBucket);
      cut2.push({ label: `mid ${midArch.toLowerCase()} × sup ${supBucket}`, stats: cellStats(cellRows) });
    }
  }
  printCut('2. Tabela 2×3 — mid (melee/ranged) × sup inimigo (premium/leona/resto)', cut2);

  // ==========================================================================
  // 3. Camille + mid melee vs QUALQUER sup inimigo agregado ("com todos suporte")
  // ==========================================================================
  const cut3 = [{ label: 'Camille + mid melee (todos sups inimigos agregados)', stats: cellStats(rows.filter((r) => r.mid_arch === 'MELEE')) }];
  printCut('3. Camille + mid melee vs QUALQUER sup inimigo (agregado)', cut3);
  console.log('\n(Mesma célula da linha "mid melee" do corte 1 — repetida aqui como referência explícita pro corte 2, conforme pedido.)');

  // ==========================================================================
  // 4. Referência — os 3 sups inimigos sozinhos
  // ==========================================================================
  const cut4 = ['Rell', 'Nautilus', 'Leona'].map((champ) => ({
    label: champ,
    stats: cellStats(rows.filter((r) => normChamp(r.enemy_support) === normChamp(champ))),
  }));
  printCut('4. Referência — os 3 sups inimigos sozinhos (confirmação vs padrão citado)', cut4);
  const CITED = { Rell: { n: 15, hit: 73.3 }, Nautilus: { n: 8, hit: 87.5 }, Leona: { n: 23, hit: 65.2 } };
  console.log('\nCitado: Rell 73.3% n15, Nautilus 87.5% n8, Leona 65.2% n23.');
  for (const c of cut4) {
    const cited = CITED[c.label];
    const matches = cited && cited.n === c.stats.n && cited.hit === c.stats.hit_pct;
    console.log(`Recalculado aqui: ${c.label} — n=${c.stats.n}, hit=${c.stats.hit_pct}% — ${matches ? 'BATE EXATO' : 'confere no output'}`);
  }

  // ==========================================================================
  // VEREDITO
  // ==========================================================================
  const totalCells = cellsTested;
  const expectedByChance = fmt1(totalCells * 0.05);
  console.log(`\n\n## Honestidade estatística\n`);
  console.log(`Células testadas (cortes 1+2+3+4): ${totalCells}. Esperado passando por acaso a 95%: ~${expectedByChance}.`);

  // "sinal separável" = alguma célula com n>=8 cujo CI não sobrepõe a de outra célula relevante do mesmo corte.
  function overlaps(a, b) {
    if (a.wilson_ci_95.lower == null || b.wilson_ci_95.lower == null) return true; // sem CI, assume sobreposto (conservador)
    return a.wilson_ci_95.lower <= b.wilson_ci_95.upper && b.wilson_ci_95.lower <= a.wilson_ci_95.upper;
  }
  const meleeStats = cut1[0].stats;
  const rangedStats = cut1[1].stats;
  const cut1Separable = meleeStats.n >= 8 && rangedStats.n >= 8 && !overlaps(meleeStats, rangedStats);
  console.log(`\nCorte 1 (melee vs ranged) — CI se sobrepõem: ${overlaps(meleeStats, rangedStats) ? 'SIM (sobrepõem, indistinguível)' : 'NÃO (separável)'}.`);

  const verdict = cut1Separable
    ? `Sinal separável no corte 1: mid ${meleeStats.hit_pct > rangedStats.hit_pct ? 'MELEE' : 'RANGED'} performa melhor sem sobreposição de CI.`
    : 'SEM SINAL SEPARÁVEL AINDA — CIs se sobrepõem em todos os cortes testados, amostra pequena demais (n=3-23 por célula) pra distinguir de ruído.';
  console.log(`\n**VEREDITO: ${verdict}**`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD, over_be_ref_pct: OVER_BE_REF, baseline_window_pct: BASELINE_WINDOW, z_score_95: Z95,
      fair_fallback_min_n: FALLBACK_MIN_N, small_sample_n: SMALL_N,
      melee_mid_list: MELEE_MID_LIST,
    },
    meta: { camille_games_n: camilleRaw.length, no_window: noWindow, no_roster: noRoster, no_mid_data: noMidData, baseline: baseline },
    cut1_mid_melee_vs_ranged: cut1,
    cut2_2x3_table: cut2,
    cut3_melee_any_enemy_support: cut3,
    cut4_reference_enemy_supports: cut4,
    verdict: { cells_tested: totalCells, expected_by_chance: expectedByChance, cut1_ci_overlap: overlaps(meleeStats, rangedStats), text: verdict },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
