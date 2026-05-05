// Enrich-match-context: pra cada bet sem raw_extraction.match_context, busca o
// match no lolesports (cache de schedules), busca livestats, e adiciona
// match_context ao raw_extraction. Não mexe em status/profit/settled_at.
//
// Uso:
//   node enrich-match-context.cjs            → roda pra TODAS bets sem match_context
//   node enrich-match-context.cjs --dry-run  → diagnóstico sem PATCH
//   node enrich-match-context.cjs --limit 5  → processa só as 5 primeiras (debug)
//
// Stdout: JSON summary + samples de results

const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Manter sincronizado com analyze_yesterday.cjs:20-21
const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];

// LEAGUE_IDS sem EWC (não está no lolesports — ver knowledge/lessons/2026-05-05-ewc-not-in-lolesports-api.md)
const LEAGUE_IDS = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  MSI: '98767991325878492',
  Worlds: '98767975604431411',
};

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : null;

const norm = s => s ? s.toLowerCase().replace(/[\s.\-']/g, '') : '';
const isPurePeel = sup => sup && PEEL_PURE.includes(norm(sup));
const isFlexEngage = sup => sup && FLEX_ENGAGE.includes(norm(sup));

function detectTrigger(supBlue, supRed) {
  const pures = (isPurePeel(supBlue) ? 1 : 0) + (isPurePeel(supRed) ? 1 : 0);
  const flexes = (isFlexEngage(supBlue) ? 1 : 0) + (isFlexEngage(supRed) ? 1 : 0);
  if (pures === 2) return '2peel';
  if (pures === 1 && flexes >= 1) return '1peel+flex';
  return null;
}

function fetchJsonSafe(host, pathUrl) {
  return new Promise((resolve, reject) => {
    https.get({
      host, path: pathUrl,
      headers: {
        'x-api-key': LOLES_KEY,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function supabaseRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    let data = null;
    if (body !== null) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method, headers,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Pre-fetch schedules: até 5 páginas pra trás de cada liga, com paginação `older`
async function buildScheduleCache() {
  const cache = {}; // { league_short: [ { matchId, startTime, teams: [{code,name},...] } ] }
  for (const [shortName, leagueId] of Object.entries(LEAGUE_IDS)) {
    cache[shortName] = [];
    let pageToken = null;
    for (let pi = 0; pi < 6; pi++) {
      const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}` + (pageToken ? `&pageToken=${pageToken}` : '');
      let r;
      try { r = await fetchJsonSafe('esports-api.lolesports.com', url); }
      catch (e) { console.error(`[cache] ${shortName} page ${pi} falhou: ${e.message}`); break; }
      const events = r?.data?.schedule?.events || [];
      for (const ev of events) {
        if (!ev.match?.id || !ev.startTime) continue;
        cache[shortName].push({
          matchId: String(ev.match.id),
          startTime: ev.startTime,
          state: ev.state,
          teams: (ev.match.teams || []).map(t => ({ code: t.code, name: t.name, id: String(t.id || '') })),
        });
      }
      const olderToken = r?.data?.schedule?.pages?.older;
      if (!olderToken) break;
      pageToken = olderToken;
    }
    console.error(`[cache] ${shortName}: ${cache[shortName].length} matches`);
  }
  return cache;
}

// Infere league_short do texto livre da bet.league
function inferLeagueShort(leagueText) {
  if (!leagueText) return null;
  const u = leagueText.toUpperCase();
  if (/EWC|ESPORTS WORLD CUP/.test(u)) return 'EWC';
  if (/CBLOL|BRASIL/.test(u)) return 'CBLOL';
  if (/\bLCK\b/.test(u)) return 'LCK';
  if (/\bLPL\b/.test(u)) return 'LPL';
  if (/\bLEC\b/.test(u)) return 'LEC';
  if (/\bLCS\b/.test(u)) return 'LCS';
  if (/MSI/.test(u)) return 'MSI';
  if (/WORLDS|CHAMPIONSHIP/.test(u)) return 'Worlds';
  return null;
}

function teamMatch(eventTeams, qA, qB) {
  if (!eventTeams || eventTeams.length !== 2) return false;
  const codes = eventTeams.map(t => norm(t.code));
  const names = eventTeams.map(t => norm(t.name));
  const a = norm(qA), b = norm(qB);
  const matchOne = (q, list) => list.some(item => item === q || (q.length >= 3 && (item.startsWith(q) || q.startsWith(item))));
  return (matchOne(a, codes) || matchOne(a, names)) && (matchOne(b, codes) || matchOne(b, names));
}

function findMatch(cache, leagueShort, teamA, teamB, betDatetime) {
  const candidates = [];
  const betDate = betDatetime ? new Date(betDatetime).toISOString().slice(0, 10) : null;
  const leagues = leagueShort ? [leagueShort] : Object.keys(cache);
  for (const lg of leagues) {
    if (!cache[lg]) continue;
    for (const ev of cache[lg]) {
      const evDate = ev.startTime.slice(0, 10);
      if (betDate) {
        const diff = Math.abs(new Date(evDate) - new Date(betDate)) / (24 * 3600 * 1000);
        if (diff > 2) continue; // janela ±2 dias
      }
      if (!teamMatch(ev.teams, teamA, teamB)) continue;
      candidates.push({ league_short: lg, ...ev });
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && betDate) {
    candidates.sort((a, b) => Math.abs(new Date(a.startTime) - new Date(betDate)) - Math.abs(new Date(b.startTime) - new Date(betDate)));
  }
  return { picked: candidates[0], ambiguous: candidates.length > 1, count: candidates.length };
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
  return fetchJsonSafe('feed.lolesports.com', `/livestats/v1/window/${gameId}?startingTime=${startingTime}`);
}

function extractGameData(window) {
  const meta = window?.gameMetadata;
  if (!meta || !window.frames?.length) return null;
  const lastFrame = window.frames[window.frames.length - 1];
  if (lastFrame.gameState !== 'finished') return { gameState: lastFrame.gameState };
  const picks = (md) => {
    const p = md.participantMetadata;
    const get = role => p.find(x => x.role === role)?.championId || null;
    return { top: get('top'), jungle: get('jungle'), mid: get('mid'), adc: get('bottom'), support: get('support') };
  };
  const blueMeta = meta.blueTeamMetadata;
  const redMeta = meta.redTeamMetadata;
  const blueInh = lastFrame.blueTeam?.inhibitors || 0;
  const redInh = lastFrame.redTeam?.inhibitors || 0;
  let winnerSide = null;
  if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
  return {
    gameState: 'finished',
    kBlue: lastFrame.blueTeam?.totalKills ?? 0,
    kRed: lastFrame.redTeam?.totalKills ?? 0,
    totalKills: (lastFrame.blueTeam?.totalKills ?? 0) + (lastFrame.redTeam?.totalKills ?? 0),
    bluePicks: picks(blueMeta),
    redPicks: picks(redMeta),
    winnerSide,
    blueTeamId: String(blueMeta.esportsTeamId || ''),
    redTeamId: String(redMeta.esportsTeamId || ''),
  };
}

function parsePickLine(pickRaw) {
  const numMatch = (pickRaw || '').match(/(\d+(?:[.,]\d+)?)/);
  return numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;
}

async function processBet(supabaseUrl, supabaseKey, cache, bet) {
  const result = { bet_id: bet.id, league: bet.league, teams: `${bet.team_a} vs ${bet.team_b}` };

  // Já tem match_context?
  if (bet.raw_extraction?.match_context?.lolesports_match_id) {
    result.status = 'skipped';
    result.reason = 'already_has_match_context';
    return result;
  }

  // EWC: não-coberto
  const leagueShort = inferLeagueShort(bet.league);
  if (leagueShort === 'EWC') {
    const newRaw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
    newRaw.match_context = {
      coverage_status: 'ewc_not_in_lolesports',
      league_inferred: 'EWC',
      enriched_at: new Date().toISOString(),
    };
    if (DRY_RUN) {
      result.status = 'dry_run_ewc';
      result.would_set = newRaw.match_context;
      return result;
    }
    try {
      await supabaseRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${bet.id}`, { raw_extraction: newRaw });
      result.status = 'enriched_ewc_marker';
    } catch (e) {
      result.status = 'error';
      result.reason = `patch_ewc: ${e.message}`;
    }
    return result;
  }

  // Busca match
  const found = findMatch(cache, leagueShort, bet.team_a, bet.team_b, bet.bet_datetime);
  if (!found) {
    result.status = 'skipped';
    result.reason = `no_match_found (league=${leagueShort || 'unknown'}, ${bet.team_a} vs ${bet.team_b}, ${bet.bet_datetime?.slice(0,10)})`;
    return result;
  }
  const { picked, ambiguous } = found;

  // Busca eventDetails → games
  let detail;
  try {
    detail = await fetchJsonSafe('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${picked.matchId}`);
  } catch (e) {
    result.status = 'error';
    result.reason = `eventDetails: ${e.message}`;
    return result;
  }
  const games = detail?.data?.event?.match?.games || [];

  // Localiza game pelo map_number (se is_map_bet) ou primeiro completed
  let game;
  if (bet.is_map_bet && bet.map_number) {
    game = games.find(g => g.number === bet.map_number);
  } else {
    game = games.find(g => g.state === 'completed') || games[0];
  }
  if (!game) {
    result.status = 'skipped';
    result.reason = `no_game_for_map_${bet.map_number}`;
    return result;
  }
  if (game.state !== 'completed') {
    result.status = 'skipped';
    result.reason = `game_state_${game.state}`;
    return result;
  }

  // Busca livestats
  let win;
  try { win = await fetchGameWindow(game.id, picked.startTime); }
  catch (e) {
    result.status = 'error';
    result.reason = `livestats: ${e.message}`;
    return result;
  }
  const gd = extractGameData(win);
  if (!gd || gd.gameState !== 'finished') {
    result.status = 'skipped';
    result.reason = `game_window_${gd?.gameState || 'no_data'}`;
    return result;
  }

  // Detecta trigger e under_hit
  const triggerType = detectTrigger(gd.bluePicks.support, gd.redPicks.support);
  const pickLine = parsePickLine(bet.pick);
  const underHit = pickLine != null ? gd.totalKills < pickLine : null;

  // Monta novo raw_extraction (preserva campos antigos)
  const newRaw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
  newRaw.match_context = {
    coverage_status: 'enriched',
    league_inferred: picked.league_short,
    lolesports_match_id: picked.matchId,
    lolesports_game_id: String(game.id),
    blue_team_id: gd.blueTeamId,
    red_team_id: gd.redTeamId,
    blue_picks: gd.bluePicks,
    red_picks: gd.redPicks,
    kills_blue: gd.kBlue,
    kills_red: gd.kRed,
    total_kills: gd.totalKills,
    winner_side: gd.winnerSide,
    trigger_type: triggerType,
    pick_line: pickLine,
    under_hit: underHit,
    match_ambiguous_at_link: ambiguous,
    enriched_at: new Date().toISOString(),
  };

  if (DRY_RUN) {
    result.status = 'dry_run_would_enrich';
    result.would_set = newRaw.match_context;
    return result;
  }

  try {
    await supabaseRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${bet.id}`, { raw_extraction: newRaw });
    result.status = 'enriched';
    result.kills = gd.totalKills;
    result.trigger = triggerType;
    result.supports = `${gd.bluePicks.support}/${gd.redPicks.support}`;
    result.under_hit = underHit;
  } catch (e) {
    result.status = 'error';
    result.reason = `patch: ${e.message}`;
  }
  return result;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  console.error('[1/3] Construindo cache de schedules das ligas operadas...');
  const cache = await buildScheduleCache();

  console.error('[2/3] Lendo bets do Supabase...');
  const all = await new Promise((resolve, reject) => {
    const u = new URL(`${supabaseUrl}/rest/v1/bets?select=*&limit=500`);
    https.get({
      host: u.hostname, path: u.pathname + u.search,
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  const target = all.filter(b => !b.raw_extraction?.match_context?.lolesports_match_id);
  const toProcess = LIMIT ? target.slice(0, LIMIT) : target;
  console.error(`[3/3] Processando ${toProcess.length}/${target.length} bets sem match_context...`);

  const summary = {
    total_bets: all.count || all.length,
    needing_enrichment: target.length,
    processed: toProcess.length,
    enriched: 0,
    enriched_ewc_marker: 0,
    skipped: 0,
    errors: 0,
    dry_run: DRY_RUN,
    by_status: {},
    samples: [],
  };

  for (let i = 0; i < toProcess.length; i++) {
    const bet = toProcess[i];
    const r = await processBet(supabaseUrl, supabaseKey, cache, bet);
    summary.by_status[r.status] = (summary.by_status[r.status] || 0) + 1;
    if (r.status === 'enriched' || r.status === 'dry_run_would_enrich') summary.enriched++;
    else if (r.status === 'enriched_ewc_marker' || r.status === 'dry_run_ewc') summary.enriched_ewc_marker++;
    else if (r.status === 'error') summary.errors++;
    else summary.skipped++;
    if (summary.samples.length < 8) summary.samples.push(r);
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${toProcess.length}...`);
    // pequena pausa pra não martelar API
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(JSON.stringify(summary, null, 2));
})().catch(e => {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
});
