// scripts/analysis/les-update.cjs
//
// UPDATE da análise LES (26-les-complete.json era até 2026-07-21) com dado até
// 2026-07-26 — insumo do relatório "set definitivo de ligas" 2026-07-26.
//
// O que faz:
//   1. Carrega as linhas LES do universo allregions (2026-04-08 → 2026-07-21).
//   2. Busca na lolesports API os matches LES completed de 22→26/07 (own cache
//      key `lesupd{n}`, noCache nas páginas de schedule pra pegar jogo novo;
//      eventDetails/window batem cache padrão).
//   3. Merge por game_id, recomputa fair leave-one-out DENTRO da LES (mesma
//      metodologia de multi-league-mining/under-stress-line/lcp-viability).
//   4. Reporta: escada Under 3 linhas (trigger-only), por trigger, Milio/Camille,
//      mensal, trigger-rate mensal, all-games (contradição 43.5%), calibração
//      da fair, perfil de kills, horários BRT, volume futuro (schedule unstarted).
//
// Uso: node scripts/analysis/les-update.cjs
// Output: audit-output/33-les-update.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  getSchedulePage,
  getEventDetails,
  getWindow,
  getTeams,
  tsRoundedTo10sCapped,
} = require('../audit/lib/api-cache.cjs');
const { detectTrigger, extractGameData, isFrameSuspect } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_FILE = path.join(ROOT, 'audit-output', '33-les-update.json');
const UNIVERSE_ALLREGIONS = path.join(ROOT, 'audit-output', '00-universe-allregions.json');

const LES_ID = '105266074488398661';
const NEW_FROM = '2026-07-22';
const NEW_TO = '2026-07-27'; // exclusivo — captura até 2026-07-26 inclusive

const RUNGS = {
  fair_plus_1: { offset: 1, odd: 1.72, be: 58.1 },
  fair: { offset: 0, odd: 1.83, be: 54.6 },
  fair_minus_1: { offset: -1, odd: 1.95, be: 51.3 },
};
const STRESS_FLOOR_ODD = 1.72;
const OVER_ODD = 1.8;
const Z95 = 1.96;
const FALLBACK_MIN_N = 5;
const SAFETY_PAGE_CAP = 10;
const OFFSET_HOURS_TRY_ORDER = [6, 2, 4, 8];

const fmt1 = (n) => (Number.isFinite(n) ? +n.toFixed(1) : null);
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

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
  return fmt1((100 * (wins * (odd - 1) - (n - wins))) / n);
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function cellStats(rows, hitFn, odd) {
  const n = rows.length;
  const wins = rows.filter(hitFn).length;
  return { n, wins, hit_pct: n ? fmt1((100 * wins) / n) : null, wilson_ci_95: wilsonCI(wins, n), roi_pct: roiPct(wins, n, odd) };
}

// ============================================================================
// COLETA — schedule LES recente (own key + noCache), eventDetails+window cache padrão
// ============================================================================
async function fetchRecentLesEvents() {
  const allEvents = [];
  const completedNew = [];
  let pageToken = null;
  let oldestSeen = '9999-12-31';
  let pageIndex = 0;
  const seen = new Set();
  while (pageIndex < SAFETY_PAGE_CAP) {
    const page = await getSchedulePage(LES_ID, pageToken, { pageIndex: `lesupd${pageIndex}`, noCache: true });
    const sched = page?.data?.schedule;
    for (const ev of sched?.events || []) {
      if (!ev.startTime) continue;
      const matchId = String(ev.match?.id || ev.id || '');
      const key = matchId + ev.startTime;
      if (seen.has(key)) continue;
      seen.add(key);
      const date = ev.startTime.slice(0, 10);
      if (date < oldestSeen) oldestSeen = date;
      allEvents.push({
        match_id: matchId,
        startTime: ev.startTime,
        state: ev.state,
        blockName: ev.blockName || null,
        teams: (ev.match?.teams || []).map((t) => t.code || t.name || String(t.id)),
        bo: ev.match?.strategy?.count || null,
        raw: ev,
      });
      if (ev.state === 'completed' && date >= NEW_FROM && date < NEW_TO) completedNew.push(ev);
    }
    const olderToken = sched?.pages?.older;
    pageIndex++;
    if (!olderToken) break;
    if (oldestSeen < NEW_FROM) break;
    pageToken = olderToken;
  }
  return { allEvents, completedNew, oldestSeen, pagesFetched: pageIndex };
}

async function fetchGameWindow(gameId, matchStartISO) {
  const baseMs = new Date(matchStartISO).getTime();
  if (!Number.isFinite(baseMs)) return { window: null, error: 'invalid_match_start_time' };
  let lastErr = null;
  for (const hours of OFFSET_HOURS_TRY_ORDER) {
    const startingTime = tsRoundedTo10sCapped(baseMs + hours * 3600 * 1000);
    let win;
    try {
      win = await getWindow(gameId, startingTime);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (win && Array.isArray(win.frames) && win.frames.length > 0 && win.gameMetadata) {
      return { window: win, error: null };
    }
  }
  return { window: null, error: lastErr || 'no_valid_frames_after_all_offsets' };
}

async function collectNewGames(completedEvents, teamsMap) {
  const games = [];
  for (const ev of completedEvents) {
    const matchId = String(ev.match?.id || ev.id);
    let detail;
    try {
      detail = await getEventDetails(matchId);
    } catch (e) {
      console.error(`  [eventDetails ERROR] match=${matchId}: ${e.message}`);
      continue;
    }
    const completedGames = (detail?.data?.event?.match?.games || []).filter((g) => g.state === 'completed');
    for (const g of completedGames) {
      const { window, error } = await fetchGameWindow(g.id, ev.startTime);
      const gd = window ? extractGameData(window) : null;
      const rec = {
        game_id: String(g.id),
        match_id: matchId,
        league: 'LES',
        league_id: LES_ID,
        date: ev.startTime,
        map_number: g.number,
        team_blue: null,
        team_red: null,
        total_kills: null,
        sup_blue: null,
        sup_red: null,
        trigger_type: null,
        suspect: true,
        fetch_error: error || null,
        is_new: true,
      };
      if (gd) {
        rec.team_blue = teamsMap.get(gd.blueTeamId) || gd.blueTeamId;
        rec.team_red = teamsMap.get(gd.redTeamId) || gd.redTeamId;
        rec.total_kills = gd.totalKills;
        rec.sup_blue = gd.supBlue;
        rec.sup_red = gd.supRed;
        rec.trigger_type = detectTrigger(gd.supBlue, gd.supRed);
        rec.suspect = isFrameSuspect(gd);
      }
      games.push(rec);
    }
  }
  const byId = new Map();
  for (const g of games) byId.set(g.game_id, g);
  return [...byId.values()];
}

function computeFairLOO(population) {
  const teamHist = new Map();
  for (const g of population) {
    for (const t of [g.team_norm_blue, g.team_norm_red]) {
      if (!teamHist.has(t)) teamHist.set(t, []);
      teamHist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
    }
  }
  const leagueAvg = mean(population.map((g) => g.total_kills));
  const fairMap = new Map();
  let fallbackRefs = 0;
  for (const g of population) {
    const avgFor = (team) => {
      const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== g.game_id);
      if (arr.length < FALLBACK_MIN_N) {
        fallbackRefs++;
        return leagueAvg;
      }
      return mean(arr.map((x) => x.total_kills));
    };
    const raw = (avgFor(g.team_norm_blue) + avgFor(g.team_norm_red)) / 2;
    fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
  }
  return { fairMap, fallbackRefs, totalRefs: population.length * 2 };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('LES UPDATE — dado até 2026-07-26 (base: universo até 21/07 + fetch novo)');
  console.log('='.repeat(70));

  const universe = JSON.parse(fs.readFileSync(UNIVERSE_ALLREGIONS, 'utf8'));
  const lesOld = universe.filter((g) => g.league === 'LES');
  console.log(`\nLES no universo (até 21/07): ${lesOld.length} rows (${lesOld.filter((g) => !g.suspect && g.total_kills != null).length} válidas)`);

  const teamsRaw = await getTeams();
  const teamsMap = new Map();
  for (const t of teamsRaw?.data?.teams || []) teamsMap.set(String(t.id), t.name);

  const { allEvents, completedNew, pagesFetched } = await fetchRecentLesEvents();
  console.log(`Schedule: ${pagesFetched} páginas, ${allEvents.length} eventos, ${completedNew.length} matches completed em ${NEW_FROM}→${NEW_TO} (excl.)`);

  const newGames = await collectNewGames(completedNew, teamsMap);
  console.log(`Games novos coletados: ${newGames.length} (${newGames.filter((g) => !g.suspect).length} válidos)`);
  for (const g of newGames) {
    console.log(`  ${g.date.slice(0, 10)} M${g.map_number} ${g.team_blue} x ${g.team_red} — ${g.total_kills} kills, sups ${g.sup_blue}/${g.sup_red}, trigger=${g.trigger_type || '-'}${g.suspect ? ' [SUSPECT]' : ''}`);
  }

  // merge por game_id
  const byId = new Map();
  for (const g of lesOld) byId.set(String(g.game_id), { ...g });
  for (const g of newGames) if (!byId.has(g.game_id)) byId.set(g.game_id, g);
  const merged = [...byId.values()].filter((g) => !g.suspect && g.total_kills != null);
  for (const g of merged) {
    g.team_norm_blue = normalizeTeam(g.team_blue);
    g.team_norm_red = normalizeTeam(g.team_red);
    g.month = (g.date || '').slice(0, 7);
  }
  console.log(`\nPopulação LES merged válida: ${merged.length}`);

  const { fairMap, fallbackRefs, totalRefs } = computeFairLOO(merged);
  for (const g of merged) {
    g.fair = fairMap.get(g.game_id);
    g.abs_err = Math.abs(g.total_kills - g.fair);
  }

  const trigger = merged.filter((g) => g.trigger_type);
  const hasMilio = (g) => normChamp(g.sup_blue) === 'milio' || normChamp(g.sup_red) === 'milio';
  const hasCamille = (g) => normChamp(g.sup_blue) === 'camille' || normChamp(g.sup_red) === 'camille';
  const hitAt = (offset) => (g) => g.total_kills < g.fair + offset;
  const overHitFair = (g) => g.total_kills > g.fair;

  // escada
  console.log('\n## Under trigger-only — escada (n=' + trigger.length + ')\n');
  console.log('| linha | n | hit% | CI95% | ROI stress @1.72 | ROI odd real |');
  console.log('|---|---|---|---|---|---|');
  const rungs = {};
  for (const [key, cfg] of Object.entries(RUNGS)) {
    const stress = cellStats(trigger, hitAt(cfg.offset), STRESS_FLOOR_ODD);
    const real = cellStats(trigger, hitAt(cfg.offset), cfg.odd);
    rungs[key] = { stress, real_odd: cfg.odd, real_roi_pct: real.roi_pct, be_real: cfg.be };
    console.log(`| ${key} | ${stress.n} | ${stress.hit_pct} | [${stress.wilson_ci_95.lower}–${stress.wilson_ci_95.upper}] | ${stress.roi_pct}% | ${real.roi_pct}% @${cfg.odd} |`);
  }

  // por trigger / recortes
  const cuts = {
    '2peel': cellStats(trigger.filter((g) => g.trigger_type === '2peel'), hitAt(1), 1.72),
    '1peel+flex': cellStats(trigger.filter((g) => g.trigger_type === '1peel+flex'), hitAt(1), 1.72),
    milio_in_game_trigger: cellStats(trigger.filter(hasMilio), hitAt(1), 1.72),
    '2peel_sem_milio': cellStats(trigger.filter((g) => g.trigger_type === '2peel' && !hasMilio(g)), hitAt(1), 1.72),
    trigger_sem_milio: cellStats(trigger.filter((g) => !hasMilio(g)), hitAt(1), 1.72),
  };
  console.log('\n## Recortes (fair+1 @1.72)\n');
  console.log('| recorte | n | hit% | CI95% | ROI% |');
  console.log('|---|---|---|---|---|');
  for (const [k, s] of Object.entries(cuts)) console.log(`| ${k} | ${s.n} | ${s.hit_pct ?? '-'} | [${s.wilson_ci_95.lower ?? '-'}–${s.wilson_ci_95.upper ?? '-'}] | ${s.roi_pct ?? '-'} |`);

  // mensal + trigger rate
  const months = [...new Set(merged.map((g) => g.month))].sort();
  const monthly = months.map((m) => {
    const pop = merged.filter((g) => g.month === m);
    const trig = pop.filter((g) => g.trigger_type);
    return {
      month: m,
      maps: pop.length,
      trigger_n: trig.length,
      trigger_rate_pct: fmt1((100 * trig.length) / pop.length),
      under: cellStats(trig, hitAt(1), 1.72),
      avg_kills: fmt1(mean(pop.map((g) => g.total_kills))),
    };
  });
  console.log('\n## Mensal\n');
  console.log('| mês | mapas | triggers | trigger rate | under hit (fair+1) | avg kills |');
  console.log('|---|---|---|---|---|---|');
  for (const m of monthly) console.log(`| ${m.month} | ${m.maps} | ${m.trigger_n} | ${m.trigger_rate_pct}% | ${m.under.hit_pct ?? '-'}% (${m.under.wins}/${m.under.n}) | ${m.avg_kills} |`);

  // presença de Milio/Camille no meta LES (all games)
  const milioAll = merged.filter(hasMilio);
  const camilleAll = merged.filter(hasCamille);
  const milioJuly = milioAll.filter((g) => g.month === '2026-07');
  const camilleJuly = camilleAll.filter((g) => g.month === '2026-07');
  const camilleStats = cellStats(camilleAll, overHitFair, OVER_ODD);
  const milioAllUnder = cellStats(milioAll, hitAt(1), 1.72);
  console.log('\n## Meta LES — Milio/Camille (all games)\n');
  console.log(`Milio sup: ${milioAll.length}/${merged.length} mapas (${fmt1((100 * milioAll.length) / merged.length)}%) — julho: ${milioJuly.length}/${merged.filter((g) => g.month === '2026-07').length}`);
  console.log(`  Under fair+1 com Milio no jogo (mesmo sem trigger): ${milioAllUnder.wins}/${milioAllUnder.n} = ${milioAllUnder.hit_pct}%`);
  console.log(`Camille sup: ${camilleAll.length}/${merged.length} mapas — julho: ${camilleJuly.length}. Over fair: ${camilleStats.wins}/${camilleStats.n} = ${camilleStats.hit_pct ?? '-'}%`);

  // all-games (contradição 43.5%)
  const allFairPlus1 = cellStats(merged, hitAt(1), 1.72);
  const allFair = cellStats(merged, hitAt(0), 1.72);
  console.log('\n## All-games (sem filtro de trigger — contradição 43.5%)\n');
  console.log(`fair+1: ${allFairPlus1.wins}/${allFairPlus1.n} = ${allFairPlus1.hit_pct}% | fair: ${allFair.wins}/${allFair.n} = ${allFair.hit_pct}%`);

  // calibração fair
  const calib = {
    n: merged.length,
    median_abs_err: fmt1(median(merged.map((g) => g.abs_err))),
    mean_abs_err: fmt1(mean(merged.map((g) => g.abs_err))),
    fallback_pct: fmt1((100 * fallbackRefs) / totalRefs),
  };
  console.log(`\n## Calibração fair LOO: mediana |kills−fair| = ${calib.median_abs_err}, média = ${calib.mean_abs_err}, fallback ${calib.fallback_pct}%`);

  // kills profile
  const kills = merged.map((g) => g.total_kills);
  const profile = { n: kills.length, mean: fmt1(mean(kills)), median: median(kills), stdev: fmt1(stdev(kills)), over275_pct: fmt1((100 * kills.filter((k) => k > 27.5).length) / kills.length), over305_pct: fmt1((100 * kills.filter((k) => k > 30.5).length) / kills.length) };
  console.log(`\n## Kills: média ${profile.mean}, mediana ${profile.median}, desvio ${profile.stdev}, >27.5: ${profile.over275_pct}%, >30.5: ${profile.over305_pct}%`);

  // volume futuro — schedule unstarted
  const upcoming = allEvents.filter((e) => e.state === 'unstarted' && e.startTime >= '2026-07-26');
  const byWeek = new Map();
  for (const e of upcoming) {
    const d = new Date(e.startTime);
    const onejan = new Date(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    const key = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    byWeek.set(key, (byWeek.get(key) || 0) + 1);
  }
  console.log('\n## Volume futuro (matches unstarted por semana)');
  for (const [w, c] of [...byWeek.entries()].sort()) console.log(`  ${w}: ${c} matches`);

  const output = {
    generated_at: new Date().toISOString(),
    coverage: { old_universe_to: '2026-07-21', new_fetch: `${NEW_FROM}→2026-07-26`, new_games: newGames.length, merged_valid_n: merged.length },
    params: { z: Z95, fallback_min_n: FALLBACK_MIN_N, rungs: RUNGS, stress_floor_odd: STRESS_FLOOR_ODD },
    rungs,
    cuts,
    monthly,
    meta_presence: {
      milio_maps: milioAll.length,
      milio_maps_july: milioJuly.length,
      milio_under_fair_plus1_allgames: milioAllUnder,
      camille_maps: camilleAll.length,
      camille_maps_july: camilleJuly.length,
      camille_over_fair: camilleStats,
    },
    all_games: { fair_plus_1: allFairPlus1, fair: allFair },
    fair_calibration: calib,
    kills_profile: profile,
    upcoming_matches_by_week: Object.fromEntries([...byWeek.entries()].sort()),
    new_games_detail: newGames,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
