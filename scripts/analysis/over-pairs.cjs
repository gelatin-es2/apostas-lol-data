// scripts/analysis/over-pairs.cjs
//
// Follow-up do dono: ele definiu um conjunto de "bonecos over" dele —
// OVER_SET = {Rell, Nautilus, Pyke, Leona, Elise} — DEPOIS de ver a tabela por
// champion de scripts/analysis/over-by-support.cjs.
//
// *** CAVEAT OBRIGATÓRIO (ler antes de usar qualquer número daqui) ***
// Esse conjunto foi escolhido olhando o resultado (seleção pós-hoc) — é overfit em
// cima do MESMO dado que gerou os champions (Rell/Nautilus vieram do topo da tabela
// de 13-over-by-support.json). Isso NÃO é validação out-of-sample de verdade — é
// re-análise do mesmo dado com um filtro escolhido a posteriori. O único teste
// honesto possível aqui é CONSISTÊNCIA ENTRE OS 2 SPLITS (se o efeito é real, os
// dois splits deveriam apontar na mesma direção; se só um split "salva" o número,
// é sinal de ruído/overfit, não de edge).
//
// Fair leave-one-out — MESMA função de over-method-v2.cjs/over-by-support.cjs,
// recalculada por split. Odd flat 1.80 (BE 55.6%), igual ao corte por champion.
//
// Uso: node scripts/analysis/over-pairs.cjs
// Output: audit-output/14-over-pairs.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE } = require('../audit/lib/audit-common.cjs');
const { normTeamName } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '14-over-pairs.json');

const SPLIT_FILES = {
  1: { file: path.join(AUDIT_OUTPUT, '00-universe-split1.json'), label: 'split1 (jan-mar 2026)' },
  2: { file: path.join(AUDIT_OUTPUT, '00-universe.json'), label: 'split2 (abr-jun 2026)' },
};

const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const Z95 = 1.96;
const PAIR_MIN_N = 3;

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const OVER_SET_DISPLAY = ['Rell', 'Nautilus', 'Pyke', 'Leona', 'Elise'];
const OVER_SET = new Set(OVER_SET_DISPLAY.map(normChamp));
const STRICT_SET_DISPLAY = ['Rell', 'Nautilus'];
const STRICT_SET = new Set(STRICT_SET_DISPLAY.map(normChamp));
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));

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

// ============================================================================
// Fair leave-one-out — sync: scripts/analysis/over-method-v2.cjs /
// scripts/analysis/over-by-support.cjs (mesma fórmula, mesmo recorte por split).
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

function loadSplit(splitNum) {
  const cfg = SPLIT_FILES[splitNum];
  const universeFull = loadJson(cfg.file);
  const teamHist = buildTeamKillsHistory(universeFull);
  const leagueAvg = buildLeagueAvgKills(universeFull);
  const population = universeFull.filter((g) => !g.suspect && g.total_kills != null);

  const rows = population.map((g) => {
    const fair = fairFormulaForGame(g, teamHist, leagueAvg);
    return {
      split: splitNum,
      game_id: g.game_id,
      league: g.league,
      date: g.date,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      fair,
      over_hit: g.total_kills > fair,
    };
  });

  return { label: cfg.label, population_n: population.length, rows };
}

function cellStats(rows, odd) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, odd) };
}

// Critério combinado (pedido explícito do dono): CI inferior pooled ≥ BE (rigor
// estatístico de over-method-v2.cjs) E replicação nos 2 splits (hit ≥ BE nos dois,
// de over-by-support.cjs). INCERTO = central pooled ≥ BE mas não bate os 2 critérios
// juntos. NEGATIVO = central pooled < BE.
function verdict3Level(poolCell, s1Cell, s2Cell, be) {
  if (poolCell.n === 0) return 'SEM_DADO';
  const s1Ok = s1Cell.hit_pct != null && s1Cell.hit_pct >= be;
  const s2Ok = s2Cell.hit_pct != null && s2Cell.hit_pct >= be;
  const ciLowerOk = poolCell.wilson_ci_95.lower != null && poolCell.wilson_ci_95.lower >= be;
  if (ciLowerOk && s1Ok && s2Ok) return 'LUCRATIVO';
  if (poolCell.hit_pct != null && poolCell.hit_pct >= be) return 'INCERTO';
  return 'NEGATIVO';
}

function evalRule(ruleFn, split1Rows, split2Rows, odd, be) {
  const r1 = split1Rows.filter(ruleFn);
  const r2 = split2Rows.filter(ruleFn);
  const rPooled = [...r1, ...r2];
  const s1 = cellStats(r1, odd);
  const s2 = cellStats(r2, odd);
  const pooled = cellStats(rPooled, odd);
  const verdict = verdict3Level(pooled, s1, s2, be);
  return { split1: s1, split2: s2, pooled, verdict };
}

function printRuleTable(title, res) {
  console.log(`\n### ${title}\n`);
  console.log('| contexto | n | hit% | CI95% | ROI% |');
  console.log('|---|---|---|---|---|');
  for (const [name, c] of [['split1', res.split1], ['split2', res.split2], ['pooled', res.pooled]]) {
    const ciStr = c.n ? `[${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}]` : '-';
    console.log(`| ${name} | ${c.n} | ${c.hit_pct ?? '-'} | ${ciStr} | ${c.roi_pct ?? '-'} |`);
  }
  console.log(`\n**Veredito: ${res.verdict}**`);
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('OVER — pares dentro do OVER_SET do dono (Rell/Nautilus/Pyke/Leona/Elise)');
  console.log('='.repeat(70));
  console.log('\n*** CAVEAT: conjunto escolhido pós-hoc, olhando a tabela por champion (over-by-support.cjs).');
  console.log('Risco de overfit no mesmo dado — o único teste honesto aqui é CONSISTÊNCIA ENTRE OS 2 SPLITS. ***\n');

  const split1 = loadSplit(1);
  const split2 = loadSplit(2);
  console.log(`split1 (${split1.label}): população=${split1.population_n}`);
  console.log(`split2 (${split2.label}): população=${split2.population_n}`);

  // --- Elise como support: quantos jogos ela realmente tem no papel de support ---
  function eliseSupportCount(rows) {
    return rows.filter((r) => normChamp(r.sup_blue) === 'elise' || normChamp(r.sup_red) === 'elise').length;
  }
  const eliseS1 = eliseSupportCount(split1.rows);
  const eliseS2 = eliseSupportCount(split2.rows);
  console.log(`\nElise como SUPPORT (normalmente é jungler): split1=${eliseS1}, split2=${eliseS2}, pooled=${eliseS1 + eliseS2}`);

  // --- Regra 1: ambos supports ∈ OVER_SET ---
  const bothInOverSet = (r) => OVER_SET.has(normChamp(r.sup_blue)) && OVER_SET.has(normChamp(r.sup_red));
  const rule1 = evalRule(bothInOverSet, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('1. AMBOS supports ∈ OVER_SET {Rell, Nautilus, Pyke, Leona, Elise}', rule1);

  // --- Regra 2: variante estrita — ambos ∈ {Rell, Nautilus} ---
  const bothStrict = (r) => STRICT_SET.has(normChamp(r.sup_blue)) && STRICT_SET.has(normChamp(r.sup_red));
  const rule2 = evalRule(bothStrict, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('2. Variante ESTRITA — ambos ∈ {Rell, Nautilus}', rule2);

  // --- Regra 3: variante frouxa — ≥1 ∈ OVER_SET E o outro lado NÃO é peel ---
  const looseRule = (r) => {
    const blueIn = OVER_SET.has(normChamp(r.sup_blue));
    const redIn = OVER_SET.has(normChamp(r.sup_red));
    if (!blueIn && !redIn) return false;
    if (blueIn && redIn) return true; // OVER_SET e PEEL_PURE são disjuntos — trivialmente satisfaz
    if (blueIn) return !PEEL_SET.has(normChamp(r.sup_red));
    return !PEEL_SET.has(normChamp(r.sup_blue));
  };
  const rule3 = evalRule(looseRule, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('3. Variante FROUXA — ≥1 ∈ OVER_SET E o outro lado NÃO é PEEL_PURE', rule3);

  // --- Regra 4: pares específicos dentro do OVER_SET (n≥3 pra stats completas, senão só n) ---
  console.log('\n\n### 4. Pares específicos dentro do OVER_SET\n');
  const pairKeys = [];
  for (let i = 0; i < OVER_SET_DISPLAY.length; i++) {
    for (let j = i + 1; j < OVER_SET_DISPLAY.length; j++) {
      pairKeys.push([OVER_SET_DISPLAY[i], OVER_SET_DISPLAY[j]]);
    }
  }
  const pairResults = pairKeys.map(([a, b]) => {
    const an = normChamp(a);
    const bn = normChamp(b);
    const matchFn = (r) => {
      const blue = normChamp(r.sup_blue);
      const red = normChamp(r.sup_red);
      return (blue === an && red === bn) || (blue === bn && red === an);
    };
    const r1 = split1.rows.filter(matchFn);
    const r2 = split2.rows.filter(matchFn);
    const rPooled = [...r1, ...r2];
    const s1 = cellStats(r1, OVER_ODD);
    const s2 = cellStats(r2, OVER_ODD);
    const pooled = cellStats(rPooled, OVER_ODD);
    return { pair: `${a} + ${b}`, n_split1: s1.n, n_split2: s2.n, pooled, eligible: pooled.n >= PAIR_MIN_N };
  });
  pairResults.sort((x, y) => y.pooled.n - x.pooled.n);
  console.log('| par | n_s1 | n_s2 | n_pooled | hit%_pooled | ROI%_pooled | obs |');
  console.log('|---|---|---|---|---|---|---|');
  for (const p of pairResults) {
    const obs = p.eligible ? '' : `amostra insuficiente (n<${PAIR_MIN_N})`;
    console.log(`| ${p.pair} | ${p.n_split1} | ${p.n_split2} | ${p.pooled.n} | ${p.eligible ? p.pooled.hit_pct ?? '-' : '-'} | ${p.eligible ? p.pooled.roi_pct ?? '-' : '-'} | ${obs} |`);
  }

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    caveat_obrigatorio:
      'OVER_SET {Rell, Nautilus, Pyke, Leona, Elise} foi escolhido pelo dono DEPOIS de ver a tabela por champion ' +
      '(audit-output/13-over-by-support.json) — seleção pós-hoc sobre o MESMO dado que gerou os candidatos ' +
      '(Rell/Nautilus vieram do topo daquela tabela). Isso não é validação out-of-sample — é re-análise do mesmo ' +
      'dado com filtro escolhido a posteriori, risco real de overfit. O único teste honesto possível é a ' +
      'CONSISTÊNCIA ENTRE OS 2 SPLITS: se o efeito é real, os dois deveriam apontar na mesma direção; se só um ' +
      'split "salva" o número, é ruído, não edge.',
    params: {
      over_odd: OVER_ODD,
      over_be_pct: OVER_BE,
      z_score_95: Z95,
      pair_min_n: PAIR_MIN_N,
      over_set: OVER_SET_DISPLAY,
      strict_set: STRICT_SET_DISPLAY,
      verdict_criteria: {
        LUCRATIVO: 'CI95% inferior do pooled ≥ BE E hit%_split1 ≥ BE E hit%_split2 ≥ BE (rigor estatístico + replicação nos 2 splits)',
        INCERTO: 'hit%_pooled ≥ BE mas não atende os 2 critérios acima juntos',
        NEGATIVO: 'hit%_pooled < BE',
      },
    },
    meta: {
      split1_population_n: split1.population_n,
      split2_population_n: split2.population_n,
      elise_as_support: { split1: eliseS1, split2: eliseS2, pooled: eliseS1 + eliseS2, note: 'Elise normalmente joga jungle — n baixo aqui é esperado, não é bug.' },
    },
    rule1_both_in_over_set: rule1,
    rule2_strict_rell_nautilus: rule2,
    rule3_loose_one_in_set_other_not_peel: rule3,
    rule4_specific_pairs: pairResults,
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
