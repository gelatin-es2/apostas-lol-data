// scripts/analysis/over-red-teams.cjs
//
// Follow-up do dono: "e se eu apostar Over só nos jogos de TIME VERMELHO do método
// Under dele?" (vermelho = time que quebra o Under nas flags do método dele).
//
// Classificação TRAILING sem leakage — pra cada jogo, cada time é classificado pelo
// histórico ANTERIOR à data do jogo, DENTRO DO MESMO SPLIT (nunca cruza split1/split2,
// nunca olha pro futuro):
//   under-rate trailing = % dos jogos ANTERIORES do time com total_kills < fair
//   VERMELHO = under-rate < 50% (n≥5 jogos anteriores)
//   VERDE    = under-rate ≥ 60% (n≥5 jogos anteriores)
//   NEUTRO   = resto (inclui n<5, insuficiente pra classificar)
//
// Isso é a MESMA pergunta do D2 de scripts/analysis/split2-over-method.cjs (hot/cold
// por delta de kills, classificado num período fixo abril → testado mai-jun: NÃO
// persistiu, hot=45.1% vs cold=45.6% vs neutral=46.4% — praticamente flat), mas com
// (a) flag diferente (under-rate em vez de delta médio) e (b) walk-forward contínuo
// em vez de corte fixo por período. Reportamos a comparação explicitamente.
//
// Fair leave-one-out — MESMA função de over-method-v2.cjs / over-by-support.cjs /
// over-pairs.cjs, recalculada por split. Over @ fair, odd flat 1.80 (BE 55.6%).
//
// Uso: node scripts/analysis/over-red-teams.cjs
// Output: audit-output/15-over-red-teams.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE } = require('../audit/lib/audit-common.cjs');
const { normTeamName } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '15-over-red-teams.json');

const SPLIT_FILES = {
  1: { file: path.join(AUDIT_OUTPUT, '00-universe-split1.json'), label: 'split1 (jan-mar 2026)' },
  2: { file: path.join(AUDIT_OUTPUT, '00-universe.json'), label: 'split2 (abr-jun 2026)' },
};

const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const Z95 = 1.96;
const TRAILING_MIN_N = 5;
const RED_THRESHOLD = 0.5; // under-rate < 50% = VERMELHO
const GREEN_THRESHOLD = 0.6; // under-rate >= 60% = VERDE

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const OVER_SET4_DISPLAY = ['Rell', 'Nautilus', 'Pyke', 'Leona']; // sem Elise, conjunto exato do follow-up
const OVER_SET4 = new Set(OVER_SET4_DISPLAY.map(normChamp));

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
// over-by-support.cjs / over-pairs.cjs (mesma fórmula, mesmo recorte por split).
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
function cellStats(rows, odd) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, odd) };
}
// sync: scripts/analysis/over-pairs.cjs (mesmo critério combinado)
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
// Trailing under-rate classifier — walk-forward DENTRO do split, sem leakage.
// ============================================================================
function buildTrailingUnderRate(rowsChrono) {
  const record = new Map(); // team -> { n, underCount }
  const clsOf = (team) => {
    const rec = record.get(team);
    if (!rec || rec.n < TRAILING_MIN_N) return 'NEUTRO';
    const rate = rec.underCount / rec.n;
    if (rate < RED_THRESHOLD) return 'VERMELHO';
    if (rate >= GREEN_THRESHOLD) return 'VERDE';
    return 'NEUTRO';
  };
  const out = new Map(); // game_id -> { clsBlue, clsRed }
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
      team_blue: normTeamName(g.team_blue) || g.team_blue,
      team_red: normTeamName(g.team_red) || g.team_red,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      total_kills: g.total_kills,
      fair,
      over_hit: g.total_kills > fair,
    };
  });

  const chrono = [...rowsRaw].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.game_id).localeCompare(String(b.game_id)));
  const trailingCls = buildTrailingUnderRate(chrono);
  const rows = chrono.map((r) => {
    const cls = trailingCls.get(r.game_id);
    return { ...r, clsBlue: cls.clsBlue, clsRed: cls.clsRed };
  });

  return { label: cfg.label, population_n: population.length, rows };
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

// Persistência agregada por bucket (VERMELHO/VERDE/NEUTRO) — comparável ao D2 do
// split2-over-method.cjs (que usava hot/neutral/cold por delta médio, período fixo).
function persistenceByBucket(rows) {
  const buckets = { VERMELHO: [], VERDE: [], NEUTRO: [] };
  for (const r of rows) {
    for (const cls of [r.clsBlue, r.clsRed]) {
      buckets[cls].push(r);
    }
  }
  const out = {};
  for (const b of ['VERMELHO', 'VERDE', 'NEUTRO']) {
    const rs = buckets[b];
    const n = rs.length;
    const wins = rs.filter((r) => r.over_hit).length;
    out[b] = { n, wins, over_hit_pct: n ? fmt1((100 * wins) / n) : null };
  }
  return out;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('OVER nos jogos de TIME VERMELHO (trailing under-rate, sem leakage)');
  console.log('='.repeat(70));

  const split1 = loadSplit(1);
  const split2 = loadSplit(2);
  console.log(`\nsplit1 (${split1.label}): população=${split1.population_n}`);
  console.log(`split2 (${split2.label}): população=${split2.population_n}`);

  const dist1 = persistenceByBucket(split1.rows);
  const dist2 = persistenceByBucket(split2.rows);
  const distPooled = {};
  for (const b of ['VERMELHO', 'VERDE', 'NEUTRO']) {
    const n = dist1[b].n + dist2[b].n;
    const wins = dist1[b].wins + dist2[b].wins;
    distPooled[b] = { n, wins, over_hit_pct: n ? fmt1((100 * wins) / n) : null };
  }

  console.log('\n\n## Persistência por bucket (trailing, comparável ao D2 antigo)\n');
  console.log('| bucket | n_s1 | hit%_s1 | n_s2 | hit%_s2 | n_pooled | hit%_pooled |');
  console.log('|---|---|---|---|---|---|---|');
  for (const b of ['VERMELHO', 'VERDE', 'NEUTRO']) {
    console.log(`| ${b} | ${dist1[b].n} | ${dist1[b].over_hit_pct ?? '-'} | ${dist2[b].n} | ${dist2[b].over_hit_pct ?? '-'} | ${distPooled[b].n} | ${distPooled[b].over_hit_pct ?? '-'} |`);
  }

  // --- Regra 1: ≥1 vermelho ---
  const rule1Fn = (r) => r.clsBlue === 'VERMELHO' || r.clsRed === 'VERMELHO';
  const rule1 = evalRule(rule1Fn, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('1. ≥1 time VERMELHO no jogo → Over @ fair', rule1);

  // --- Regra 2: ambos vermelhos ---
  const rule2Fn = (r) => r.clsBlue === 'VERMELHO' && r.clsRed === 'VERMELHO';
  const rule2 = evalRule(rule2Fn, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('2. AMBOS times VERMELHO → Over @ fair', rule2);

  // --- Regra 3: ≥1 vermelho E nenhum support peel ---
  const rule3Fn = (r) => rule1Fn(r) && !PEEL_SET.has(normChamp(r.sup_blue)) && !PEEL_SET.has(normChamp(r.sup_red));
  const rule3 = evalRule(rule3Fn, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('3. ≥1 VERMELHO E nenhum support PEEL_PURE → Over @ fair', rule3);

  // --- Regra 4: ≥1 vermelho E ≥1 support do OVER_SET {rell,nautilus,pyke,leona} ---
  const rule4Fn = (r) => rule1Fn(r) && (OVER_SET4.has(normChamp(r.sup_blue)) || OVER_SET4.has(normChamp(r.sup_red)));
  const rule4 = evalRule(rule4Fn, split1.rows, split2.rows, OVER_ODD, OVER_BE);
  printRuleTable('4. ≥1 VERMELHO E ≥1 support ∈ {Rell, Nautilus, Pyke, Leona} → Over @ fair', rule4);

  // --- Comparação com D2 (split2-over-method.cjs) ---
  const D2_REFERENCE = {
    D2a_abril_para_maijun: { hot: 45.1, neutral: 46.4, cold: 45.6, n_hot: 244, n_neutral: 416, n_cold: 248 },
    D2b_aprmai_para_jun: { hot: 36.8, neutral: 38.2, cold: 60.6, n_hot: 38, n_neutral: 89, n_cold: 33, flag: 'amostra pequena, cold>hot é provável ruído' },
  };
  const rule1SpreadPooled = fmt1((distPooled.VERMELHO.over_hit_pct ?? 0) - (distPooled.VERDE.over_hit_pct ?? 0));
  console.log('\n\n## Comparação com D2 (hot/cold por delta médio, split2-over-method.cjs)\n');
  console.log(`D2a (classificação abril → teste mai-jun): hot=${D2_REFERENCE.D2a_abril_para_maijun.hot}% vs neutral=${D2_REFERENCE.D2a_abril_para_maijun.neutral}% vs cold=${D2_REFERENCE.D2a_abril_para_maijun.cold}% — flat, sem persistência.`);
  console.log(`Este corte (trailing under-rate, pooled): VERMELHO=${distPooled.VERMELHO.over_hit_pct}% vs VERDE=${distPooled.VERDE.over_hit_pct}% vs NEUTRO=${distPooled.NEUTRO.over_hit_pct}% — spread VERMELHO-VERDE=${rule1SpreadPooled}pp.`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD,
      over_be_pct: OVER_BE,
      z_score_95: Z95,
      trailing_min_n: TRAILING_MIN_N,
      red_threshold_under_rate: RED_THRESHOLD,
      green_threshold_under_rate: GREEN_THRESHOLD,
      over_set4: OVER_SET4_DISPLAY,
      verdict_criteria: {
        LUCRATIVO: 'CI95% inferior do pooled ≥ BE E hit%_split1 ≥ BE E hit%_split2 ≥ BE',
        INCERTO: 'hit%_pooled ≥ BE mas não atende os 2 critérios acima juntos',
        NEGATIVO: 'hit%_pooled < BE',
      },
    },
    meta: {
      split1_population_n: split1.population_n,
      split2_population_n: split2.population_n,
      classification_method: 'trailing walk-forward, sem leakage, dentro do split — cada time classificado pelo histórico ANTERIOR à data do jogo, nunca cruza split1/split2',
    },
    persistence_by_bucket: { split1: dist1, split2: dist2, pooled: distPooled },
    d2_reference_comparison: D2_REFERENCE,
    rule1_geq1_vermelho: rule1,
    rule2_ambos_vermelho: rule2,
    rule3_vermelho_sem_peel: rule3,
    rule4_vermelho_e_over_set: rule4,
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
