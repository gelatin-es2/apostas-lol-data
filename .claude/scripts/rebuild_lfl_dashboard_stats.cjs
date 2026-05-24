// LFL-only dashboard rebuild — análise focada na liga francesa Split 2.
// Output: cron-data/lfl_dashboard_stats.json com breakdown rico:
// backtest, supports, teams, champs — todos filtrados só LFL.

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
const FAIR_ADJUSTMENT = -1;
const FALLBACK_LINE = 29.5;
const MIN_SAMPLE_TEAM = 5;

const LFL_ID = '105266103462388553';

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
  const m = new Map();
  for (const t of r.data.teams) m.set(t.id, t.name);
  return m;
}

async function fetchAllMatches() {
  const out = [];
  let pageToken = null;
  for (let pi = 0; pi < 5; pi++) {
    const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${LFL_ID}` + (pageToken ? `&pageToken=${pageToken}` : '');
    let r;
    try { r = await fetchJsonSafe('esports-api.lolesports.com', url, { 'x-api-key': LOLES }); }
    catch (e) { console.error(`page ${pi} err: ${e.message}`); break; }
    let oldestDate = '9999-12-31';
    for (const e of (r.data?.schedule?.events || [])) {
      if (!e.match?.id || !e.startTime) continue;
      const date = e.startTime.slice(0, 10);
      if (date < oldestDate) oldestDate = date;
      if (e.state === 'completed' && date >= SPLIT2_START) {
        out.push({ matchId: e.match.id, date });
      }
    }
    if (!r.data?.schedule?.pages?.older) break;
    if (oldestDate < SPLIT2_START) break;
    pageToken = r.data.schedule.pages.older;
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
    return {
      blueTeamId: blueMeta.esportsTeamId, redTeamId: redMeta.esportsTeamId,
      bluePicks: picks(blueMeta), redPicks: picks(redMeta),
      kills: kBlue + kRed, kBlue, kRed,
    };
  } catch { return null; }
}

(async () => {
  console.error('[1/4] teams map...');
  const teamsMap = await fetchTeamsMap();

  console.error('[2/4] matches LFL Split 2...');
  const matches = await fetchAllMatches();
  console.error(`  ${matches.length} matches completed`);

  console.error('[3/4] fetch livestats...');
  const games = [];
  let mIdx = 0;
  for (const m of matches) {
    mIdx++;
    if (mIdx % 20 === 0) console.error(`  match ${mIdx}/${matches.length}`);
    try {
      const det = await fetchJsonSafe('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${m.matchId}`, { 'x-api-key': LOLES });
      for (const g of (det.data?.event?.match?.games || [])) {
        if (g.state !== 'completed') continue;
        const meta = await fetchGameMeta(g.id);
        if (!meta) continue;
        games.push({ ...meta, gameId: g.id, mapNum: g.number, date: m.date });
      }
    } catch (e) { /* skip */ }
  }
  console.error(`  ${games.length} games fetched`);

  console.error('[4/4] fair line + agregação...');
  const teamKills = new Map();
  function tname(g, side) {
    const tid = side === 'blue' ? g.blueTeamId : g.redTeamId;
    return teamsMap.get(tid) || tid;
  }
  for (const g of games) {
    const b = tname(g, 'blue'), r = tname(g, 'red');
    if (!teamKills.has(b)) teamKills.set(b, []);
    if (!teamKills.has(r)) teamKills.set(r, []);
    teamKills.get(b).push(g.kBlue);
    teamKills.get(r).push(g.kRed);
  }
  const allKills = games.flatMap(g => [g.kBlue, g.kRed]);
  const lgAvg = allKills.length ? allKills.reduce((a,b)=>a+b,0)/allKills.length : null;
  function fair(g) {
    const ba = teamKills.get(tname(g,'blue')) || [];
    const ra = teamKills.get(tname(g,'red')) || [];
    const baEx = ba.length > 1 ? (ba.reduce((a,b)=>a+b,0) - g.kBlue)/(ba.length-1) : null;
    const raEx = ra.length > 1 ? (ra.reduce((a,b)=>a+b,0) - g.kRed)/(ra.length-1) : null;
    const bAvg = (ba.length-1 >= MIN_SAMPLE_TEAM) ? baEx : lgAvg;
    const rAvg = (ra.length-1 >= MIN_SAMPLE_TEAM) ? raEx : lgAvg;
    if (bAvg == null || rAvg == null) return FALLBACK_LINE;
    return Math.round(bAvg + rAvg + FAIR_ADJUSTMENT - 0.5) + 0.5;
  }
  for (const g of games) g.line = fair(g);

  // Filtra triggers
  const peel2 = games.filter(g => PEEL.includes(g.bluePicks.support) && PEEL.includes(g.redPicks.support));
  const peel1Flex = games.filter(g => {
    const sB = g.bluePicks.support, sR = g.redPicks.support;
    if (PEEL.includes(sB) && PEEL.includes(sR)) return false;
    return ((PEEL.includes(sB) && FLEX.includes(sR)) || (PEEL.includes(sR) && FLEX.includes(sB)));
  });

  function compute(subset) {
    let green = 0, red = 0;
    for (const g of subset) g.kills < g.line ? green++ : red++;
    const profit = green * STAKE * (ODD - 1) - red * STAKE;
    const backtest = {
      n: subset.length,
      hit: subset.length ? +(100*green/subset.length).toFixed(1) : 0,
      profit: +profit.toFixed(2),
      roi: subset.length ? +(100*profit/(subset.length*STAKE)).toFixed(1) : 0,
      breakeven_185: 54.1,
      breakeven_175: 57.1,
    };
    // teams
    const tAgg = {};
    for (const g of subset) {
      for (const tid of [g.blueTeamId, g.redTeamId]) {
        const tn = teamsMap.get(tid) || tid;
        if (!tAgg[tn]) tAgg[tn] = { n:0, h:0 };
        tAgg[tn].n++;
        if (g.kills < g.line) tAgg[tn].h++;
      }
    }
    const teams = Object.entries(tAgg).filter(([,s])=>s.n>=3).map(([n,s])=>({name:n, n:s.n, hit:+(100*s.h/s.n).toFixed(1)})).sort((a,b)=>b.hit-a.hit);
    // sups
    const sAgg = {};
    for (const g of subset) {
      for (const s of [g.bluePicks.support, g.redPicks.support]) {
        if (!PEEL.includes(s) && !FLEX.includes(s)) continue;
        if (!sAgg[s]) sAgg[s] = { n:0, h:0 };
        sAgg[s].n++;
        if (g.kills < g.line) sAgg[s].h++;
      }
    }
    const supports = Object.entries(sAgg).filter(([,s])=>s.n>=3).map(([n,s])=>({name:n, n:s.n, hit:+(100*s.h/s.n).toFixed(1)})).sort((a,b)=>b.hit-a.hit);
    // champs
    const cAgg = {};
    for (const g of subset) {
      for (const picks of [g.bluePicks, g.redPicks]) {
        for (const role of ['top','jungle','mid','adc']) {
          const c = picks[role];
          if (!c) continue;
          const k = `${c}|${role}`;
          if (!cAgg[k]) cAgg[k] = { champ:c, role, n:0, h:0 };
          cAgg[k].n++;
          if (g.kills < g.line) cAgg[k].h++;
        }
      }
    }
    const champs = Object.values(cAgg).filter(c=>c.n>=4).map(c=>({champ:c.champ, role:c.role, n:c.n, hit:+(100*c.h/c.n).toFixed(1)})).sort((a,b)=>b.hit-a.hit);
    return { backtest, teams, supports, champs };
  }

  const stats2peel = compute(peel2);
  const statsAll = compute([...peel2, ...peel1Flex]);

  const out = {
    generated_at: new Date().toISOString(),
    league: 'LFL',
    split_start: SPLIT2_START,
    total_games_fetched: games.length,
    fair_method: 'livestats_team_avg(blue+red)-1, fallback 29.5',
    stake: STAKE, odd: ODD,
    backtest_2peel: stats2peel.backtest,
    backtest_all: statsAll.backtest,
    teams_2peel: stats2peel.teams,
    teams_all: statsAll.teams,
    supports_2peel: stats2peel.supports,
    supports_all: statsAll.supports,
    champs_2peel: stats2peel.champs,
    champs_all: statsAll.champs,
  };
  const outFile = path.join(ROOT, 'cron-data', 'lfl_dashboard_stats.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`Wrote: ${outFile}`);
  const bt = stats2peel.backtest;
  console.error(`LFL 2peel: n=${bt.n} hit=${bt.hit}% profit=R$${bt.profit} ROI=${bt.roi}%`);
})();
