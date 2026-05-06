// Análise STANDALONE do método 2-peel Under aplicado às ligas tier 2 EU.
// NÃO toca em bets, method_reports nem dashboard_stats.json — só gera um JSON
// separado pra comparação com a performance no tier 1 (LEC/LCK/LPL/CBLOL).
//
// Filtros:
//   - Split 2 2026 (datas >= 2026-04-01)
//   - Ligas EMEA tier 2 listadas em LEAGUE_IDS abaixo
//   - LINE = 29.5 fixa (igual o backtest do dashboard_stats.json), stake 100, odd 1.85
//
// Triggers:
//   - 2peel: ambos sup PEEL_PURE
//   - 1peel+flex: 1 peel + 1 flex_engage (Bard/Rakan/Alistar) — em tier 2 não tem
//     LEC, então Bard conta normal em qualquer dessas ligas
//
// Output:
//   - cron-data/tier2_eu_split2_analysis.json
//   - resumo no stdout

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, 'cron-data');
const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SPLIT2_START = '2026-04-01';
const LINE = 29.5;
const STAKE = 100;
const ODD = 1.85;

const LEAGUE_IDS = {
  'EMEA Masters':    '100695891328981122',
  'LFL':             '105266103462388553',
  'NLC':             '105266098308571975',
  'Prime League':    '105266091639104326',
  'LES':             '105266074488398661',
  'Hitpoint Masters':'105266106309666619',
  'LIT':             '105266094998946936',
  'Liga Portuguesa': '105266101075764040',
  'Rift Legends':    '113673877956508505',
};

const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];
const norm = s => s ? String(s).toLowerCase().replace(/[\s.\-']/g,'') : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    https.get({
      host, path: urlPath,
      headers: { 'x-api-key': LOLES, 'User-Agent': 'Mozilla/5.0', Origin: 'https://lolesports.com', Referer: 'https://lolesports.com/' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function tsRoundedTo10s(date) {
  const t = Math.floor(date.getTime() / 10000) * 10000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

async function fetchGameWindow(gameId, matchStart) {
  const targetMs = Math.min(
    new Date(matchStart).getTime() + 6 * 3600 * 1000,
    Date.now() - 60 * 1000,
  );
  const startingTime = tsRoundedTo10s(new Date(targetMs));
  return fetchJson('feed.lolesports.com', `/livestats/v1/window/${gameId}?startingTime=${startingTime}`);
}

async function listMatchesForLeague(leagueId, leagueName) {
  const out = [];
  let pageToken = null;
  for (let pi = 0; pi < 8; pi++) { // até 8 páginas pra cobrir o split inteiro
    const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}` + (pageToken ? `&pageToken=${pageToken}` : '');
    let r;
    try { r = await fetchJson('esports-api.lolesports.com', url); }
    catch (e) { console.error(`  [${leagueName}] schedule p${pi}: ${e.message}`); break; }
    const events = r?.data?.schedule?.events || [];
    let oldest = '9999-99-99';
    for (const ev of events) {
      if (ev.state !== 'completed') continue;
      if (!ev.match?.id || !ev.startTime) continue;
      const d = ev.startTime.slice(0, 10);
      if (d < oldest) oldest = d;
      if (d < SPLIT2_START) continue;
      out.push({
        league: leagueName,
        match_id: ev.match.id,
        start_time: ev.startTime,
        match_date: d,
        team_a: ev.match.teams[0]?.code || ev.match.teams[0]?.name,
        team_b: ev.match.teams[1]?.code || ev.match.teams[1]?.name,
      });
    }
    if (oldest < SPLIT2_START) break;
    if (!r?.data?.schedule?.pages?.older) break;
    pageToken = r.data.schedule.pages.older;
    await sleep(80);
  }
  return out;
}

async function fetchGames(matches) {
  const games = [];
  let i = 0;
  for (const m of matches) {
    i++;
    if (i % 20 === 0) console.error(`  ${i}/${matches.length}`);
    let detail;
    try {
      detail = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${m.match_id}`);
    } catch (e) { continue; }
    for (const g of (detail?.data?.event?.match?.games || [])) {
      if (g.state !== 'completed') continue;
      let win;
      try { win = await fetchGameWindow(g.id, m.start_time); }
      catch (e) { continue; }
      const last = win?.frames?.[win.frames.length - 1];
      if (!last || last.gameState !== 'finished') continue;
      const meta = win?.gameMetadata;
      const supBlue = meta?.blueTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;
      const supRed  = meta?.redTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;
      const kBlue = last.blueTeam?.totalKills ?? 0;
      const kRed  = last.redTeam?.totalKills ?? 0;
      games.push({
        league: m.league,
        match_id: m.match_id,
        game_id: g.id,
        map_number: g.number,
        match_date: m.match_date,
        team_blue: m.team_a,
        team_red:  m.team_b,
        kills_blue: kBlue, kills_red: kRed,
        total_kills: kBlue + kRed,
        sup_blue: supBlue, sup_red: supRed,
      });
      await sleep(50);
    }
    await sleep(50);
  }
  return games;
}

function classifyTrigger(g) {
  const sb = norm(g.sup_blue);
  const sr = norm(g.sup_red);
  const peelB = PEEL_PURE.includes(sb);
  const peelR = PEEL_PURE.includes(sr);
  const flexB = FLEX_ENGAGE.includes(sb);
  const flexR = FLEX_ENGAGE.includes(sr);
  if (peelB && peelR) return '2peel';
  if ((peelB && flexR) || (peelR && flexB)) return '1peel+flex';
  return null;
}

function aggregate(games) {
  let g=0, r=0;
  for (const x of games) { if (x.total_kills < LINE) g++; else r++; }
  const n = g + r;
  const profit = g * STAKE * (ODD - 1) - r * STAKE;
  return {
    n,
    hit: n > 0 ? +(100 * g / n).toFixed(1) : 0,
    profit: +profit.toFixed(2),
    roi: n > 0 ? +(100 * profit / (n * STAKE)).toFixed(1) : 0,
    breakeven: +(100 / ODD).toFixed(1),
  };
}

(async () => {
  console.error(`[setup] tier 2 EU split 2 (>=${SPLIT2_START}), LINE=${LINE} stake=${STAKE} odd=${ODD}`);
  console.error(`[setup] ligas: ${Object.keys(LEAGUE_IDS).join(', ')}`);

  // 1. listar matches
  const allMatches = [];
  for (const [name, id] of Object.entries(LEAGUE_IDS)) {
    const ms = await listMatchesForLeague(id, name);
    console.error(`[1/3] ${name}: ${ms.length} matches no split 2`);
    allMatches.push(...ms);
  }
  console.error(`[1/3] total ${allMatches.length} matches`);

  // 2. fetchar games
  console.error(`[2/3] coletando livestats de ${allMatches.length} matches...`);
  const games = await fetchGames(allMatches);
  console.error(`[2/3] ${games.length} games com kills extraídos`);

  // 3. classificar e agregar
  for (const g of games) g.trigger = classifyTrigger(g);
  const peel2 = games.filter(g => g.trigger === '2peel');
  const peel1f = games.filter(g => g.trigger === '1peel+flex');
  const both = [...peel2, ...peel1f];

  // por liga
  const ligas = {};
  for (const lg of Object.keys(LEAGUE_IDS)) {
    const lg2peel = peel2.filter(g => g.league === lg);
    const lg1pf  = peel1f.filter(g => g.league === lg);
    const lgAll  = games.filter(g => g.league === lg);
    ligas[lg] = {
      total_games: lgAll.length,
      '2peel': aggregate(lg2peel),
      '1peel+flex': aggregate(lg1pf),
      method_total: aggregate([...lg2peel, ...lg1pf]),
    };
  }

  const out = {
    generated_at: new Date().toISOString(),
    split_start: SPLIT2_START,
    line: LINE, stake: STAKE, odd: ODD,
    leagues_analyzed: Object.keys(LEAGUE_IDS),
    totals: {
      games_analyzed: games.length,
      '2peel': aggregate(peel2),
      '1peel+flex': aggregate(peel1f),
      method_total: aggregate(both),
    },
    by_league: ligas,
    games_sample: games.slice(0, 5).map(g => ({ league:g.league, match_date:g.match_date, teams:`${g.team_blue} v ${g.team_red}`, sups:`${g.sup_blue}/${g.sup_red}`, kills:g.total_kills, trigger:g.trigger })),
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'tier2_eu_split2_analysis.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`[3/3] wrote ${outFile}`);
  console.log(JSON.stringify({
    games_analyzed: games.length,
    totals: out.totals,
    by_league_summary: Object.fromEntries(Object.entries(ligas).map(([k, v]) => [k, { games:v.total_games, m2peel:v['2peel'], m1pf:v['1peel+flex'], total:v.method_total }])),
  }, null, 2));
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
