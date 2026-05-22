// Backfill match_context pras 15 bets tier 1 com mismatch de nome
// (Ninjas in Pyjamas ↔ Shenzhen NIP, JD Gaming ↔ Beijing JDG, etc).
//
// Algoritmo: fuzzy match (substring contains após normalização)
// pra achar o match real e puxar livestats.
//
// Uso: node backfill-missing-tier1.cjs [--dry-run]

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const DRY_RUN = process.argv.includes('--dry-run');

const LEAGUE_IDS = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
};

const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];
const norm = s => s ? s.toLowerCase().replace(/[\s.\-'’]/g, '') : '';

function get(host, p, useApiKey) {
  return new Promise((resolve, reject) => {
    const headers = useApiKey
      ? { 'x-api-key': LOLES_KEY, 'User-Agent': 'Mozilla/5.0', Origin: 'https://lolesports.com', Referer: 'https://lolesports.com/' }
      : { 'User-Agent': 'Mozilla/5.0' };
    https.get({ host, path: p, headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ts10(d) {
  const t = Math.floor(d.getTime()/10000)*10000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

// Fuzzy: query bate em item se um contém o outro (após norm)
function fuzzyMatch(queryName, candidateName, candidateCode) {
  const q = norm(queryName);
  const n = norm(candidateName);
  const c = norm(candidateCode);
  if (!q || !n) return false;
  if (q === n || q === c) return true;
  if (n.includes(q) || q.includes(n)) return true;
  if (c && (c.includes(q) || q.includes(c))) return true;
  return false;
}

function teamsMatch(evTeams, betA, betB) {
  if (evTeams.length !== 2) return false;
  const a0 = fuzzyMatch(betA, evTeams[0].name, evTeams[0].code);
  const a1 = fuzzyMatch(betA, evTeams[1].name, evTeams[1].code);
  const b0 = fuzzyMatch(betB, evTeams[0].name, evTeams[0].code);
  const b1 = fuzzyMatch(betB, evTeams[1].name, evTeams[1].code);
  return (a0 && b1) || (a1 && b0);
}

async function findMatch(league, teamA, teamB, betDate) {
  const id = LEAGUE_IDS[league];
  if (!id) return null;
  // schedule scan
  const r = await get('esports-api.lolesports.com', '/persisted/gw/getSchedule?hl=en-US&leagueId=' + id, true);
  const events = r?.data?.schedule?.events || [];
  const candidates = events.filter(e => e.match && e.startTime?.slice(0,10) === betDate);
  for (const ev of candidates) {
    if (teamsMatch(ev.match.teams, teamA, teamB)) return ev;
  }
  // Tenta ±1 dia (timezone shift)
  const d = new Date(betDate);
  for (const offset of [-1, 1]) {
    const tryDate = new Date(d.getTime() + offset * 86400000).toISOString().slice(0,10);
    const c2 = events.filter(e => e.match && e.startTime?.slice(0,10) === tryDate);
    for (const ev of c2) {
      if (teamsMatch(ev.match.teams, teamA, teamB)) return ev;
    }
  }
  return null;
}

async function fetchGameData(game, matchStart) {
  const baseMs = new Date(matchStart).getTime() + 6 * 3600 * 1000;
  const targetMs = Math.min(baseMs, Date.now() - 200 * 1000);
  const startingTime = ts10(new Date(targetMs));
  const win = await get('feed.lolesports.com', '/livestats/v1/window/' + game.id + '?startingTime=' + startingTime, false);
  if (!win?.frames?.length || !win.gameMetadata) return null;
  const lf = win.frames[win.frames.length - 1];
  const meta = win.gameMetadata;
  const picks = md => {
    const p = md.participantMetadata;
    const g = role => p.find(x => x.role === role)?.championId || null;
    return { top: g('top'), jungle: g('jungle'), mid: g('mid'), adc: g('bottom'), support: g('support') };
  };
  const kBlue = lf.blueTeam?.totalKills ?? 0;
  const kRed = lf.redTeam?.totalKills ?? 0;
  const bluePicks = picks(meta.blueTeamMetadata);
  const redPicks = picks(meta.redTeamMetadata);
  const sB = (bluePicks.support || '').toLowerCase();
  const sR = (redPicks.support || '').toLowerCase();
  const peelB = PEEL_PURE.includes(sB), peelR = PEEL_PURE.includes(sR);
  const flexB = FLEX_ENGAGE.includes(sB), flexR = FLEX_ENGAGE.includes(sR);
  let trigger = null;
  if (peelB && peelR) trigger = '2peel';
  else if ((peelB && flexR) || (peelR && flexB)) trigger = '1peel+flex';
  const blueInh = lf.blueTeam?.inhibitors || 0;
  const redInh = lf.redTeam?.inhibitors || 0;
  let winnerSide = null;
  if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
  return {
    game_id: String(game.id),
    blue_team_id: String(meta.blueTeamMetadata.esportsTeamId),
    red_team_id: String(meta.redTeamMetadata.esportsTeamId),
    blue_picks: bluePicks,
    red_picks: redPicks,
    kills_blue: kBlue,
    kills_red: kRed,
    total_kills: kBlue + kRed,
    winner_side: winnerSide,
    trigger_type: trigger,
  };
}

(async () => {
  const cfg = loadConfig();
  const list = await new Promise(resolve => {
    https.get(cfg.supabaseUrl + '/rest/v1/bets?select=id,league,team_a,team_b,bet_datetime,map_number,raw_extraction&bookmaker=neq.SIMULATED&status=in.(green,red)&bet_datetime=gte.2026-04-01T00:00:00Z', {headers:{apikey:cfg.supabaseKey, Authorization:'Bearer '+cfg.supabaseKey}}, res => {
      let b=''; res.on('data', c => b+=c); res.on('end', () => resolve(JSON.parse(b)));
    });
  });
  const tier1 = ['LCK','LPL','LEC','CBLOL','LCS'];
  const missing = list.filter(r => tier1.includes(r.league) && r.raw_extraction?.match_context?.total_kills == null);
  console.error('Bets pra backfill:', missing.length);

  let fixed = 0, notfound = 0, errors = 0;
  for (const bet of missing) {
    const date = bet.bet_datetime.slice(0,10);
    let ev;
    try { ev = await findMatch(bet.league, bet.team_a, bet.team_b, date); }
    catch (e) { console.error(bet.id.slice(0,8), 'findMatch err:', e.message); errors++; continue; }
    if (!ev) { console.error(bet.id.slice(0,8), 'no_match:', bet.team_a, 'vs', bet.team_b, '@', date); notfound++; continue; }

    // Pega game pelo map_number
    let det;
    try { det = await get('esports-api.lolesports.com', '/persisted/gw/getEventDetails?hl=en-US&id=' + ev.match.id, true); }
    catch (e) { errors++; continue; }
    const games = det?.data?.event?.match?.games || [];
    const game = games.find(g => g.number === bet.map_number);
    if (!game || game.state !== 'completed') { console.error(bet.id.slice(0,8), 'no_game M' + bet.map_number); notfound++; continue; }

    let gd;
    try { gd = await fetchGameData(game, ev.startTime); }
    catch (e) { console.error(bet.id.slice(0,8), 'livestats err:', e.message); errors++; continue; }
    if (!gd) { errors++; continue; }

    console.log(bet.id.slice(0,8), '→ match', ev.match.id, 'M' + game.number, 'kills', gd.total_kills, 'trigger', gd.trigger_type);

    if (!DRY_RUN) {
      const newRaw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
      newRaw.match_context = {
        ...(newRaw.match_context || {}),
        lolesports_match_id: String(ev.match.id),
        lolesports_game_id: gd.game_id,
        start_time: ev.startTime,
        blue_team_id: gd.blue_team_id,
        red_team_id: gd.red_team_id,
        blue_picks: gd.blue_picks,
        red_picks: gd.red_picks,
        kills_blue: gd.kills_blue,
        kills_red: gd.kills_red,
        total_kills: gd.total_kills,
        winner_side: gd.winner_side,
        trigger_type: gd.trigger_type,
        backfill_source: 'manual_fuzzy_match_2026-05-22',
      };
      // patch
      await new Promise((resolve, reject) => {
        const data = JSON.stringify({ raw_extraction: newRaw, pandascore_match_id: Number(ev.match.id) || null });
        const req = https.request({
          hostname: 'yxhpopkxlupdpqkdaffg.supabase.co',
          path: '/rest/v1/bets?id=eq.' + bet.id,
          method: 'PATCH',
          headers: {apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Prefer: 'return=minimal'}
        }, res => { let b=''; res.on('data', c => b+=c); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.write(data); req.end();
      });
    }
    fixed++;
    await new Promise(r => setTimeout(r, 200)); // rate-limit gentle
  }

  console.log(JSON.stringify({ fixed, notfound, errors, dry_run: DRY_RUN }));
})().catch(e => console.error('ERRO:', e.message));
