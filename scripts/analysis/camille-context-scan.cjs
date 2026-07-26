// scripts/analysis/camille-context-scan.cjs
//
// Follow-up do dono: dentro da janela Camille support (~113 jogos, all-regions),
// existe algum CONTEXTO que justifique stake 2x ("o Milio da janela")? Scan completo
// de outliers intra-janela, com HONESTIDADE ESTATÍSTICA MÁXIMA — o resultado esperado
// é "nada passa" (ruído de N pequeno subdividido em ~30 células), e isso é reportado
// como resultado, não escondido.
//
// REGRA DE VEREDITO (fria, sem exceção): um contexto só "passa" se
//   CI95% inferior > 67.3% (hit central da janela INTEIRA)   OU
//   hit central ≥ 62% E n ≥ 25
// Conto quantas células testei no total e reporto o esperado por acaso a 95% CI
// (~5% por célula, assumindo independência — aproximação, células não são
// perfeitamente independentes entre si).
//
// Fair leave-one-out POR LIGA — MESMA função de camille-sweep.cjs /
// multi-league-mining.cjs / under-stress-line.cjs (fallback n<5 pra média da liga).
//
// Zero chamada de API — universo + windows 100% em cache (audit-output/00-universe-
// allregions.json + audit-cache/window-*.json).
//
// Uso: node scripts/analysis/camille-context-scan.cjs
// Output: audit-output/20-camille-context.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, LEAGUE_IDS } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '20-camille-context.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const OVER_ODD = 1.8;
const OVER_BE_REF = 55.6; // referência só de contexto — a régua de verdito é a baseline da janela, não o BE
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs
const CHAMPION_MIN_N = 5; // cut 1 — champion específico precisa n≥5
const ALT_HIT_MIN = 62;
const ALT_N_MIN = 25;
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];

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

// ============================================================================
// ARQUÉTIPOS
// ============================================================================
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

// Support inimigo — sync: scripts/analysis/over-method-v2.cjs / over-red-teams.cjs
// (mesmas listas PEEL/ENGAGE/MAGE, mesmo default de Braum=ENGAGE).
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric', 'morgana',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));
const MAGE_LIST = ['lux', 'brand', 'xerath', 'zyra', 'velkoz', 'swain', 'anivia', 'mel', 'neeko', 'rumble'];
const MAGE_SET = new Set(MAGE_LIST.map(normChamp));
function classifySupport(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (c === 'braum') return 'ENGAGE';
  if (PEEL_SET.has(c)) return 'PEEL';
  if (ENGAGE_SET.has(c)) return 'ENGAGE';
  if (MAGE_SET.has(c)) return 'MAGE';
  return 'OUTRO';
}

// Jungler — DIVE (engage/all-in duro, joga pra abrir luta) vs FARM (scale/pick à
// distância, não força all-in cedo). Listas do próprio prompt do dono + completude
// pelos junglers observados no dataset de julho. NOCTURNE é um judgment call — o
// prompt sugeriu ele em "farm?" com incerteza; mantive na leitura literal sugerida
// (farm), mas o kit dele (ult global = engage/pick) pende mais pra dive na prática
// competitiva — sinalizado aqui, não testado nos 2 lados por escopo/tempo.
const JUNGLE_DIVE_LIST = ['leesin', 'vi', 'jarvaniv', 'skarner', 'elise', 'xinzhao', 'zac', 'monkeywking', 'monkeyking', 'sejuani', 'amumu', 'wukong'];
const JUNGLE_FARM_LIST = ['graves', 'karthus', 'kindred', 'nocturne', 'fiddlesticks', 'shyvana'];
const JUNGLE_DIVE_SET = new Set(JUNGLE_DIVE_LIST.map(normChamp));
const JUNGLE_FARM_SET = new Set(JUNGLE_FARM_LIST.map(normChamp));
function classifyJungle(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (JUNGLE_DIVE_SET.has(c)) return 'DIVE';
  if (JUNGLE_FARM_SET.has(c)) return 'FARM';
  return 'OUTRO';
}

// Mid — ASSASSINO (burst/pick, all-in curto) vs MAGO (poke/control/burst à distância).
// Ahri e TwistedFate são hybrids clássicos — Ahri classificada MAGO (poke+burst,
// leitura padrão), TwistedFate fica OUTRO (utility/pick, não é nem burst puro nem
// control mage puro). Sylas é fighter/assassino híbrido — classificado ASSASSINO
// (all-in curto, kit de burst físico), documentado por ser controverso.
const MID_ASSASSIN_LIST = ['leblanc', 'zed', 'akali', 'katarina', 'fizz', 'qiyana', 'talon', 'ekko', 'kassadin', 'sylas'];
const MID_MAGE_LIST = ['syndra', 'orianna', 'viktor', 'azir', 'anivia', 'ryze', 'taliyah', 'swain', 'xerath', 'velkoz', 'lux', 'brand', 'zyra', 'hwei', 'neeko', 'ahri', 'cassiopeia', 'malzahar'];
const MID_ASSASSIN_SET = new Set(MID_ASSASSIN_LIST.map(normChamp));
const MID_MAGE_SET = new Set(MID_MAGE_LIST.map(normChamp));
function classifyMid(champRaw) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (MID_ASSASSIN_SET.has(c)) return 'ASSASSINO';
  if (MID_MAGE_SET.has(c)) return 'MAGO';
  return 'OUTRO';
}

// Tiers de liga — ELITE = torneios internacionais curtos; MAJOR = as 6 ligas
// originalmente operadas (nome como aparece no dataset all-regions — La Ligue
// Française é o nome real da API pra LFL); resto = MENOR.
const ELITE_LEAGUES = new Set(['MSI', 'Esports World Cup']);
const MAJOR_LEAGUES = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'La Ligue Française']);
function tierOf(league) {
  if (ELITE_LEAGUES.has(league)) return 'ELITE';
  if (MAJOR_LEAGUES.has(league)) return 'MAJOR';
  return 'MENOR';
}

// Synergy targets — top-5 |delta| de julho (multi-league-mining.cjs) + Kalista/Varus
// citados explicitamente pelo dono (Varus estava no dataset com delta+2.6 n=39, fora
// do top5; Kalista não apareceu no top5 nem foi vista com n relevante — reportado
// como tal, não forçado).
const SYNERGY_TARGETS = ['Sylas', 'Leblanc', 'Pyke', 'Nocturne', 'Kalista', 'Varus'];

// ============================================================================
// Fair leave-one-out POR LIGA — sync: camille-sweep.cjs / multi-league-mining.cjs.
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

function cellStats(rows, odd = OVER_ODD) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd) };
}

let cellsTested = 0;
function verdictFor(cell, baseline) {
  cellsTested++;
  const passLower = cell.wilson_ci_95.lower != null && cell.wilson_ci_95.lower > baseline;
  const passAlt = cell.hit_pct != null && cell.hit_pct >= ALT_HIT_MIN && cell.n >= ALT_N_MIN;
  return { pass: passLower || passAlt, pass_via: passLower ? 'ci_lower_acima_baseline' : passAlt ? 'central_62_n25' : null };
}

function printCut(title, cells, baseline) {
  console.log(`\n### ${title}\n`);
  console.log('| contexto | n | hit% | CI95% | ROI% | PASS |');
  console.log('|---|---|---|---|---|---|');
  for (const c of cells) {
    const v = verdictFor(c.stats, baseline);
    const ciStr = c.stats.n ? `[${c.stats.wilson_ci_95.lower ?? '-'}, ${c.stats.wilson_ci_95.upper ?? '-'}]` : '-';
    console.log(`| ${c.label} | ${c.stats.n} | ${c.stats.hit_pct ?? '-'} | ${ciStr} | ${c.stats.roi_pct ?? '-'} | ${v.pass ? `SIM (${v.pass_via})` : ''} |`);
    c.verdict = v;
  }
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CAMILLE CONTEXT SCAN — existe contexto pra stake 2x?');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  const fairMap = computeFairPerLeague(populationAll);

  // --- Monta rows Camille support com side, enemy support, e roster completo ---
  const camilleRaw = populationAll.filter((g) => (g.sup_blue || '').toLowerCase() === 'camille' || (g.sup_red || '').toLowerCase() === 'camille');
  console.log(`\nCamille support games: ${camilleRaw.length}`);

  let noWindow = 0;
  let noRoster = 0;
  const camilleRows = [];
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
    const jungler = roster ? roster[camilleSide].jungle : null;
    const mid = roster ? roster[camilleSide].mid : null;
    const allChamps = roster ? [...Object.values(roster.blue), ...Object.values(roster.red)] : [];
    camilleRows.push({
      game_id: g.game_id,
      league: g.league,
      month: (g.date || '').slice(0, 7),
      date: g.date,
      total_kills: g.total_kills,
      fair,
      delta: fmt1(g.total_kills - fair),
      over_hit: g.total_kills > fair,
      camille_side: camilleSide,
      enemy_support: enemySupport,
      enemy_support_arch: classifySupport(enemySupport),
      jungler,
      jungler_arch: jungler ? classifyJungle(jungler) : null,
      mid,
      mid_arch: mid ? classifyMid(mid) : null,
      all_champs: allChamps,
      tier: tierOf(g.league),
    });
  }
  console.log(`Cobertura de roster: sem window: ${noWindow}, sem roster completo: ${noRoster} (de ${camilleRaw.length}).`);

  const baseline = cellStats(camilleRows, OVER_ODD);
  console.log(`\nBaseline da janela inteira: n=${baseline.n}, hit=${baseline.hit_pct}%, CI95%=[${baseline.wilson_ci_95.lower}, ${baseline.wilson_ci_95.upper}], ROI=${baseline.roi_pct}%`);
  const BASELINE_CENTRAL = baseline.hit_pct;

  // ==========================================================================
  // 1. Sup inimigo — arquétipo e champion específico (n≥5)
  // ==========================================================================
  const archCells = ['PEEL', 'ENGAGE', 'MAGE', 'OUTRO'].map((arch) => ({
    label: `arquétipo=${arch}`,
    stats: cellStats(camilleRows.filter((r) => r.enemy_support_arch === arch)),
  }));
  printCut('1a. Sup inimigo — por ARQUÉTIPO', archCells, BASELINE_CENTRAL);

  const byEnemyChamp = new Map();
  for (const r of camilleRows) {
    if (!r.enemy_support) continue;
    if (!byEnemyChamp.has(r.enemy_support)) byEnemyChamp.set(r.enemy_support, []);
    byEnemyChamp.get(r.enemy_support).push(r);
  }
  const champCells = [...byEnemyChamp.entries()]
    .filter(([, rs]) => rs.length >= CHAMPION_MIN_N)
    .map(([champ, rs]) => ({ label: champ, stats: cellStats(rs) }))
    .sort((a, b) => (b.stats.hit_pct ?? -1) - (a.stats.hit_pct ?? -1));
  printCut(`1b. Sup inimigo — CHAMPION específico (n≥${CHAMPION_MIN_N})`, champCells, BASELINE_CENTRAL);

  // ==========================================================================
  // 2. Nível — elite/major/menor
  // ==========================================================================
  const tierCells = ['ELITE', 'MAJOR', 'MENOR'].map((tier) => ({
    label: tier,
    stats: cellStats(camilleRows.filter((r) => r.tier === tier)),
  }));
  printCut('2. Nível da liga', tierCells, BASELINE_CENTRAL);

  // ==========================================================================
  // 3. Comp do próprio time — jungler (dive/farm) e mid (assassino/mago)
  // ==========================================================================
  const jungleCells = ['DIVE', 'FARM', 'OUTRO'].map((arch) => ({
    label: `jungle=${arch}`,
    stats: cellStats(camilleRows.filter((r) => r.jungler_arch === arch)),
  }));
  printCut('3a. Jungler do time dela — DIVE vs FARM', jungleCells, BASELINE_CENTRAL);

  const midCells = ['ASSASSINO', 'MAGO', 'OUTRO'].map((arch) => ({
    label: `mid=${arch}`,
    stats: cellStats(camilleRows.filter((r) => r.mid_arch === arch)),
  }));
  printCut('3b. Mid do time dela — ASSASSINO vs MAGO', midCells, BASELINE_CENTRAL);

  // ==========================================================================
  // 4. Sinergia — Camille + outro boneco over do patch, no mesmo jogo (qualquer lado)
  // ==========================================================================
  const synergyCells = SYNERGY_TARGETS.map((target) => ({
    label: `+${target}`,
    stats: cellStats(camilleRows.filter((r) => r.all_champs.some((c) => normChamp(c) === normChamp(target)))),
  }));
  printCut('4. Sinergia — Camille + outro campeão no mesmo jogo', synergyCells, BASELINE_CENTRAL);

  // Camille + Rell×Naut especificamente (o exemplo do dono) — ambos no jogo, qualquer lado.
  const rellNautSynergy = cellStats(camilleRows.filter((r) => r.all_champs.some((c) => normChamp(c) === 'rell') && r.all_champs.some((c) => normChamp(c) === 'nautilus')));
  console.log(`\nExemplo do dono — Camille + Rell E Nautilus no mesmo jogo (qualquer lado): n=${rellNautSynergy.n}, hit=${rellNautSynergy.hit_pct ?? '-'}%`);
  const rellNautVerdict = verdictFor(rellNautSynergy, BASELINE_CENTRAL);

  // ==========================================================================
  // 5. Distribuição de kills vs fair (buckets)
  // ==========================================================================
  console.log('\n\n### 5. Distribuição de delta (kills - fair)\n');
  const deltas = camilleRows.map((r) => r.delta).sort((a, b) => a - b);
  const mean = fmt1(deltas.reduce((a, b) => a + b, 0) / deltas.length);
  const median = fmt1(deltas.length % 2 ? deltas[(deltas.length - 1) / 2] : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2);
  const pctAbove = (threshold) => fmt1((100 * camilleRows.filter((r) => r.delta > threshold).length) / camilleRows.length);
  const distribution = {
    n: camilleRows.length,
    mean_delta: mean,
    median_delta: median,
    pct_above_fair_plus_1: pctAbove(1),
    pct_above_fair_plus_2: pctAbove(2),
    pct_above_fair_plus_3: pctAbove(3),
  };
  console.log(`Média: ${mean} | Mediana: ${median} | % acima de fair+1: ${distribution.pct_above_fair_plus_1}% | fair+2: ${distribution.pct_above_fair_plus_2}% | fair+3: ${distribution.pct_above_fair_plus_3}%`);

  // ==========================================================================
  // 6. Mês
  // ==========================================================================
  const months = [...new Set(camilleRows.map((r) => r.month))].sort();
  const monthCells = months.map((m) => ({ label: m, stats: cellStats(camilleRows.filter((r) => r.month === m)) }));
  printCut('6. Mês', monthCells, BASELINE_CENTRAL);

  // ==========================================================================
  // 7. Side
  // ==========================================================================
  const sideCells = ['blue', 'red'].map((side) => ({ label: side, stats: cellStats(camilleRows.filter((r) => r.camille_side === side)) }));
  printCut('7. Side da Camille', sideCells, BASELINE_CENTRAL);

  // ==========================================================================
  // VEREDITO ESTRUTURADO
  // ==========================================================================
  const allCells = [...archCells, ...champCells, ...tierCells, ...jungleCells, ...midCells, ...synergyCells, ...monthCells, ...sideCells];
  const passing = allCells.filter((c) => c.verdict?.pass);
  const expectedByChance = fmt1(allCells.length * 0.05);

  console.log('\n\n## VEREDITO ESTRUTURADO\n');
  console.log(`Células testadas (excluindo distribuição, que não é pass/fail): ${allCells.length} + 1 (sinergia Rell×Naut) = ${allCells.length + 1}`);
  console.log(`Esperado por acaso a 95% (~5%/célula, aproximação, células não totalmente independentes): ~${expectedByChance}`);
  console.log(`Observado passando: ${passing.length + (rellNautVerdict.pass ? 1 : 0)}`);
  if (passing.length === 0 && !rellNautVerdict.pass) {
    console.log('\n**NÃO HÁ BASE PRA 2x AINDA.** Nenhuma célula testada teve CI inferior acima da baseline (67.3% aprox.) nem central≥62% com n≥25.');
  } else {
    console.log('\nCélulas que passaram:');
    for (const c of passing) console.log(`- ${c.label}: n=${c.stats.n}, hit=${c.stats.hit_pct}%, CI95%=[${c.stats.wilson_ci_95.lower}, ${c.stats.wilson_ci_95.upper}] (via ${c.verdict.pass_via})`);
    if (rellNautVerdict.pass) console.log(`- Camille+Rell+Nautilus: n=${rellNautSynergy.n}, hit=${rellNautSynergy.hit_pct}% (via ${rellNautVerdict.pass_via})`);
  }

  // Candidatos a observar — maior n entre os que NÃO passaram mas têm hit acima da baseline central (sem cruzar o critério formal).
  const observeCandidates = allCells
    .filter((c) => !c.verdict?.pass && c.stats.hit_pct != null && c.stats.hit_pct > BASELINE_CENTRAL && c.stats.n >= 10)
    .sort((a, b) => b.stats.hit_pct - a.stats.hit_pct)
    .slice(0, 5);
  console.log('\nCandidatos a OBSERVAR (acima da baseline central, mas não cruzam o critério formal, n≥10):');
  for (const c of observeCandidates) console.log(`- ${c.label}: n=${c.stats.n}, hit=${c.stats.hit_pct}%`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD, over_be_ref_pct: OVER_BE_REF, z_score_95: Z95,
      fair_fallback_min_n: FALLBACK_MIN_N, champion_min_n: CHAMPION_MIN_N,
      verdict_rule: `CI95% inferior > ${BASELINE_CENTRAL}% (baseline central da janela) OU (hit central ≥ ${ALT_HIT_MIN}% E n ≥ ${ALT_N_MIN})`,
    },
    meta: { camille_games_n: camilleRaw.length, no_window: noWindow, no_roster: noRoster, baseline: baseline },
    archetypes_used: {
      support: { PEEL: PEEL_PURE, ENGAGE: ENGAGE_LIST, MAGE: MAGE_LIST },
      jungle_dive: JUNGLE_DIVE_LIST, jungle_farm: JUNGLE_FARM_LIST,
      mid_assassin: MID_ASSASSIN_LIST, mid_mage: MID_MAGE_LIST,
      tiers: { elite: [...ELITE_LEAGUES], major: [...MAJOR_LEAGUES] },
      synergy_targets: SYNERGY_TARGETS,
    },
    cut1a_enemy_support_archetype: archCells,
    cut1b_enemy_support_champion: champCells,
    cut2_league_tier: tierCells,
    cut3a_jungle_archetype: jungleCells,
    cut3b_mid_archetype: midCells,
    cut4_synergy: synergyCells,
    cut4_synergy_rell_naut: { stats: rellNautSynergy, verdict: rellNautVerdict },
    cut5_delta_distribution: distribution,
    cut6_month: monthCells,
    cut7_side: sideCells,
    verdict: {
      cells_tested: allCells.length + 1,
      expected_by_chance: expectedByChance,
      passing_count: passing.length + (rellNautVerdict.pass ? 1 : 0),
      passing_cells: passing.map((c) => c.label).concat(rellNautVerdict.pass ? ['Camille+Rell+Nautilus'] : []),
      no_base_for_2x: passing.length === 0 && !rellNautVerdict.pass,
      observe_candidates: observeCandidates.map((c) => ({ label: c.label, n: c.stats.n, hit_pct: c.stats.hit_pct })),
    },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
