// scripts/audit/phase0-universe.cjs
//
// Fase 0: enumera o universo de jogos das 6 ligas operadas (LCK/LPL/LEC/CBLOL/LCS/LFL)
// num range de datas. Schedule → eventDetails → livestats window, com cache em disco
// (audit-cache/) — jogos completed são imutáveis, re-run é ~grátis.
//
// Range default = split 2 (2026-04-01 → 2026-06-30). Pra outro range (ex: split 1),
// passa --from/--to/--out — os schedule pages já em cache (audit-cache/) são
// reaproveitados automaticamente (paginação é determinística por pageIndex,
// independente do range pedido), só paga rede pelas páginas/eventDetails/windows
// que ainda não foram buscados.
//
// Uso:
//   node phase0-universe.cjs --league=LCK
//   node phase0-universe.cjs --all
//   node phase0-universe.cjs --league=LCK --from=2026-01-01 --to=2026-04-01 --out=00-universe-split1.json
//
// Volume: ~1.400-1.700 requests na 1ª rodada com todas as ligas. Rode POR LIGA pra
// caber no timeout de comando (~10min); se uma liga sozinha estourar, rode em
// background. Progresso logado a cada 25 games.
//
// Output: audit-output/<--out ou 00-universe.json> (array de games, MERGE por liga —
// rodar --league=X de novo só substitui os games dessa liga, preserva as outras já
// processadas) + audit-output/<fetch-errors correspondente> (mesmo esquema de merge).

'use strict';

const fs = require('fs');
const path = require('path');

const {
  getSchedulePage,
  getEventDetails,
  getWindow,
  getTeams,
  tsRoundedTo10sCapped,
} = require('./lib/api-cache.cjs');

const {
  LEAGUE_IDS,
  SPLIT2_FROM: DEFAULT_FROM,
  SPLIT2_TO: DEFAULT_TO,
  detectTrigger,
  extractGameData,
  isFrameSuspect,
} = require('./lib/audit-common.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');
const DEFAULT_UNIVERSE_FILENAME = '00-universe.json';

// FROM/TO mutáveis — setados em parseArgs(), lidos por fetchLeagueEvents() (mesmo
// módulo, ordem de execução garante que já estão setados antes do 1º uso real).
let FROM = DEFAULT_FROM;
let TO = DEFAULT_TO;

// Deriva o nome do arquivo de erros a partir do --out, pra não misturar erros de
// splits diferentes no mesmo arquivo. 00-universe.json -> fetch-errors.json
// (comportamento antigo, preservado); 00-universe-split1.json -> fetch-errors-split1.json;
// qualquer outro nome -> fetch-errors-<nome>.json.
function errorsFilenameFor(universeFilename) {
  const base = universeFilename.replace(/\.json$/, '');
  if (base === '00-universe') return 'fetch-errors.json';
  const suffix = base.replace(/^00-universe-?/, '');
  return suffix ? `fetch-errors-${suffix}.json` : 'fetch-errors.json';
}

const SAFETY_PAGE_CAP = 25; // não deve ser atingido na prática (só rede muito instável)
// Heurística de settle: startTime + 6h. Se vier vazio, tenta offsets alternativos
// antes de desistir (jogo pode ter atrasado, ou o feed pode ter horário deslocado).
const OFFSET_HOURS_TRY_ORDER = [6, 2, 4, 8];
const PROGRESS_EVERY = 25;

function parseArgs() {
  const argv = process.argv.slice(2);
  const leagueArg = argv.find((a) => a.startsWith('--league='));
  const fromArg = argv.find((a) => a.startsWith('--from='));
  const toArg = argv.find((a) => a.startsWith('--to='));
  const outArg = argv.find((a) => a.startsWith('--out='));
  const all = argv.includes('--all');
  const league = leagueArg ? leagueArg.split('=')[1].toUpperCase() : null;

  if (!league && !all) {
    console.error('Uso: node phase0-universe.cjs --league=LCK|LPL|LEC|CBLOL|LCS|LFL | --all [--from=YYYY-MM-DD --to=YYYY-MM-DD --out=nome.json]');
    process.exit(1);
  }
  const leagues = all ? Object.keys(LEAGUE_IDS) : [league];
  for (const l of leagues) {
    if (!LEAGUE_IDS[l]) {
      console.error(`Liga desconhecida: "${l}". Válidas: ${Object.keys(LEAGUE_IDS).join(', ')}`);
      process.exit(1);
    }
  }

  const from = fromArg ? fromArg.split('=')[1] : DEFAULT_FROM;
  const to = toArg ? toArg.split('=')[1] : DEFAULT_TO;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error(`--from/--to devem ser YYYY-MM-DD. Recebido: from=${from} to=${to}`);
    process.exit(1);
  }
  const universeFilename = outArg ? outArg.split('=')[1] : DEFAULT_UNIVERSE_FILENAME;

  return { leagues, from, to, universeFilename };
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function loadJsonArraySafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function logFetchError(errorsArr, entry) {
  const full = { ts: new Date().toISOString(), ...entry };
  errorsArr.push(full);
  process.stderr.write(`  [FETCH ERROR] ${entry.stage} league=${entry.league} ${entry.message}\n`);
}

// Pagina getSchedule (pages.older) até oldestDate visto na página < FROM.
// Sem cap artificial de 5 páginas — só o cap de segurança (25).
async function fetchLeagueEvents(leagueName, errorsArr) {
  const leagueId = LEAGUE_IDS[leagueName];
  const events = [];
  let pageToken = null;
  let oldestSeen = '9999-12-31';
  let pageIndex = 0;
  let hitSafetyCap = false;

  while (pageIndex < SAFETY_PAGE_CAP) {
    let page;
    try {
      page = await getSchedulePage(leagueId, pageToken, { pageIndex });
    } catch (e) {
      logFetchError(errorsArr, {
        stage: 'schedule',
        league: leagueName,
        pageIndex,
        message: e.message,
        statusCode: e.statusCode ?? null,
      });
      break; // sem essa página não dá pra continuar paginando pra trás com segurança
    }

    const sched = page?.data?.schedule;
    const pageEvents = sched?.events || [];
    for (const ev of pageEvents) {
      if (!ev.startTime) continue;
      const date = ev.startTime.slice(0, 10);
      if (date < oldestSeen) oldestSeen = date;
      if (ev.state === 'completed' && date >= FROM && date < TO) {
        events.push(ev);
      }
    }

    const olderToken = sched?.pages?.older;
    pageIndex++;
    if (!olderToken) break;
    if (oldestSeen < FROM) break; // já passou do recorte, não precisa ir mais fundo
    pageToken = olderToken;
  }

  if (pageIndex >= SAFETY_PAGE_CAP) {
    hitSafetyCap = true;
    console.error(
      `  [${leagueName}] ATENÇÃO: atingiu cap de segurança de ${SAFETY_PAGE_CAP} páginas ` +
        `sem achar oldestDate < ${FROM} (oldestDate visto: ${oldestSeen})`
    );
  }

  return { events, oldestSeen, hitSafetyCap };
}

async function fetchGamesForMatch(matchId, leagueName, errorsArr) {
  let detail;
  try {
    detail = await getEventDetails(matchId);
  } catch (e) {
    logFetchError(errorsArr, {
      stage: 'eventDetails',
      league: leagueName,
      matchId: String(matchId),
      message: e.message,
      statusCode: e.statusCode ?? null,
    });
    return [];
  }
  const games = detail?.data?.event?.match?.games || [];
  return games.filter((g) => g.state === 'completed');
}

// Tenta getWindow com startTime+6h; se não vier frame válido, tenta +2h/+4h/+8h antes
// de desistir. Retorna { window, error } — error != null só quando NENHUM offset deu certo.
async function fetchGameWindow(gameId, matchStartISO, leagueName, matchId, errorsArr) {
  const baseMs = matchStartISO ? new Date(matchStartISO).getTime() : NaN;
  if (!Number.isFinite(baseMs)) {
    return { window: null, error: 'invalid_match_start_time' };
  }

  let lastWindow = null;
  let lastNetworkError = null;
  for (const hours of OFFSET_HOURS_TRY_ORDER) {
    const startingTime = tsRoundedTo10sCapped(baseMs + hours * 3600 * 1000);
    let win;
    try {
      win = await getWindow(gameId, startingTime);
    } catch (e) {
      lastNetworkError = e.message;
      logFetchError(errorsArr, {
        stage: 'window',
        league: leagueName,
        matchId: String(matchId),
        gameId: String(gameId),
        offsetHours: hours,
        message: e.message,
        statusCode: e.statusCode ?? null,
      });
      continue; // tenta o próximo offset mesmo após erro de rede nesse
    }
    lastWindow = win;
    const hasFrames = win && Array.isArray(win.frames) && win.frames.length > 0 && win.gameMetadata;
    if (hasFrames) return { window: win, error: null };
  }

  return {
    window: lastWindow,
    error: lastNetworkError
      ? `no_valid_frames_after_all_offsets (last network error: ${lastNetworkError})`
      : 'no_valid_frames_after_all_offsets',
  };
}

async function processLeague(leagueName, teamsMap, errorsArr) {
  console.error(`\n=== ${leagueName} ===`);
  const { events, oldestSeen, hitSafetyCap } = await fetchLeagueEvents(leagueName, errorsArr);
  console.error(`  [${leagueName}] matches completed no split2: ${events.length} | oldestDate visto: ${oldestSeen}`);

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
      if (gameCounter % PROGRESS_EVERY === 0) {
        console.error(`  [${leagueName}] progresso: ${gameCounter} games processados...`);
      }

      const { window, error: windowError } = await fetchGameWindow(g.id, matchStart, leagueName, matchId, errorsArr);
      const gd = window ? extractGameData(window) : null;

      const record = {
        game_id: String(g.id),
        match_id: String(matchId),
        league: leagueName,
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
      // record.suspect default é true (declarado acima) — games sem gd (fetch_error)
      // ficam suspect:true também, e contam no resumo (senão o stdout subestima
      // suspects em relação ao que fica gravado no 00-universe.json).
      if (record.suspect) suspectCount++;
      if (record.trigger_type) triggerCount++;
      gamesOut.push(record);
    }
  }

  const summary = {
    league: leagueName,
    matches: events.length,
    games: gamesOut.length,
    games_with_trigger: triggerCount,
    suspects: suspectCount,
    fetch_errors: gamesOut.filter((g) => g.fetch_error).length,
    oldest_date_seen: oldestSeen,
    hit_safety_cap: hitSafetyCap,
  };
  return { games: gamesOut, summary };
}

(async () => {
  const { leagues, from, to, universeFilename } = parseArgs();
  FROM = from;
  TO = to;
  const UNIVERSE_FILE = path.join(OUTPUT_DIR, universeFilename);
  const FETCH_ERRORS_FILE = path.join(OUTPUT_DIR, errorsFilenameFor(universeFilename));
  ensureOutputDir();
  console.error(`Fase 0 — universo (${FROM} → ${TO}) | ligas: ${leagues.join(', ')} | out: ${universeFilename}`);

  let teamsRaw;
  try {
    teamsRaw = await getTeams();
  } catch (e) {
    console.error(`FATAL: getTeams() falhou (necessário pra mapear esportsTeamId→nome): ${e.message}`);
    process.exit(1);
  }
  const teamsMap = new Map();
  for (const t of teamsRaw?.data?.teams || []) teamsMap.set(String(t.id), t.name);
  console.error(`  teams map: ${teamsMap.size} times`);

  // Merge: preserva no arquivo final os games/erros de ligas que NÃO estamos
  // reprocessando agora (permite rodar --league=X de novo sem apagar as outras).
  const existingUniverse = loadJsonArraySafe(UNIVERSE_FILE);
  const existingErrors = loadJsonArraySafe(FETCH_ERRORS_FILE);
  const keptUniverse = existingUniverse.filter((g) => !leagues.includes(g.league));
  const keptErrors = existingErrors.filter((e) => !leagues.includes(e.league));

  const runErrors = [];
  const summaries = [];
  let newGames = [];

  for (const leagueName of leagues) {
    const { games, summary } = await processLeague(leagueName, teamsMap, runErrors);
    newGames = newGames.concat(games);
    summaries.push(summary);
  }

  const finalUniverse = keptUniverse.concat(newGames);
  fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(finalUniverse, null, 2));
  fs.writeFileSync(FETCH_ERRORS_FILE, JSON.stringify(keptErrors.concat(runErrors), null, 2));

  console.log('\n=== RESUMO FASE 0 ===');
  for (const s of summaries) {
    console.log(
      `${s.league}: matches=${s.matches} games=${s.games} trigger=${s.games_with_trigger} ` +
        `suspects=${s.suspects} fetch_errors=${s.fetch_errors} oldestDate=${s.oldest_date_seen}` +
        `${s.hit_safety_cap ? ' [CAP DE SEGURANÇA ATINGIDO]' : ''}`
    );
  }

  const totalGames = finalUniverse.length;
  const totalTrigger = finalUniverse.filter((g) => g.trigger_type).length;
  console.log(`\nUniverso completo (todas ligas já rodadas, incluindo runs anteriores): games=${totalGames} com trigger=${totalTrigger}`);
  console.log(`Output: ${UNIVERSE_FILE}`);
  console.log(`Fetch errors (total acumulado): ${keptErrors.length + runErrors.length} → ${FETCH_ERRORS_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
