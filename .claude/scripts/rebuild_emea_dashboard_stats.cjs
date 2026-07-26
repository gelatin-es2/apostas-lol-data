// EMEA Masters ecosystem — dashboard stats rebuild
// Cobre EMEA Masters + 12 ligas regionais europeias / MENA
// Output: cron-data/emea_dashboard_stats.json
//
// FÓRMULA FAIR: canônica do método principal (rebuild_dashboard_stats_cron.cjs:288-302)
//   blueAvg + redAvg = total_kills do match (leave-one-out)
//   fairFormula = Math.round((blueAvg + redAvg) / 2 - 0.5) + 0.5
//   FAIR_ADJUSTMENT = 0 (NÃO usa o -1 do tier-2 antigo)
//   Fallback team: se n-1 < 5 usa média da liga (também em total_kills/2)
//   Fallback final: 29.5
//
// TRIGGER: igual tier-1 (PEEL / FLEX do método principal)
// NÃO modifica nenhum script/arquivo existente.

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../..');

// ─── Constantes ────────────────────────────────────────────────────────────────

const LOLES       = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SPLIT2_START = '2026-04-01';
const STAKE        = 100;
const ODD          = 1.85;
const FALLBACK_LINE = 29.5;
const MIN_SAMPLE_TEAM = 5;   // n-1 mínimo p/ usar avg do time; abaixo usa avg da liga
const FAIR_ADJUSTMENT = 0;   // canônico método principal; NÃO usar -1

// Trigger — idêntico ao tier-1 canônico
const PEEL = ['Soraka','Sona','Janna','Lulu','Yuumi','Karma','Seraphine','Renata','RenataGlasc','Nami','Milio'];
const FLEX = ['Bard','Rakan','Lux','Anivia'];

// 13 ligas do ecossistema EMEA Masters
const LEAGUES = [
  { id: '100695891328981122', name: 'EMEA Masters'     },
  { id: '105266103462388553', name: 'LFL'               },
  { id: '105266098308571975', name: 'NLC'               },
  { id: '105266091639104326', name: 'Prime League'      },
  { id: '105266074488398661', name: 'LES'               },
  { id: '105266106309666619', name: 'Hitpoint Masters'  },
  { id: '105266094998946936', name: 'LIT'               },
  { id: '105266101075764040', name: 'Liga Portuguesa'   },
  { id: '113673877956508505', name: 'Rift Legends'      },
  { id: '105266111679554379', name: 'Esports Balkan'    },
  { id: '105266108767593290', name: 'Hellenic Legends'  },
  { id: '109545772895506419', name: 'Arabian League'    },
  { id: '107407335299756365', name: 'Road of Legends'   },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJsonSafe(host, p_, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      host,
      path: p_,
      headers: {
        'x-api-key': LOLES,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
        ...headers,
      },
    };
    https.get(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          // Bigint fix: IDs de 15+ dígitos viram string p/ evitar precisão perdida
          const fixed = body.replace(
            /"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g,
            '"$1":"$2"'
          );
          resolve(JSON.parse(fixed));
        } catch (e) { reject(new Error(`JSON parse error: ${e.message} (host=${host} path=${p_})`)); }
      });
    }).on('error', reject);
  });
}

// ─── Teams map ─────────────────────────────────────────────────────────────────

async function fetchTeamsMap() {
  const r = await fetchJsonSafe('esports-api.lolesports.com', '/persisted/gw/getTeams?hl=en-US', {});
  const map = new Map();
  for (const t of (r.data?.teams || [])) map.set(t.id, t.name);
  return map;
}

// ─── Schedule por liga ─────────────────────────────────────────────────────────

async function fetchMatchesForLeague(lg) {
  const out = [];
  let pageToken = null;
  // EMEA tem mais páginas; limite conservador de 10 páginas
  for (let pi = 0; pi < 10; pi++) {
    const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${lg.id}` +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    let r;
    try {
      r = await fetchJsonSafe('esports-api.lolesports.com', url, {});
    } catch (e) {
      console.error(`  [schedule] ${lg.name} page ${pi} err: ${e.message}`);
      break;
    }
    const events = r.data?.schedule?.events || [];
    let oldestDate = '9999-12-31';
    for (const e of events) {
      if (!e.match?.id || !e.startTime) continue;
      const date = e.startTime.slice(0, 10);
      if (date < oldestDate) oldestDate = date;
      if (e.state === 'completed' && date >= SPLIT2_START) {
        out.push({
          lg: lg.name,
          matchId: e.match.id,
          date,
          teams: (e.match.teams || []).map(t => ({ id: t.id, name: t.name, code: t.code })),
        });
      }
    }
    if (!r.data?.schedule?.pages?.older) break;
    if (oldestDate < SPLIT2_START) break;
    pageToken = r.data.schedule.pages.older;
    await sleep(60);
  }
  return out;
}

async function fetchAllMatches() {
  const out = [];
  for (const lg of LEAGUES) {
    const matches = await fetchMatchesForLeague(lg);
    console.error(`  ${lg.name}: ${matches.length} matches`);
    out.push(...matches);
    await sleep(60);
  }
  return out;
}

// ─── Game metadata via livestats ───────────────────────────────────────────────

function nowMinus60TS() {
  const d = new Date(Date.now() - 60000);
  d.setSeconds(d.getSeconds() - (d.getSeconds() % 10));
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.000Z$/, 'Z');
}

async function fetchGameMeta(gameId) {
  try {
    const ts = nowMinus60TS();
    const r = await fetchJsonSafe(
      'feed.lolesports.com',
      `/livestats/v1/window/${gameId}?startingTime=${ts}`,
      {}
    );
    if (!r.gameMetadata || !r.frames?.length) return null;
    const blueMeta = r.gameMetadata.blueTeamMetadata;
    const redMeta  = r.gameMetadata.redTeamMetadata;
    const lastFrame = r.frames[r.frames.length - 1];
    const kBlue = lastFrame.blueTeam?.totalKills ?? 0;
    const kRed  = lastFrame.redTeam?.totalKills  ?? 0;
    const picks = (md) => {
      const p = md.participantMetadata;
      const get = (role) => p.find(x => x.role === role)?.championId || null;
      return { top: get('top'), jungle: get('jungle'), mid: get('mid'), adc: get('bottom'), support: get('support') };
    };
    const blueInh   = lastFrame.blueTeam?.inhibitors ?? 0;
    const redInh    = lastFrame.redTeam?.inhibitors  ?? 0;
    const blueTowers = lastFrame.blueTeam?.towers ?? 0;
    const redTowers  = lastFrame.redTeam?.towers  ?? 0;
    let winnerSide = null;
    if (blueInh !== redInh)       winnerSide = blueInh   > redInh   ? 'blue' : 'red';
    else if (blueTowers !== redTowers) winnerSide = blueTowers > redTowers ? 'blue' : 'red';
    return {
      blueTeamId: blueMeta.esportsTeamId,
      redTeamId:  redMeta.esportsTeamId,
      bluePicks:  picks(blueMeta),
      redPicks:   picks(redMeta),
      kills: kBlue + kRed,
      kBlue, kRed,
      winnerSide,
    };
  } catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.error('[1/5] teams map...');
  const teamsMap = await fetchTeamsMap();
  console.error(`  ${teamsMap.size} teams loaded`);

  console.error('[2/5] matches EMEA ecosystem...');
  const matches = await fetchAllMatches();
  console.error(`  TOTAL: ${matches.length} matches completed >= ${SPLIT2_START}`);

  console.error('[3/5] games per match (livestats)...');
  const games = [];
  let mIdx = 0;
  let skippedNoLivestats = 0;
  let skippedNotCompleted = 0;
  for (const m of matches) {
    mIdx++;
    if (mIdx % 50 === 0) console.error(`  match ${mIdx}/${matches.length} | games: ${games.length}`);
    let det;
    try {
      det = await fetchJsonSafe(
        'esports-api.lolesports.com',
        `/persisted/gw/getEventDetails?hl=en-US&id=${m.matchId}`,
        {}
      );
    } catch (e) {
      console.error(`  match ${m.matchId} (${m.lg}) getEventDetails err: ${e.message}`);
      await sleep(100);
      continue;
    }
    for (const g of (det.data?.event?.match?.games || [])) {
      if (g.state !== 'completed') { skippedNotCompleted++; continue; }
      await sleep(50 + Math.random() * 30); // 50-80ms entre chamadas livestats
      const meta = await fetchGameMeta(g.id);
      if (!meta) { skippedNoLivestats++; continue; }
      games.push({
        ...meta,
        lg: m.lg,
        matchId: m.matchId,
        gameId: g.id,
        mapNum: g.number,
        date: m.date,
      });
    }
    await sleep(50);
  }
  console.error(`  ${games.length} games fetched | sem-livestats: ${skippedNoLivestats} | not-completed: ${skippedNotCompleted}`);

  // ─── Fair line por game (fórmula canônica tier-1) ────────────────────────────

  console.error('[4/5] computing fair lines...');

  // Acumular total_kills do match por time (igual tier-1 — NÃO kBlue/kRed separados)
  const teamKillsList  = new Map(); // team_name → [totalKills, ...]
  const leagueKillsList = new Map(); // liga → [totalKills, ...] (todos os games da liga)

  function teamNameFromId(tid) {
    return teamsMap.get(tid) || tid;
  }

  for (const g of games) {
    const blueName = teamNameFromId(g.blueTeamId);
    const redName  = teamNameFromId(g.redTeamId);
    const total    = g.kBlue + g.kRed;
    if (!teamKillsList.has(blueName)) teamKillsList.set(blueName, []);
    if (!teamKillsList.has(redName))  teamKillsList.set(redName, []);
    teamKillsList.get(blueName).push(total);
    teamKillsList.get(redName).push(total);
    if (!leagueKillsList.has(g.lg)) leagueKillsList.set(g.lg, []);
    leagueKillsList.get(g.lg).push(total);
  }

  // Média da liga em total_kills (para fallback quando n-1 < MIN_SAMPLE_TEAM)
  const leagueAvgTotal = new Map();
  for (const [l, arr] of leagueKillsList) {
    leagueAvgTotal.set(l, arr.reduce((a, b) => a + b, 0) / arr.length);
  }

  // Fallback global para ligas com 0 games (não deve acontecer, mas defensivo)
  const globalAvgTotal = (() => {
    const all = [...leagueKillsList.values()].flat();
    return all.length ? all.reduce((a, b) => a + b, 0) / all.length : FALLBACK_LINE * 2;
  })();

  const sourceTally = {};

  function fairForGame(g) {
    const blueName = teamNameFromId(g.blueTeamId);
    const redName  = teamNameFromId(g.redTeamId);
    const blueArr  = teamKillsList.get(blueName) || [];
    const redArr   = teamKillsList.get(redName)  || [];
    const total    = g.kBlue + g.kRed;

    // Leave-one-out: exclui o próprio game do cálculo (evita data leakage)
    // Igual tier-1: blueArr[i] = total_kills do match, então excluímos "total" de ambos os arrays
    const blueAvgEx = blueArr.length > 1
      ? (blueArr.reduce((a, b) => a + b, 0) - total) / (blueArr.length - 1)
      : null;
    const redAvgEx = redArr.length > 1
      ? (redArr.reduce((a, b) => a + b, 0) - total) / (redArr.length - 1)
      : null;

    const lAvgTotal = leagueAvgTotal.get(g.lg) ?? globalAvgTotal;

    // Se n-1 >= MIN_SAMPLE_TEAM usa média do time, senão usa média da liga
    const blueAvg = (blueArr.length - 1 >= MIN_SAMPLE_TEAM) ? blueAvgEx : lAvgTotal;
    const redAvg  = (redArr.length  - 1 >= MIN_SAMPLE_TEAM) ? redAvgEx  : lAvgTotal;

    if (blueAvg == null || redAvg == null) {
      sourceTally['fallback_29.5'] = (sourceTally['fallback_29.5'] || 0) + 1;
      return { line: FALLBACK_LINE, source: 'fallback_29.5' };
    }

    // Fórmula canônica: (blueAvg + redAvg) / 2 arredondado pro .5 mais próximo
    // blueAvg e redAvg já são totais do match (não por lado), então a média deles é o total esperado
    const raw = (blueAvg + redAvg) / 2 + FAIR_ADJUSTMENT;
    const fairFormula = Math.round(raw - 0.5) + 0.5;

    const src = 'livestats_team_avg(total+total)/2';
    sourceTally[src] = (sourceTally[src] || 0) + 1;
    return { line: fairFormula, source: src };
  }

  for (const g of games) {
    const f = fairForGame(g);
    g.line      = f.line;
    g.fairSource = f.source;
  }
  console.error('  fair sources:', JSON.stringify(sourceTally));

  // ─── Trigger detection ───────────────────────────────────────────────────────

  console.error('[5/5] computing stats...');

  const peel2 = games.filter(g =>
    PEEL.includes(g.bluePicks.support) && PEEL.includes(g.redPicks.support)
  );
  const peel1Flex = games.filter(g => {
    const sB = g.bluePicks.support, sR = g.redPicks.support;
    if (PEEL.includes(sB) && PEEL.includes(sR)) return false;
    const bluePeel = PEEL.includes(sB), redPeel = PEEL.includes(sR);
    const blueFlex = FLEX.includes(sB), redFlex = FLEX.includes(sR);
    return (bluePeel && redFlex) || (redPeel && blueFlex);
  });
  const allTriggers = [...peel2, ...peel1Flex];
  console.error(`  triggers: 2peel=${peel2.length} | 1peel+flex=${peel1Flex.length} | all=${allTriggers.length}`);

  // ─── Agregação de stats ──────────────────────────────────────────────────────

  function computeStats(subset) {
    let green = 0, red = 0;
    for (const g of subset) { if (g.kills < g.line) green++; else red++; }
    const profit = green * STAKE * (ODD - 1) - red * STAKE;
    const backtest = {
      n:         subset.length,
      hit:       subset.length ? +(100 * green / subset.length).toFixed(1) : 0,
      profit:    +profit.toFixed(2),
      roi:       subset.length ? +(100 * profit / (subset.length * STAKE)).toFixed(1) : 0,
      breakeven: +(100 / ODD).toFixed(1),
    };

    // LIGAS — colore n≥10; hit classifica verde/branco/vermelho
    const ligaAgg = {};
    for (const g of subset) {
      if (!ligaAgg[g.lg]) ligaAgg[g.lg] = { n: 0, h: 0 };
      ligaAgg[g.lg].n++;
      if (g.kills < g.line) ligaAgg[g.lg].h++;
    }
    const ligas = Object.entries(ligaAgg)
      .map(([name, s]) => ({
        name,
        n:    s.n,
        hit:  +(100 * s.h / s.n).toFixed(1),
        // classificação: só aplica cor com n≥10
        color: s.n >= 10
          ? (100 * s.h / s.n >= 60 ? 'green' : 100 * s.h / s.n >= 50 ? 'white' : 'red')
          : 'gray',
      }))
      .sort((a, b) => b.hit - a.hit);

    // SUPPORTS
    const supAgg = {};
    for (const g of subset) {
      for (const s of [g.bluePicks.support, g.redPicks.support]) {
        if (!PEEL.includes(s) && !FLEX.includes(s)) continue;
        if (!supAgg[s]) supAgg[s] = { n: 0, h: 0 };
        supAgg[s].n++;
        if (g.kills < g.line) supAgg[s].h++;
      }
    }
    const supports = Object.entries(supAgg)
      .filter(([, s]) => s.n >= 3)
      .map(([name, s]) => ({ name, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) }))
      .sort((a, b) => b.hit - a.hit);

    // TIMES — colore n≥4; small_sample: true se n<4
    const teamAgg = {};
    for (const g of subset) {
      for (const tid of [g.blueTeamId, g.redTeamId]) {
        const tname = teamNameFromId(tid);
        if (!teamAgg[tname]) teamAgg[tname] = { n: 0, h: 0, lg: g.lg };
        teamAgg[tname].n++;
        if (g.kills < g.line) teamAgg[tname].h++;
      }
    }
    const teams = Object.entries(teamAgg)
      .map(([name, s]) => ({
        name,
        lg:          s.lg,
        n:           s.n,
        hit:         +(100 * s.h / s.n).toFixed(1),
        small_sample: s.n < 4,
        color: s.n >= 4
          ? (100 * s.h / s.n >= 60 ? 'green' : 100 * s.h / s.n >= 50 ? 'white' : 'red')
          : 'gray',
      }))
      .sort((a, b) => b.hit - a.hit);

    // CHAMPS
    const champAgg = {};
    for (const g of subset) {
      for (const picks of [g.bluePicks, g.redPicks]) {
        for (const role of ['top','jungle','mid','adc']) {
          const champ = picks[role];
          if (!champ) continue;
          const key = `${champ}|${role}`;
          if (!champAgg[key]) champAgg[key] = { champ, role, n: 0, h: 0 };
          champAgg[key].n++;
          if (g.kills < g.line) champAgg[key].h++;
        }
      }
    }
    const champs = Object.values(champAgg)
      .filter(c => c.n >= 6)
      .map(c => ({ champ: c.champ, role: c.role, n: c.n, hit: +(100 * c.h / c.n).toFixed(1) }))
      .sort((a, b) => b.hit - a.hit);

    return { backtest, ligas, supports, teams, champs };
  }

  const stats2peel    = computeStats(peel2);
  const stats1PeelFlex = computeStats(peel1Flex);
  const statsAll      = computeStats(allTriggers);

  // ─── Agregação "all maps" por time (todos os games, sem filtro de trigger) ────
  // Conta n_all e under_all pra cada time sobre o dataset completo.
  // Cada game contribui pros DOIS times (blue + red), igual o teamAgg triggered.

  const allMapsAgg = {}; // tname → { n: 0, under: 0, lg: '...' }
  for (const g of games) {
    for (const tid of [g.blueTeamId, g.redTeamId]) {
      const tname = teamNameFromId(tid);
      if (!allMapsAgg[tname]) allMapsAgg[tname] = { n: 0, under: 0, lg: g.lg };
      allMapsAgg[tname].n++;
      if (g.kills < g.line) allMapsAgg[tname].under++;
    }
  }

  // Injeta n_all / under_all / under_all_pct em cada objeto de team (por trigger)
  for (const statsObj of [stats2peel, stats1PeelFlex, statsAll]) {
    for (const t of statsObj.teams) {
      const agg = allMapsAgg[t.name];
      if (agg) {
        t.n_all          = agg.n;
        t.under_all      = agg.under;
        t.under_all_pct  = agg.n > 0 ? +(100 * agg.under / agg.n).toFixed(1) : 0;
      } else {
        t.n_all = 0; t.under_all = 0; t.under_all_pct = 0;
      }
    }
  }

  // Ranking de tendência Under sobre todos os mapas (n_all >= 10 pra cor válida)
  const teams_under_tendency = Object.entries(allMapsAgg)
    .map(([name, s]) => ({
      name,
      lg:             s.lg,
      n_all:          s.n,
      under_all:      s.under,
      under_all_pct:  s.n > 0 ? +(100 * s.under / s.n).toFixed(1) : 0,
      small_sample:   s.n < 10,
    }))
    .sort((a, b) => b.under_all_pct - a.under_all_pct);

  // ─── Sanity: range de datas ──────────────────────────────────────────────────

  const dates = games.map(g => g.date).sort();
  const range = dates.length
    ? { from: dates[0], to: dates[dates.length - 1] }
    : { from: null, to: null };

  // Distribuição de ligas no total de games
  const leagueGameCount = {};
  for (const g of games) leagueGameCount[g.lg] = (leagueGameCount[g.lg] || 0) + 1;

  // ─── Output ──────────────────────────────────────────────────────────────────

  const out = {
    generated_at:    new Date().toISOString(),
    split_start:     SPLIT2_START,
    range,
    total_games:     games.length,
    total_matches:   matches.length,
    games_per_league: leagueGameCount,
    leagues_covered: LEAGUES.map(l => l.name),
    fair_method:     'livestats_team_avg(total+total)/2, FAIR_ADJUSTMENT=0, fallback 29.5',
    stake:           STAKE,
    odd:             ODD,
    line_sources:    sourceTally,
    // Top-level = 2peel (compatível com padrão do dashboard)
    backtest:        stats2peel.backtest,
    ligas:           stats2peel.ligas,
    supports:        stats2peel.supports,
    teams:           stats2peel.teams,
    champs:          stats2peel.champs,
    // Granular por trigger
    by_trigger: {
      '2peel':      stats2peel,
      '1peel+flex': stats1PeelFlex,
      all:          statsAll,
    },
    // Tendência Under por time sobre TODOS os mapas do dataset (sem filtro trigger)
    // Campo extra injetado em teams[]: n_all, under_all, under_all_pct
    teams_under_tendency,
  };

  const outDir  = path.join(ROOT, 'cron-data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'emea_dashboard_stats.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`\nWrote: ${outFile}`);

  const bt = stats2peel.backtest;
  console.error(`Backtest 2peel EMEA: n=${bt.n} hit=${bt.hit}% profit=${bt.profit} ROI=${bt.roi}%`);
  console.error(`Backtest 1peel+flex: n=${stats1PeelFlex.backtest.n} hit=${stats1PeelFlex.backtest.hit}% ROI=${stats1PeelFlex.backtest.roi}%`);
  console.error(`Backtest all:        n=${statsAll.backtest.n} hit=${statsAll.backtest.hit}% ROI=${statsAll.backtest.roi}%`);
  console.error('\nLigas 2peel:');
  for (const l of stats2peel.ligas) {
    const flag = l.color === 'green' ? '🟢' : l.color === 'red' ? '🔴' : l.color === 'white' ? '⚪' : '⬜';
    console.error(`  ${flag} ${l.name.padEnd(20)} n=${String(l.n).padStart(3)} hit=${l.hit}%`);
  }
})();
