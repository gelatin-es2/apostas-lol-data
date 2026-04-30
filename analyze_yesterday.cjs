// Analisa jogos de ontem das 5 majors:
//   - busca resultados (kills + comp) via lolesports unofficial API + gol.gg fallback
//   - pra cada mapa: foi 2-peel? bateu Under na fair calculada?
//   - salva em cron-data/YYYY-MM-DD-results.json
//
// Uso: node analyze_yesterday.cjs

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const ORACLE_CSV = path.join(ROOT, 'year_backtest/datasets/2026_oracle.csv');
const OUT_DIR = path.join(__dirname, 'cron-data');

const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LEAGUE_IDS = {
  LPL: '98767991314006698',
  LCK: '98767991310872058',
  LEC: '98767991302996019',
  CBLOL: '98767991325878492',
  LCS: '98767991299243165',
};
const PEEL_PURE = ['Soraka','Sona','Janna','Lulu','Yuumi','Karma','Seraphine','Renata Glasc','Nami','Milio'];

function ymd(date) { return date.toISOString().slice(0, 10); }
const TODAY = new Date();
const YESTERDAY = new Date(TODAY.getTime() - 24*3600*1000);
const YESTERDAY_STR = ymd(YESTERDAY);

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

console.error('[1/3] Carregando perfil de times...');
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

console.error('[2/3] Buscando jogos de ontem (' + YESTERDAY_STR + ')...');
const results = [];
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
  const events = (schedule?.data?.schedule?.events || []).filter(ev => ev.startTime?.slice(0,10) === YESTERDAY_STR);
  for (const ev of events) {
    if (ev.state !== 'completed') continue;
    const matchId = ev.match?.id;
    if (!matchId) continue;
    const teams = ev.match?.teams || [];
    if (teams.length !== 2) continue;
    const t1 = teams[0]?.code || teams[0]?.name;
    const t2 = teams[1]?.code || teams[1]?.name;
    // Buscar games da match (lolesports fornece game IDs)
    let matchDetail;
    try {
      matchDetail = await fetch(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`, {
        'x-api-key': LOLESPORTS_KEY,
      });
    } catch (e) {
      console.error(`  ${liga} matchDetail ${matchId} falhou: ${e.message}`);
      continue;
    }
    const games = matchDetail?.data?.event?.match?.games || [];
    for (const game of games) {
      if (game.state !== 'completed') continue;
      const gameId = game.id;
      // Buscar window pra kills + supports (livestats/v1)
      let win;
      try {
        // Endpoint window: pega do final do mapa
        const startTime = game.startTime || ev.startTime;
        win = await fetch(`https://feed.lolesports.com/livestats/v1/window/${gameId}`, {
          'x-api-key': LOLESPORTS_KEY,
        });
      } catch (e) {
        console.error(`    game ${gameId} window falhou: ${e.message}`);
        continue;
      }
      const frames = win?.frames;
      if (!frames || !frames.length) continue;
      const last = frames[frames.length - 1];
      const blueKills = last?.blueTeam?.totalKills || 0;
      const redKills = last?.redTeam?.totalKills || 0;
      const totalKills = blueKills + redKills;
      // Supports
      let supBlue = null, supRed = null;
      try {
        const detail = await fetch(`https://feed.lolesports.com/livestats/v1/details/${gameId}`, { 'x-api-key': LOLESPORTS_KEY });
        const partB = detail?.frames?.[0]?.participants || [];
        const findSup = (team) => team.find(p => /support/i.test(p.role || ''))?.championId;
        // detail aggregates by side
      } catch {}
      // Fallback: pega champion via game.teams[i].players (se disponível)
      const fillSupFromGame = (side) => {
        const team = (game.teams || []).find(t => t.side === side);
        const sup = (team?.players || []).find(p => /support|sup/i.test(p.role || ''));
        return sup?.champion || sup?.championName || null;
      };
      if (!supBlue) supBlue = fillSupFromGame('blue');
      if (!supRed) supRed = fillSupFromGame('red');

      // Calcular fair
      const p1 = teamProfile.get(t1), p2 = teamProfile.get(t2);
      const fair = (p1 && p2 && p1.n >= 11 && p2.n >= 11) ? Math.round((p1.avg + p2.avg) - 0.5) + 0.5 : null;
      const isPeel = (c) => c && PEEL_PURE.includes(c);
      const peelBucket = (supBlue && supRed)
        ? (isPeel(supBlue) && isPeel(supRed) ? '2peel' : (isPeel(supBlue) || isPeel(supRed) ? '1peel' : '0peel'))
        : 'unknown';
      const underHit = (fair != null) ? totalKills < fair : null;

      results.push({
        league: liga,
        match_id: matchId,
        game_id: gameId,
        team_blue: t1, team_red: t2,
        kills_blue: blueKills, kills_red: redKills, total_kills: totalKills,
        sup_blue: supBlue, sup_red: supRed,
        peel_bucket: peelBucket,
        matchup_fair: fair,
        under_hit: underHit,
      });
      console.error(`  ${liga} ${t1} vs ${t2} game ${gameId}: ${totalKills} kills | fair=${fair} | bucket=${peelBucket} | Under: ${underHit}`);
    }
  }
}

console.error(`[3/3] Salvando ${results.length} resultados...`);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${YESTERDAY_STR}-results.json`);
fs.writeFileSync(outFile, JSON.stringify({
  date: YESTERDAY_STR,
  analyzed_at: new Date().toISOString(),
  ligas: Object.keys(LEAGUE_IDS),
  count: results.length,
  results,
}, null, 2));
console.error(`Wrote: ${outFile}`);
