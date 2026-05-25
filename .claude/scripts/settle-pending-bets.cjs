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
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./_load-config.cjs');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const CRON_DIR = path.resolve(__dirname, '..', '..', 'cron-data');
const PEEL_PURE_SETTLE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
const MIN_SAMPLE_SETTLE = 5;

// Carrega avgs de time a partir do results.json do dia, pra calcular fair_formula no settle.
// Lê todos os results.json disponíveis no cron-data pra montar histórico 21d.
function buildTeamAvgsFromResults(targetDate) {
  const cutoff = new Date(targetDate + 'T00:00:00Z');
  cutoff.setDate(cutoff.getDate() - 21);
  const since = cutoff.toISOString().slice(0, 10);

  const teamHist = new Map();
  const leagueHist = new Map();

  const files = fs.existsSync(CRON_DIR)
    ? fs.readdirSync(CRON_DIR).filter(f => f.endsWith('-results.json'))
    : [];

  for (const file of files) {
    const dateStr = file.slice(0, 10);
    if (dateStr < since || dateStr > targetDate) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CRON_DIR, file), 'utf8'));
      for (const r of data.results || []) {
        if (r.total_kills == null) continue;
        for (const team of [r.team_blue, r.team_red]) {
          if (!team) continue;
          if (!teamHist.has(team)) teamHist.set(team, []);
          teamHist.get(team).push(r.total_kills);
        }
        const lg = r.league;
        if (lg) {
          if (!leagueHist.has(lg)) leagueHist.set(lg, []);
          leagueHist.get(lg).push(r.kills_blue ?? 0, r.kills_red ?? 0);
        }
      }
    } catch { /* arquivo corrompido: pula */ }
  }

  const teamAvg = new Map();
  for (const [t, arr] of teamHist) {
    teamAvg.set(t, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  const leagueAvg = new Map();
  for (const [l, arr] of leagueHist) {
    leagueAvg.set(l, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return { teamAvg, teamHist, leagueAvg };
}

// Calcula fair_formula para um bet usando histório de times.
function calcFairFormula(bet, teamHist, leagueAvg) {
  const mc = bet.raw_extraction?.match_context || {};
  const teamA = normalizeTeam(mc.teams?.[0]?.name || bet.team_a);
  const teamB = normalizeTeam(mc.teams?.[1]?.name || bet.team_b);
  const lg = (bet.league || '').toUpperCase().replace(/\s+/g,'');
  const lgKey = ['LCK','LPL','LEC','CBLOL','LFL','LCS'].find(k => lg.includes(k)) || null;

  const aHist = teamHist.get(teamA) || [];
  const bHist = teamHist.get(teamB) || [];
  const lAvgPerSide = leagueAvg.get(lgKey) ?? 14.5;
  const lAvgTotal = lAvgPerSide * 2;

  const aAvg = aHist.length >= MIN_SAMPLE_SETTLE
    ? aHist.reduce((a, b) => a + b, 0) / aHist.length
    : lAvgTotal;
  const bAvg = bHist.length >= MIN_SAMPLE_SETTLE
    ? bHist.reduce((a, b) => a + b, 0) / bHist.length
    : lAvgTotal;

  const raw = aAvg + bAvg;
  const formula = Math.round(raw / 2 - 0.5) + 0.5;
  return +formula.toFixed(1);
}

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Manter sincronizado com analyze_yesterday.cjs:20-21
const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
// FLEX expandido 2026-05-23 (CEO): Lux + Anivia
const FLEX_ENGAGE = ['bard','rakan','alistar','lux','anivia'];

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
// Fix 2026-05-23: usa o ÚLTIMO número da string (evita capturar "Mapa 4" em "Total. Mapa 4 Menos de 27.5")
function parsePick(pickRaw, market) {
  const lower = (pickRaw || '').toLowerCase();
  const allMatches = Array.from(lower.matchAll(/(\d+(?:[.,]\d+)?)/g));
  const numMatch = allMatches.length ? allMatches[allMatches.length - 1] : null;
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
  // Guard: se matchStart é null/inválido, vira Date(null)=epoch 1970+6h e livestats
  // retorna body vazio (jogo nem existia). Fallback pra "agora-60s" preserva safety.
  const startMs = matchStart ? new Date(matchStart).getTime() : NaN;
  const baseMs = Number.isFinite(startMs) && startMs > 0 ? startMs + 6 * 3600 * 1000 : Date.now() - 200 * 1000;
  const targetMs = Math.min(baseMs, Date.now() - 200 * 1000);
  const startingTime = tsRoundedTo10s(new Date(targetMs));
  return fetchJson('feed.lolesports.com', `/livestats/v1/window/${gameId}?startingTime=${startingTime}`);
}

// Fix 2+3: detecta frame suspeito (CDN stale ou snapshot do início do jogo).
// Retorna true se o frame NÃO pode ser considerado definitivo.
// Condição: gameState !== 'finished' E (gameTime < 600s OU total_kills < 5).
// Se gameState === 'finished', o frame é autorizado pelo próprio feed — não recusa.
function isFrameSuspect(frame) {
  if (!frame) return true;
  if (frame.gameState === 'finished') return false; // feed confirmou: aceita
  const gameTimeSecs = (frame.gameTime ?? 0) / 1000; // gameTime vem em ms no feed
  const totalKills = (frame.blueTeam?.totalKills ?? 0) + (frame.redTeam?.totalKills ?? 0);
  return gameTimeSecs < 600 || totalKills < 5;
}

function extractGameData(window, trustCompleted) {
  const meta = window?.gameMetadata;
  if (!meta || !window.frames?.length) return null;
  const lastFrame = window.frames[window.frames.length - 1];

  // Fix 2+3: mesmo com trustCompleted=true (eventDetails diz 'completed'),
  // o frame pode ser stale do CDN. Verifica se é suspeito antes de aceitar.
  // Se suspeito → retorna sinal especial pra forçar retry na próxima execução.
  if (trustCompleted && isFrameSuspect(lastFrame)) {
    const gameTimeSecs = ((lastFrame.gameTime ?? 0) / 1000).toFixed(0);
    const totalKills = (lastFrame.blueTeam?.totalKills ?? 0) + (lastFrame.redTeam?.totalKills ?? 0);
    return {
      gameState: lastFrame.gameState,
      suspect: true,
      suspect_reason: `gameState=${lastFrame.gameState} gameTime=${gameTimeSecs}s kills=${totalKills} (stale CDN suspected)`,
    };
  }

  // Riot API às vezes nunca publica frame com gameState='finished' mesmo quando
  // eventDetails marca o game como completed. Se trustCompleted=true (eventDetails
  // confirmou completed) e frame não é suspeito, usar último frame disponível.
  if (!trustCompleted && lastFrame.gameState !== 'finished') return { gameState: lastFrame.gameState };

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

  // Top 5 campos extras (fix 2026-05-22 — CEO request "tem acesso a isso tmb")
  // Extraction defensiva: cada campo cai pra null se não existir
  const gameDurationSecs = lastFrame.gameTime != null ? Math.round(lastFrame.gameTime / 1000) : null;
  const safe = (v) => v != null ? v : null;

  // Procura frame ~15min (900000ms) pra kills_at_15min e gold_diff_at_15min
  let frame15 = null;
  for (const f of window.frames) {
    if (f.gameTime != null && f.gameTime >= 900000) { frame15 = f; break; }
  }
  const kills15 = frame15 ? (frame15.blueTeam?.totalKills ?? 0) + (frame15.redTeam?.totalKills ?? 0) : null;
  const goldDiff15 = frame15 ? ((frame15.blueTeam?.totalGold ?? 0) - (frame15.redTeam?.totalGold ?? 0)) : null;

  // First blood: primeiro frame com kills > 0 (qualquer lado)
  let firstBloodTeam = null;
  for (const f of window.frames) {
    const kB = f.blueTeam?.totalKills ?? 0;
    const kR = f.redTeam?.totalKills ?? 0;
    if (kB > 0 || kR > 0) {
      firstBloodTeam = kB >= kR ? 'blue' : 'red';
      break;
    }
  }

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
    // === Top 5 extras ===
    gameDurationSecs,
    firstBloodTeam,
    killsAt15min: kills15,
    goldDiffAt15min: goldDiff15,
    blueDragons: Array.isArray(lastFrame.blueTeam?.dragons) ? lastFrame.blueTeam.dragons.length : safe(lastFrame.blueTeam?.dragons),
    redDragons: Array.isArray(lastFrame.redTeam?.dragons) ? lastFrame.redTeam.dragons.length : safe(lastFrame.redTeam?.dragons),
    blueBarons: safe(lastFrame.blueTeam?.barons),
    redBarons: safe(lastFrame.redTeam?.barons),
    blueTowers: safe(lastFrame.blueTeam?.towers),
    redTowers: safe(lastFrame.redTeam?.towers),
    blueTotalGold: safe(lastFrame.blueTeam?.totalGold),
    redTotalGold: safe(lastFrame.redTeam?.totalGold),
    blueBans: Array.isArray(blueMeta.bans) ? blueMeta.bans : null,
    redBans: Array.isArray(redMeta.bans) ? redMeta.bans : null,
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

// Fix 1: gameWindowCache compartilhado entre chamadas da mesma execução do script.
// Evita que 2+ bets do mesmo lolesports_game_id façam requests duplicados ao CDN,
// o que poderia resultar em snapshots stale diferentes pra cada bet.
async function settleBet(supabaseUrl, supabaseKey, bet, gameWindowCache) {
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

  // 3. window livestats — Fix 1: cache por game_id pra evitar requests duplicados
  const matchStart = detail?.data?.event?.startTime || bet.bet_datetime;
  let win;
  const cacheKey = String(game.id);
  if (gameWindowCache.has(cacheKey)) {
    win = gameWindowCache.get(cacheKey);
    // log só em dry-run pra não poluir output normal
    if (DRY_RUN) process.stderr.write(`[cache hit] game_id=${cacheKey} reusado sem novo request\n`);
  } else {
    try {
      win = await fetchGameWindow(game.id, matchStart);
      gameWindowCache.set(cacheKey, win); // armazena pra demais bets do mesmo game
    } catch (e) {
      return { bet_id: bet.id, status: 'error', reason: `livestats: ${e.message}` };
    }
  }

  // game.state === 'completed' no eventDetails é a fonte autoritativa do "jogo terminou".
  // Passamos trustCompleted=true pra extractGameData usar último frame disponível mesmo
  // que gameState do frame esteja 'in_game' (Riot às vezes não publica frame final).
  const trustCompleted = game.state === 'completed';
  const gd = extractGameData(win, trustCompleted);
  if (!gd) return { bet_id: bet.id, status: 'error', reason: 'livestats_no_data' };

  // Fix 2+3: frame suspeito (CDN stale) → skip pra retry na próxima execução
  if (gd.suspect) {
    process.stderr.write(`[WARN] bet=${bet.id} game=${cacheKey} frame suspeito: ${gd.suspect_reason}\n`);
    return { bet_id: bet.id, status: 'skipped', reason: `suspect_frame: ${gd.suspect_reason}` };
  }

  if (gd.gameState && gd.gameState !== 'finished' && !trustCompleted) {
    return { bet_id: bet.id, status: 'skipped', reason: `game_window_state_${gd.gameState}` };
  }

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

  // Series score at bet: conta quantos games estavam completed antes desse map
  let seriesScoreAtBet = null;
  if (bet.map_number && bet.map_number > 1) {
    let blueWins = 0, redWins = 0;
    for (const g of games) {
      if (g.number >= bet.map_number) break;
      // Pra contar wins precisaria dos resultados — usamos game.state + cap simples
      // (deixa só "X mapas já jogados antes" como aproximação)
    }
    const mapsPlayedBefore = games.filter(g => g.number < bet.map_number && g.state === 'completed').length;
    seriesScoreAtBet = { maps_completed_before: mapsPlayedBefore, current_map: bet.map_number };
  }

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
    // === Top 5 extras (fix 2026-05-22) ===
    game_duration_secs: gd.gameDurationSecs,
    first_blood_team: gd.firstBloodTeam,
    kills_at_15min: gd.killsAt15min,
    gold_diff_at_15min: gd.goldDiffAt15min,
    blue_dragons: gd.blueDragons,
    red_dragons: gd.redDragons,
    blue_barons: gd.blueBarons,
    red_barons: gd.redBarons,
    blue_towers: gd.blueTowers,
    red_towers: gd.redTowers,
    blue_total_gold: gd.blueTotalGold,
    red_total_gold: gd.redTotalGold,
    blue_bans: gd.blueBans,
    red_bans: gd.redBans,
    series_score_at_bet: seriesScoreAtBet,
  };

  // Calcula fair_pinnacle/fair_formula pra popular as colunas dedicadas no settle.
  // Essa é a janela onde Pinnacle já foi logado (Elvis roda /log-fair antes do jogo).
  const betDateStr = (bet.bet_datetime || '').slice(0, 10);
  const pinnacleMap = betDateStr ? loadFairPinnacle(betDateStr) : { byMatchId: new Map() };
  const matchIdStr = bet.raw_extraction?.match_context?.lolesports_match_id;
  const fairPinnacleSettle = matchIdStr
    ? (pinnacleMap.byMatchId.get(String(matchIdStr)) ?? null)
    : null;

  const { teamHist: tHist, leagueAvg: lAvg } = buildTeamAvgsFromResults(betDateStr || new Date().toISOString().slice(0, 10));
  const fairFormulaSettle = calcFairFormula(bet, tHist, lAvg);

  const fairLineSourceSettle = fairPinnacleSettle != null
    ? 'pinnacle_manual'
    : fairFormulaSettle != null
      ? 'formula'
      : 'fallback_29.5';

  // Schema da tabela bets NÃO tem coluna under_hit (essa é da method_reports).
  // under_hit fica em raw_extraction.match_context (JSONB) acima.
  const update = {
    status,
    profit,
    settled_at: new Date().toISOString(),
    settle_source: `lolesports api - ${gd.totalKills} kills`,
    raw_extraction: newRawExtraction,
    // Popula colunas de fair só se ainda NULL no banco (bet não sobrescreve valor já presente)
    ...(bet.fair_pinnacle == null && fairPinnacleSettle != null ? { fair_pinnacle: fairPinnacleSettle } : {}),
    ...(bet.fair_formula == null && fairFormulaSettle != null ? { fair_formula: fairFormulaSettle } : {}),
    ...(bet.fair_line_source == null ? { fair_line_source: fairLineSourceSettle } : {}),
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

  // Fix 1: cache compartilhado por execução — 1 request por game_id, independente
  // de quantas bets apontem pro mesmo lolesports_game_id nessa rodada.
  const gameWindowCache = new Map();

  for (const bet of pending) {
    if (bet.status !== 'pending' && !SPECIFIC_BET_ID) continue;
    const result = await settleBet(supabaseUrl, supabaseKey, bet, gameWindowCache);
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
