// scripts/analysis/over-by-support.cjs
//
// Follow-up do dono: "não tem NENHUM suporte que seja lucrativo no Over?"
//
// Corte por CHAMPION de support (não por arquétipo) — Over hit @ fair, odd flat 1.80
// (BE 55.6%), Wilson 95% CI, por split (1 e 2) e pooled. Fair leave-one-out é a MESMA
// função de scripts/analysis/over-method-v2.cjs, recalculada por split (não mistura
// histórico de time entre splits).
//
// Critério "lucrativo de verdade": central pooled ≥ BE E hit ≥ BE nos DOIS splits
// separados (replicação out-of-split). Central pooled ≥ BE mas 1 split abaixo = INCERTO.
// Resto = NÃO.
//
// Problema de comparações múltiplas: com N champions testados (n_pooled≥20) a 95% CI,
// ~N*5% passariam o corte "central ≥ BE" só por acaso — reportado explicitamente no
// output. A exigência de replicação nos 2 splits reduz bastante esse risco (não elimina).
//
// Zero chamada de API — tudo lido de audit-output/00-universe*.json (kills/supports já
// extraídos no phase0, não depende de window/roster).
//
// Uso: node scripts/analysis/over-by-support.cjs
// Output: audit-output/13-over-by-support.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { normTeamName } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '13-over-by-support.json');

const SPLIT_FILES = {
  1: { file: path.join(AUDIT_OUTPUT, '00-universe-split1.json'), label: 'split1 (jan-mar 2026)' },
  2: { file: path.join(AUDIT_OUTPUT, '00-universe.json'), label: 'split2 (abr-jun 2026)' },
};

const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const UNDER_ODD = 1.72;
const UNDER_BE = 58.1;
const MIN_N_POOLED = 20;
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
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

// ============================================================================
// Fair leave-one-out — sync: scripts/analysis/over-method-v2.cjs (mesma fórmula,
// mesmo recorte por split). Se mudar lá, mudar aqui.
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

// sync: scripts/analysis/over-method-v2.cjs
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

// ============================================================================
// Carrega 1 split — rows com fair local + kills por lado (pra team-controlled delta).
// ============================================================================
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
      team_blue: normTeamName(g.team_blue) || g.team_blue,
      team_red: normTeamName(g.team_red) || g.team_red,
      kills_blue: g.kills_blue,
      kills_red: g.kills_red,
      total_kills: g.total_kills,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      fair,
      over_hit_fair: g.total_kills > fair,
      under_hit_fair_plus1: g.total_kills < fair + 1,
    };
  });

  return { label: cfg.label, population_n: population.length, rows };
}

// Explode rows em 1 entrada por lado (blue/red) — cada jogo credita os 2 champions
// distintos que jogaram support nele (draft padrão nunca repete campeão na mesma
// partida, então nunca há double-count do MESMO champion no mesmo jogo).
function champRowsFromSplit(rows) {
  const out = [];
  for (const r of rows) {
    if (r.sup_blue) {
      out.push({ champ: r.sup_blue, split: r.split, team: r.team_blue, ownKills: r.kills_blue, over_hit: r.over_hit_fair, under_hit: r.under_hit_fair_plus1, game_id: r.game_id });
    }
    if (r.sup_red) {
      out.push({ champ: r.sup_red, split: r.split, team: r.team_red, ownKills: r.kills_red, over_hit: r.over_hit_fair, under_hit: r.under_hit_fair_plus1, game_id: r.game_id });
    }
  }
  return out;
}

function overStatsForChamp(champ, champRows) {
  const rs = champRows.filter((r) => r.champ === champ);
  const n = rs.length;
  const wins = rs.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: { lower: ci.lower, upper: ci.upper }, roi_pct: roiPct(wins, n, OVER_ODD) };
}
function underStatsForChamp(champ, champRows) {
  const rs = champRows.filter((r) => r.champ === champ);
  const n = rs.length;
  const wins = rs.filter((r) => r.under_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  return { n, wins, hit_pct: hitPct, roi_pct: roiPct(wins, n, UNDER_ODD) };
}

// Team-controlled delta — sync: scripts/analysis/split2-over-method.cjs C2
// (teamControlledDelta), adaptada pra usar kills_blue/kills_red diretos do universo
// (não precisa de window/roster — support já vem no próprio registro).
function teamControlledDelta(champRaw, rows) {
  const champNorm = normChamp(champRaw);
  const byTeam = new Map();
  for (const r of rows) {
    for (const side of ['blue', 'red']) {
      const team = side === 'blue' ? r.team_blue : r.team_red;
      const ownKills = side === 'blue' ? r.kills_blue : r.kills_red;
      const sup = side === 'blue' ? r.sup_blue : r.sup_red;
      const picked = normChamp(sup) === champNorm;
      if (!byTeam.has(team)) byTeam.set(team, { withKills: [], withoutKills: [] });
      const e = byTeam.get(team);
      if (picked) e.withKills.push(ownKills);
      else e.withoutKills.push(ownKills);
    }
  }
  let sumWeighted = 0;
  let totalWeightN = 0;
  const perTeam = [];
  for (const [team, e] of byTeam) {
    if (e.withKills.length === 0 || e.withoutKills.length === 0) continue;
    const avgWith = e.withKills.reduce((a, b) => a + b, 0) / e.withKills.length;
    const avgWithout = e.withoutKills.reduce((a, b) => a + b, 0) / e.withoutKills.length;
    const deltaTeam = avgWith - avgWithout;
    perTeam.push({ team, n_with: e.withKills.length, n_without: e.withoutKills.length, avg_with: fmt1(avgWith), avg_without: fmt1(avgWithout), delta_team: fmt1(deltaTeam) });
    sumWeighted += deltaTeam * e.withKills.length;
    totalWeightN += e.withKills.length;
  }
  perTeam.sort((a, b) => b.n_with - a.n_with);
  return {
    team_controlled_delta: totalWeightN ? fmt1(sumWeighted / totalWeightN) : null,
    n_teams_with_baseline: perTeam.length,
    n_games_pooled: totalWeightN,
    per_team: perTeam,
  };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('OVER POR SUPPORT — corte por champion (odd flat 1.80, BE 55.6%)');
  console.log('='.repeat(70));

  const split1 = loadSplit(1);
  const split2 = loadSplit(2);
  console.log(`\nsplit1 (${split1.label}): população=${split1.population_n}`);
  console.log(`split2 (${split2.label}): população=${split2.population_n}`);

  const champRows1 = champRowsFromSplit(split1.rows);
  const champRows2 = champRowsFromSplit(split2.rows);
  const champRowsPooled = [...champRows1, ...champRows2];

  const allChampsSeen = [...new Set(champRowsPooled.map((r) => r.champ))].sort();

  const results = [];
  for (const champ of allChampsSeen) {
    const s1 = overStatsForChamp(champ, champRows1);
    const s2 = overStatsForChamp(champ, champRows2);
    const pooled = overStatsForChamp(champ, champRowsPooled);
    if (pooled.n < MIN_N_POOLED) continue;

    const centralPooledOk = pooled.hit_pct != null && pooled.hit_pct >= OVER_BE;
    const s1Ok = s1.hit_pct != null && s1.hit_pct >= OVER_BE;
    const s2Ok = s2.hit_pct != null && s2.hit_pct >= OVER_BE;

    let verdict = 'NÃO';
    if (centralPooledOk && s1Ok && s2Ok) verdict = 'LUCRATIVO';
    else if (centralPooledOk) verdict = 'INCERTO';

    let teamControlled = null;
    if (verdict === 'LUCRATIVO' || verdict === 'INCERTO') {
      teamControlled = {
        split1: teamControlledDelta(champ, split1.rows),
        split2: teamControlledDelta(champ, split2.rows),
      };
    }

    results.push({ champion: champ, split1: s1, split2: s2, pooled, verdict, team_controlled_delta: teamControlled });
  }
  results.sort((a, b) => (b.pooled.hit_pct ?? -1) - (a.pooled.hit_pct ?? -1));

  const totalChampionsSeen = allChampsSeen.length;
  const championsTestedN = results.length;
  const expectedFalsePositives = fmt1(championsTestedN * 0.05);

  console.log(`\nChampions distintos vistos como support (qualquer n): ${totalChampionsSeen}`);
  console.log(`Champions testados (n_pooled≥${MIN_N_POOLED}): ${championsTestedN}`);
  console.log(`[COMPARAÇÕES MÚLTIPLAS] Com ${championsTestedN} champions testados a 95% CI, ~${expectedFalsePositives} passariam o corte "central≥BE" só por acaso (5% cada). A exigência de replicação nos 2 splits (critério LUCRATIVO) reduz bastante esse risco, mas INCERTO sozinho NÃO é evidência forte.`);

  console.log('\n\n## Tabela completa — Over @ fair, odd 1.80, BE 55.6% (ordenado por hit% pooled desc)\n');
  console.log('| champion | n_s1 | hit%_s1 | n_s2 | hit%_s2 | n_pooled | hit%_pooled | CI95%_pooled | ROI%_pooled | veredito |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const ciStr = r.pooled.n ? `[${r.pooled.wilson_ci_95.lower}, ${r.pooled.wilson_ci_95.upper}]` : '-';
    console.log(`| ${r.champion} | ${r.split1.n} | ${r.split1.hit_pct ?? '-'} | ${r.split2.n} | ${r.split2.hit_pct ?? '-'} | ${r.pooled.n} | ${r.pooled.hit_pct ?? '-'} | ${ciStr} | ${r.pooled.roi_pct ?? '-'} | ${r.verdict} |`);
  }

  const flagged = results.filter((r) => r.verdict === 'LUCRATIVO' || r.verdict === 'INCERTO');
  console.log(`\n\n## Team-controlled delta — champions LUCRATIVO/INCERTO (${flagged.length})\n`);
  if (flagged.length === 0) {
    console.log('Nenhum champion passou nem "LUCRATIVO" nem "INCERTO" — nenhum controle de confusor a rodar.');
  }
  for (const r of flagged) {
    console.log(`\n### ${r.champion} (${r.verdict})\n`);
    for (const [splitLabel, tc] of [['split1', r.team_controlled_delta.split1], ['split2', r.team_controlled_delta.split2]]) {
      console.log(`${splitLabel}: team_controlled_delta=${tc.team_controlled_delta ?? '-'} (n_teams=${tc.n_teams_with_baseline}, n_games_pooled=${tc.n_games_pooled})`);
    }
  }

  // --- Bônus: mesmos champions pelo lado UNDER, pooled ---
  const underBonus = results
    .map((r) => {
      const u = underStatsForChamp(r.champion, champRowsPooled);
      return { champion: r.champion, n_pooled: u.n, hit_pct_under: u.hit_pct, roi_pct_under: u.roi_pct };
    })
    .sort((a, b) => (b.hit_pct_under ?? -1) - (a.hit_pct_under ?? -1));

  console.log(`\n\n## Bônus — mesmos champions pelo lado UNDER (fair+1 @ 1.72, BE 58.1%, pooled)\n`);
  console.log('| champion | n_pooled | hit%_under_pooled | ROI%_under_pooled |');
  console.log('|---|---|---|---|');
  for (const u of underBonus) {
    console.log(`| ${u.champion} | ${u.n_pooled} | ${u.hit_pct_under ?? '-'} | ${u.roi_pct_under ?? '-'} |`);
  }

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const nLucrativo = results.filter((r) => r.verdict === 'LUCRATIVO').length;
  const nIncerto = results.filter((r) => r.verdict === 'INCERTO').length;
  const nNao = results.filter((r) => r.verdict === 'NÃO').length;
  const bestOver = results[0] || null;
  const bestUnder = underBonus[0] || null;

  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD,
      over_be_pct: OVER_BE,
      under_odd: UNDER_ODD,
      under_be_pct: UNDER_BE,
      min_n_pooled: MIN_N_POOLED,
      z_score_95: Z95,
      verdict_criteria: {
        LUCRATIVO: 'hit%_pooled >= BE E hit%_split1 >= BE E hit%_split2 >= BE (replicação nos 2 splits)',
        INCERTO: 'hit%_pooled >= BE mas pelo menos 1 split abaixo de BE',
        'NÃO': 'hit%_pooled < BE',
      },
    },
    meta: {
      split1_population_n: split1.population_n,
      split2_population_n: split2.population_n,
      total_champions_seen: totalChampionsSeen,
      champions_tested_n_pooled_geq_20: championsTestedN,
      multiple_comparisons_note: `${championsTestedN} champions testados a 95% CI — esperado ~${expectedFalsePositives} passariam "central≥BE" só por acaso (5%/teste). Critério LUCRATIVO exige replicação nos 2 splits, reduz o risco de falso positivo mas não elimina (splits não são 100% independentes — mesmos times/ligas em períodos diferentes).`,
      verdict_counts: { LUCRATIVO: nLucrativo, INCERTO: nIncerto, 'NÃO': nNao },
    },
    results,
    under_bonus_pooled: underBonus,
    facts: [
      `${championsTestedN} champions de support testados (n_pooled≥${MIN_N_POOLED}), de ${totalChampionsSeen} vistos no total.`,
      `Nenhum champion atingiu "LUCRATIVO" (central pooled ≥ BE E replicado nos 2 splits)` + (nLucrativo > 0 ? ` — exceto: ${results.filter(r=>r.verdict==='LUCRATIVO').map(r=>r.champion).join(', ')}.` : '.'),
      `${nIncerto} champion(s) em "INCERTO" (pooled ≥ BE mas 1 split abaixo)` + (nIncerto > 0 ? `: ${results.filter(r=>r.verdict==='INCERTO').map(r=>r.champion).join(', ')}.` : '.'),
      bestOver ? `Melhor champion no Over (pooled): ${bestOver.champion} — hit=${bestOver.pooled.hit_pct}%, CI95%=[${bestOver.pooled.wilson_ci_95.lower},${bestOver.pooled.wilson_ci_95.upper}], BE=${OVER_BE}%.` : 'Nenhum champion com n_pooled suficiente.',
      bestUnder ? `Melhor champion no Under (pooled, mesma lista): ${bestUnder.champion} — hit=${bestUnder.hit_pct_under}%, ROI=${bestUnder.roi_pct_under}%, BE=${UNDER_BE}%.` : null,
    ].filter(Boolean),
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
