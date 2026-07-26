// scripts/analysis/shen-under.cjs
//
// Hipótese do dono (2026-07-24): "Shen é um boneco UNDER kill". Esta análise
// quantifica: jogos com Shen SUPPORT (qualquer lado) têm total_kills abaixo da
// fair? E Shen TOP? E Shen+peel do outro lado (candidato a variante do trigger)?
//
// Fontes (ZERO chamada de API — tudo em cache/output existente):
//   audit-output/00-universe-split1.json      — split 1 (jan-mar, 6 ligas, 696 games)
//   audit-output/00-universe-allregions.json  — 04-01 → 07-21, ~30 ligas (inclui as 6)
//   audit-cache/window-{gameId}.json          — role completo dos 10 picks (pro Shen TOP)
//
// Splits (mesma convenção da sessão 2026-07-21):
//   split1 = universo split1 (jan-mar) · split2 = allregions com date < 2026-07-01
//   split3 = allregions com date >= 2026-07-01 (julho, até 07-21)
//
// Fair leave-one-out POR LIGA — MESMA função de camille-sweep.cjs /
// champion-over-table.cjs (fallback: time com <5 jogos anteriores na liga → média
// da liga). Split 1 tem fair própria (computada só dentro do split 1), allregions
// tem a sua — sem vazar jogo avaliado pra dentro da média (regra inviolável #3).
//
// Régua Under (régua de odds do Elvis, doc 2026-07-21-metodo-under-split3.md):
//   Under na fair   @ 1.83 → BE 54.6%
//   Under na fair+1 @ 1.72 → BE 58.1%   (padrão de entrada do método)
//
// Regras invioláveis aplicadas: stats por MAPA (game_id) · times via getTeams (já
// resolvido na coleta) · Wilson CI em toda taxa · células n<10 flagadas
// (regra do Elvis: n<10 não é base de dados) · split 1/2/3 separados (anti-leakage).
//
// Uso: node scripts/analysis/shen-under.cjs
// Output: audit-output/27-shen-under.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, FLEX_ENGAGE } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '27-shen-under.json');
const SPLIT1_FILE = path.join(AUDIT_OUTPUT, '00-universe-split1.json');
const ALLREGIONS_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const Z95 = 1.96;
const SMALL_N = 10; // regra do Elvis: n<10 = não é base de dados
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs / champion-over-table.cjs
const JULY_CUTOFF = '2026-07-01';

// Régua de odds do Elvis (doc canônico 2026-07-21-metodo-under-split3.md)
const RUNGS = {
  fair: { odd: 1.83, be_pct: 54.6, label: 'Under na fair @1.83 (BE 54.6%)' },
  fairp1: { odd: 1.72, be_pct: 58.1, label: 'Under na fair+1 @1.72 (BE 58.1%)' },
};

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const FLEX_SET = new Set(FLEX_ENGAGE.map(normChamp));
// engage clássico — sync: camille-sweep.cjs ENGAGE_LIST (+braum); precedência de
// classificação: SHEN > PEEL > FLEX > ENGAGE > OUTRO.
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric',
  'morgana', 'braum',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));

function classifySup(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (c === 'shen') return 'SHEN';
  if (PEEL_SET.has(c)) return 'PEEL';
  if (FLEX_SET.has(c)) return 'FLEX';
  if (ENGAGE_SET.has(c)) return 'ENGAGE';
  return 'OUTRO';
}

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

// Stats completas de uma célula pro UNDER: n, kills médio, fair média, delta médio
// (kills − fair; negativo = under-lean) + hit/CI/ROI nas 2 réguas da escada.
function cellStats(rows) {
  const n = rows.length;
  if (!n) {
    return { n: 0, small_sample: true, avg_kills: null, avg_fair: null, avg_delta: null, fair: null, fairp1: null };
  }
  const avgKills = rows.reduce((a, r) => a + r.total_kills, 0) / n;
  const avgFair = rows.reduce((a, r) => a + r.fair, 0) / n;
  const avgDelta = rows.reduce((a, r) => a + (r.total_kills - r.fair), 0) / n;
  const rung = (key) => {
    const { odd, be_pct } = RUNGS[key];
    const wins = rows.filter((r) => (key === 'fair' ? r.total_kills < r.fair : r.total_kills < r.fair + 1)).length;
    const ci = wilsonCI(wins, n);
    return {
      wins,
      hit_pct: fmt1((100 * wins) / n),
      wilson_ci_95: ci,
      roi_pct: roiPct(wins, n, odd),
      be_pct,
      pass_ci_lower_above_be: ci.lower != null && ci.lower > be_pct,
    };
  };
  return {
    n,
    small_sample: n < SMALL_N,
    avg_kills: fmt1(avgKills),
    avg_fair: fmt1(avgFair),
    avg_delta: fmt2(avgDelta),
    fair: rung('fair'),
    fairp1: rung('fairp1'),
  };
}

// ============================================================================
// Fair leave-one-out POR LIGA — sync: camille-sweep.cjs computeFairPerLeague.
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
      const avgFor = (teamRaw) => {
        const arr = (teamHist.get(normalizeTeam(teamRaw)) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvgTotal;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return fairMap;
}

// Top laners direto do window cache (mesma fonte dos 10 picks usada em
// champion-over-table.cjs). Retorna null se cache ausente/sem role.
function topLanersFromCache(gameId) {
  const p = path.join(AUDIT_CACHE, `window-${gameId}.json`);
  if (!fs.existsSync(p)) return null;
  let w;
  try {
    w = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  const topOf = (md) => md?.participantMetadata?.find((x) => x.role === 'top')?.championId || null;
  return {
    top_blue: topOf(w?.gameMetadata?.blueTeamMetadata),
    top_red: topOf(w?.gameMetadata?.redTeamMetadata),
  };
}

function printCellRow(label, s) {
  if (!s || !s.n) {
    console.log(`| ${label} | 0 | - | - | - | - | - | - | |`);
    return;
  }
  const f = s.fair;
  const f1 = s.fairp1;
  console.log(
    `| ${label} | ${s.n} | ${s.avg_kills} | ${s.avg_delta > 0 ? '+' : ''}${s.avg_delta} | ` +
      `${f.hit_pct}% [${f.wilson_ci_95.lower}, ${f.wilson_ci_95.upper}] | ${f.roi_pct}% | ` +
      `${f1.hit_pct}% [${f1.wilson_ci_95.lower}, ${f1.wilson_ci_95.upper}] | ${f1.roi_pct}% | ` +
      `${s.small_sample ? 'n<10 — NÃO é base de dados' : ''} |`
  );
}
function tableHeader() {
  console.log('| célula | n | kills méd | delta (kills−fair) | Under@fair hit [CI95] | ROI@1.83 | Under@fair+1 hit [CI95] | ROI@1.72 | flag |');
  console.log('|---|---|---|---|---|---|---|---|---|');
}

// ============================================================================
// MAIN
// ============================================================================
(() => {
  console.log('='.repeat(78));
  console.log('SHEN UNDER — hipótese do dono: "Shen é boneco under kill"');
  console.log('='.repeat(78));

  // --- carga + fair por universo (leave-one-out dentro de cada coleção) ---
  const uni1 = loadJson(SPLIT1_FILE).filter((g) => !g.suspect && g.total_kills != null);
  const uniAll = loadJson(ALLREGIONS_FILE).filter((g) => !g.suspect && g.total_kills != null);

  // dedupe defensivo por game_id dentro do allregions (mesmo game em 2 ligas seria bug de coleta)
  const seen = new Set();
  const uniAllDedup = uniAll.filter((g) => (seen.has(g.game_id) ? false : (seen.add(g.game_id), true)));
  const dupCount = uniAll.length - uniAllDedup.length;

  const fair1 = computeFairPerLeague(uni1);
  const fairAll = computeFairPerLeague(uniAllDedup);

  const mkRow = (g, split, fairMap) => {
    const tops = topLanersFromCache(g.game_id) || { top_blue: null, top_red: null };
    return {
      game_id: g.game_id,
      league: g.league,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      split,
      team_blue: normalizeTeam(g.team_blue),
      team_red: normalizeTeam(g.team_red),
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      top_blue: tops.top_blue,
      top_red: tops.top_red,
      total_kills: g.total_kills,
      fair: fairMap.get(g.game_id),
    };
  };

  const rows = [
    ...uni1.map((g) => mkRow(g, 'split1', fair1)),
    ...uniAllDedup.map((g) => mkRow(g, (g.date || '') < JULY_CUTOFF ? 'split2' : 'split3', fairAll)),
  ].filter((r) => Number.isFinite(r.fair));

  const missingTop = rows.filter((r) => !r.top_blue || !r.top_red).length;
  console.log(`\nPopulação: split1=${rows.filter((r) => r.split === 'split1').length} · split2=${rows.filter((r) => r.split === 'split2').length} · split3(jul até 07-21)=${rows.filter((r) => r.split === 'split3').length} · total=${rows.length}`);
  console.log(`Dupes de game_id removidos no allregions: ${dupCount} · rows sem top laner no cache: ${missingTop}`);

  const SPLITS = ['split1', 'split2', 'split3'];
  const isShenSup = (r) => normChamp(r.sup_blue) === 'shen' || normChamp(r.sup_red) === 'shen';
  const isShenTop = (r) => normChamp(r.top_blue) === 'shen' || normChamp(r.top_red) === 'shen';

  // ==========================================================================
  // 1. SHEN SUPPORT (qualquer lado) vs baseline sem Shen sup — por split + pooled
  // ==========================================================================
  console.log('\n\n## 1. Shen SUPPORT presente (qualquer lado) vs baseline (universo sem Shen sup)\n');
  const shenSup = rows.filter(isShenSup);
  const noShenSup = rows.filter((r) => !isShenSup(r));

  tableHeader();
  const bySplit = {};
  for (const sp of SPLITS) {
    const s = cellStats(shenSup.filter((r) => r.split === sp));
    const b = cellStats(noShenSup.filter((r) => r.split === sp));
    bySplit[sp] = { shen_sup: s, baseline_sem_shen: b };
    printCellRow(`Shen sup — ${sp}`, s);
    printCellRow(`baseline — ${sp}`, b);
  }
  const shenSupPooled = cellStats(shenSup);
  const baselinePooled = cellStats(noShenSup);
  const shenSupPre = cellStats(shenSup.filter((r) => r.split !== 'split3')); // splits 1+2 (pré-julho)
  printCellRow('**Shen sup — POOLED (1+2+3)**', shenSupPooled);
  printCellRow('Shen sup — pooled splits 1+2 (pré-jul)', shenSupPre);
  printCellRow('baseline — POOLED', baselinePooled);

  const monthly = {};
  for (const r of shenSup) monthly[r.month] = (monthly[r.month] || 0) + 1;
  console.log('\n### Timeline mensal do Shen sup (chegada de meta, tipo Camille)\n');
  console.log('| mês | n |');
  console.log('|---|---|');
  for (const m of Object.keys(monthly).sort()) console.log(`| ${m} | ${monthly[m]} |`);

  // ==========================================================================
  // 2. Por liga (pooled entre splits; células n<10 flagadas)
  // ==========================================================================
  console.log('\n\n## 2. Shen sup por liga (pooled 1+2+3)\n');
  const byLeagueMap = new Map();
  for (const r of shenSup) {
    if (!byLeagueMap.has(r.league)) byLeagueMap.set(r.league, []);
    byLeagueMap.get(r.league).push(r);
  }
  tableHeader();
  const byLeagueOut = [];
  for (const [league, rs] of [...byLeagueMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = cellStats(rs);
    byLeagueOut.push({ league, ...s });
    printCellRow(league, s);
  }

  // ==========================================================================
  // 3. Shen sup × support do OUTRO lado (classe e champion)
  // ==========================================================================
  console.log('\n\n## 3. Shen sup × support inimigo (classe do sup do outro lado)\n');
  const enemySupOf = (r) => (normChamp(r.sup_blue) === 'shen' ? r.sup_red : r.sup_blue);
  const byEnemyClass = new Map();
  const byEnemyChamp = new Map();
  for (const r of shenSup) {
    const enemy = enemySupOf(r);
    const cls = classifySup(enemy) || 'OUTRO';
    if (!byEnemyClass.has(cls)) byEnemyClass.set(cls, []);
    byEnemyClass.get(cls).push(r);
    const ec = normChamp(enemy) || '?';
    byEnemyChamp.set(ec, (byEnemyChamp.get(ec) || 0) + 1);
  }
  tableHeader();
  const enemyClassOut = [];
  for (const cls of ['PEEL', 'FLEX', 'ENGAGE', 'OUTRO']) {
    const rs = byEnemyClass.get(cls) || [];
    const s = cellStats(rs);
    enemyClassOut.push({ enemy_class: cls, ...s });
    printCellRow(`Shen + sup inimigo ${cls}`, s);
  }
  const shenPlusPeel = byEnemyClass.get('PEEL') || [];
  const shenPlusPeelBySplit = {};
  console.log('\n### Célula-chave "1peel+shen" (Shen sup + PEEL_PURE do outro lado) por split\n');
  tableHeader();
  for (const sp of SPLITS) {
    const s = cellStats(shenPlusPeel.filter((r) => r.split === sp));
    shenPlusPeelBySplit[sp] = s;
    printCellRow(`1peel+shen — ${sp}`, s);
  }
  const shenPlusPeelPooled = cellStats(shenPlusPeel);
  printCellRow('**1peel+shen — POOLED**', shenPlusPeelPooled);
  console.log('\nSup inimigo do Shen (champion → n): ' + [...byEnemyChamp.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(', '));

  // ==========================================================================
  // 4. Shen lado a lado com os FLEX_ENGAGE atuais (Bard/Rakan/Lux/Anivia)
  //    (a) champ sup presente qualquer lado · (b) champ sup + peel do outro lado
  //    Benchmark: 2peel (core do método) na mesma régua/população.
  // ==========================================================================
  console.log('\n\n## 4. Shen vs FLEX_ENGAGE atuais — mesma régua, pooled 1+2+3\n');
  const champAny = (c) => rows.filter((r) => normChamp(r.sup_blue) === c || normChamp(r.sup_red) === c);
  const champPlusPeel = (c) =>
    rows.filter((r) => {
      const a = normChamp(r.sup_blue);
      const b = normChamp(r.sup_red);
      return (a === c && PEEL_SET.has(b)) || (b === c && PEEL_SET.has(a));
    });
  const twoPeel = rows.filter((r) => PEEL_SET.has(normChamp(r.sup_blue)) && PEEL_SET.has(normChamp(r.sup_red)));

  console.log('### (a) Champion sup presente (qualquer lado)\n');
  tableHeader();
  const flexCompareAny = [];
  for (const c of ['bard', 'rakan', 'lux', 'anivia', 'shen']) {
    const s = cellStats(champAny(c));
    flexCompareAny.push({ champ: c, ...s });
    printCellRow(c, s);
  }
  console.log('\n### (b) Champion sup + PEEL_PURE do outro lado (formato do trigger 1peel+flex)\n');
  tableHeader();
  const flexComparePlusPeel = [];
  for (const c of ['bard', 'rakan', 'lux', 'anivia', 'shen']) {
    const s = cellStats(champPlusPeel(c));
    flexComparePlusPeel.push({ champ: c, ...s });
    printCellRow(`1peel+${c}`, s);
  }
  const twoPeelStats = cellStats(twoPeel);
  printCellRow('**benchmark 2peel (core)**', twoPeelStats);

  // ==========================================================================
  // 5. SHEN TOP (role=top no window cache) — efeito do boneco em outra lane
  // ==========================================================================
  console.log('\n\n## 5. Shen TOP (não-support) — por split + pooled\n');
  const shenTop = rows.filter((r) => isShenTop(r) && !isShenSup(r));
  tableHeader();
  const shenTopBySplit = {};
  for (const sp of SPLITS) {
    const s = cellStats(shenTop.filter((r) => r.split === sp));
    shenTopBySplit[sp] = s;
    printCellRow(`Shen top — ${sp}`, s);
  }
  const shenTopPooled = cellStats(shenTop);
  const shenTopPre = cellStats(shenTop.filter((r) => r.split !== 'split3')); // splits 1+2
  printCellRow('**Shen top — POOLED**', shenTopPooled);
  printCellRow('Shen top — pooled splits 1+2 (pré-jul)', shenTopPre);
  const shenTopPlusPeel = shenTop.filter((r) => PEEL_SET.has(normChamp(r.sup_blue)) || PEEL_SET.has(normChamp(r.sup_red)));
  printCellRow('Shen top + ≥1 peel sup no jogo', cellStats(shenTopPlusPeel));

  // Sobreposição com o trigger Under vigente: se os jogos de Shen top com peel já
  // são jogos de trigger (2peel / 1peel+flex), o método JÁ cobre — o valor
  // incremental do Shen top está nos jogos SEM trigger.
  const hasTrigger = (r) => {
    const a = normChamp(r.sup_blue);
    const b = normChamp(r.sup_red);
    const peels = (PEEL_SET.has(a) ? 1 : 0) + (PEEL_SET.has(b) ? 1 : 0);
    const flexes = (FLEX_SET.has(a) ? 1 : 0) + (FLEX_SET.has(b) ? 1 : 0);
    return peels === 2 || (peels === 1 && flexes >= 1);
  };
  const shenTopTrigger = shenTop.filter(hasTrigger);
  const shenTopNoTrigger = shenTop.filter((r) => !hasTrigger(r));
  const shenTopPlusPeelTrigger = shenTopPlusPeel.filter(hasTrigger);
  console.log('\n### Shen top × trigger Under vigente (valor incremental)\n');
  tableHeader();
  printCellRow('Shen top DENTRO do trigger (2peel/1peel+flex)', cellStats(shenTopTrigger));
  printCellRow('Shen top FORA do trigger (célula incremental)', cellStats(shenTopNoTrigger));
  const shenTopNoTriggerBySplit = {};
  for (const sp of SPLITS) {
    const s = cellStats(shenTopNoTrigger.filter((r) => r.split === sp));
    shenTopNoTriggerBySplit[sp] = s;
    printCellRow(`Shen top fora do trigger — ${sp}`, s);
  }
  console.log(`\nDos ${shenTopPlusPeel.length} jogos "Shen top + ≥1 peel", ${shenTopPlusPeelTrigger.length} já são trigger do método vigente.`);

  // Confound da célula Shen sup: sup inimigo mais comum é Camille (janela Over do
  // Elvis) — quantificar o recorte pra não recomendar Under contra a própria janela.
  const shenSupVsCamille = shenSup.filter((r) => normChamp(enemySupOf(r)) === 'camille');
  const shenSupVsEngageNoCamille = (byEnemyClass.get('ENGAGE') || []).filter((r) => normChamp(enemySupOf(r)) !== 'camille');
  console.log('\n### Confound: Shen sup × Camille sup inimigo (janela Over ativa)\n');
  tableHeader();
  const shenVsCamilleStats = cellStats(shenSupVsCamille);
  const shenVsEngageNoCamilleStats = cellStats(shenSupVsEngageNoCamille);
  printCellRow('Shen sup vs Camille sup', shenVsCamilleStats);
  printCellRow('Shen sup vs ENGAGE (sem Camille)', shenVsEngageNoCamilleStats);

  // ==========================================================================
  // 6. Veredito automático (critério: CI inferior > BE no pooled splits 1+2 +
  //    coerência no split 3; régua fair+1 @1.72 BE 58.1 = entrada padrão)
  // ==========================================================================
  const crit = {
    pre_july_pooled_n: shenSupPre.n,
    pre_july_ci_lower_fairp1: shenSupPre.n ? shenSupPre.fairp1.wilson_ci_95.lower : null,
    pre_july_pass: shenSupPre.n ? shenSupPre.fairp1.pass_ci_lower_above_be : false,
    split3_n: bySplit.split3.shen_sup.n,
    split3_hit_fairp1: bySplit.split3.shen_sup.n ? bySplit.split3.shen_sup.fairp1.hit_pct : null,
    split3_above_be: bySplit.split3.shen_sup.n ? bySplit.split3.shen_sup.fairp1.hit_pct > RUNGS.fairp1.be_pct : false,
    pooled_n: shenSupPooled.n,
    pooled_ci_lower_fairp1: shenSupPooled.n ? shenSupPooled.fairp1.wilson_ci_95.lower : null,
    pooled_pass: shenSupPooled.n ? shenSupPooled.fairp1.pass_ci_lower_above_be : false,
    shen_plus_peel_n: shenPlusPeelPooled.n,
    shen_plus_peel_pass: shenPlusPeelPooled.n ? shenPlusPeelPooled.fairp1.pass_ci_lower_above_be : false,
  };

  console.log('\n\n## 6. Critérios de entrada no método (computados)\n');
  console.log(JSON.stringify(crit, null, 2));

  // ==========================================================================
  // OUTPUT JSON
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      rungs: RUNGS,
      z_score_95: Z95,
      small_sample_n: SMALL_N,
      fair_fallback_min_n: FALLBACK_MIN_N,
      july_cutoff: JULY_CUTOFF,
      splits: {
        split1: '00-universe-split1.json (jan-mar, 6 ligas, fair leave-one-out própria)',
        split2: '00-universe-allregions.json date < 2026-07-01 (~30 ligas)',
        split3: '00-universe-allregions.json date >= 2026-07-01 (julho até 07-21)',
      },
      engage_list: ENGAGE_LIST,
      note: 'Fair leave-one-out POR LIGA (fallback n<5 → média da liga), sync camille-sweep.cjs. Shen top via role=top dos windows cacheados.',
    },
    meta: {
      population_n: rows.length,
      by_split_n: Object.fromEntries(SPLITS.map((sp) => [sp, rows.filter((r) => r.split === sp).length])),
      allregions_gameid_dupes_removed: dupCount,
      rows_missing_top_from_cache: missingTop,
    },
    shen_support: {
      by_split: bySplit,
      pooled: shenSupPooled,
      pooled_splits_1_2: shenSupPre,
      baseline_pooled: baselinePooled,
      monthly_n: monthly,
    },
    shen_support_by_league: byLeagueOut,
    shen_vs_enemy_class: enemyClassOut,
    shen_plus_peel: { by_split: shenPlusPeelBySplit, pooled: shenPlusPeelPooled, enemy_champ_counts: Object.fromEntries([...byEnemyChamp.entries()].sort((a, b) => b[1] - a[1])) },
    flex_comparison: {
      any_side: flexCompareAny,
      plus_peel: flexComparePlusPeel,
      benchmark_2peel: twoPeelStats,
    },
    shen_top: {
      by_split: shenTopBySplit,
      pooled: shenTopPooled,
      pooled_splits_1_2: shenTopPre,
      plus_any_peel: cellStats(shenTopPlusPeel),
      plus_any_peel_already_trigger_n: shenTopPlusPeelTrigger.length,
      inside_trigger: cellStats(shenTopTrigger),
      outside_trigger: cellStats(shenTopNoTrigger),
      outside_trigger_by_split: shenTopNoTriggerBySplit,
    },
    shen_sup_confound_camille: {
      vs_camille: shenVsCamilleStats,
      vs_engage_sem_camille: shenVsEngageNoCamilleStats,
    },
    entry_criteria: crit,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})();
