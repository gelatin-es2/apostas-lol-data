// scripts/analysis/tcl-viability.cjs
//
// Análise de viabilidade da TCL (Türkiye Şampiyonluk Ligi, leagueId
// 98767991343597634, região EMEA) pros dois métodos operados:
//   1. Under kill — trigger 2peel / 1peel+flex, linhas fair (@1.83) e fair+1 (@1.72)
//   2. Over kill — janela Camille support, linha ≤ fair (@1.80, BE 55.6)
//
// Motivação do CEO: "já é no mesmo horário de outras ligas que eu faço" —
// o script mede isso de verdade: horários reais BRT da TCL vs bloco da tarde
// (Prime League / LES / LFL, 12h–17h BRT).
//
// Coleta o histórico 2026 COMPLETO da TCL (2026-01-01 → 2026-07-30) via schedule
// paginado → eventDetails → livestats window. Cache compartilhado em audit-cache/:
//   - eventDetails/window: chaves padrão (event-{matchId} / window-{gameId}) —
//     os 86 games abr→jun já coletados pelo universo allregions saem do cache.
//   - schedule: chave própria `tclfull{n}` pra não sobrescrever páginas de outras
//     runs. Re-run bate cache; `--fresh` força refetch das páginas de schedule.
//
// Metodologia sincronizada com scripts/analysis/lcp-viability.cjs /
// multi-league-mining.cjs / under-stress-line.cjs / les-update.cjs
// (mesmos critérios do relatório de expansão 2026-07-21):
//   - fair leave-one-out POR LIGA, fallback média da liga se time tem <5 outros jogos
//   - Wilson CI 95% em toda taxa
//   - critério candidata Under: hit fair+1 ≥ 58.1%, n ≥ 25, CI inferior ≥ 50%
//   - escada realista: fair+1@1.72 / fair@1.83 / fair−1@1.95 + piso stress @1.72
//
// Uso: node scripts/analysis/tcl-viability.cjs [--fresh]
// Output: audit-output/37-tcl-viability.json + tabelas markdown no stdout.

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
const OUTPUT_FILE = path.join(ROOT, 'audit-output', '37-tcl-viability.json');
const UNIVERSE_ALLREGIONS = path.join(ROOT, 'audit-output', '00-universe-allregions.json');
const POLYMARKET_VOLUME = path.join(ROOT, 'audit-output', '29-polymarket-volume-2026.json');

const TCL_ID = '98767991343597634';
const FROM = '2026-01-01';
const TO = '2026-07-31'; // exclusivo — captura até 2026-07-30 inclusive

const FRESH = process.argv.includes('--fresh');

// sync: under-stress-line.cjs (escada realista) + multi-league-mining.cjs (critério candidata)
const RUNGS = {
  fair_plus_1: { offset: 1, odd: 1.72, be: 58.1 },
  fair: { offset: 0, odd: 1.83, be: 54.6 },
  fair_minus_1: { offset: -1, odd: 1.95, be: 51.3 },
};
const STRESS_FLOOR_ODD = 1.72; // piso conservador: 3 linhas todas @1.72
const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs / multi-league-mining.cjs
const CANDIDATE_MIN_N = 25;
const CANDIDATE_CI_LOWER_MIN = 50;
const MIN_CELL_N = 10; // regra do projeto: célula n<10 não é base de dados

const SAFETY_PAGE_CAP = 30;
const OFFSET_HOURS_TRY_ORDER = [6, 2, 4, 8];
const BRT_OFFSET_H = -3;

// Bloco da tarde que o CEO já opera (Prime 12–15h · LES 12:00/14:30 · LFL 13–16h BRT)
const AFTERNOON_BLOCK = { from_h: 12, to_h: 18 }; // [12:00, 18:00) BRT
// Ligas de comparação (mesmo bloco de horário) — ids canônicos
const COMPARE_LEAGUES = {
  'Prime League': '105266091639104326',
  LES: '105266074488398661',
  LFL: '105266103462388553', // universo usa o nome "La Ligue Française"
};

const fmt1 = (n) => (Number.isFinite(n) ? +n.toFixed(1) : null);
const norm = (s) => (s ? s.toLowerCase().replace(/\s+/g, '') : '');

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

// ============================================================================
// COLETA — schedule TCL completo 2026 (paginação own-key), eventDetails+window
// via cache padrão compartilhado.
// ============================================================================
async function fetchTclEvents() {
  const allEvents = []; // todos os states (pra análise de horário/volume)
  const completedInRange = [];
  let pageToken = null;
  let oldestSeen = '9999-12-31';
  let pageIndex = 0;
  const seenMatchIds = new Set();

  while (pageIndex < SAFETY_PAGE_CAP) {
    const page = await getSchedulePage(TCL_ID, pageToken, {
      pageIndex: `tclfull${pageIndex}`,
      noCache: FRESH,
    });
    const sched = page?.data?.schedule;
    const pageEvents = sched?.events || [];
    for (const ev of pageEvents) {
      if (!ev.startTime) continue;
      const matchId = String(ev.match?.id || ev.id || '');
      if (seenMatchIds.has(matchId + ev.startTime)) continue;
      seenMatchIds.add(matchId + ev.startTime);
      const date = ev.startTime.slice(0, 10);
      if (date < oldestSeen) oldestSeen = date;
      allEvents.push({
        match_id: matchId,
        startTime: ev.startTime,
        state: ev.state,
        blockName: ev.blockName || null,
        teams: (ev.match?.teams || []).map((t) => t.name || t.code || String(t.id)),
        strategy: ev.match?.strategy?.count || null,
        rawEvent: ev,
      });
      if (ev.state === 'completed' && date >= FROM && date < TO) completedInRange.push(ev);
    }
    const olderToken = sched?.pages?.older;
    pageIndex++;
    if (!olderToken) break;
    if (oldestSeen < FROM) break;
    pageToken = olderToken;
  }
  return { allEvents, completedInRange, oldestSeen, pagesFetched: pageIndex };
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

async function collectTclGames(completedEvents, teamsMap) {
  const games = [];
  let fetchErrors = 0;
  let processed = 0;
  for (const ev of completedEvents) {
    const matchId = String(ev.match?.id || ev.id);
    let detail;
    try {
      detail = await getEventDetails(matchId);
    } catch (e) {
      fetchErrors++;
      console.error(`  [eventDetails ERROR] match=${matchId}: ${e.message}`);
      continue;
    }
    const completedGames = (detail?.data?.event?.match?.games || []).filter((g) => g.state === 'completed');
    for (const g of completedGames) {
      processed++;
      if (processed % 50 === 0) console.error(`  progresso: ${processed} games...`);
      const { window, error } = await fetchGameWindow(g.id, ev.startTime);
      const gd = window ? extractGameData(window) : null;
      const rec = {
        game_id: String(g.id),
        match_id: matchId,
        date: ev.startTime,
        month: ev.startTime.slice(0, 7),
        map_number: g.number,
        block: ev.blockName || null,
        team_blue: null,
        team_red: null,
        kills_blue: null,
        kills_red: null,
        total_kills: null,
        sup_blue: null,
        sup_red: null,
        trigger_type: null,
        suspect: true,
        fetch_error: error || null,
      };
      if (gd) {
        rec.team_blue = normalizeTeam(teamsMap.get(gd.blueTeamId) || gd.blueTeamId);
        rec.team_red = normalizeTeam(teamsMap.get(gd.redTeamId) || gd.redTeamId);
        rec.kills_blue = gd.kBlue;
        rec.kills_red = gd.kRed;
        rec.total_kills = gd.totalKills;
        rec.sup_blue = gd.supBlue;
        rec.sup_red = gd.supRed;
        rec.trigger_type = detectTrigger(gd.supBlue, gd.supRed);
        rec.suspect = isFrameSuspect(gd);
      }
      if (rec.fetch_error) fetchErrors++;
      games.push(rec);
    }
  }
  // dedupe por game_id (defensivo)
  const byId = new Map();
  for (const g of games) byId.set(g.game_id, g);
  return { games: [...byId.values()], fetchErrors };
}

// ============================================================================
// FAIR leave-one-out dentro da TCL — sync: multi-league-mining.cjs
// computeFairPerLeague (fallback média da liga se time tem <5 OUTROS jogos).
// ============================================================================
function computeFairLOO(population) {
  const teamHist = new Map();
  for (const g of population) {
    for (const t of [g.team_blue, g.team_red]) {
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
    const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
    fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
  }
  return { fairMap, fallbackRefs, totalRefs: population.length * 2 };
}

function periodOf(dateStr) {
  const d = dateStr.slice(0, 10);
  if (d < '2026-04-01') return 'jan_mar';
  if (d < '2026-07-01') return 'apr_jun';
  return 'julho';
}

function underCells(rows) {
  const n = rows.length;
  const out = { n };
  for (const [key, rung] of Object.entries(RUNGS)) {
    const wins = rows.filter((r) => r.total_kills < r.fair + rung.offset).length;
    out[key] = {
      wins,
      hit_pct: n ? fmt1((100 * wins) / n) : null,
      wilson_ci_95: wilsonCI(wins, n),
      roi_realistic_pct: roiPct(wins, n, rung.odd),
      roi_stress_floor_pct: roiPct(wins, n, STRESS_FLOOR_ODD),
      odd_realistic: rung.odd,
      be_realistic_pct: rung.be,
    };
  }
  return out;
}

function overCells(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.total_kills > r.fair).length;
  return {
    n,
    wins,
    hit_pct: n ? fmt1((100 * wins) / n) : null,
    wilson_ci_95: wilsonCI(wins, n),
    roi_pct: roiPct(wins, n, OVER_ODD),
    odd: OVER_ODD,
    be_pct: OVER_BE,
  };
}

function killsProfile(rows) {
  const kills = rows.map((r) => r.total_kills);
  return {
    n: rows.length,
    mean: fmt1(mean(kills)),
    median: median(kills),
    stdev: fmt1(stdev(kills)),
    pct_over_27_5: fmt1((100 * kills.filter((k) => k > 27.5).length) / (kills.length || 1)),
    pct_gte_30: fmt1((100 * kills.filter((k) => k >= 30).length) / (kills.length || 1)),
    pct_over_30_5: fmt1((100 * kills.filter((k) => k > 30.5).length) / (kills.length || 1)),
  };
}

function brtHour(iso) {
  const d = new Date(iso);
  return (d.getUTCHours() + 24 + BRT_OFFSET_H) % 24;
}
function brtHourDecimal(iso) {
  const d = new Date(iso);
  return ((d.getUTCHours() + 24 + BRT_OFFSET_H) % 24) + d.getUTCMinutes() / 60;
}
function brtHHMM(iso) {
  const d = new Date(iso);
  const h = (d.getUTCHours() + 24 + BRT_OFFSET_H) % 24;
  return `${String(h).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function brtDow(iso) {
  // dia da semana no fuso BRT (0=dom..6=sáb)
  const d = new Date(new Date(iso).getTime() + BRT_OFFSET_H * 3600 * 1000);
  return d.getUTCDay();
}
const DOW_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function inAfternoonBlock(iso) {
  const h = brtHourDecimal(iso);
  return h >= AFTERNOON_BLOCK.from_h && h < AFTERNOON_BLOCK.to_h;
}

function hourStats(matchDates) {
  const hhmm = {};
  const dow = {};
  let inBlock = 0;
  for (const iso of matchDates) {
    const k = brtHHMM(iso);
    hhmm[k] = (hhmm[k] || 0) + 1;
    const dw = DOW_PT[brtDow(iso)];
    dow[dw] = (dow[dw] || 0) + 1;
    if (inAfternoonBlock(iso)) inBlock++;
  }
  return {
    n_matches: matchDates.length,
    start_times_brt: Object.fromEntries(Object.entries(hhmm).sort((a, b) => b[1] - a[1])),
    dow_brt: dow,
    pct_in_block_12_18_brt: fmt1((100 * inBlock) / (matchDates.length || 1)),
  };
}

// dedupe: universo tem 1 row por MAPA — horário é por MATCH
function uniqueMatchDates(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.match_id, r.date);
  return [...m.values()];
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log(`TCL VIABILITY — leagueId ${TCL_ID} | ${FROM} → 2026-07-30 | fresh=${FRESH}`);
  console.log('='.repeat(70));

  const teamsRaw = await getTeams();
  const teamsMap = new Map();
  for (const t of teamsRaw?.data?.teams || []) teamsMap.set(String(t.id), t.name);

  console.error('\n[1/4] Schedule TCL 2026 (paginado)...');
  const { allEvents, completedInRange, oldestSeen, pagesFetched } = await fetchTclEvents();
  console.error(`  páginas: ${pagesFetched} | eventos totais vistos: ${allEvents.length} | completed no range: ${completedInRange.length} | oldest: ${oldestSeen}`);

  console.error('\n[2/4] eventDetails + windows (cache compartilhado)...');
  const { games, fetchErrors } = await collectTclGames(completedInRange, teamsMap);
  const population = games.filter((g) => !g.suspect && g.total_kills != null);
  console.error(`  games coletados: ${games.length} | população válida: ${population.length} | suspects/erros: ${games.length - population.length} (fetch errors: ${fetchErrors})`);

  console.error('\n[3/4] Fair leave-one-out + análises...');
  const { fairMap, fallbackRefs, totalRefs } = computeFairLOO(population);
  for (const g of population) {
    g.fair = fairMap.get(g.game_id);
    g.delta = fmt1(g.total_kills - g.fair);
    g.period = periodOf(g.date);
  }

  // --- Calibração da fair (TCL full 2026) ---
  const absErr = population.map((g) => Math.abs(g.total_kills - g.fair));
  const calibrationTcl = {
    n: population.length,
    median_abs_error: fmt1(median(absErr)),
    mean_abs_error: fmt1(mean(absErr)),
    pct_within_3: fmt1((100 * absErr.filter((e) => e <= 3).length) / (absErr.length || 1)),
    pct_within_5: fmt1((100 * absErr.filter((e) => e <= 5).length) / (absErr.length || 1)),
    fallback_refs: fallbackRefs,
    fallback_rate_pct: fmt1((100 * fallbackRefs) / (totalRefs || 1)),
    mean_bias: fmt1(mean(population.map((g) => g.total_kills - g.fair))),
  };

  // --- Baseline bloco da tarde (allregions abr→jul, mesma fair LOO por liga) ---
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_ALLREGIONS, 'utf8'));
  const blockCalibration = {};
  const blockProfile = {};
  const blockHours = {};
  const blockRowsByLeague = {};
  for (const [label, lid] of Object.entries(COMPARE_LEAGUES)) {
    const rows = universe
      .filter((g) => g.league_id === lid && !g.suspect && g.total_kills != null)
      .map((g) => ({ ...g, team_blue: normalizeTeam(g.team_blue), team_red: normalizeTeam(g.team_red) }));
    blockRowsByLeague[label] = rows;
    const { fairMap: fm, fallbackRefs: fb, totalRefs: tr } = computeFairLOO(rows);
    const errs = rows.map((g) => Math.abs(g.total_kills - fm.get(g.game_id)));
    blockCalibration[label] = {
      n: rows.length,
      median_abs_error: fmt1(median(errs)),
      mean_abs_error: fmt1(mean(errs)),
      fallback_rate_pct: fmt1((100 * fb) / (tr || 1)),
    };
    blockProfile[label] = killsProfile(rows);
    blockHours[label] = hourStats(uniqueMatchDates(rows));
  }

  // --- Perfil de kills ---
  const tclAprJul = population.filter((g) => g.date.slice(0, 10) >= '2026-04-01');
  const profile = {
    tcl_full_2026: killsProfile(population),
    tcl_jan_mar: killsProfile(population.filter((g) => g.period === 'jan_mar')),
    tcl_apr_jul: killsProfile(tclAprJul), // janela comparável ao bloco (allregions)
    block_apr_jul: blockProfile,
  };

  // --- Under: trigger + células por período ---
  const triggerRows = population.filter((g) => g.trigger_type);
  const byPeriodUnder = {};
  for (const p of ['full_2026', 'jan_mar', 'apr_jun', 'julho']) {
    const rows = p === 'full_2026' ? triggerRows : triggerRows.filter((r) => r.period === p);
    byPeriodUnder[p] = underCells(rows);
  }
  // quebra por tipo de trigger (full 2026) — playbook split 3 trata 2peel ≠ 1peel+flex
  const byTriggerType = {};
  for (const tt of ['2peel', '1peel+flex']) {
    byTriggerType[tt] = underCells(triggerRows.filter((r) => r.trigger_type === tt));
  }
  const milioTrig = triggerRows.filter((r) => norm(r.sup_blue) === 'milio' || norm(r.sup_red) === 'milio');
  byTriggerType.milio_in_game = underCells(milioTrig);

  // frequência do trigger por mês + avg kills (leitura de patch)
  const months = [...new Set(population.map((g) => g.month))].sort();
  const triggerByMonth = months.map((m) => {
    const maps = population.filter((g) => g.month === m);
    const trig = maps.filter((g) => g.trigger_type);
    return {
      month: m,
      maps: maps.length,
      triggers: trig.length,
      trigger_rate_pct: fmt1((100 * trig.length) / (maps.length || 1)),
      two_peel: trig.filter((g) => g.trigger_type === '2peel').length,
      one_peel_flex: trig.filter((g) => g.trigger_type === '1peel+flex').length,
      avg_kills: fmt1(mean(maps.map((g) => g.total_kills))),
      under_fair_plus1_hit: trig.length
        ? `${trig.filter((g) => g.total_kills < g.fair + 1).length}/${trig.length}`
        : null,
    };
  });

  // --- Over janela Camille ---
  const camilleRows = population.filter((g) => norm(g.sup_blue) === 'camille' || norm(g.sup_red) === 'camille');
  const byPeriodOver = {};
  for (const p of ['full_2026', 'jan_mar', 'apr_jun', 'julho']) {
    const rows = p === 'full_2026' ? camilleRows : camilleRows.filter((r) => r.period === p);
    byPeriodOver[p] = overCells(rows);
  }
  const camilleByMonth = months.map((m) => {
    const maps = population.filter((g) => g.month === m);
    const cam = camilleRows.filter((g) => g.month === m);
    return { month: m, maps: maps.length, camille_sup_maps: cam.length, share_pct: fmt1((100 * cam.length) / (maps.length || 1)) };
  });

  // --- Horários BRT + volume + calendário futuro ---
  const completed2026 = allEvents.filter((e) => e.state === 'completed' && e.startTime.slice(0, 10) >= FROM && e.startTime.slice(0, 10) < TO);
  const upcoming = allEvents.filter((e) => e.state === 'unstarted').sort((a, b) => a.startTime.localeCompare(b.startTime));
  const tclHours = hourStats(completed2026.map((e) => e.startTime));
  // matches por semana ISO (todas as semanas com jogo)
  const weekOf = (iso) => {
    const d = new Date(iso);
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d.getTime() - day * 86400000);
    return monday.toISOString().slice(0, 10);
  };
  const weekCount = {};
  for (const e of completed2026) {
    const w = weekOf(e.startTime);
    weekCount[w] = (weekCount[w] || 0) + 1;
  }
  const weeks = Object.entries(weekCount).sort((a, b) => a[0].localeCompare(b[0]));
  const lastCompleted = completed2026.map((e) => e.startTime).sort().slice(-1)[0] || null;
  const blocksSeen = {};
  for (const e of allEvents) {
    const key = `${e.blockName || '?'} (${e.state})`;
    blocksSeen[key] = (blocksSeen[key] || 0) + 1;
  }
  const scheduleAnalysis = {
    completed_matches_2026: completed2026.length,
    last_completed_startTime: lastCompleted,
    tcl_hours: tclHours,
    block_hours: blockHours,
    afternoon_block_def: `[${AFTERNOON_BLOCK.from_h}:00, ${AFTERNOON_BLOCK.to_h}:00) BRT`,
    matches_per_week: weeks.map(([w, c]) => ({ week_monday: w, matches: c })),
    upcoming_total: upcoming.length,
    upcoming_next10: upcoming.slice(0, 10).map((e) => ({
      startTime: e.startTime,
      brt: brtHHMM(e.startTime),
      dow_brt: DOW_PT[brtDow(e.startTime)],
      teams: e.teams,
      block: e.blockName,
      bo: e.strategy,
    })),
    blocks_seen: blocksSeen,
  };

  // --- Liquidez Polymarket (29-polymarket-volume-2026.json) ---
  let liquidity = null;
  try {
    const pm = JSON.parse(fs.readFileSync(POLYMARKET_VOLUME, 'utf8'));
    const lt = pm.league_totals_2026 || {};
    const pick = (k) => {
      const v = lt[k];
      if (!v) return null;
      return { events: v.events, volume_total_usd: v.volume_total_usd, volume_per_event_usd: Math.round(v.volume_total_usd / (v.events || 1)) };
    };
    liquidity = {
      source: '29-polymarket-volume-2026.json (gamma-api, 2026-01-01→2026-07-25)',
      TCL: pick('TCL'),
      LES: pick('LES'),
      Prime: pick('PRM'),
      LFL: pick('LFL'),
    };
  } catch (e) {
    liquidity = { error: e.message };
  }

  // --- Vereditos (critérios do relatório de expansão 2026-07-21) ---
  const fullU = byPeriodUnder.full_2026;
  const julU = byPeriodUnder.julho;
  const underCandidate =
    fullU.fair_plus_1.hit_pct != null &&
    fullU.fair_plus_1.hit_pct >= RUNGS.fair_plus_1.be &&
    fullU.n >= CANDIDATE_MIN_N &&
    fullU.fair_plus_1.wilson_ci_95.lower >= CANDIDATE_CI_LOWER_MIN;
  const stressFloorPass = fullU.fair.roi_stress_floor_pct != null && fullU.fair.roi_stress_floor_pct > 0;
  const realisticLadderPass =
    fullU.fair.roi_realistic_pct != null && fullU.fair.roi_realistic_pct > 0 &&
    fullU.fair_minus_1.roi_realistic_pct != null && fullU.fair_minus_1.roi_realistic_pct > 0;
  const verdicts = {
    under: {
      criteria: {
        candidate_mining: {
          rule: `hit fair+1 ≥ ${RUNGS.fair_plus_1.be}%, n ≥ ${CANDIDATE_MIN_N}, CI_inferior ≥ ${CANDIDATE_CI_LOWER_MIN}%`,
          n: fullU.n,
          hit: fullU.fair_plus_1.hit_pct,
          ci_lower: fullU.fair_plus_1.wilson_ci_95.lower,
          pass: underCandidate,
        },
        stress_floor: { rule: 'ROI > 0 na fair com odd travada 1.72 (piso conservador)', roi: fullU.fair.roi_stress_floor_pct, pass: stressFloorPass },
        realistic_ladder: { rule: 'ROI > 0 na fair @1.83 E na fair−1 @1.95 (escada real)', roi_fair: fullU.fair.roi_realistic_pct, roi_fair_minus_1: fullU.fair_minus_1.roi_realistic_pct, pass: realisticLadderPass },
        july_consistency: { n_julho: julU.n, hit_fair_plus_1_julho: julU.fair_plus_1.hit_pct, small_sample: julU.n < MIN_CELL_N },
      },
    },
    over_camille: {
      n_full: byPeriodOver.full_2026.n,
      n_julho: byPeriodOver.julho.n,
      hit_full: byPeriodOver.full_2026.hit_pct,
      ci_full: byPeriodOver.full_2026.wilson_ci_95,
      be: OVER_BE,
      insufficient_data: byPeriodOver.full_2026.n < MIN_CELL_N,
      pooled_window_baseline: { n: 113, hit_pct: 67.3, note: 'baseline global da janela Camille (20-camille-context.json), todas as ligas' },
    },
    schedule_fit: {
      claim_ceo: 'TCL é no mesmo horário de outras ligas que eu faço (bloco da tarde)',
      tcl_pct_in_block_12_18_brt: tclHours.pct_in_block_12_18_brt,
      block_pcts: Object.fromEntries(Object.entries(blockHours).map(([k, v]) => [k, v.pct_in_block_12_18_brt])),
      upcoming_matches: upcoming.length,
      last_completed: lastCompleted,
    },
  };

  // ==========================================================================
  // STDOUT
  // ==========================================================================
  console.log(`\n## Perfil de kills — TCL vs bloco da tarde (mapas válidos)\n`);
  console.log('| universo | n | média | mediana | desvio | >27.5 | ≥30 | >30.5 |');
  console.log('|---|---|---|---|---|---|---|---|');
  const profRows = [
    ['TCL 2026 completo', profile.tcl_full_2026],
    ['TCL jan–mar (winter)', profile.tcl_jan_mar],
    ['TCL abr–jul', profile.tcl_apr_jul],
    ...Object.entries(profile.block_apr_jul).map(([k, v]) => [`${k} abr–jul`, v]),
  ];
  for (const [name, p] of profRows) {
    console.log(`| ${name} | ${p.n} | ${p.mean} | ${p.median} | ${p.stdev} | ${p.pct_over_27_5}% | ${p.pct_gte_30}% | ${p.pct_over_30_5}% |`);
  }

  console.log(`\n## Calibração fair LOO — mediana |kills − fair|\n`);
  console.log('| liga | n | mediana abs err | média abs err | fallback% |');
  console.log('|---|---|---|---|---|');
  console.log(`| TCL (full 2026) | ${calibrationTcl.n} | ${calibrationTcl.median_abs_error} | ${calibrationTcl.mean_abs_error} | ${calibrationTcl.fallback_rate_pct}% |`);
  for (const [label, c] of Object.entries(blockCalibration)) {
    console.log(`| ${label} (abr–jul) | ${c.n} | ${c.median_abs_error} | ${c.mean_abs_error} | ${c.fallback_rate_pct}% |`);
  }

  console.log(`\n## Under — trigger peel na TCL, por período\n`);
  console.log('| período | n | hit fair (@1.83, BE 54.6) | CI | ROI | hit fair+1 (@1.72, BE 58.1) | CI | ROI |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [p, c] of Object.entries(byPeriodUnder)) {
    const f = c.fair, f1 = c.fair_plus_1;
    console.log(`| ${p} | ${c.n} | ${f.hit_pct ?? '-'}% | [${f.wilson_ci_95.lower ?? '-'},${f.wilson_ci_95.upper ?? '-'}] | ${f.roi_realistic_pct ?? '-'}% | ${f1.hit_pct ?? '-'}% | [${f1.wilson_ci_95.lower ?? '-'},${f1.wilson_ci_95.upper ?? '-'}] | ${f1.roi_realistic_pct ?? '-'}% |`);
  }
  console.log(`\n### Por tipo de trigger (full 2026)\n`);
  console.log('| tipo | n | hit fair+1 | CI | ROI @1.72 |');
  console.log('|---|---|---|---|---|');
  for (const [tt, c] of Object.entries(byTriggerType)) {
    const f1 = c.fair_plus_1;
    console.log(`| ${tt} | ${c.n} | ${f1?.hit_pct ?? '-'}% | [${f1?.wilson_ci_95.lower ?? '-'},${f1?.wilson_ci_95.upper ?? '-'}] | ${f1?.roi_realistic_pct ?? '-'}% |`);
  }
  console.log(`\n### Frequência do trigger + kills por mês\n`);
  console.log('| mês | mapas | triggers | taxa | 2peel | 1peel+flex | avg kills | under fair+1 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const t of triggerByMonth) console.log(`| ${t.month} | ${t.maps} | ${t.triggers} | ${t.trigger_rate_pct}% | ${t.two_peel} | ${t.one_peel_flex} | ${t.avg_kills} | ${t.under_fair_plus1_hit ?? '-'} |`);

  console.log(`\n## Over — janela Camille sup na TCL\n`);
  console.log('| período | n | hit @fair (BE 55.6) | CI | ROI @1.80 |');
  console.log('|---|---|---|---|---|');
  for (const [p, c] of Object.entries(byPeriodOver)) {
    console.log(`| ${p} | ${c.n} | ${c.hit_pct ?? '-'}% | [${c.wilson_ci_95.lower ?? '-'},${c.wilson_ci_95.upper ?? '-'}] | ${c.roi_pct ?? '-'}% |`);
  }
  console.log(`\n### Presença da Camille sup por mês\n`);
  console.log('| mês | mapas | Camille sup | share |');
  console.log('|---|---|---|---|');
  for (const c of camilleByMonth) console.log(`| ${c.month} | ${c.maps} | ${c.camille_sup_maps} | ${c.share_pct}% |`);

  console.log(`\n## Horários (BRT), encaixe no bloco da tarde e volume\n`);
  console.log(`TCL matches completed 2026: ${scheduleAnalysis.completed_matches_2026} | último completed: ${lastCompleted}`);
  console.log(`Horários de início TCL (BRT): ${JSON.stringify(tclHours.start_times_brt)}`);
  console.log(`Dias da semana TCL (BRT): ${JSON.stringify(tclHours.dow_brt)}`);
  console.log(`TCL no bloco 12–18h BRT: ${tclHours.pct_in_block_12_18_brt}%`);
  for (const [label, h] of Object.entries(blockHours)) {
    console.log(`${label}: bloco ${h.pct_in_block_12_18_brt}% | inícios ${JSON.stringify(h.start_times_brt)} | dias ${JSON.stringify(h.dow_brt)}`);
  }
  console.log(`Matches/semana TCL: ${scheduleAnalysis.matches_per_week.map((w) => `${w.week_monday}:${w.matches}`).join(' | ')}`);
  console.log(`Upcoming (unstarted): ${upcoming.length}`);
  for (const u of scheduleAnalysis.upcoming_next10) console.log(`  ${u.startTime} (${u.dow_brt} ${u.brt} BRT) ${u.teams.join(' x ')} [${u.block}] BO${u.bo}`);
  console.log(`Blocos vistos no schedule: ${JSON.stringify(blocksSeen)}`);

  console.log(`\n## Liquidez Polymarket 2026\n`);
  console.log(JSON.stringify(liquidity, null, 2));

  console.log(`\n## Vereditos (critérios do relatório de expansão 2026-07-21)\n`);
  console.log(JSON.stringify(verdicts, null, 2));

  // ==========================================================================
  // OUTPUT JSON
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      league_id: TCL_ID, from: FROM, to_exclusive: TO, fresh: FRESH,
      rungs: RUNGS, stress_floor_odd: STRESS_FLOOR_ODD, over_odd: OVER_ODD, over_be_pct: OVER_BE,
      fair_fallback_min_n: FALLBACK_MIN_N, candidate_min_n: CANDIDATE_MIN_N,
      candidate_ci_lower_min: CANDIDATE_CI_LOWER_MIN, min_cell_n: MIN_CELL_N,
      afternoon_block: AFTERNOON_BLOCK,
      compare_leagues: COMPARE_LEAGUES,
      methodology_sync: ['lcp-viability.cjs', 'multi-league-mining.cjs', 'under-stress-line.cjs', 'camille-sweep.cjs', 'les-update.cjs'],
    },
    meta: {
      schedule_pages: pagesFetched, events_seen: allEvents.length, oldest_date_seen: oldestSeen,
      matches_completed_in_range: completedInRange.length, games_collected: games.length,
      population_n: population.length, excluded_suspect_or_null: games.length - population.length,
      fetch_errors: fetchErrors,
    },
    profile,
    fair_calibration: { tcl: calibrationTcl, block_apr_jul: blockCalibration },
    under: { by_period: byPeriodUnder, by_trigger_type: byTriggerType, trigger_by_month: triggerByMonth },
    over_camille: { by_period: byPeriodOver, camille_by_month: camilleByMonth },
    schedule: scheduleAnalysis,
    liquidity_polymarket: liquidity,
    verdicts,
    population_rows: population.map((g) => ({
      game_id: g.game_id, match_id: g.match_id, date: g.date, map_number: g.map_number,
      team_blue: g.team_blue, team_red: g.team_red, total_kills: g.total_kills,
      sup_blue: g.sup_blue, sup_red: g.sup_red, trigger_type: g.trigger_type,
      fair: g.fair, delta: g.delta, period: g.period, block: g.block,
    })),
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
