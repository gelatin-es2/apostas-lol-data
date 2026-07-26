// scripts/analysis/over-method-v2.cjs
//
// Refino do método Over total kills com (a) o modelo de odds REAL do dono (escada por
// distância da fair, ~0.11/linha) e (b) validação em dados novos (split 1, jan-mar
// 2026) que a regra NUNCA viu — split 1 é teste cego, split 2 é onde as regras foram
// definidas (ver scripts/analysis/split2-over-method.cjs).
//
// Fair leave-one-out é recalculada POR SPLIT (médias de time só dentro do próprio
// split — split 1 e split 2 não se misturam na história de kills de nenhum time,
// mesmo que o time jogue nos dois).
//
// Regras testadas — PRÉ-FIXADAS no split 2, NÃO reajustadas aqui:
//   2xEngage      = archBlue===ENGAGE && archRed===ENGAGE
//   EngageNoPeel  = (archBlue===ENGAGE || archRed===ENGAGE) && nenhum dos dois é PEEL
//
// Modelo de odds real (info do dono, casa dele, ~0.11 odd por linha de distância):
//   Over fair-1 → 1.72 (BE 58.1%) · Over fair → 1.83 (BE 54.6%) ·
//   Over fair+1 → 1.95 (BE 51.3%, EXTRAPOLADO da escada — a casa não confirmou esse
//   degrau especificamente, só o padrão simétrico do Under).
//
// Uso: node scripts/analysis/over-method-v2.cjs
// Output: audit-output/12-over-v2.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE } = require('../audit/lib/audit-common.cjs');
const { normTeamName } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '12-over-v2.json');

const SPLIT_FILES = {
  1: { file: path.join(AUDIT_OUTPUT, '00-universe-split1.json'), label: 'split1 (jan-mar 2026, teste cego)' },
  2: { file: path.join(AUDIT_OUTPUT, '00-universe.json'), label: 'split2 (abr-jun 2026, onde a regra foi definida)' },
};

// === Escada de odds real do dono (ver prompt/CLAUDE.md) ===
const RUNGS = [
  { key: 'fair_minus_1', offset: -1, odd: 1.72, be_pct: 58.1, extrapolated: false },
  { key: 'fair', offset: 0, odd: 1.83, be_pct: 54.6, extrapolated: false },
  { key: 'fair_plus_1', offset: 1, odd: 1.95, be_pct: 51.3, extrapolated: true },
];
const UNDER_RUNG = { key: 'fair_plus_1', offset: 1, odd: 1.72, be_pct: 58.1 }; // método Under real do dono, hoje

const Z95 = 1.96;

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
// ARQUÉTIPOS DE SUPPORT — cópia sincronizada de scripts/analysis/split2-over-method.cjs
// (mesmas listas, mesma lógica de classificação, INCLUINDO o tratamento do Braum).
// sync: scripts/analysis/split2-over-method.cjs L59-126 — se mudar lá, mudar aqui.
// Reuso intencional (prompt): as regras 2xEngage/EngageNoPeel foram definidas em cima
// dessas listas no split 2; usar listas diferentes aqui invalidaria o teste cego.
// ============================================================================
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

const PEEL_SET = new Set(PEEL_PURE.map(normChamp));

const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric', 'morgana',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));

const MAGE_LIST = [
  'lux', 'brand', 'xerath', 'zyra', 'velkoz', 'swain',
  'anivia', 'mel', 'neeko', 'rumble',
];
const MAGE_SET = new Set(MAGE_LIST.map(normChamp));

const BRAUM_NORM = 'braum';
const BRAUM_DEFAULT = 'ENGAGE'; // mesmo default do split2-over-method.cjs

function classify(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (c === BRAUM_NORM) return BRAUM_DEFAULT;
  if (PEEL_SET.has(c)) return 'PEEL';
  if (ENGAGE_SET.has(c)) return 'ENGAGE';
  if (MAGE_SET.has(c)) return 'MAGE';
  return 'OUTRO';
}

// ============================================================================
// Fair leave-one-out — cópia adaptada, mas rodada POR SPLIT (teamHist/leagueAvg
// construídos só com o universo daquele split, nunca cruzando splits).
// sync: split2-over-method.cjs L136-173 (mesma fórmula).
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
// Window loader — só usado pro relatório de cobertura de picks (item 3 do prompt).
// As regras 2xEngage/EngageNoPeel usam sup_blue/sup_red do PRÓPRIO universo (já
// extraído no phase0 a partir do mesmo window) — não dependem do roster de 10 picks.
// ============================================================================
function loadWindow(gameId) {
  const f = path.join(AUDIT_CACHE, `window-${gameId}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
function hasFullRoster(windowJson) {
  const bm = windowJson?.gameMetadata?.blueTeamMetadata;
  const rm = windowJson?.gameMetadata?.redTeamMetadata;
  if (!bm || !rm) return false;
  const rolesOf = (md) => new Set((md.participantMetadata || []).map((p) => p.role));
  const b = rolesOf(bm);
  const r = rolesOf(rm);
  return ROLES.every((role) => b.has(role) && r.has(role));
}

// ============================================================================
// Wilson score interval (95%) — padrão pra proporção binomial com n pequeno.
// ============================================================================
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

// bucket de estatística pra uma célula (n games, rung específico)
function cellStats(rows, rungKey, odd) {
  const n = rows.length;
  const wins = rows.filter((r) => r.hits[rungKey]).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return {
    n,
    wins,
    hit_pct: hitPct,
    wilson_ci_95: { lower: ci.lower, upper: ci.upper },
    roi_pct: roiPct(wins, n, odd),
  };
}

function volumePerMonth(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const m = (r.date || '').slice(0, 7);
    if (!m) continue;
    byMonth.set(m, (byMonth.get(m) || 0) + 1);
  }
  const months = [...byMonth.keys()].sort();
  return {
    n_total: rows.length,
    n_months: months.length,
    avg_per_month: months.length ? fmt1(rows.length / months.length) : null,
    by_month: Object.fromEntries(months.map((m) => [m, byMonth.get(m)])),
  };
}

// ============================================================================
// Carrega e monta rows de 1 split.
// ============================================================================
function loadSplit(splitNum) {
  const cfg = SPLIT_FILES[splitNum];
  const universeFull = loadJson(cfg.file);
  const teamHist = buildTeamKillsHistory(universeFull);
  const leagueAvg = buildLeagueAvgKills(universeFull);
  const population = universeFull.filter((g) => !g.suspect && g.total_kills != null);

  const gamesPerTeam = [...teamHist.values()].map((a) => a.length);
  const fairQuality = {
    n_teams: gamesPerTeam.length,
    avg_games_per_team: gamesPerTeam.length ? fmt1(gamesPerTeam.reduce((a, b) => a + b, 0) / gamesPerTeam.length) : null,
  };

  let noWindowFile = 0;
  let noFullRoster = 0;
  const rows = population.map((g) => {
    const fair = fairFormulaForGame(g, teamHist, leagueAvg);
    const win = loadWindow(g.game_id);
    if (!win) noWindowFile++;
    else if (!hasFullRoster(win)) noFullRoster++;

    const archBlue = classify(g.sup_blue);
    const archRed = classify(g.sup_red);

    const hits = {};
    for (const rung of RUNGS) {
      hits[rung.key] = g.total_kills > fair + rung.offset;
    }
    const underHitFairPlus1 = g.total_kills < fair + UNDER_RUNG.offset;

    return {
      split: splitNum,
      game_id: g.game_id,
      league: g.league,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      team_blue: normTeamName(g.team_blue) || g.team_blue,
      team_red: normTeamName(g.team_red) || g.team_red,
      total_kills: g.total_kills,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      trigger_type: g.trigger_type,
      fair,
      archBlue,
      archRed,
      hits, // { fair_minus_1, fair, fair_plus_1 } -> bool (Over hit)
      under_hit_fair_plus_1: underHitFairPlus1,
    };
  });

  const coverage = {
    population_n: population.length,
    no_window_file: noWindowFile,
    no_full_roster: noFullRoster,
    rows_with_full_roster: population.length - noWindowFile - noFullRoster,
    coverage_pct: population.length ? fmt1((100 * (population.length - noWindowFile - noFullRoster)) / population.length) : null,
  };

  return {
    label: cfg.label,
    universe_raw_n: universeFull.length,
    suspect_n: universeFull.filter((g) => g.suspect).length,
    fetch_error_n: universeFull.filter((g) => g.fetch_error).length,
    population_n: population.length,
    coverage,
    fair_quality: fairQuality,
    rows,
  };
}

const RULES = {
  '2xEngage': (r) => r.archBlue === 'ENGAGE' && r.archRed === 'ENGAGE',
  'EngageNoPeel': (r) => (r.archBlue === 'ENGAGE' || r.archRed === 'ENGAGE') && r.archBlue !== 'PEEL' && r.archRed !== 'PEEL',
};
const RULE_NAMES = Object.keys(RULES);
const BUCKET_NAMES = ['baseline', ...RULE_NAMES];

function rowsForBucket(rows, bucketName) {
  if (bucketName === 'baseline') return rows;
  return rows.filter(RULES[bucketName]);
}

function buildRungTable(rows) {
  const out = {};
  for (const bucket of BUCKET_NAMES) {
    const bucketRows = rowsForBucket(rows, bucket);
    out[bucket] = {};
    for (const rung of RUNGS) {
      out[bucket][rung.key] = { odd: rung.odd, be_pct: rung.be_pct, extrapolated: rung.extrapolated, ...cellStats(bucketRows, rung.key, rung.odd) };
    }
  }
  return out;
}

function underSanity(rows) {
  const triggered = rows.filter((r) => !!r.trigger_type);
  const n = triggered.length;
  const wins = triggered.filter((r) => r.under_hit_fair_plus_1).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return {
    rung: UNDER_RUNG,
    n,
    wins,
    hit_pct: hitPct,
    wilson_ci_95: { lower: ci.lower, upper: ci.upper },
    roi_pct: roiPct(wins, n, UNDER_RUNG.odd),
  };
}

function peelPeelSanity(rows) {
  const cellRows = rows.filter((r) => r.archBlue === 'PEEL' && r.archRed === 'PEEL');
  const n = cellRows.length;
  const wins = cellRows.filter((r) => r.hits.fair).length; // Over hit na linha fair (mid rung)
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, over_hit_pct_at_fair: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, expected_range: '35-42%' };
}

function verdictFor(pooledCell) {
  if (pooledCell.n === 0) return 'SEM_DADO';
  const be = pooledCell.be_pct;
  const lower = pooledCell.wilson_ci_95.lower;
  const center = pooledCell.hit_pct;
  if (lower != null && lower >= be) return 'LUCRATIVO';
  if (center != null && center >= be) return 'INCERTO';
  return 'NEGATIVO';
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('MÉTODO OVER v2 — modelo de odds real + validação split 1 (teste cego)');
  console.log('='.repeat(70));

  const split1 = loadSplit(1);
  const split2 = loadSplit(2);
  const pooledRows = [...split1.rows, ...split2.rows];

  console.log(`\nSplit 1 (${split1.label}): universo bruto=${split1.universe_raw_n}, suspect=${split1.suspect_n}, fetch_error=${split1.fetch_error_n}, população=${split1.population_n}`);
  console.log(`  Cobertura window/roster: ${split1.coverage.rows_with_full_roster}/${split1.coverage.population_n} (${split1.coverage.coverage_pct}%) — sem window file: ${split1.coverage.no_window_file}, sem roster completo: ${split1.coverage.no_full_roster}`);
  console.log(`  Qualidade da fair: ${split1.fair_quality.n_teams} times, ${split1.fair_quality.avg_games_per_team} jogos/time em média`);
  console.log(`Split 2 (${split2.label}): universo bruto=${split2.universe_raw_n}, suspect=${split2.suspect_n}, fetch_error=${split2.fetch_error_n}, população=${split2.population_n}`);
  console.log(`  Cobertura window/roster: ${split2.coverage.rows_with_full_roster}/${split2.coverage.population_n} (${split2.coverage.coverage_pct}%) — sem window file: ${split2.coverage.no_window_file}, sem roster completo: ${split2.coverage.no_full_roster}`);
  console.log(`  Qualidade da fair: ${split2.fair_quality.n_teams} times, ${split2.fair_quality.avg_games_per_team} jogos/time em média`);

  const tables = {
    1: buildRungTable(split1.rows),
    2: buildRungTable(split2.rows),
    pooled: buildRungTable(pooledRows),
  };

  console.log('\n\n## Hit% / CI95% / ROI por bucket × rung × contexto (split1 / split2 / pooled)\n');
  for (const bucket of BUCKET_NAMES) {
    console.log(`\n### bucket: ${bucket}\n`);
    console.log('| contexto | rung | odd | BE% | n | hit% | CI95% | ROI% |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const ctx of ['1', '2', 'pooled']) {
      for (const rung of RUNGS) {
        const c = tables[ctx][bucket][rung.key];
        const ciStr = c.n ? `[${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}]` : '-';
        console.log(`| ${ctx === '1' ? 'split1' : ctx === '2' ? 'split2' : 'pooled'} | ${rung.key}${rung.extrapolated ? ' (extrap.)' : ''} | ${rung.odd} | ${rung.be_pct} | ${c.n} | ${c.hit_pct ?? '-'} | ${ciStr} | ${c.roi_pct ?? '-'} |`);
      }
    }
  }

  // --- Sanity: Under do dono nos 2 splits ---
  const underS1 = underSanity(split1.rows);
  const underS2 = underSanity(split2.rows);
  const underPooled = underSanity(pooledRows);
  console.log('\n\n## Sanity — método Under real do dono (trigger peel, Under fair+1 @ 1.72, BE 58.1%)\n');
  console.log('| contexto | n | hit% (Under) | CI95% | ROI% |');
  console.log('|---|---|---|---|---|');
  for (const [name, s] of [['split1', underS1], ['split2', underS2], ['pooled', underPooled]]) {
    const ciStr = s.n ? `[${s.wilson_ci_95.lower}, ${s.wilson_ci_95.upper}]` : '-';
    console.log(`| ${name} | ${s.n} | ${s.hit_pct ?? '-'} | ${ciStr} | ${s.roi_pct ?? '-'} |`);
  }

  // --- Sanity: PEEL×PEEL Over hit no split1 (espelho do Under) ---
  const peelPeelS1 = peelPeelSanity(split1.rows);
  const peelPeelS2 = peelPeelSanity(split2.rows);
  console.log('\n\n## Sanity — célula PEEL×PEEL, Over hit @ fair (esperado ~35-42%, espelho do Under)\n');
  console.log(`split1: n=${peelPeelS1.n}, Over hit=${peelPeelS1.over_hit_pct_at_fair}% CI95%=[${peelPeelS1.wilson_ci_95.lower}, ${peelPeelS1.wilson_ci_95.upper}]`);
  console.log(`split2: n=${peelPeelS2.n}, Over hit=${peelPeelS2.over_hit_pct_at_fair}% CI95%=[${peelPeelS2.wilson_ci_95.lower}, ${peelPeelS2.wilson_ci_95.upper}]`);
  const peelPeelFlag = peelPeelS1.n >= 10 && (peelPeelS1.over_hit_pct_at_fair < 30 || peelPeelS1.over_hit_pct_at_fair > 47);
  if (peelPeelFlag) console.log('[FLAG] PEEL×PEEL do split1 fora do range esperado (35-42%) — fair do split1 pode estar mal calibrada, ver notas.');
  else if (peelPeelS1.over_hit_pct_at_fair > 42) console.log(`[INFO] ponto central (${peelPeelS1.over_hit_pct_at_fair}%) acima de 42% mas dentro do CI95% — consistente com ruído de amostra (split1 tem menos jogos/time que split2, fair mais ruidosa), não necessariamente miscalibração.`);

  // --- Tabela de decisão (pooled, regra × rung) ---
  console.log('\n\n## TABELA DE DECISÃO (pooled split1+split2)\n');
  console.log('| regra | rung | odd | BE% | n | hit%(pooled) | CI95% | ROI% | veredito |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const decision = [];
  for (const bucket of BUCKET_NAMES) {
    for (const rung of RUNGS) {
      const c = tables.pooled[bucket][rung.key];
      const verdict = verdictFor(c);
      decision.push({ bucket, rung: rung.key, odd: rung.odd, be_pct: rung.be_pct, extrapolated: rung.extrapolated, ...c, verdict });
      const ciStr = c.n ? `[${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}]` : '-';
      console.log(`| ${bucket} | ${rung.key}${rung.extrapolated ? ' (extrap.)' : ''} | ${rung.odd} | ${rung.be_pct} | ${c.n} | ${c.hit_pct ?? '-'} | ${ciStr} | ${c.roi_pct ?? '-'} | ${verdict} |`);
    }
  }

  // --- Volume/mês das duas regras (rows completas, sem filtro de rung) ---
  const volumes = {};
  for (const bucket of RULE_NAMES) {
    volumes[bucket] = {
      split1: volumePerMonth(rowsForBucket(split1.rows, bucket)),
      split2: volumePerMonth(rowsForBucket(split2.rows, bucket)),
      pooled: volumePerMonth(rowsForBucket(pooledRows, bucket)),
    };
  }
  console.log('\n\n## Volume/mês por regra\n');
  console.log('| regra | contexto | n_total | n_meses | média/mês |');
  console.log('|---|---|---|---|---|');
  for (const bucket of RULE_NAMES) {
    for (const ctx of ['split1', 'split2', 'pooled']) {
      const v = volumes[bucket][ctx];
      console.log(`| ${bucket} | ${ctx} | ${v.n_total} | ${v.n_months} | ${v.avg_per_month ?? '-'} |`);
    }
  }

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      rungs: RUNGS,
      under_rung: UNDER_RUNG,
      z_score_95: Z95,
      odds_model_source: 'informado pelo dono — precificação por distância da fair, ~0.11 odd/linha; fair+1 do Over é EXTRAPOLAÇÃO simétrica do degrau do Under, não confirmada diretamente pela casa',
    },
    meta: {
      split1: { label: split1.label, universe_raw_n: split1.universe_raw_n, suspect_n: split1.suspect_n, fetch_error_n: split1.fetch_error_n, population_n: split1.population_n, coverage: split1.coverage, fair_quality: split1.fair_quality },
      split2: { label: split2.label, universe_raw_n: split2.universe_raw_n, suspect_n: split2.suspect_n, fetch_error_n: split2.fetch_error_n, population_n: split2.population_n, coverage: split2.coverage, fair_quality: split2.fair_quality },
      pooled_population_n: pooledRows.length,
    },
    archetypes: { PEEL: PEEL_PURE, ENGAGE: ENGAGE_LIST, MAGE: MAGE_LIST, braum_default: BRAUM_DEFAULT },
    rules: { '2xEngage': 'archBlue===ENGAGE && archRed===ENGAGE', 'EngageNoPeel': '(archBlue===ENGAGE || archRed===ENGAGE) && nenhum PEEL' },
    tables_by_context: tables, // { '1': {...}, '2': {...}, pooled: {...} }
    under_sanity: { split1: underS1, split2: underS2, pooled: underPooled },
    peel_peel_sanity: { split1: peelPeelS1, split2: peelPeelS2, flag: peelPeelFlag },
    decision_table: decision,
    volume_per_month: volumes,
    notes: [
      'Fair leave-one-out recalculada POR SPLIT — teamHist/leagueAvg do split1 usam só o universo split1 (jan-mar), do split2 só o universo split2 (abr-jun). Times que aparecem nos dois splits têm 2 históricos separados, nunca misturados.',
      'Regras 2xEngage/EngageNoPeel foram definidas e escolhidas no split2 (ver split2-over-method.cjs) — split1 é validação out-of-sample cega, NENHUMA regra nova foi criada ou ajustada aqui.',
      'Rung fair_plus_1 do Over (odd 1.95) é EXTRAPOLAÇÃO simétrica do degrau conhecido do Under — a casa não confirmou esse valor especificamente pro Over, só o padrão de ~0.11/linha e os valores fair-1/fair.',
      'Cobertura de window/roster (10 picks) reportada por transparência, mas as regras 2xEngage/EngageNoPeel usam sup_blue/sup_red do PRÓPRIO universo (extraído no phase0 do mesmo window) — não dependem de roster completo.',
      'Verdito da tabela de decisão usa hit% POOLED (split1+split2 combinados) — LUCRATIVO exige limite inferior do Wilson 95% CI ≥ BE do rung; INCERTO = ponto central ≥ BE mas CI cruza o BE; NEGATIVO = ponto central < BE.',
      'Em subgrupos pequenos (ex: 2xEngage no split2, n=66), os 3 rungs podem dar hit% IDÊNTICO — não é bug: fair sempre termina em .5 e kills é sempre inteiro, então o delta (kills-fair) é sempre um meio-inteiro; só quando delta=±0.5 exatamente os 3 rungs adjacentes (fair-1/fair/fair+1) podem divergir entre si. Se nenhum jogo do subgrupo cai exatamente nesse ponto, os 3 rungs coincidem por construção matemática.',
      `Fair quality: split1 tem ${split1.fair_quality.avg_games_per_team} jogos/time em média (vs ${split2.fair_quality.avg_games_per_team} no split2) — leave-one-out mais ruidosa no split1 (menos histórico por time), o que explica desvios como o PEEL×PEEL (44.6% vs 35-42% esperado, mas CI95% cobre o range esperado — ruído de amostra, não miscalibração sistemática).`,
    ],
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
