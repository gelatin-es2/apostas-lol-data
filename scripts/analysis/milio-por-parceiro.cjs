// scripts/analysis/milio-por-parceiro.cjs
//
// MILIO POR TIPO DE PARCEIRO — o tier 2u do Milio deve ser diferenciado pelo
// TIPO do outro suporte? (pedido do CEO 2026-07-26: "Milio com 1 flex = 1u e
// Milio com 1 peel = 2u — verificar se faz sentido").
//
// Pergunta central: Milio+peel (2peel com Milio) performa DIFERENTE de
// Milio+flex (1peel+flex com Milio como peel)? Se a diferença não for
// estatisticamente defensável, a regra simples "Milio = 2u sempre" fica.
//
// Categorias do sup DO OUTRO LADO (Milio de um lado, classifica o oposto):
//   peel   — PEEL_PURE (soraka/sona/janna/lulu/yuumi/karma/seraphine/renata/nami)
//   flex   — FLEX_ENGAGE (bard/rakan/lux/anivia)
//   engage — ENGAGE_LIST menos flex (rell/naut/leona/alistar/thresh/blitz/pyke...)
//   outro  — qualquer sup fora das 3 listas (mid/utility no sup etc.)
// Hoje o método só opera peel e flex; engage/outro = skip (referência ~50%).
//
// ============================================================================
// FONTES (tudo cache/disco; NENHUMA chamada de API — reusa a coleta de 26/07)
// ============================================================================
//   audit-output/00-universe-split1.json          — jan–mar, 6 ligas (696 games)
//   audit-output/00-universe-allregions.json      — 04-01 → 07-21, ~30 ligas
//   audit-output/00-universe-split3-window.json   — 07-21 → 07-26, ~43 ligas
//   cron-data/YYYY-MM-DD-fair-pinnacle.json       — fair Pinnacle (POR match_id)
//   Supabase `bets`                               — READ-ONLY, só bloco R$ real
//
// Recortes de tempo (mesma convenção do bard-flex-definitivo.cjs):
//   split1 = 2026-01-14 → 2026-03-30 · split2 = 04-01 → 06-30
//   julpre = 07-01 → 07-20 (majors paradas) · split3 = 07-21 → hoje
//
// Réguas de fair (sync: bard-flex-definitivo.cjs):
//   fair_loo   — leave-one-out por liga (convenção do repo; régua principal)
//   fair_trail — trailing causal (robustez: "dava pra saber na hora?")
//   fair_pinn  — Pinnacle manual, lookup SÓ por lolesports_match_id
//
// Régua de odds: Under na fair @1.83 (BE 54.6%) · fair+1 @1.72 (BE 58.1%).
// Regras invioláveis: stats por MAPA · n<10 = não é base · Wilson CI em toda
// taxa · CI da DIFERENÇA + z de 2 proporções no teste central · Supabase RO.
//
// Uso: node scripts/analysis/milio-por-parceiro.cjs [--no-bets]
// Output: audit-output/35-milio-parceiro.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, FLEX_ENGAGE } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const CRON_DIR = path.join(ROOT, 'cron-data');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '35-milio-parceiro.json');

const SPLIT1_FILE = path.join(AUDIT_OUTPUT, '00-universe-split1.json');
const ALLREGIONS_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');
const SPLIT3_FILE = path.join(AUDIT_OUTPUT, '00-universe-split3-window.json');

const Z95 = 1.96;
const SMALL_N = 10;
const FALLBACK_MIN_N = 5; // sync: bard-flex-definitivo.cjs / camille-sweep.cjs

const SPLIT2_FROM = '2026-04-01';
const JULPRE_FROM = '2026-07-01';
const SPLIT3_FROM = '2026-07-21';

const RUNGS = {
  fair: { odd: 1.83, be_pct: 54.6, label: 'Under na fair @1.83 (BE 54.6%)' },
  fairp1: { odd: 1.72, be_pct: 58.1, label: 'Under na fair+1 @1.72 (BE 58.1%)' },
};

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const FLEX_SET = new Set(FLEX_ENGAGE.map(normChamp));
// sync: bard-flex-definitivo.cjs ENGAGE_LIST / shen-under.cjs
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric',
  'morgana', 'braum',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));

const fmt1 = (n) => (Number.isFinite(n) ? +n.toFixed(1) : null);
const fmt2 = (n) => (Number.isFinite(n) ? +n.toFixed(2) : null);

function loadJson(file, fatal = true) {
  if (!fs.existsSync(file)) {
    if (fatal) {
      console.error(`FATAL: ${file} não existe.`);
      process.exit(1);
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fatal) {
      console.error(`FATAL: ${file} inválido: ${e.message}`);
      process.exit(1);
    }
    return null;
  }
}

// sync: bard-flex-definitivo.cjs wilsonCI
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lower: fmt1(100 * Math.max(0, center - margin)),
    upper: fmt1(100 * Math.min(1, center + margin)),
  };
}

function roiPct(wins, n, odd) {
  if (!n) return null;
  return fmt1((100 * (wins * (odd - 1) - (n - wins))) / n);
}

// sync: bard-flex-definitivo.cjs twoPropZ (teste z de 2 proporções + p bicaudal)
function twoPropZ(x1, n1, x2, n2) {
  if (!n1 || !n2) return { z: null, p_two_sided: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: null, p_two_sided: null };
  const z = (p1 - p2) / se;
  const erf = (x) => {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-x * x);
    return s * y;
  };
  const pTwo = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { z: fmt2(z), p_two_sided: pTwo < 1e-6 ? 1e-6 : +pTwo.toFixed(4) };
}

// CI 95% de Wald pra DIFERENÇA de proporções (em pontos percentuais).
// É o número que responde "peel ≠ flex é real ou ruído?": se o intervalo cruza
// zero, a diferença não é defensável.
function diffCI(x1, n1, x2, n2) {
  if (!n1 || !n2) return { diff_pp: null, lower_pp: null, upper_pp: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return {
    diff_pp: fmt1(100 * (p1 - p2)),
    lower_pp: fmt1(100 * (p1 - p2 - Z95 * se)),
    upper_pp: fmt1(100 * (p1 - p2 + Z95 * se)),
  };
}

// ============================================================================
// cellStats — bloco padrão de uma célula nas 2 réguas de odd.
// sync: bard-flex-definitivo.cjs cellStats (sem bootstrap/duração — não precisa)
// ============================================================================
function cellStats(rows, fairKey = 'fair_loo') {
  const usable = rows.filter((r) => Number.isFinite(r[fairKey]));
  const n = usable.length;
  const base = {
    n,
    small_sample: n < SMALL_N,
    avg_kills: null,
    avg_fair: null,
    avg_delta: null,
    fair: null,
    fairp1: null,
  };
  if (!n) return base;
  base.avg_kills = fmt1(usable.reduce((a, r) => a + r.total_kills, 0) / n);
  base.avg_fair = fmt1(usable.reduce((a, r) => a + r[fairKey], 0) / n);
  base.avg_delta = fmt2(usable.reduce((a, r) => a + (r.total_kills - r[fairKey]), 0) / n);
  for (const key of ['fair', 'fairp1']) {
    const { odd, be_pct } = RUNGS[key];
    const wins = usable.filter((r) =>
      key === 'fair' ? r.total_kills < r[fairKey] : r.total_kills < r[fairKey] + 1
    ).length;
    const ci = wilsonCI(wins, n);
    base[key] = {
      wins,
      hit_pct: fmt1((100 * wins) / n),
      wilson_ci_95: ci,
      roi_pct: roiPct(wins, n, odd),
      be_pct,
      pass_ci_lower_above_be: ci.lower != null && ci.lower > be_pct,
    };
  }
  return base;
}

function tableHeader() {
  console.log(
    '| célula | n | kills méd | delta (kills−fair) | Under@fair hit [CI95] | ROI@1.83 | Under@fair+1 hit [CI95] | ROI@1.72 | flag |'
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
}
function printCellRow(label, s, flagExtra = '') {
  if (!s || !s.n) {
    console.log(`| ${label} | 0 | - | - | - | - | - | - | ${flagExtra} |`);
    return;
  }
  const f = s.fair;
  const f1 = s.fairp1;
  console.log(
    `| ${label} | ${s.n} | ${s.avg_kills} | ${s.avg_delta > 0 ? '+' : ''}${s.avg_delta} | ` +
      `${f.hit_pct}% [${f.wilson_ci_95.lower}–${f.wilson_ci_95.upper}] | ${f.roi_pct}% | ` +
      `${f1.hit_pct}% [${f1.wilson_ci_95.lower}–${f1.wilson_ci_95.upper}] | ${f1.roi_pct}% | ` +
      `${s.small_sample ? 'n<10 — NÃO é base de dados' : ''}${flagExtra} |`
  );
}

// ============================================================================
// FAIR A/B — leave-one-out e trailing (sync: bard-flex-definitivo.cjs)
// ============================================================================
function computeFairLOO(population) {
  const byLeague = new Map();
  for (const g of population) {
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
    const leagueAvg = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const avgFor = (teamRaw) => {
        const arr = (teamHist.get(normalizeTeam(teamRaw)) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvg;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return fairMap;
}

function computeFairTrailing(population) {
  const byLeague = new Map();
  for (const g of population) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map();
  for (const [, gamesRaw] of byLeague) {
    const games = [...gamesRaw].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const teamHist = new Map();
    const leagueKills = [];
    const leagueOverall = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const leagueTrailing = leagueKills.length
        ? leagueKills.reduce((a, b) => a + b, 0) / leagueKills.length
        : leagueOverall;
      const avgFor = (teamRaw) => {
        const arr = teamHist.get(normalizeTeam(teamRaw)) || [];
        if (arr.length < FALLBACK_MIN_N) return leagueTrailing;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
      };
      const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
      for (const t of [g.team_blue, g.team_red]) {
        const k = normalizeTeam(t);
        if (!teamHist.has(k)) teamHist.set(k, []);
        teamHist.get(k).push(g.total_kills);
      }
      leagueKills.push(g.total_kills);
    }
  }
  return fairMap;
}

// sync: bard-flex-definitivo.cjs loadFairPinnacleByMatchId (SÓ por match_id)
function loadFairPinnacleByMatchId() {
  const byMatch = new Map();
  if (!fs.existsSync(CRON_DIR)) return { byMatch, files_n: 0 };
  const files = fs.readdirSync(CRON_DIR).filter((f) => /-fair-pinnacle\.json$/.test(f));
  for (const f of files) {
    const j = loadJson(path.join(CRON_DIR, f), false);
    for (const e of j?.fair_lines || []) {
      if (e.fair_line == null || !e.lolesports_match_id) continue;
      byMatch.set(String(e.lolesports_match_id), e.fair_line);
    }
  }
  return { byMatch, files_n: files.length };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  const noBets = process.argv.includes('--no-bets');
  const TODAY = new Date().toISOString().slice(0, 10);

  console.log('='.repeat(90));
  console.log('MILIO POR TIPO DE PARCEIRO — o 2u deve depender do sup do outro lado?');
  console.log('='.repeat(90));

  // 1. Universos (dedup allregions ∪ split3 por game_id, igual bard-flex)
  const uni1 = loadJson(SPLIT1_FILE).filter((g) => !g.suspect && g.total_kills != null);
  const uniAll = loadJson(ALLREGIONS_FILE).filter((g) => !g.suspect && g.total_kills != null);
  const uni3 = (loadJson(SPLIT3_FILE, false) || []).filter((g) => !g.suspect && g.total_kills != null);
  const seen = new Set();
  const poolModern = [];
  for (const g of [...uniAll, ...uni3]) {
    if (seen.has(g.game_id)) continue;
    seen.add(g.game_id);
    poolModern.push(g);
  }

  const fairLoo1 = computeFairLOO(uni1);
  const fairTrail1 = computeFairTrailing(uni1);
  const fairLooM = computeFairLOO(poolModern);
  const fairTrailM = computeFairTrailing(poolModern);
  const { byMatch: pinnByMatch, files_n: pinnFiles } = loadFairPinnacleByMatchId();

  const splitOf = (dateStr, isSplit1) => {
    if (isSplit1) return 'split1';
    const d = (dateStr || '').slice(0, 10);
    if (d < SPLIT2_FROM) return 'pre';
    if (d < JULPRE_FROM) return 'split2';
    if (d < SPLIT3_FROM) return 'julpre';
    return 'split3';
  };

  const mkRow = (g, isSplit1) => ({
    game_id: String(g.game_id),
    match_id: String(g.match_id),
    league: g.league,
    date: g.date,
    split: splitOf(g.date, isSplit1),
    map_number: g.map_number,
    sup_blue: g.sup_blue,
    sup_red: g.sup_red,
    total_kills: g.total_kills,
    fair_loo: (isSplit1 ? fairLoo1 : fairLooM).get(g.game_id) ?? null,
    fair_trail: (isSplit1 ? fairTrail1 : fairTrailM).get(g.game_id) ?? null,
    fair_pinn: pinnByMatch.get(String(g.match_id)) ?? null,
  });

  const rows = [...uni1.map((g) => mkRow(g, true)), ...poolModern.map((g) => mkRow(g, false))].filter(
    (r) => Number.isFinite(r.fair_loo)
  );
  const SPLITS = ['split1', 'split2', 'julpre', 'split3'];

  // 2. Classificação: Milio de um lado → categoria do sup DO OUTRO lado
  const milioSide = (r) =>
    normChamp(r.sup_blue) === 'milio' ? 'blue' : normChamp(r.sup_red) === 'milio' ? 'red' : null;
  const partnerOf = (r) => {
    const side = milioSide(r);
    if (!side) return null;
    return normChamp(side === 'blue' ? r.sup_red : r.sup_blue);
  };
  const categoryOf = (partner) => {
    if (!partner) return null;
    if (PEEL_SET.has(partner)) return 'peel';
    if (FLEX_SET.has(partner)) return 'flex';
    if (ENGAGE_SET.has(partner)) return 'engage';
    return 'outro';
  };

  const milioRows = rows.filter((r) => milioSide(r) !== null).map((r) => ({
    ...r,
    partner: partnerOf(r),
    category: categoryOf(partnerOf(r)),
  }));

  const CATS = ['peel', 'flex', 'engage', 'outro'];
  const byCat = Object.fromEntries(CATS.map((c) => [c, milioRows.filter((r) => r.category === c)]));

  const out = {
    generated_at: new Date().toISOString(),
    params: {
      rungs: RUNGS,
      small_sample_n: SMALL_N,
      splits: {
        split1: '2026-01-14 → 2026-03-30 (6 ligas)',
        split2: '2026-04-01 → 2026-06-30 (allregions, ~30 ligas)',
        julpre: '2026-07-01 → 2026-07-20 (majors paradas)',
        split3: `2026-07-21 → ${TODAY} (coleta 26/07, ~43 ligas)`,
      },
      categorias: {
        peel: 'outro sup em PEEL_PURE (= 2peel com Milio)',
        flex: 'outro sup em FLEX_ENGAGE (= 1peel+flex com Milio como peel)',
        engage: 'outro sup em ENGAGE_LIST fora do flex (skip atual)',
        outro: 'sup fora das 3 listas (skip atual)',
      },
      peel_pure: PEEL_PURE,
      flex_engage: FLEX_ENGAGE,
      engage_list: ENGAGE_LIST,
    },
    meta: {
      population_n: rows.length,
      milio_sup_n: milioRows.length,
      by_cat_n: Object.fromEntries(CATS.map((c) => [c, byCat[c].length])),
      pinnacle_files: pinnFiles,
      pinnacle_matches_indexed: pinnByMatch.size,
    },
  };

  console.log(`\nPopulação (mapas válidos com fair): ${rows.length} · Milio como SUP: ${milioRows.length}`);
  console.log(
    '  por categoria do parceiro: ' + CATS.map((c) => `${c}=${byCat[c].length}`).join(' · ')
  );
  console.log(
    '  distribuição de parceiros (top): ' +
      Object.entries(
        milioRows.reduce((m, r) => ((m[r.partner] = (m[r.partner] || 0) + 1), m), {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => `${k}:${v}`)
        .join(' · ')
  );

  // 3. TABELA PRINCIPAL — categoria × split (fair LOO)
  console.log('\n\n## 1. Milio por categoria do parceiro — por split (fair LOO)\n');
  const catTable = {};
  for (const cat of CATS) {
    console.log(`\n### Milio + ${cat}\n`);
    tableHeader();
    const bySplit = {};
    for (const sp of SPLITS) {
      const s = cellStats(byCat[cat].filter((r) => r.split === sp));
      bySplit[sp] = s;
      printCellRow(`${cat} — ${sp}`, s);
    }
    const pooled123 = cellStats(byCat[cat].filter((r) => ['split1', 'split2', 'split3'].includes(r.split)));
    const pooledAll = cellStats(byCat[cat]);
    printCellRow(`**${cat} — POOLED 1+2+3**`, pooled123);
    printCellRow(`${cat} — POOLED tudo (inclui julpre)`, pooledAll);
    catTable[cat] = { by_split: bySplit, pooled_1_2_3: pooled123, pooled_tudo: pooledAll };
  }
  // benchmark: Milio qualquer contexto + universo
  console.log('\n### Benchmarks\n');
  tableHeader();
  const milioTodos = cellStats(milioRows);
  const milioOperavel = cellStats(milioRows.filter((r) => r.category === 'peel' || r.category === 'flex'));
  printCellRow('Milio sup — QUALQUER parceiro', milioTodos);
  printCellRow('**Milio operável hoje (peel ∪ flex)**', milioOperavel);
  printCellRow('universo inteiro (referência)', cellStats(rows));
  out.por_categoria = catTable;
  out.benchmarks = { milio_qualquer_parceiro: milioTodos, milio_peel_ou_flex: milioOperavel, universo: cellStats(rows) };

  // 4. TESTE CENTRAL — peel vs flex: diferença é real ou ruído?
  console.log('\n\n## 2. TESTE CENTRAL — Milio+peel vs Milio+flex (a pergunta do Elvis)\n');
  const centralTest = {};
  for (const [label, filt] of [
    ['pooled 1+2+3', (r) => ['split1', 'split2', 'split3'].includes(r.split)],
    ['pooled tudo (c/ julpre)', () => true],
    ['split2', (r) => r.split === 'split2'],
    ['split3', (r) => r.split === 'split3'],
  ]) {
    const peel = cellStats(byCat.peel.filter(filt));
    const flex = cellStats(byCat.flex.filter(filt));
    const entry = { peel: { n: peel.n }, flex: { n: flex.n }, rungs: {} };
    for (const key of ['fair', 'fairp1']) {
      if (!peel.n || !flex.n) {
        entry.rungs[key] = { skip: 'sem amostra' };
        continue;
      }
      const d = diffCI(peel[key].wins, peel.n, flex[key].wins, flex.n);
      const z = twoPropZ(peel[key].wins, peel.n, flex[key].wins, flex.n);
      entry.rungs[key] = {
        peel_hit: peel[key].hit_pct,
        flex_hit: flex[key].hit_pct,
        diff_peel_menos_flex_pp: d.diff_pp,
        diff_ci95_pp: [d.lower_pp, d.upper_pp],
        cruza_zero: d.lower_pp != null && d.lower_pp <= 0 && d.upper_pp >= 0,
        z: z.z,
        p_two_sided: z.p_two_sided,
      };
    }
    centralTest[label] = entry;
  }
  console.log('| recorte | régua | peel hit (n) | flex hit (n) | diff (peel−flex) | CI95 da diff | p (z 2 prop.) | veredito |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [label, e] of Object.entries(centralTest)) {
    for (const key of ['fair', 'fairp1']) {
      const r = e.rungs[key];
      if (r.skip) {
        console.log(`| ${label} | ${key} | n=${e.peel.n} | n=${e.flex.n} | - | - | - | ${r.skip} |`);
        continue;
      }
      console.log(
        `| ${label} | ${key} | ${r.peel_hit}% (n=${e.peel.n}) | ${r.flex_hit}% (n=${e.flex.n}) | ` +
          `${r.diff_peel_menos_flex_pp > 0 ? '+' : ''}${r.diff_peel_menos_flex_pp}pp | ` +
          `[${r.diff_ci95_pp[0]}, ${r.diff_ci95_pp[1]}] | ${r.p_two_sided} | ` +
          `${r.cruza_zero ? 'CI cruza zero → RUÍDO' : r.diff_peel_menos_flex_pp > 0 ? 'peel MELHOR (real)' : 'flex MELHOR (real)'} |`
      );
    }
  }
  out.teste_central_peel_vs_flex = centralTest;

  // 5. FLEX individual (Milio×Bard / ×Rakan / ×Lux / ×Anivia) + peel individual
  console.log('\n\n## 3. Quebra por parceiro individual (pooled tudo, fair LOO, n≥5 exibido)\n');
  const porParceiro = [];
  const groups = new Map();
  for (const r of milioRows) {
    if (!groups.has(r.partner)) groups.set(r.partner, []);
    groups.get(r.partner).push(r);
  }
  tableHeader();
  for (const [partner, rs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = cellStats(rs);
    const perSplit = Object.fromEntries(
      SPLITS.map((sp) => [sp, cellStats(rs.filter((r) => r.split === sp))])
    );
    porParceiro.push({ partner, category: categoryOf(partner), ...s, by_split: perSplit });
    if (rs.length >= 5) printCellRow(`Milio × ${partner} (${categoryOf(partner)})`, s);
  }
  out.por_parceiro = porParceiro;

  // 6. Robustez das 2 células principais — réguas trailing e Pinnacle
  console.log('\n\n## 4. Robustez — mesmas células, réguas de fair diferentes\n');
  tableHeader();
  const robust = {};
  for (const cat of ['peel', 'flex']) {
    robust[cat] = {
      loo: cellStats(byCat[cat], 'fair_loo'),
      trailing: cellStats(byCat[cat], 'fair_trail'),
      pinnacle: cellStats(byCat[cat].filter((r) => r.fair_pinn != null), 'fair_pinn'),
    };
    printCellRow(`Milio+${cat} — fair LOO`, robust[cat].loo);
    printCellRow(`Milio+${cat} — fair TRAILING causal`, robust[cat].trailing);
    printCellRow(`Milio+${cat} — fair PINNACLE (só mapas cobertos)`, robust[cat].pinnacle);
  }
  out.robustez = robust;

  // 7. R$ REAL (Supabase read-only) — bets do Elvis com Milio, por categoria
  let betsBlock = { skipped: true };
  if (!noBets) {
    try {
      const { loadAllBets } = require('../audit/lib/audit-common.cjs');
      const bets = await loadAllBets();
      const supsOfBet = (b) => {
        const mc = b.raw_extraction?.match_context || {};
        return [normChamp(mc.blue_picks?.support), normChamp(mc.red_picks?.support)];
      };
      const isMilioBet = (b) => supsOfBet(b).includes('milio');
      const partnerOfBet = (b) => {
        const [a, c] = supsOfBet(b);
        return a === 'milio' ? c : a;
      };
      const isUnder = (b) => /under|menos\s*de/i.test(b.pick || '');
      const settled = bets.filter((b) => b.status === 'green' || b.status === 'red');
      const milioAll = settled.filter(isMilioBet);
      const milioUnder = milioAll.filter(isUnder);
      const milioReal = milioUnder.filter((b) => b.bookmaker !== 'SIMULATED');
      const milioSim = milioUnder.filter((b) => b.bookmaker === 'SIMULATED');

      const sumProfit = (arr) => arr.reduce((a, b) => a + (parseFloat(b.profit) || 0), 0);
      const sumStake = (arr) => arr.reduce((a, b) => a + (parseFloat(b.stake) || 0), 0);
      // hit POR MAPA (1 stake/mapa — réplica aggBy de lib/analiseStats.cjs)
      const hitPorMapa = (arr) => {
        const byMap = new Map();
        for (const b of [...arr].sort((x, y) =>
          String(y.bet_datetime || '').localeCompare(String(x.bet_datetime || ''))
        )) {
          const gid = String(b.raw_extraction?.match_context?.lolesports_game_id || b.id);
          if (!byMap.has(gid)) byMap.set(gid, b.status === 'green');
        }
        const n = byMap.size;
        const w = [...byMap.values()].filter(Boolean).length;
        return { mapas: n, mapas_green: w, hit_por_mapa_pct: n ? fmt1((100 * w) / n) : null };
      };
      const grupo = (arr) => ({
        bets: arr.length,
        ...hitPorMapa(arr),
        green: arr.filter((b) => b.status === 'green').length,
        red: arr.filter((b) => b.status === 'red').length,
        hit_por_bet_pct: arr.length
          ? fmt1((100 * arr.filter((b) => b.status === 'green').length) / arr.length)
          : null,
        stake_total: fmt1(sumStake(arr)),
        pl_total: fmt1(sumProfit(arr)),
        roi_pct: sumStake(arr) ? fmt1((100 * sumProfit(arr)) / sumStake(arr)) : null,
      });

      const catRealGroups = {};
      for (const cat of CATS) {
        catRealGroups[cat] = milioReal.filter((b) => categoryOf(partnerOfBet(b)) === cat);
      }
      const semContexto = milioReal.filter((b) => !partnerOfBet(b));

      console.log('\n\n## 5. R$ REAL — bets do Elvis com Milio (Supabase, read-only, Under)\n');
      console.log('| recorte | bets | mapas | G | R | hit% por bet | hit% por MAPA | stake total | P/L | ROI |');
      console.log('|---|---|---|---|---|---|---|---|---|---|');
      const realLines = [
        ['Milio Under — bets REAIS (todas)', grupo(milioReal)],
        ...CATS.map((c) => [`  ↳ parceiro ${c}`, grupo(catRealGroups[c])]),
        ['  ↳ sem sup do outro lado no contexto', grupo(semContexto)],
        ['Milio Under — SIMULATED', grupo(milioSim)],
        ['(contexto: Milio não-Under — Over/ML)', grupo(milioAll.filter((b) => !isUnder(b) && b.bookmaker !== 'SIMULATED'))],
      ];
      for (const [lb, g] of realLines) {
        console.log(
          `| ${lb} | ${g.bets} | ${g.mapas} | ${g.green} | ${g.red} | ${g.hit_por_bet_pct ?? '-'}% | ` +
            `${g.hit_por_mapa_pct ?? '-'}% | R$${g.stake_total} | R$${g.pl_total} | ${g.roi_pct ?? '-'}% |`
        );
      }
      // lista de parceiros nas bets reais (transparência)
      const partnerDist = milioReal.reduce((m, b) => {
        const p = partnerOfBet(b) || '(sem contexto)';
        m[p] = (m[p] || 0) + 1;
        return m;
      }, {});
      console.log(`\nParceiros nas bets reais: ${JSON.stringify(partnerDist)}`);

      betsBlock = {
        skipped: false,
        total_bets_banco: bets.length,
        settled: settled.length,
        milio_under_reais: grupo(milioReal),
        por_categoria: Object.fromEntries(CATS.map((c) => [c, grupo(catRealGroups[c])])),
        sem_contexto: grupo(semContexto),
        simulated: grupo(milioSim),
        parceiros_distribuicao: partnerDist,
      };
    } catch (e) {
      console.log(`\n\n## 5. R$ real — FALHOU: ${e.message}`);
      betsBlock = { skipped: true, error: e.message };
    }
  }
  out.bets_reais = betsBlock;

  // 8. VEREDITO AUTOMÁTICO
  const p123 = catTable.peel.pooled_1_2_3;
  const f123 = catTable.flex.pooled_1_2_3;
  const tc = centralTest['pooled 1+2+3'];
  const verdict = {
    peel_n: p123.n,
    peel_hit_fairp1: p123.n ? p123.fairp1.hit_pct : null,
    flex_n: f123.n,
    flex_hit_fairp1: f123.n ? f123.fairp1.hit_pct : null,
    diff_pp: tc.rungs.fairp1.diff_peel_menos_flex_pp ?? null,
    diff_ci95: tc.rungs.fairp1.diff_ci95_pp ?? null,
    p_two_sided: tc.rungs.fairp1.p_two_sided ?? null,
    diferenca_defensavel:
      tc.rungs.fairp1.cruza_zero === false && (tc.rungs.fairp1.p_two_sided ?? 1) < 0.05,
    ambos_acima_be_fairp1:
      p123.n && f123.n ? p123.fairp1.hit_pct > 58.1 && f123.fairp1.hit_pct > 58.1 : null,
  };
  verdict.recomendacao = verdict.diferenca_defensavel
    ? verdict.diff_pp > 0
      ? 'Diferença REAL, peel melhor — a regra do Elvis (flex=1u, peel=2u) tem base.'
      : 'Diferença REAL mas INVERTIDA (flex melhor) — manter 2u em ambos; NÃO criar regra invertida.'
    : 'Diferença NÃO defensável estatisticamente — MANTER "Milio = 2u sempre" (simplicidade ganha).';
  console.log('\n\n## 6. Veredito computado\n');
  console.log(JSON.stringify(verdict, null, 2));
  out.veredito = verdict;

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
