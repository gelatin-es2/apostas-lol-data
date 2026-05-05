// Daily cron rebuild — fetcha tudo via API, sem CSV local
// Output: cron-data/dashboard_stats.json
// Filtro: Split 2 2026 (datas >= 2026-04-01)

const fs = require('fs');
const path = require('path');
const https = require('https');

const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SPLIT2_START = '2026-04-01';
const PEEL = ['Soraka','Sona','Janna','Lulu','Yuumi','Karma','Seraphine','Renata','RenataGlasc','Nami','Milio'];
const STAKE = 100;
const ODD = 1.85;
const LINE = 29.5;

const LEAGUES = [
  { id: '98767991302996019', name: 'LEC' },
  { id: '98767991310872058', name: 'LCK' },
  { id: '98767991314006698', name: 'LPL' },
  { id: '98767991332355509', name: 'CBLOL' },
];

function fetchJsonSafe(host, path_, headers) {
  return new Promise((resolve, reject) => {
    https.get({ host, path: path_, headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
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
      const r = await fetchJsonSafe('esports-api.lolesports.com', url, { 'x-api-key': LOLES });
      let oldestDate = '9999-12-31';
      for (const e of r.data.schedule.events) {
        if (!e.match?.id || !e.startTime) continue;
        const date = e.startTime.slice(0, 10);
        if (date < oldestDate) oldestDate = date;
        if (e.state === 'completed' && date >= SPLIT2_START) {
          out.push({ lg: lg.name, matchId: e.match.id, date, teams: (e.match.teams || []).map(t => ({ id: t.id, name: t.name, code: t.code })) });
        }
      }
      if (!r.data.schedule.pages?.older) break;
      if (oldestDate < SPLIT2_START) break; // já passou do recorte
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
    const kills = (lastFrame.blueTeam?.totalKills || 0) + (lastFrame.redTeam?.totalKills || 0);
    const picks = (md) => {
      const p = md.participantMetadata;
      const get = (role) => p.find(x => x.role === role)?.championId || null;
      return { top: get('top'), jungle: get('jungle'), mid: get('mid'), adc: get('bottom'), support: get('support') };
    };
    // winner = team with more inhibitors destroyed
    const blueInh = lastFrame.blueTeam?.inhibitors || 0;
    const redInh = lastFrame.redTeam?.inhibitors || 0;
    const blueTowers = lastFrame.blueTeam?.towers || 0;
    const redTowers = lastFrame.redTeam?.towers || 0;
    let winnerSide = null;
    if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
    else if (blueTowers !== redTowers) winnerSide = blueTowers > redTowers ? 'blue' : 'red';
    return {
      blueTeamId: blueMeta.esportsTeamId,
      redTeamId: redMeta.esportsTeamId,
      bluePicks: picks(blueMeta),
      redPicks: picks(redMeta),
      kills,
      gameState: lastFrame.gameState,
      winnerSide,
    };
  } catch { return null; }
}

// Champion name → Data Dragon slug (overrides for special-case names)
const DDRAGON_OVERRIDE = {
  'Wukong': 'MonkeyKing', 'Renata Glasc': 'Renata',
};
function ddragonSlug(name) {
  if (DDRAGON_OVERRIDE[name]) return DDRAGON_OVERRIDE[name];
  return name; // lolesports já retorna sem espaços/apóstrofos (ex: "KSante", "TwistedFate")
}

async function fetchLatestDdragonVersion() {
  return new Promise((resolve) => {
    https.get('https://ddragon.leagueoflegends.com/api/versions.json', res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        try { const arr = JSON.parse(body); if (Array.isArray(arr) && arr[0]) return resolve(arr[0]); } catch {}
        resolve('16.9.1');
      });
    }).on('error', () => resolve('16.9.1'));
  });
}

(async () => {
  console.error('[1/4] Fetching teams map...');
  const teamsMap = await fetchTeamsMap();

  console.error('[2/4] Fetching matches Split 2...');
  const matches = await fetchAllMatches();
  console.error(`  ${matches.length} matches completed >= ${SPLIT2_START}`);

  console.error('[3/4] Fetching games per match...');
  const games = [];
  let mIdx = 0;
  for (const m of matches) {
    mIdx++;
    if (mIdx % 30 === 0) console.error(`  match ${mIdx}/${matches.length}`);
    try {
      const det = await fetchJsonSafe('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${m.matchId}`, { 'x-api-key': LOLES });
      for (const g of det.data.event.match.games) {
        if (g.state !== 'completed') continue;
        const meta = await fetchGameMeta(g.id);
        if (!meta) continue;
        games.push({ ...meta, lg: m.lg, matchId: m.matchId, gameId: g.id, mapNum: g.number, date: m.date });
      }
    } catch (e) { console.error(`  match ${m.matchId} ERR`); }
  }
  console.error(`  ${games.length} games fetched`);

  console.error('[4/4] Computing stats...');

  const FLEX = ['Bard', 'Rakan', 'Alistar'];

  // Filtros por trigger type
  const peel2 = games.filter(g => PEEL.includes(g.bluePicks.support) && PEEL.includes(g.redPicks.support));
  const peel1Flex = games.filter(g => {
    const sB = g.bluePicks.support, sR = g.redPicks.support;
    if (PEEL.includes(sB) && PEEL.includes(sR)) return false; // já é 2peel
    const bluePeel = PEEL.includes(sB), redPeel = PEEL.includes(sR);
    const blueFlex = FLEX.includes(sB), redFlex = FLEX.includes(sR);
    return (bluePeel && redFlex) || (redPeel && blueFlex);
  });
  const allTriggers = [...peel2, ...peel1Flex];

  console.error(`  triggers: 2peel=${peel2.length} | 1peel+flex=${peel1Flex.length} | all=${allTriggers.length}`);

  // Agrega backtest + ligas + supports + teams + champs pra um subset de games
  function computeStats(subset) {
    // BACKTEST
    let green = 0, red = 0;
    for (const g of subset) { if (g.kills < LINE) green++; else red++; }
    const profit = green * STAKE * (ODD - 1) - red * STAKE;
    const backtest = {
      n: subset.length,
      hit: subset.length ? +(100 * green / subset.length).toFixed(1) : 0,
      profit: +profit.toFixed(2),
      roi: subset.length ? +(100 * profit / (subset.length * STAKE)).toFixed(1) : 0,
      breakeven: +(100 / ODD).toFixed(1),
    };

    // LIGAS
    const ligaAgg = {};
    for (const g of subset) {
      if (!ligaAgg[g.lg]) ligaAgg[g.lg] = { n: 0, h: 0 };
      ligaAgg[g.lg].n++;
      if (g.kills < LINE) ligaAgg[g.lg].h++;
    }
    const ligas = Object.entries(ligaAgg).map(([name, s]) => ({ name, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    // SUPPORTS (peel + flex)
    const supAgg = {};
    for (const g of subset) {
      for (const s of [g.bluePicks.support, g.redPicks.support]) {
        if (!PEEL.includes(s) && !FLEX.includes(s)) continue;
        if (!supAgg[s]) supAgg[s] = { n: 0, h: 0 };
        supAgg[s].n++;
        if (g.kills < LINE) supAgg[s].h++;
      }
    }
    const supports = Object.entries(supAgg).filter(([_, s]) => s.n >= 3).map(([name, s]) => ({ name, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    // TIMES
    const teamAgg = {};
    for (const g of subset) {
      for (const tid of [g.blueTeamId, g.redTeamId]) {
        const tname = teamsMap.get(tid) || tid;
        if (!teamAgg[tname]) teamAgg[tname] = { n: 0, h: 0, lg: g.lg };
        teamAgg[tname].n++;
        if (g.kills < LINE) teamAgg[tname].h++;
      }
    }
    const teams = Object.entries(teamAgg).filter(([_, s]) => s.n >= 4).map(([name, s]) => ({ name, lg: s.lg, n: s.n, hit: +(100 * s.h / s.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    // CHAMPS POR LANE
    const champAgg = {};
    for (const g of subset) {
      for (const picks of [g.bluePicks, g.redPicks]) {
        for (const role of ['top','jungle','mid','adc']) {
          const champ = picks[role];
          if (!champ) continue;
          const key = `${champ}|${role}`;
          if (!champAgg[key]) champAgg[key] = { champ, role, n: 0, h: 0 };
          champAgg[key].n++;
          if (g.kills < LINE) champAgg[key].h++;
        }
      }
    }
    const champs = Object.values(champAgg).filter(c => c.n >= 8).map(c => ({ champ: c.champ, role: c.role, n: c.n, hit: +(100 * c.h / c.n).toFixed(1) })).sort((a, b) => b.hit - a.hit);

    return { backtest, ligas, supports, teams, champs };
  }

  const stats2peel = computeStats(peel2);
  const stats1PeelFlex = computeStats(peel1Flex);
  const statsAll = computeStats(allTriggers);

  // Bardo (LEC vs fora) — análise especial: jogos com Bard + outro peel (subset de 1peel+flex).
  // Mantida porque LEC tem comportamento de Bard distinto do resto — split histórico útil pra UI.
  const bardLec = { n: 0, h: 0 };
  const bardOther = { n: 0, h: 0 };
  for (const g of games) {
    const hasBard = g.bluePicks.support === 'Bard' || g.redPicks.support === 'Bard';
    if (!hasBard) continue;
    const otherSup = g.bluePicks.support === 'Bard' ? g.redPicks.support : g.bluePicks.support;
    if (!PEEL.includes(otherSup)) continue;
    const bucket = g.lg === 'LEC' ? bardLec : bardOther;
    bucket.n++;
    if (g.kills < LINE) bucket.h++;
  }
  // Bardo é flex_engage, não peel — semanticamente entra no 1peel+flex
  if (bardLec.n) stats1PeelFlex.supports.unshift({ name: 'Bard (LEC)', n: bardLec.n, hit: +(100 * bardLec.h / bardLec.n).toFixed(1) });
  if (bardOther.n) stats1PeelFlex.supports.push({ name: 'Bard (fora LEC)', n: bardOther.n, hit: +(100 * bardOther.h / bardOther.n).toFixed(1) });

  const out = {
    generated_at: new Date().toISOString(),
    split_start: SPLIT2_START,
    line: LINE,
    stake: STAKE,
    odd: ODD,
    // Top-level = 2peel (compat com frontend atual; novos consumidores devem usar by_trigger).
    // Importante: top-level NÃO inclui mais a injeção especial Bard(LEC)/Bard(fora LEC)
    // — ela vive em by_trigger['1peel+flex'].supports porque Bard é flex, não peel.
    backtest: stats2peel.backtest,
    ligas: stats2peel.ligas,
    supports: stats2peel.supports,
    teams: stats2peel.teams,
    champs: stats2peel.champs,
    // Granular por trigger — fonte da verdade pra novos consumidores
    by_trigger: {
      '2peel': stats2peel,
      '1peel+flex': stats1PeelFlex,
      all: statsAll,
    },
  };

  const outDir = path.join(__dirname, 'cron-data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'dashboard_stats.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`Wrote: ${outFile}`);
  console.error(`Backtest: n=${backtest.n} hit=${backtest.hit}% profit=R$${backtest.profit} ROI=${backtest.roi}%`);

  // === ML PICKS (winrate por champion × posição) ===
  console.error('[ML] computing winrates...');
  const ddv = await fetchLatestDdragonVersion();
  const POS_MAP = { top: 'top', jungle: 'jng', mid: 'mid', adc: 'bot', support: 'sup' };
  const champWr = {}; // { 'Champion|pos' -> { wins, losses, lgs: Set } }
  let gamesUsed = 0;
  for (const g of games) {
    if (!g.winnerSide) continue;
    gamesUsed++;
    const sides = [
      { picks: g.bluePicks, won: g.winnerSide === 'blue' },
      { picks: g.redPicks, won: g.winnerSide === 'red' },
    ];
    for (const s of sides) {
      for (const [role, pos] of Object.entries(POS_MAP)) {
        const champ = s.picks[role];
        if (!champ) continue;
        const key = `${champ}|${pos}`;
        if (!champWr[key]) champWr[key] = { champion: champ, pos, wins: 0, losses: 0, lgs: {} };
        if (s.won) champWr[key].wins++; else champWr[key].losses++;
        champWr[key].lgs[g.lg] = (champWr[key].lgs[g.lg] || 0) + 1;
      }
    }
  }
  const MIN = 8;
  const byPosition = { top: [], jng: [], mid: [], bot: [], sup: [] };
  const totalMaps = { top: 0, jng: 0, mid: 0, bot: 0, sup: 0 };
  for (const g of games) if (g.winnerSide) for (const pos of ['top','jng','mid','bot','sup']) totalMaps[pos]++;
  for (const [key, c] of Object.entries(champWr)) {
    const n = c.wins + c.losses;
    if (n < MIN) continue;
    byPosition[c.pos].push({
      champion: c.champion,
      slug: ddragonSlug(c.champion),
      n, wins: c.wins, losses: c.losses,
      wr: +(c.wins / n).toFixed(3),
      ligas: Object.entries(c.lgs).sort((a,b) => b[1] - a[1]).map(([lg, n]) => `${lg}(${n})`).join(' '),
    });
  }
  for (const pos of Object.keys(byPosition)) byPosition[pos].sort((a, b) => b.wr - a.wr || b.n - a.n);
  const ml = {
    generated_at: new Date().toISOString(),
    split_label: `${SPLIT2_START} → ${games.length ? games.map(g => g.date).sort().pop() : '?'}`,
    leagues: LEAGUES.map(l => l.name),
    cutoff_date: SPLIT2_START,
    min_games: MIN,
    total_rows: Object.values(byPosition).reduce((s, arr) => s + arr.length, 0),
    total_maps_per_pos: totalMaps,
    ddragon_version: ddv,
    by_position: byPosition,
  };
  const mlFile = path.join(outDir, 'ml_picks.json');
  fs.writeFileSync(mlFile, JSON.stringify(ml, null, 2));
  // Wrap as JS for dashboard inclusion
  const mlJsFile = path.join(outDir, 'ml_picks.js');
  fs.writeFileSync(mlJsFile, `window.ML_DATA = ${JSON.stringify(ml, null, 2)};\n`);
  console.error(`Wrote: ${mlFile} (${ml.total_rows} entries, ${gamesUsed} games used)`);
})();
