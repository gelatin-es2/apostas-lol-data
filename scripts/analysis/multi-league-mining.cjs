// scripts/analysis/multi-league-mining.cjs
//
// Última mineração no dataset das 30 ligas com dado (audit-output/00-universe-allregions.json
// — 2026-04-01 → 2026-07-21, coletado por scripts/analysis/camille-collect.cjs, 100% em
// cache, zero chamada de API nova). 3 perguntas:
//
//   A. EXPANSÃO DO UNDER — por liga, Under hit nos jogos com trigger peel (fair+1 @ 1.72,
//      BE 58.1%). Candidatas a expansão do método pras 6 ligas operadas hoje.
//   B. META DE JULHO — o patch mudou o jogo? kills médio, taxa de trigger, hit do Under
//      no patch novo (abr-jun vs julho).
//   C. NOVOS SINAIS DE CHAMPION — delta kills vs fair por champion (qualquer role) só em
//      julho, controle por time (técnica C2 de split2-over-method.cjs) nos top 5 |delta|,
//      e detecção de champions genuinamente novos (não vistos abr-jun).
//
// Fair leave-one-out POR LIGA — MESMA função/critério de scripts/analysis/camille-sweep.cjs
// (fallback pra média da liga se time tem <5 jogos anteriores NA MESMA LIGA).
//
// Uso: node scripts/analysis/multi-league-mining.cjs
// Output: audit-output/18-multi-league-mining.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { LEAGUE_IDS } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '18-multi-league-mining.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const UNDER_ODD = 1.72;
const UNDER_BE = 58.1;
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs
const CANDIDATE_MIN_N = 25;
const CANDIDATE_CI_LOWER_MIN = 50;
const CHAMPION_MIN_N_JULY = 10;
const TOP_DELTA_N = 5;

const ORIGINAL_6_IDS = new Set(Object.values(LEAGUE_IDS));
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];

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
// Fair leave-one-out POR LIGA — sync: scripts/analysis/camille-sweep.cjs (mesmo
// critério: fallback se time tem <5 jogos anteriores na MESMA liga).
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

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('MULTI-LEAGUE MINING — 30 ligas, 2026-04-01 → 2026-07-21');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  console.log(`\nUniverso bruto: ${universeRaw.length} | população válida: ${populationAll.length}`);

  const fairMap = computeFairPerLeague(populationAll);
  const rows = populationAll.map((g) => {
    const fair = fairMap.get(g.game_id);
    return {
      game_id: g.game_id,
      league: g.league,
      league_id: g.league_id,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      team_blue: normalizeTeam(g.team_blue),
      team_red: normalizeTeam(g.team_red),
      kills_blue: g.kills_blue,
      kills_red: g.kills_red,
      total_kills: g.total_kills,
      trigger_type: g.trigger_type,
      fair,
      delta: fmt1(g.total_kills - fair),
      under_hit: g.total_kills < fair + 1, // linha real do Under = fair+1
      is_original_6: ORIGINAL_6_IDS.has(String(g.league_id)),
    };
  });

  // ==========================================================================
  // A. EXPANSÃO DO UNDER — por liga, jogos com trigger peel
  // ==========================================================================
  console.log('\n\n## A. EXPANSÃO DO UNDER — Under hit por liga (trigger peel, fair+1 @ 1.72, BE 58.1%)\n');

  const triggerRows = rows.filter((r) => r.trigger_type);
  const byLeagueTrigger = new Map();
  for (const r of triggerRows) {
    if (!byLeagueTrigger.has(r.league)) byLeagueTrigger.set(r.league, { league: r.league, league_id: r.league_id, is_original_6: r.is_original_6, rows: [] });
    byLeagueTrigger.get(r.league).rows.push(r);
  }
  const leagueUnderTable = [...byLeagueTrigger.values()].map((e) => {
    const n = e.rows.length;
    const wins = e.rows.filter((r) => r.under_hit).length;
    const hitPct = n ? fmt1((100 * wins) / n) : null;
    const ci = wilsonCI(wins, n);
    const roi = roiPct(wins, n, UNDER_ODD);
    const isCandidate = hitPct != null && hitPct >= UNDER_BE && n >= CANDIDATE_MIN_N && ci.lower != null && ci.lower >= CANDIDATE_CI_LOWER_MIN;
    return { league: e.league, league_id: e.league_id, is_original_6: e.is_original_6, n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roi, is_candidate: isCandidate };
  }).sort((a, b) => (b.hit_pct ?? -1) - (a.hit_pct ?? -1));

  console.log('| liga | n | hit% | CI95% | ROI% | benchmark(6 atuais) | candidata |');
  console.log('|---|---|---|---|---|---|---|');
  for (const t of leagueUnderTable) {
    const ciStr = t.n ? `[${t.wilson_ci_95.lower}, ${t.wilson_ci_95.upper}]` : '-';
    console.log(`| ${t.league} | ${t.n} | ${t.hit_pct ?? '-'} | ${ciStr} | ${t.roi_pct ?? '-'} | ${t.is_original_6 ? 'BENCHMARK' : ''} | ${t.is_candidate ? '**CANDIDATA**' : ''} |`);
  }
  const candidates = leagueUnderTable.filter((t) => t.is_candidate && !t.is_original_6);
  console.log(`\n### Candidatas explícitas a expansão (central≥BE, n≥${CANDIDATE_MIN_N}, CI_inferior≥${CANDIDATE_CI_LOWER_MIN}%)\n`);
  if (candidates.length === 0) {
    console.log('Nenhuma liga nova cruzou o critério.');
  } else {
    for (const c of candidates) console.log(`- **${c.league}**: n=${c.n}, hit=${c.hit_pct}%, CI95%=[${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}], ROI=${c.roi_pct}%`);
  }

  // ==========================================================================
  // B. META DE JULHO
  // ==========================================================================
  console.log('\n\n## B. META DE JULHO — o patch mudou o jogo?\n');

  const julyRows = rows.filter((r) => r.month === '2026-07');
  const aprJunRows = rows.filter((r) => r.month === '2026-04' || r.month === '2026-05' || r.month === '2026-06');

  const avgKills = (rs) => (rs.length ? fmt1(rs.reduce((a, r) => a + r.total_kills, 0) / rs.length) : null);
  const triggerRate = (rs) => (rs.length ? fmt1((100 * rs.filter((r) => r.trigger_type).length) / rs.length) : null);

  const aggB = {
    avg_kills: { abr_jun: avgKills(aprJunRows), julho: avgKills(julyRows) },
    trigger_rate_pct: { abr_jun: triggerRate(aprJunRows), julho: triggerRate(julyRows) },
    n: { abr_jun: aprJunRows.length, julho: julyRows.length },
  };
  console.log(`### Agregado (todas as ligas)\n`);
  console.log(`Kills médio: abr-jun=${aggB.avg_kills.abr_jun} (n=${aggB.n.abr_jun}) | julho=${aggB.avg_kills.julho} (n=${aggB.n.julho})`);
  console.log(`Taxa de trigger peel: abr-jun=${aggB.trigger_rate_pct.abr_jun}% | julho=${aggB.trigger_rate_pct.julho}%`);
  const killsDelta = fmt1(aggB.avg_kills.julho - aggB.avg_kills.abr_jun);
  const triggerDelta = fmt1(aggB.trigger_rate_pct.julho - aggB.trigger_rate_pct.abr_jun);
  console.log(`Delta kills: ${killsDelta > 0 ? '+' : ''}${killsDelta} | Delta trigger rate: ${triggerDelta > 0 ? '+' : ''}${triggerDelta}pp — volume do Under em split3 tende a ${triggerDelta > 0 ? 'AUMENTAR' : triggerDelta < 0 ? 'DIMINUIR' : 'ficar igual'}.`);

  const julyLeagues = [...new Set(julyRows.map((r) => r.league))];
  console.log(`\n### Por liga (só ligas com jogo em julho, ${julyLeagues.length} ligas)\n`);
  console.log('| liga | n_abrjun | kills_abrjun | trig%_abrjun | n_jul | kills_jul | trig%_jul |');
  console.log('|---|---|---|---|---|---|---|');
  const byLeagueB = [];
  for (const league of julyLeagues) {
    const rsAJ = aprJunRows.filter((r) => r.league === league);
    const rsJul = julyRows.filter((r) => r.league === league);
    const entry = {
      league,
      abr_jun: { n: rsAJ.length, avg_kills: avgKills(rsAJ), trigger_rate_pct: triggerRate(rsAJ) },
      julho: { n: rsJul.length, avg_kills: avgKills(rsJul), trigger_rate_pct: triggerRate(rsJul) },
    };
    byLeagueB.push(entry);
    console.log(`| ${league} | ${entry.abr_jun.n} | ${entry.abr_jun.avg_kills ?? '-'} | ${entry.abr_jun.trigger_rate_pct ?? '-'} | ${entry.julho.n} | ${entry.julho.avg_kills ?? '-'} | ${entry.julho.trigger_rate_pct ?? '-'} |`);
  }

  const julyTriggerRows = julyRows.filter((r) => r.trigger_type);
  const julyTriggerN = julyTriggerRows.length;
  const julyTriggerWins = julyTriggerRows.filter((r) => r.under_hit).length;
  const julyTriggerHitPct = julyTriggerN ? fmt1((100 * julyTriggerWins) / julyTriggerN) : null;
  const julyTriggerCI = wilsonCI(julyTriggerWins, julyTriggerN);
  const julyTriggerROI = roiPct(julyTriggerWins, julyTriggerN, UNDER_ODD);
  console.log(`\n### Under hit em julho, jogos com trigger (fair+1 @ 1.72, BE 58.1%)\n`);
  console.log(`n=${julyTriggerN}, hit=${julyTriggerHitPct ?? '-'}%, CI95%=[${julyTriggerCI.lower ?? '-'}, ${julyTriggerCI.upper ?? '-'}], ROI=${julyTriggerROI ?? '-'}%${julyTriggerN < 30 ? ' — [FLAG] n pequeno' : ''}`);

  // ==========================================================================
  // C. NOVOS SINAIS DE CHAMPION (julho)
  // ==========================================================================
  console.log('\n\n## C. NOVOS SINAIS DE CHAMPION — julho, qualquer role\n');

  let noWindow = 0;
  let noRoster = 0;
  const participantRows = [];
  const champsSeenByMonth = new Map(); // month -> Set(champ)
  for (const r of rows) {
    const win = loadWindow(r.game_id);
    if (!win) {
      noWindow++;
      continue;
    }
    const roster = extractRoster(win);
    if (!roster) {
      noRoster++;
      continue;
    }
    if (!champsSeenByMonth.has(r.month)) champsSeenByMonth.set(r.month, new Set());
    const monthSet = champsSeenByMonth.get(r.month);
    for (const side of ['blue', 'red']) {
      const ownKills = side === 'blue' ? r.kills_blue : r.kills_red;
      const team = side === 'blue' ? r.team_blue : r.team_red;
      for (const role of ROLES) {
        const champ = roster[side][role];
        if (!champ) continue;
        monthSet.add(champ);
        participantRows.push({ champ, role, side, team, ownKills, game_id: r.game_id, month: r.month, delta: r.delta, league: r.league });
      }
    }
  }
  console.log(`Cobertura de roster: ${participantRows.length ? 'ok' : 'falhou'} — sem window file: ${noWindow}, sem roster completo: ${noRoster} (de ${rows.length} games).`);

  const julyParticipants = participantRows.filter((p) => p.month === '2026-07');
  const byChamp = new Map();
  for (const p of julyParticipants) {
    if (!byChamp.has(p.champ)) byChamp.set(p.champ, []);
    byChamp.get(p.champ).push(p);
  }
  const champTable = [...byChamp.entries()]
    .map(([champ, ps]) => {
      const n = ps.length;
      const avgDelta = n ? fmt1(ps.reduce((a, p) => a + p.delta, 0) / n) : null;
      return { champ, n, avg_delta: avgDelta };
    })
    .filter((c) => c.n >= CHAMPION_MIN_N_JULY)
    .sort((a, b) => Math.abs(b.avg_delta) - Math.abs(a.avg_delta));

  console.log(`\n### Champions em julho com n≥${CHAMPION_MIN_N_JULY} (${champTable.length} elegíveis), ordenado por |avg_delta|\n`);
  console.log('| champion | n_julho | avg_delta (kills-fair) |');
  console.log('|---|---|---|');
  for (const c of champTable) console.log(`| ${c.champ} | ${c.n} | ${c.avg_delta} |`);

  // Lookup rápido (game_id|team) -> Set(champs) só de julho — evita scan O(n*m).
  const julyPicksByGameTeam = new Map();
  for (const p of julyParticipants) {
    const key = `${p.game_id}|${p.team}`;
    if (!julyPicksByGameTeam.has(key)) julyPicksByGameTeam.set(key, new Set());
    julyPicksByGameTeam.get(key).add(p.champ);
  }

  // Controle por time (técnica C2) — top 5 |delta|
  function teamControlledDelta(champRaw, rowsWithTeamKills) {
    const byTeam = new Map();
    for (const r of rowsWithTeamKills) {
      const team = r.team;
      const picks = julyPicksByGameTeam.get(`${r.game_id}|${team}`);
      const picked = picks ? picks.has(champRaw) : false;
      if (!byTeam.has(team)) byTeam.set(team, { withKills: [], withoutKills: [] });
      const e = byTeam.get(team);
      if (picked) e.withKills.push(r.ownKills);
      else e.withoutKills.push(r.ownKills);
    }
    let sumWeighted = 0;
    let totalWeightN = 0;
    const perTeam = [];
    for (const [team, e] of byTeam) {
      if (e.withKills.length === 0 || e.withoutKills.length === 0) continue;
      const avgWith = e.withKills.reduce((a, b) => a + b, 0) / e.withKills.length;
      const avgWithout = e.withoutKills.reduce((a, b) => a + b, 0) / e.withoutKills.length;
      const deltaTeam = avgWith - avgWithout;
      perTeam.push({ team, n_with: e.withKills.length, n_without: e.withoutKills.length, delta_team: fmt1(deltaTeam) });
      sumWeighted += deltaTeam * e.withKills.length;
      totalWeightN += e.withKills.length;
    }
    perTeam.sort((a, b) => b.n_with - a.n_with);
    return { team_controlled_delta: totalWeightN ? fmt1(sumWeighted / totalWeightN) : null, n_teams: perTeam.length, n_games_pooled: totalWeightN, per_team: perTeam };
  }

  // rowsWithTeamKills: 1 linha por (game,team) em julho, pra achar with/without.
  const julyTeamGameRows = [];
  for (const r of julyRows) {
    julyTeamGameRows.push({ game_id: r.game_id, team: r.team_blue, ownKills: r.kills_blue });
    julyTeamGameRows.push({ game_id: r.game_id, team: r.team_red, ownKills: r.kills_red });
  }

  const top5 = champTable.slice(0, TOP_DELTA_N);
  console.log(`\n### Controle por time (C2) — top ${TOP_DELTA_N} |avg_delta|\n`);
  const top5WithControl = top5.map((c) => {
    const tc = teamControlledDelta(c.champ, julyTeamGameRows);
    let verdict = 'sem_dado_suficiente';
    if (tc.team_controlled_delta != null) {
      const sameSign = Math.sign(c.avg_delta) === Math.sign(tc.team_controlled_delta) || tc.team_controlled_delta === 0;
      if (Math.abs(tc.team_controlled_delta) < 0.5) verdict = 'colapsa_perto_de_zero (provável efeito de TIME)';
      else if (!sameSign) verdict = 'inverte_sinal (provável efeito de TIME)';
      else verdict = 'sobrevive (consistente com efeito do CAMPEÃO)';
    }
    return { ...c, ...tc, verdict };
  });
  console.log('| champion | naive_avg_delta | naive_n | team_controlled_delta | n_teams | n_games_pooled | veredito |');
  console.log('|---|---|---|---|---|---|---|');
  for (const c of top5WithControl) {
    console.log(`| ${c.champ} | ${c.avg_delta} | ${c.n} | ${c.team_controlled_delta ?? '-'} | ${c.n_teams} | ${c.n_games_pooled} | ${c.verdict} |`);
  }

  // Champions novos — em julho mas não em nenhum mês abr-jun.
  const aprJunMonths = ['2026-04', '2026-05', '2026-06'];
  const champsAprJun = new Set();
  for (const m of aprJunMonths) {
    for (const c of champsSeenByMonth.get(m) || []) champsAprJun.add(c);
  }
  const champsJulho = champsSeenByMonth.get('2026-07') || new Set();
  const newChamps = [...champsJulho].filter((c) => !champsAprJun.has(c)).sort();
  console.log(`\n### Champions vistos em julho mas NUNCA em abr-jun (candidatos a "champion novo")\n`);
  if (newChamps.length === 0) {
    console.log('Nenhum — todo champion visto em julho já tinha aparecido em abr-jun no dataset.');
  } else {
    for (const c of newChamps) {
      const n = participantRows.filter((p) => p.champ === c && p.month === '2026-07').length;
      console.log(`- ${c} (n=${n} em julho)`);
    }
  }

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      under_odd: UNDER_ODD, under_be_pct: UNDER_BE, z_score_95: Z95,
      fair_fallback_min_n: FALLBACK_MIN_N,
      candidate_min_n: CANDIDATE_MIN_N, candidate_ci_lower_min: CANDIDATE_CI_LOWER_MIN,
      champion_min_n_july: CHAMPION_MIN_N_JULY, top_delta_n: TOP_DELTA_N,
    },
    meta: { universe_raw_n: universeRaw.length, population_n: populationAll.length, no_window: noWindow, no_roster: noRoster },
    partA_under_by_league: { table: leagueUnderTable, candidates: candidates.map((c) => c.league) },
    partB_july_meta: { aggregate: aggB, by_league: byLeagueB, july_trigger_under: { n: julyTriggerN, wins: julyTriggerWins, hit_pct: julyTriggerHitPct, wilson_ci_95: julyTriggerCI, roi_pct: julyTriggerROI, small_sample_flag: julyTriggerN < 30 } },
    partC_champion_signals: { champion_table_july: champTable, top5_team_controlled: top5WithControl, new_champions_july: newChamps },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
