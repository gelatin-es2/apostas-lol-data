// scripts/analysis/camille-collect.cjs
//
// Coleta o universo de jogos de TODAS as ligas da lolesports API (getLeagues) pro
// período 2026-04-01 → 2026-07-21 (inclusive) — expansão de amostra pedida pelo dono
// pra validar Camille support / Rell+Nautilus com dado maior que as 6 ligas do split2.
//
// Mesma arquitetura de scripts/audit/phase0-universe.cjs (schedule paginado →
// eventDetails → livestats window, cache em audit-cache/, throttle 250ms, retry
// 1+3 com backoff) — mas parametrizada por uma lista DINÂMICA de ligas (getLeagues),
// não a lista fixa de 6 (LEAGUE_IDS). audit-cache/ é compartilhado — as 6 ligas do
// split2 batem cache pra tudo que já foi buscado (só paga rede pelo período novo
// 07-01→07-21); as ~37 ligas novas pagam rede quase inteira.
//
// Exclui só tft_esports (Teamfight Tactics — jogo diferente, kills não se aplica).
// Todo o resto é tentado; liga com schedule vazio no período é registrada e pulada
// (não é erro, é ausência real de jogos completed nesse recorte).
//
// Uso: node scripts/analysis/camille-collect.cjs
// Output: audit-output/00-universe-allregions.json (merge por liga, salvo
// incrementalmente após CADA liga — sobrevive a interrupção) +
// audit-output/fetch-errors-allregions.json
//
// Roda LONGO (dezenas de minutos, ~40 ligas) — pensado pra rodar em background.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  getSchedulePage,
  getEventDetails,
  getWindow,
  getTeams,
  getLeagues,
  tsRoundedTo10sCapped,
} = require('../audit/lib/api-cache.cjs');

const { detectTrigger, extractGameData, isFrameSuspect } = require('../audit/lib/audit-common.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');

// --- CLI (todos opcionais; defaults = comportamento original de 2026-07-22) ---
// --from=YYYY-MM-DD --to=YYYY-MM-DD (exclusivo) --out=nome.json
// --fresh-schedule  → ignora o cache das páginas de schedule (obrigatório quando o
//                     range pedido é MAIS RECENTE que a última coleta: a página 0 em
//                     disco é de uma run antiga e não contém os jogos novos).
const argOf = (name, fallback) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
};
const FROM = argOf('from', '2026-04-01');
const TO = argOf('to', '2026-07-22'); // exclusivo — default captura até 2026-07-21 inclusive
const OUT_NAME = argOf('out', '00-universe-allregions.json');
const FRESH_SCHEDULE = process.argv.includes('--fresh-schedule');
const FRESH_EVENTS = process.argv.includes('--fresh-events');
const TRUST_SCHEDULE_COMPLETED = process.argv.includes('--trust-schedule-completed');

const UNIVERSE_FILE = path.join(OUTPUT_DIR, OUT_NAME);
const FETCH_ERRORS_FILE = path.join(
  OUTPUT_DIR,
  OUT_NAME === '00-universe-allregions.json'
    ? 'fetch-errors-allregions.json'
    : `fetch-errors-${OUT_NAME.replace(/^00-universe-?/, '').replace(/\.json$/, '') || 'collect'}.json`
);

const EXCLUDE_SLUGS = new Set(['tft_esports']); // jogo diferente (Teamfight Tactics)

const SAFETY_PAGE_CAP = 30;
const OFFSET_HOURS_TRY_ORDER = [6, 2, 4, 8];
const PROGRESS_EVERY = 25;

function loadJsonArraySafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
function logFetchError(errorsArr, entry) {
  const full = { ts: new Date().toISOString(), ...entry };
  errorsArr.push(full);
  process.stderr.write(`  [FETCH ERROR] ${entry.stage} league=${entry.league} ${entry.message}\n`);
}

// sync: scripts/audit/phase0-universe.cjs fetchLeagueEvents — mesma lógica, leagueId
// dinâmico (não vem de LEAGUE_IDS fixo).
async function fetchLeagueEvents(leagueId, leagueName, errorsArr) {
  const events = [];
  let pageToken = null;
  let oldestSeen = '9999-12-31';
  let pageIndex = 0;
  let hitSafetyCap = false;

  while (pageIndex < SAFETY_PAGE_CAP) {
    let page;
    try {
      page = await getSchedulePage(leagueId, pageToken, { pageIndex, noCache: FRESH_SCHEDULE });
    } catch (e) {
      logFetchError(errorsArr, { stage: 'schedule', league: leagueName, pageIndex, message: e.message, statusCode: e.statusCode ?? null });
      break;
    }
    const sched = page?.data?.schedule;
    const pageEvents = sched?.events || [];
    for (const ev of pageEvents) {
      if (!ev.startTime) continue;
      const date = ev.startTime.slice(0, 10);
      if (date < oldestSeen) oldestSeen = date;
      if (ev.state === 'completed' && date >= FROM && date < TO) events.push(ev);
    }
    const olderToken = sched?.pages?.older;
    pageIndex++;
    if (!olderToken) break;
    if (oldestSeen < FROM) break;
    pageToken = olderToken;
  }
  if (pageIndex >= SAFETY_PAGE_CAP) {
    hitSafetyCap = true;
    console.error(`  [${leagueName}] ATENÇÃO: cap de segurança (${SAFETY_PAGE_CAP} páginas) sem achar oldestDate < ${FROM} (visto: ${oldestSeen})`);
  }
  return { events, oldestSeen, hitSafetyCap };
}

async function fetchGamesForMatch(matchId, leagueName, errorsArr) {
  let detail;
  try {
    detail = await getEventDetails(matchId, { noCache: FRESH_EVENTS });
  } catch (e) {
    logFetchError(errorsArr, { stage: 'eventDetails', league: leagueName, matchId: String(matchId), message: e.message, statusCode: e.statusCode ?? null });
    return [];
  }
  const games = detail?.data?.event?.match?.games || [];
  const completed = games.filter((g) => g.state === 'completed');
  // Bug conhecido da Riot (documentado na revisão de 2026-07-26): getEventDetails
  // serve estado VELHO — o schedule já diz `completed` mas os games continuam
  // `unstarted`. Com --trust-schedule-completed a gente aceita todos os games do
  // match e deixa o livestats decidir: game que não rolou não devolve frame válido
  // e cai no filtro de `suspect` lá na frente. Custa alguns requests à toa, mas não
  // perde jogo real (sem isso, dias recentes de LCS/CBLOL/LEC somem da coleta).
  if (TRUST_SCHEDULE_COMPLETED && completed.length === 0 && games.length > 0) return games;
  return completed;
}

async function fetchGameWindow(gameId, matchStartISO, leagueName, matchId, errorsArr) {
  const baseMs = matchStartISO ? new Date(matchStartISO).getTime() : NaN;
  if (!Number.isFinite(baseMs)) return { window: null, error: 'invalid_match_start_time' };

  let lastWindow = null;
  let lastNetworkError = null;
  for (const hours of OFFSET_HOURS_TRY_ORDER) {
    const startingTime = tsRoundedTo10sCapped(baseMs + hours * 3600 * 1000);
    let win;
    try {
      win = await getWindow(gameId, startingTime);
    } catch (e) {
      lastNetworkError = e.message;
      logFetchError(errorsArr, { stage: 'window', league: leagueName, matchId: String(matchId), gameId: String(gameId), offsetHours: hours, message: e.message, statusCode: e.statusCode ?? null });
      continue;
    }
    lastWindow = win;
    const hasFrames = win && Array.isArray(win.frames) && win.frames.length > 0 && win.gameMetadata;
    if (hasFrames) return { window: win, error: null };
  }
  return { window: lastWindow, error: lastNetworkError ? `no_valid_frames_after_all_offsets (last network error: ${lastNetworkError})` : 'no_valid_frames_after_all_offsets' };
}

async function processLeague(leagueId, leagueName, teamsMap, errorsArr) {
  console.error(`\n=== ${leagueName} (${leagueId}) ===`);
  const { events, oldestSeen, hitSafetyCap } = await fetchLeagueEvents(leagueId, leagueName, errorsArr);
  console.error(`  [${leagueName}] matches completed no período: ${events.length} | oldestDate visto: ${oldestSeen}`);
  if (events.length === 0) {
    return { games: [], summary: { league: leagueName, league_id: leagueId, matches: 0, games: 0, games_with_trigger: 0, suspects: 0, fetch_errors: 0, oldest_date_seen: oldestSeen, hit_safety_cap: hitSafetyCap, no_data: true } };
  }

  const gamesOut = [];
  let gameCounter = 0;
  let suspectCount = 0;
  let triggerCount = 0;

  for (const ev of events) {
    const matchId = ev.match?.id || ev.id;
    const matchStart = ev.startTime;
    const teamsMatch = (ev.match?.teams || []).map((t) => t.name || t.code || String(t.id));

    const games = await fetchGamesForMatch(matchId, leagueName, errorsArr);
    for (const g of games) {
      gameCounter++;
      if (gameCounter % PROGRESS_EVERY === 0) console.error(`  [${leagueName}] progresso: ${gameCounter} games processados...`);

      const { window, error: windowError } = await fetchGameWindow(g.id, matchStart, leagueName, matchId, errorsArr);
      const gd = window ? extractGameData(window) : null;

      const record = {
        game_id: String(g.id),
        match_id: String(matchId),
        league: leagueName,
        league_id: String(leagueId),
        date: matchStart,
        map_number: g.number,
        team_blue: null,
        team_red: null,
        teams_match: teamsMatch,
        kills_blue: null,
        kills_red: null,
        total_kills: null,
        sup_blue: null,
        sup_red: null,
        trigger_type: null,
        winner_side: null,
        game_state: null,
        suspect: true,
        fetch_error: windowError || null,
      };

      if (gd) {
        record.team_blue = teamsMap.get(gd.blueTeamId) || gd.blueTeamId;
        record.team_red = teamsMap.get(gd.redTeamId) || gd.redTeamId;
        record.kills_blue = gd.kBlue;
        record.kills_red = gd.kRed;
        record.total_kills = gd.totalKills;
        record.sup_blue = gd.supBlue;
        record.sup_red = gd.supRed;
        record.trigger_type = detectTrigger(gd.supBlue, gd.supRed);
        record.winner_side = gd.winnerSide;
        record.game_state = gd.gameState;
        record.suspect = isFrameSuspect(gd);
      }
      if (record.suspect) suspectCount++;
      if (record.trigger_type) triggerCount++;
      gamesOut.push(record);
    }
  }

  const summary = {
    league: leagueName,
    league_id: leagueId,
    matches: events.length,
    games: gamesOut.length,
    games_with_trigger: triggerCount,
    suspects: suspectCount,
    fetch_errors: gamesOut.filter((g) => g.fetch_error).length,
    oldest_date_seen: oldestSeen,
    hit_safety_cap: hitSafetyCap,
    no_data: false,
  };
  return { games: gamesOut, summary };
}

(async () => {
  ensureOutputDir();
  console.error(`camille-collect — período ${FROM} → ${TO} (exclusivo) | out=${OUT_NAME} | fresh-schedule=${FRESH_SCHEDULE} | TODAS as ligas da API (exceto ${[...EXCLUDE_SLUGS].join(', ')})`);

  let teamsRaw;
  let leaguesRaw;
  try {
    teamsRaw = await getTeams();
    leaguesRaw = await getLeagues();
  } catch (e) {
    console.error(`FATAL: getTeams()/getLeagues() falhou: ${e.message}`);
    process.exit(1);
  }
  const teamsMap = new Map();
  for (const t of teamsRaw?.data?.teams || []) teamsMap.set(String(t.id), t.name);
  console.error(`  teams map: ${teamsMap.size} times`);

  const allLeagues = leaguesRaw?.data?.leagues || [];
  let targetLeagues = allLeagues.filter((l) => !EXCLUDE_SLUGS.has(l.slug));

  // --only=slug1,slug2 — pra teste/re-run pontual sem varrer as ~40 ligas de novo.
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  if (onlyArg) {
    const slugs = new Set(onlyArg.split('=')[1].split(','));
    targetLeagues = targetLeagues.filter((l) => slugs.has(l.slug));
  }
  console.error(`  ligas na API: ${allLeagues.length} | excluídas (${[...EXCLUDE_SLUGS].join(',')}): ${allLeagues.length - allLeagues.filter((l) => !EXCLUDE_SLUGS.has(l.slug)).length} | alvo: ${targetLeagues.length}`);

  let universe = loadJsonArraySafe(UNIVERSE_FILE);
  let errors = loadJsonArraySafe(FETCH_ERRORS_FILE);
  const alreadyDone = new Set(universe.map((g) => g.league));

  const summaries = [];
  const startAll = Date.now();
  for (const [idx, league] of targetLeagues.entries()) {
    const leagueName = league.name;
    if (alreadyDone.has(leagueName)) {
      console.error(`\n[SKIP] ${leagueName} já coletada nesta run anterior (presente em ${path.basename(UNIVERSE_FILE)}) — apague a entrada no arquivo se quiser recolher.`);
      continue;
    }
    const startLeague = Date.now();
    const runErrors = [];
    const { games, summary } = await processLeague(league.id, leagueName, teamsMap, runErrors);
    summaries.push(summary);

    // merge + salva INCREMENTAL (sobrevive interrupção) — remove qualquer entrada
    // antiga dessa liga (não deveria ter, mas defensivo) e adiciona a nova.
    universe = universe.filter((g) => g.league !== leagueName).concat(games);
    errors = errors.concat(runErrors);
    fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(universe, null, 2));
    fs.writeFileSync(FETCH_ERRORS_FILE, JSON.stringify(errors, null, 2));

    const elapsedLeague = ((Date.now() - startLeague) / 1000).toFixed(1);
    const elapsedAll = ((Date.now() - startAll) / 1000 / 60).toFixed(1);
    console.error(`[${idx + 1}/${targetLeagues.length}] ${leagueName}: games=${summary.games} trigger=${summary.games_with_trigger} suspects=${summary.suspects} errors=${summary.fetch_errors} — ${elapsedLeague}s (total corrido: ${elapsedAll}min)`);
  }

  console.log('\n=== RESUMO camille-collect ===');
  for (const s of summaries) {
    console.log(`${s.league}: matches=${s.matches} games=${s.games} trigger=${s.games_with_trigger} suspects=${s.suspects} fetch_errors=${s.fetch_errors} oldestDate=${s.oldest_date_seen}${s.no_data ? ' [SEM DADO NO PERÍODO]' : ''}${s.hit_safety_cap ? ' [CAP DE SEGURANÇA]' : ''}`);
  }
  console.log(`\nUniverso completo: games=${universe.length}`);
  console.log(`Output: ${UNIVERSE_FILE}`);
  console.log(`Fetch errors: ${errors.length} → ${FETCH_ERRORS_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
