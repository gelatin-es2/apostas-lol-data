// Analisa jogos de ontem das 5 majors
// Usa lolesports unofficial API (esports-api + livestats)
// Output: cron-data/YYYY-MM-DD-results.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const ORACLE_CSV = process.env.ORACLE_CSV || path.resolve(__dirname, '..', 'year_backtest/datasets/2026_oracle.csv');
const OUT_DIR = path.join(__dirname, 'cron-data');
const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const LEAGUE_IDS = {
  LPL: '98767991314006698',
  LCK: '98767991310872058',
  LEC: '98767991302996019',
  CBLOL: '98767991325878492',
  LCS: '98767991299243165',
};
const PEEL_NO_BARD = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio'];
const norm = s => s ? s.toLowerCase().replace(/\s+/g,'') : '';
const isPeel = (sup, liga) => {
  if (!sup) return false;
  const n = norm(sup);
  if (n === 'bard') return liga === 'LEC';
  return PEEL_NO_BARD.includes(n);
};

function ymd(d) { return d.toISOString().slice(0, 10); }
const YESTERDAY = ymd(new Date(Date.now() - 24*3600*1000));

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON err: ${e.message} — ${body.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur); return out;
}
function num(v) { if (v==null||v==='') return null; const n = parseFloat(v); return isNaN(n)?null:n; }

console.error('[1/4] Carregando teams + perfil de kills do CSV...');
const lines = fs.readFileSync(ORACLE_CSV, 'utf8').split(/\r?\n/);
const header = parseCSVLine(lines[0]).map(h => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const teamProfile = new Map();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const c = parseCSVLine(lines[i]);
  if (c.length < header.length - 2) continue;
  if (c[idx.position] !== 'team') continue;
  const team = c[idx.teamname]; const tk = num(c[idx.teamkills]);
  if (!team || tk == null) continue;
  if (!teamProfile.has(team)) teamProfile.set(team, { kills: [] });
  teamProfile.get(team).kills.push(tk);
}
for (const [, p] of teamProfile) { p.n = p.kills.length; p.avg = p.kills.reduce((a,b)=>a+b,0)/p.n; }

// Match team por nome OU substring (lolesports usa "BRO", oracle usa "HANJIN BRION")
function findTeamProfile(name) {
  if (!name) return null;
  if (teamProfile.has(name)) return teamProfile.get(name);
  const target = norm(name);
  for (const [oracleName, profile] of teamProfile) {
    const o = norm(oracleName);
    if (o.includes(target) || target.includes(o)) return profile;
  }
  return null;
}

(async () => {
console.error(`[2/4] Buscando jogos de ${YESTERDAY}...`);
const allGames = [];
for (const [liga, leagueId] of Object.entries(LEAGUE_IDS)) {
  let schedule;
  try {
    schedule = await fetch(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}`, {
      'x-api-key': LOLESPORTS_KEY,
    });
  } catch (e) {
    console.error(`  ${liga} schedule falhou: ${e.message}`);
    continue;
  }
  const events = (schedule?.data?.schedule?.events || []).filter(ev => ev.startTime?.slice(0,10) === YESTERDAY);
  for (const ev of events) {
    if (ev.state !== 'completed') continue;
    const matchId = ev.match?.id;
    if (!matchId) continue;
    let detail;
    try {
      detail = await fetch(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`, {
        'x-api-key': LOLESPORTS_KEY,
      });
    } catch (e) { console.error(`  matchDetail ${matchId} falhou: ${e.message}`); continue; }
    const games = detail?.data?.event?.match?.games || [];
    for (const g of games) {
      if (g.state !== 'completed') continue;
      allGames.push({
        league: liga,
        match_id: matchId,
        game_id: g.id,
        game_number: g.number,
        team_blue: ev.match.teams[0]?.code || ev.match.teams[0]?.name,
        team_red: ev.match.teams[1]?.code || ev.match.teams[1]?.name,
      });
    }
  }
}
console.error(`  ${allGames.length} games completed ontem`);

console.error('[3/4] Buscando window + comp pra cada game...');
const results = [];
for (const g of allGames) {
  const startingTime = new Date().toISOString();
  let win;
  try {
    win = await fetch(`https://feed.lolesports.com/livestats/v1/window/${g.game_id}?startingTime=${startingTime}`, {
      'x-api-key': LOLESPORTS_KEY,
    });
  } catch (e) {
    console.error(`  game ${g.game_id} window falhou: ${e.message}`);
    results.push({ ...g, error: 'window_failed' });
    continue;
  }
  const last = win?.frames?.[win.frames.length - 1];
  if (!last || last.gameState !== 'finished') {
    results.push({ ...g, error: 'not_finished' });
    continue;
  }
  const kBlue = last.blueTeam?.totalKills ?? 0;
  const kRed = last.redTeam?.totalKills ?? 0;
  const meta = win?.gameMetadata;
  const supBlue = meta?.blueTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;
  const supRed = meta?.redTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;

  const p1 = findTeamProfile(g.team_blue), p2 = findTeamProfile(g.team_red);
  const fair = (p1 && p2 && p1.n >= 11 && p2.n >= 11) ? Math.round((p1.avg + p2.avg) - 0.5) + 0.5 : null;
  const peelCount = (isPeel(supBlue, g.league) ? 1 : 0) + (isPeel(supRed, g.league) ? 1 : 0);
  const peelBucket = peelCount === 2 ? '2peel' : (peelCount === 1 ? '1peel' : '0peel');
  const underHit = (fair != null) ? (kBlue + kRed) < fair : null;

  results.push({
    league: g.league,
    match_id: g.match_id,
    game_id: g.game_id,
    map_number: g.game_number,
    team_blue: g.team_blue, team_red: g.team_red,
    kills_blue: kBlue, kills_red: kRed,
    total_kills: kBlue + kRed,
    sup_blue: supBlue, sup_red: supRed,
    peel_count: peelCount, peel_bucket: peelBucket,
    matchup_fair: fair, under_hit: underHit,
  });
  console.error(`  ${g.league} ${g.team_blue} v ${g.team_red} M${g.game_number}: ${kBlue+kRed}k | sup=${supBlue}/${supRed} (${peelBucket}) | fair=${fair} U=${underHit}`);
}

console.error(`[4/4] Salvando ${results.length} resultados...`);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${YESTERDAY}-results.json`);
fs.writeFileSync(outFile, JSON.stringify({
  date: YESTERDAY,
  analyzed_at: new Date().toISOString(),
  ligas: Object.keys(LEAGUE_IDS),
  count: results.length,
  results,
}, null, 2));
console.error(`Wrote: ${outFile}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
