// Tier 2 EU dashboard rebuild — análoga ao rebuild_dashboard_stats_cron.cjs mas pras 3
// ligas operadas pelo Elvis na tarde: LFL, LES, LIT.
// Output: cron-data/tier2_dashboard_stats.json com mesma estrutura do dashboard major
// (backtest, ligas, supports, teams, champs) + by_trigger (2peel / 1peel+flex / all).

const fs = require('fs');
const path = require('path');
const https = require('https');

// ROOT aponta pra raiz do repositório (sobe 2 níveis de .claude/scripts/)
const ROOT = path.resolve(__dirname, '../..');

const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SPLIT2_START = '2026-04-01';
const PEEL = ['Soraka','Sona','Janna','Lulu','Yuumi','Karma','Seraphine','Renata','RenataGlasc','Nami','Milio'];
const FLEX = ['Bard','Rakan','Alistar'];
const STAKE = 100;
const ODD = 1.85;
const FALLBACK_LINE = 29.5;
const MIN_SAMPLE_TEAM = 5;
const FAIR_ADJUSTMENT = -1;

const LEAGUES = [
  { id: '105266103462388553', name: 'LFL' },
  { id: '105266074488398661', name: 'LES' },
  { id: '105266094998946936', name: 'LIT' },
];

function fetchJsonSafe(host, p_, headers) {
  return new Promise((resolve, reject) => {
    https.get({ host, path: p_, headers }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchTeamsMap() {
  const r = await fetchJsonSafe('esports-api.lolesports.com', '/persisted/gw/getTeams?hl=en-US', { 'x-api-key': LOLES });
  const map = new Map();
  for (const t of r.data.teams) map.set(t.id, t.name);
  return map;
}

async function fetchAllMatches() {
  const out = [];
  for (const lg of LEAGUES) {
    let pageToken = null;
    for (let pi = 0; pi < 5; pi++) {
      const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${lg.id}` + (pageToken ? `&pageToken=${pageToken}` : '');
      let r;
      try { r = await fetchJsonSafe('esports-api.lolesports.com', url, { 'x-api-key': LOLES }); }
      catch (e) { console.error(`  ${lg.name} page ${pi} err: ${e.message}`); break; }
      let oldestDate = '9999-12-31';
      for (const e of (r.data?.schedule?.events || [])) {
        if (!e.match?.id || !e.startTime) continue;
        const date = e.startTime.slice(0, 10);
        if (date < oldestDate) oldestDate = date;
        if (e.state === 'completed' && date >= SPLIT2_START) {
          out.push({ lg: lg.name, matchId: e.match.id, date, teams: (e.match.teams || []).map(t => ({ id: t.id, name: t.name, code: t.code })) });
        }
      }
      if (!r.data?.schedule?.pages?.older) break;
      if (oldestDate < SPLIT2_START) break;
      pageToken = r.data.schedule.pages.older;
    }
  }
  return out;
}

function nowMinus60TS() {
  const d = new Date(Date.now() - 60000);
  d.setSeconds(d.getSeconds() - (d.getSeconds() % 10));
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.000Z$/, 'Z');
}

async function fetchGameMeta(gameId) {
  try {
    const ts = nowMinus60TS();
    const r = await fetchJsonSafe('feed.lolesports.com', `/livestats/v1/window/${gameId}?startingTime=${ts}`, { 'x-api-key': LOLES });
    if (!r.gameMetadata || !r.frames?.length) return null;
    const blueMeta = r.gameMetadata.blueTeamMetadata;
    const redMeta = r.gameMetadata.redTeamMetadata;
    const lastFrame = r.frames[r.frames.length - 1];
    const kBlue = lastFrame.blueTeam?.totalKills || 0;
    const kRed = lastFrame.redTeam?.totalKills || 0;
    const picks = (md) => {
      const p = md.participantMetadata;
      const get = (role) => p.find(x => x.role === role)?.championId || null;
      return { top: get('top'), jungle: get('jungle'), mid: get('mid'), adc: get('bottom'), support: get('support') };
    };
    const blueInh = lastFrame.blueTeam?.inhibitors || 0;
    const redInh = lastFrame.redTeam?.inhibitors || 0;
    let winnerSide = null;
    if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
    return {
      blueTeamId: blueMeta.esportsTeamId, redTeamId: redMeta.esportsTeamId,
      bluePicks: picks(blueMeta), redPicks: picks(redMeta),
      kills: kBlue + kRed, kBlue, kRed, winnerSide,
    };
  } catch { return null; }
}

(async () => {
  console.error('[1/4] teams map...');
  const teamsMap = await fetchTeamsMap();

  console.error('[2/4] matches tier 2...');
  const matches = await fetchAllMatches();
  console.error(`  ${matches.length} matches completed >= ${SPLIT2_START}`);

  console.error('[3/4] games per match...');
  const games = [];
  let mIdx = 0;
  for (const m of matches) {
    mIdx++;
    if (mIdx % 30 === 0) console.error(`  match ${mIdx}/${matches.length}`);
    try {
      const det = await fetchJsonSafe('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${m.matchId}`, { 'x-api-key': LOLES });
      for (const g of (det.data?.event?.match?.games || [])) {
        if (g.state !== 'completed') continue;
        const meta = await fetchGameMeta(g.id);
        if (!meta) continue;
        games.push({ ...meta, lg: m.lg, matchId: m.matchId, gameId: g.id, mapNum: g.number, date: m.date });
      }
    } catch (e) { /* skip */ }
  }
  console.error(`  ${games.length} games fetched`);

  console.error('[4/4] computing fair line per game...');
  const teamKillsList = new Map();
  const leagueKillsList = new Map();
  function teamName(g, side) {
    const tid = side === 'blue' ? g.blueTeamId : g.redTeamId;
    return teamsMap.get(tid) || tid;
  }
  for (const g of games) {
    const blueName = teamName(g, 'blue');
    const redName = teamName(g, 'red');
    if (!teamKillsList.has(blueName)) teamKillsList.set(blueName, []);
    if (!teamKillsList.has(redName))  teamKillsList.set(redName, []);
    teamKillsList.get(blueName).push(g.kBlue);
    teamKillsList.get(redName).push(g.kRed);
    if (!leagueKillsList.has(g.lg)) leagueKillsList.set(g.lg, []);
    leagueKillsList.get(g.lg).push(g.kBlue, g.kRed);
  }
  const leagueAvg = new Map();
  for (const [l, arr] of leagueKillsList) leagueAvg.set(l, arr.reduce((a,b)=>a+b,0)/arr.length);

  function fairForGame(g) {
    const blueArr = teamKillsList.get(teamName(g,'blue')) || [];
    const redArr  = teamKillsList.get(teamName(g,'red')) || [];
    const blueAvgEx = blueArr.length > 1 ? (blueArr.reduce((a,b)=>a+b,0) - g.kBlue) / (blueArr.length - 1) : null;
    const redAvgEx  = redArr.length  > 1 ? (redArr.reduce((a,b)=>a+b,0) - g.kRed) / (redArr.length - 1) : null;
    const lAvg = leagueAvg.get(g.lg) ?? null;
    const blueAvg = (blueArr.length - 1 >= MIN_SAMPLE_TEAM) ? blueAvgEx : lAvg;
    const redAvg  = (redArr.length  - 1 >= MIN_SAMPLE_TEAM) ? redAvgEx  : lAvg;
    if (blueAvg == null || redAvg == null) return { line: FALLBACK_LINE, source: 'fallback_29.5' };
    const adjusted = blueAvg + redAvg + FAIR_ADJUSTMENT;
    const line = Math.round(adjusted - 0.5) + 0.5;
    return { line, source: 'livestats_team_avg(team+team)-1' };
  }
  for (const g of games) { const f = fairForGame(g); g.line = f.line; g.fairSource = f.source; }

  console.error('[5/5] computing stats...');
  const peel2 = games.filter(g => PEEL.includes(g.bluePicks.support) && PEEL.includes(g.redPicks.support));
  const peel1Flex = games.filter(g => {
    const sB = g.bluePicks.support, sR = g.redPicks.support;
    if (PEEL.includes(sB) && PEEL.includes(sR)) return false;
    const bluePeel = PEEL.includes(sB), redPeel = PEEL.includes(sR);
    const blueFlex = FLEX.includes(sB), redFlex = FLEX.includes(sR);
    return (bluePeel && redFlex) || (redPeel && blueFlex);
  });
  const allTriggers = [...peel2, ...peel1Flex];
  console.error(`  triggers: 2peel=${peel2.length} | 1peel+flex=${peel1Flex.length}`);

  function computeStats(subset) {
    let green = 0, red = 0;
    for (const g of subset) { if (g.kills < g.line) green++; else red++; }
    const profit = green * STAKE * (ODD - 1) - red * STAKE;
    const backtest = {
      n: subset.length,
      hit: subset.length ? +(100 * green / subset.length).toFixed(1) : 0,
      profit: +profit.toFixed(2),
      roi: subset.length ? +(100 * profit / (subset.length * STAKE)).toFixed(1) : 0,
      breakeven: +(100 / ODD).toFixed(1),
    };
    const ligaAgg = {};
    for (const g of subset) {
      if (!ligaAgg[g.lg]) ligaAgg[g.lg] = { n: 0, h: 0 };
      ligaAgg[g.lg].n++;
      if (g.kills < g.line) ligaAgg[g.lg].h++;
    }
    const ligas = Object.entries(ligaAgg).map(([name, s]) => ({ name, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    const supAgg = {};
    for (const g of subset) {
      for (const s of [g.bluePicks.support, g.redPicks.support]) {
        if (!PEEL.includes(s) && !FLEX.includes(s)) continue;
        if (!supAgg[s]) supAgg[s] = { n: 0, h: 0 };
        supAgg[s].n++;
        if (g.kills < g.line) supAgg[s].h++;
      }
    }
    const supports = Object.entries(supAgg).filter(([_, s]) => s.n >= 3).map(([name, s]) => ({ name, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    const teamAgg = {};
    for (const g of subset) {
      for (const tid of [g.blueTeamId, g.redTeamId]) {
        const tname = teamsMap.get(tid) || tid;
        if (!teamAgg[tname]) teamAgg[tname] = { n: 0, h: 0, lg: g.lg };
        teamAgg[tname].n++;
        if (g.kills < g.line) teamAgg[tname].h++;
      }
    }
    const teams = Object.entries(teamAgg).filter(([_, s]) => s.n >= 4).map(([name, s]) => ({ name, lg: s.lg, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

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
    const champs = Object.values(champAgg).filter(c => c.n >= 6).map(c => ({ champ: c.champ, role: c.role, n: c.n, hit: +(100 * c.h / c.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    return { backtest, ligas, supports, teams, champs };
  }

  const stats2peel = computeStats(peel2);
  const stats1PeelFlex = computeStats(peel1Flex);
  const statsAll = computeStats(allTriggers);

  const out = {
    generated_at: new Date().toISOString(),
    split_start: SPLIT2_START,
    leagues_covered: LEAGUES.map(l => l.name),
    line_fallback: FALLBACK_LINE,
    stake: STAKE,
    odd: ODD,
    backtest: stats2peel.backtest,
    ligas: stats2peel.ligas,
    supports: stats2peel.supports,
    teams: stats2peel.teams,
    champs: stats2peel.champs,
    by_trigger: { '2peel': stats2peel, '1peel+flex': stats1PeelFlex, all: statsAll },
  };

  const outFile = path.join(ROOT, 'cron-data', 'tier2_dashboard_stats.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`Wrote: ${outFile}`);
  const bt = stats2peel.backtest;
  console.error(`Backtest 2peel tier2: n=${bt.n} hit=${bt.hit}% profit=R$${bt.profit} ROI=${bt.roi}%`);
})();
