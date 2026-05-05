// Settle bets pending: busca resultado via lolesports livestats, atualiza bets table.
//
// Uso:
//   node settle-pending-bets.cjs            → tenta settle de TODAS bets pending
//   node settle-pending-bets.cjs <bet_id>   → tenta settle só dessa bet (uuid)
//   node settle-pending-bets.cjs --dry-run  → diagnóstico sem PATCH
//
// Stdout: JSON com summary { checked, settled, skipped_not_finished, skipped_no_match, errors }
//
// Pra cada bet pending:
//   1. lê raw_extraction.match_context.lolesports_match_id
//   2. fetcha getEventDetails → identifica o game pelo map_number da bet
//   3. fetcha livestats window → kills, supports, picks, winner
//   4. decide green/red baseado em pick (Under/Over/Money Line)
//   5. PATCH bet com status, profit, settled_at, settle_source, raw_extraction enriquecido

const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Manter sincronizado com analyze_yesterday.cjs:20-21
const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SPECIFIC_BET_ID = argv.find(a => a !== '--dry-run' && /^[a-f0-9-]{36}$/i.test(a)) || null;

function fetchJson(host, pathUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({
      host, path: pathUrl,
      headers: {
        'x-api-key': LOLES_KEY,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
        ...headers,
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

const norm = s => s ? s.toLowerCase().replace(/\s+/g, '') : '';
const isPurePeel = sup => sup && PEEL_PURE.includes(norm(sup));
const isFlexEngage = sup => sup && FLEX_ENGAGE.includes(norm(sup));

function detectTrigger(supBlue, supRed) {
  const pures = (isPurePeel(supBlue) ? 1 : 0) + (isPurePeel(supRed) ? 1 : 0);
  const flexes = (isFlexEngage(supBlue) ? 1 : 0) + (isFlexEngage(supRed) ? 1 : 0);
  if (pures === 2) return '2peel';
  if (pures === 1 && flexes >= 1) return '1peel+flex';
  return null;
}

// Parser do pick: "Menos de 27.5" / "Under 27.5" / "Mais de 27.5" / "Over 27.5" / nome de time
function parsePick(pickRaw, market) {
  const lower = (pickRaw || '').toLowerCase();
  const numMatch = lower.match(/(\d+(?:[.,]\d+)?)/);
  const line = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;

  if (/menos\s*de|under/i.test(pickRaw || '')) {
    return { kind: 'under', line };
  }
  if (/mais\s*de|over/i.test(pickRaw || '')) {
    return { kind: 'over', line };
  }
  if (/money\s*line|vencedor|resultado\s*final/i.test(market || '')) {
    return { kind: 'moneyline', team_pick: pickRaw };
  }
  return { kind: 'unknown' };
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

function extractGameData(window) {
  const meta = window?.gameMetadata;
  if (!meta || !window.frames?.length) return null;
  const lastFrame = window.frames[window.frames.length - 1];
  if (lastFrame.gameState !== 'finished') return { gameState: lastFrame.gameState };

  const picks = (md) => {
    const p = md.participantMetadata;
    const get = role => p.find(x => x.role === role)?.championId || null;
    return {
      top: get('top'), jungle: get('jungle'), mid: get('mid'),
      adc: get('bottom'), support: get('support'),
    };
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
    blueTeamId: blueMeta.esportsTeamId,
    redTeamId: redMeta.esportsTeamId,
  };
}

function decideOutcome(bet, gameData) {
  const parsed = parsePick(bet.pick, bet.market);
  const tk = gameData.totalKills;

  if (parsed.kind === 'under' && parsed.line != null) {
    const won = tk < parsed.line;
    return { won, under_hit: won, parsed };
  }
  if (parsed.kind === 'over' && parsed.line != null) {
    const won = tk > parsed.line;
    return { won, under_hit: tk < parsed.line, parsed };
  }
  if (parsed.kind === 'moneyline') {
    // Compara nome do pick com nome dos times via match_context (se tiver) ou heuristica
    // Pra Money Line, settle exige saber qual side é o time apostado.
    // Sem match_context.blue_team_code/red_team_code do placement, fica indeterminável.
    // Por enquanto, marca como skip-moneyline. TODO: melhorar quando tivermos team mapping no placement.
    return { skip_reason: 'moneyline_settle_not_implemented_yet', parsed };
  }
  return { skip_reason: 'pick_kind_unknown', parsed };
}

async function settleBet(supabaseUrl, supabaseKey, bet) {
  const matchId = bet.raw_extraction?.match_context?.lolesports_match_id;
  if (!matchId) return { bet_id: bet.id, status: 'skipped', reason: 'no_match_id_in_raw_extraction' };

  // 1. eventDetails → games
  let detail;
  try {
    detail = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`);
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `eventDetails: ${e.message}` };
  }
  const games = detail?.data?.event?.match?.games || [];
  if (games.length === 0) return { bet_id: bet.id, status: 'skipped', reason: 'no_games_in_match' };

  // 2. localiza o game pelo map_number (se is_map_bet) ou primeiro completed (se match-level)
  let game;
  if (bet.is_map_bet && bet.map_number) {
    game = games.find(g => g.number === bet.map_number);
  } else {
    game = games.find(g => g.state === 'completed') || games[0];
  }
  if (!game) return { bet_id: bet.id, status: 'skipped', reason: `no_game_for_map_${bet.map_number}` };
  if (game.state !== 'completed') return { bet_id: bet.id, status: 'skipped', reason: `game_state_${game.state}` };

  // 3. window livestats
  const matchStart = detail?.data?.event?.startTime || bet.bet_datetime;
  let win;
  try {
    win = await fetchGameWindow(game.id, matchStart);
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `livestats: ${e.message}` };
  }
  const gd = extractGameData(win);
  if (!gd) return { bet_id: bet.id, status: 'error', reason: 'livestats_no_data' };
  if (gd.gameState !== 'finished') return { bet_id: bet.id, status: 'skipped', reason: `game_window_state_${gd.gameState}` };

  // 4. decide outcome
  const outcome = decideOutcome(bet, gd);
  if (outcome.skip_reason) return { bet_id: bet.id, status: 'skipped', reason: outcome.skip_reason };

  // 5. detecta trigger
  const triggerType = detectTrigger(gd.bluePicks.support, gd.redPicks.support);

  // 6. monta update payload
  const stake = parseFloat(bet.stake);
  const odd = parseFloat(bet.odd);
  const profit = outcome.won ? +(stake * (odd - 1)).toFixed(2) : -stake;
  const status = outcome.won ? 'green' : 'red';

  const newRawExtraction = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
  newRawExtraction.match_context = {
    ...(newRawExtraction.match_context || {}),
    lolesports_game_id: String(game.id),
    blue_team_id: String(gd.blueTeamId || ''),
    red_team_id: String(gd.redTeamId || ''),
    blue_picks: gd.bluePicks,
    red_picks: gd.redPicks,
    kills_blue: gd.kBlue,
    kills_red: gd.kRed,
    total_kills: gd.totalKills,
    winner_side: gd.winnerSide,
    trigger_type: triggerType,
    under_hit: outcome.under_hit,
    settled_at: new Date().toISOString(),
  };

  // Schema da tabela bets NÃO tem coluna under_hit (essa é da method_reports).
  // under_hit fica em raw_extraction.match_context (JSONB) acima.
  const update = {
    status,
    profit,
    settled_at: new Date().toISOString(),
    settle_source: `lolesports api - ${gd.totalKills} kills`,
    raw_extraction: newRawExtraction,
  };

  if (DRY_RUN) {
    return { bet_id: bet.id, status: 'dry_run_would_update', would_update: update, total_kills: gd.totalKills, trigger: triggerType };
  }

  try {
    await supabaseRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${bet.id}`, update);
    return { bet_id: bet.id, status: 'settled', outcome: status, total_kills: gd.totalKills, profit, trigger: triggerType, supports: `${gd.bluePicks.support}/${gd.redPicks.support}` };
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `patch: ${e.message}` };
  }
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // 1. busca pending bets
  let pendingUrl = `${supabaseUrl}/rest/v1/bets?status=eq.pending&select=*`;
  if (SPECIFIC_BET_ID) {
    pendingUrl = `${supabaseUrl}/rest/v1/bets?id=eq.${SPECIFIC_BET_ID}&select=*`;
  }
  const u = new URL(pendingUrl);
  const pending = await new Promise((resolve, reject) => {
    https.get({
      host: u.hostname, path: u.pathname + u.search,
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  if (pending.length === 0) {
    console.log(JSON.stringify({ checked: 0, settled: 0, message: SPECIFIC_BET_ID ? `bet ${SPECIFIC_BET_ID} não encontrada` : 'nenhuma bet pending' }));
    return;
  }

  const summary = { checked: pending.length, settled: 0, skipped: 0, errors: 0, dry_run: DRY_RUN, results: [] };

  for (const bet of pending) {
    if (bet.status !== 'pending' && !SPECIFIC_BET_ID) continue;
    const result = await settleBet(supabaseUrl, supabaseKey, bet);
    summary.results.push(result);
    if (result.status === 'settled') summary.settled++;
    else if (result.status === 'error') summary.errors++;
    else summary.skipped++;
  }

  console.log(JSON.stringify(summary, null, 2));
})().catch(e => {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
});
