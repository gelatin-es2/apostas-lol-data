// Analisa intervalo de dias nas 4 majors (LCK, LPL, LEC, CBLOL).
// Fair line: Pinnacle manual (primário, se disponível) + fórmula (blueAvgTotal+redAvgTotal)/2
// sempre calculada em paralelo. Ambas persistidas no output.
//
// Hierarquia pra matchup_fair:
//   1) Pinnacle manual (cron-data/YYYY-MM-DD-fair-pinnacle.json)
//   2) Fórmula: (avg_total_kills_blue + avg_total_kills_red) / 2, round .5
//   3) Fallback 29.5
//
// Uso:
//   node analyze_range.cjs --from YYYY-MM-DD --to YYYY-MM-DD
//   node analyze_range.cjs --from 2026-05-02 --to 2026-05-05
//
// Output: 1 arquivo por dia em cron-data/YYYY-MM-DD-results.json
// (mesmo formato de analyze_yesterday.cjs, compatível com save_report_to_db.cjs)

const fs = require('fs');
const path = require('path');
const https = require('https');
// Fix 2026-05-31: script vive em _archive/scripts/ — resolve lib e cron-data
// na RAIZ do repo (../..), não relativo ao próprio dir. Antes quebrava o cron
// (Cannot find module './lib/...') e o gap de results.json 24→30/05.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { loadFairPinnacle } = require(path.join(REPO_ROOT, 'lib', 'loadFairPinnacle.cjs'));

const OUT_DIR = path.join(REPO_ROOT, 'cron-data');
const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const LEAGUE_IDS = {
  LCK:   '98767991310872058',
  LPL:   '98767991314006698',
  LEC:   '98767991302996019',
  CBLOL: '98767991332355509',
  LCS:   '98767991299243165', // fix 2026-05-17: LCS ausente causava games LCS sem análise
};

const PEEL_PURE   = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
// FLEX expandido 2026-05-23 (CEO): Lux + Anivia
const FLEX_ENGAGE = ['bard','rakan','lux','anivia']; // Alistar removido 2026-05-29 (decisao CEO) — sync com rebuild_dashboard_stats_cron.cjs e settle-pending-bets.cjs

const HISTORY_DAYS = 21;        // janela pra construir avg dos times
const MIN_SAMPLE_TEAM = 5;       // abaixo disso → fallback liga
const REQUEST_DELAY_MS = 80;     // throttle

// ---------- args ----------
const argv = process.argv.slice(2);
function getArg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? null : v;
}
const FROM = getArg('from');
const TO = getArg('to');
if (!FROM || !TO) { console.error('Uso: node analyze_range.cjs --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error('Datas devem ser YYYY-MM-DD'); process.exit(1);
}

// ---------- helpers ----------
const norm = s => s ? s.toLowerCase().replace(/[\s.\-']/g,'') : '';
const isPurePeel = sup => sup && PEEL_PURE.includes(norm(sup));
const isFlexEngage = sup => sup && FLEX_ENGAGE.includes(norm(sup));
const ymd = d => d.toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'x-api-key': LOLES_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
        ...headers,
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function tsRoundedTo10s(date) {
  const t = Math.floor(date.getTime() / 10000) * 10000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

async function fetchWindow(gameId, matchStart) {
  const targetMs = Math.min(
    new Date(matchStart).getTime() + 6 * 3600 * 1000,
    Date.now() - 60 * 1000,
  );
  const startingTime = tsRoundedTo10s(new Date(targetMs));
  return fetchJson(`https://feed.lolesports.com/livestats/v1/window/${gameId}?startingTime=${startingTime}`);
}

// ---------- coleta de jogos ----------
async function collectGamesForLeague(league, leagueId, fromDate, toDate) {
  let schedule;
  try {
    schedule = await fetchJson(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}`);
  } catch (e) {
    console.error(`  [${league}] schedule falhou: ${e.message}`);
    return [];
  }
  // Paginação: schedule retorna ~25 events por padrão. Pra cobrir 21 dias, paginar via newer.
  let events = schedule?.data?.schedule?.events || [];
  let pageToken = schedule?.data?.schedule?.pages?.older;
  let pages = 0;
  while (pageToken && pages < 6) { // máx 6 páginas por liga
    try {
      const more = await fetchJson(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}&pageToken=${pageToken}`);
      const moreEvents = more?.data?.schedule?.events || [];
      events = events.concat(moreEvents);
      pageToken = more?.data?.schedule?.pages?.older;
      pages++;
      const oldestInPage = moreEvents[0]?.startTime?.slice(0,10);
      if (oldestInPage && oldestInPage < fromDate) break; // já cobriu
    } catch (e) {
      console.error(`  [${league}] page ${pages} falhou: ${e.message}`);
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const filtered = events.filter(ev => {
    if (ev.state !== 'completed') return false;
    const d = ev.startTime?.slice(0,10);
    return d >= fromDate && d <= toDate;
  });

  const out = [];
  for (const ev of filtered) {
    const matchId = ev.match?.id;
    if (!matchId) continue;
    let detail;
    try {
      detail = await fetchJson(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`);
    } catch (e) {
      console.error(`  [${league}] eventDetails ${matchId} falhou: ${e.message}`);
      continue;
    }
    const games = detail?.data?.event?.match?.games || [];
    for (const g of games) {
      if (g.state !== 'completed') continue;
      out.push({
        league,
        match_id: matchId,
        game_id: g.id,
        game_number: g.number,
        team_blue: ev.match.teams[0]?.code || ev.match.teams[0]?.name,
        team_red:  ev.match.teams[1]?.code || ev.match.teams[1]?.name,
        match_start: ev.startTime,
        match_date: ev.startTime.slice(0,10),
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

// ---------- análise window ----------
async function analyzeGame(g) {
  let win;
  try {
    win = await fetchWindow(g.game_id, g.match_start);
  } catch (e) {
    return { ...g, error: 'window_failed', error_detail: e.message.slice(0,200) };
  }
  const last = win?.frames?.[win.frames.length - 1];
  if (!last || last.gameState !== 'finished') return { ...g, error: 'not_finished' };

  const kBlue = last.blueTeam?.totalKills ?? 0;
  const kRed  = last.redTeam?.totalKills ?? 0;
  const meta = win?.gameMetadata;
  const supBlue = meta?.blueTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;
  const supRed  = meta?.redTeamMetadata?.participantMetadata?.find(p => p.role === 'support')?.championId;

  return {
    ...g,
    kills_blue: kBlue, kills_red: kRed,
    total_kills: kBlue + kRed,
    sup_blue: supBlue, sup_red: supRed,
  };
}

// ---------- main ----------
(async () => {
  const fromDate = new Date(FROM + 'T00:00:00Z');
  const histStart = ymd(new Date(fromDate.getTime() - HISTORY_DAYS * 24*3600*1000));
  console.error(`[setup] range alvo: ${FROM} → ${TO}`);
  console.error(`[setup] histórico pra calcular avgs: ${histStart} → ${TO}`);

  // 1. coleta TODOS os jogos do range histórico+alvo (uma varredura, otimiza chamadas)
  const allGames = [];
  for (const [league, leagueId] of Object.entries(LEAGUE_IDS)) {
    console.error(`[1/4] coletando ${league}...`);
    const games = await collectGamesForLeague(league, leagueId, histStart, TO);
    console.error(`       ${games.length} games encontrados (${histStart}→${TO})`);
    allGames.push(...games);
  }

  // 2. analisa window de cada jogo
  console.error(`[2/4] analisando window de ${allGames.length} games (kills + supports)...`);
  const analyzed = [];
  for (let i = 0; i < allGames.length; i++) {
    const r = await analyzeGame(allGames[i]);
    analyzed.push(r);
    if ((i+1) % 10 === 0) console.error(`       ${i+1}/${allGames.length}`);
    await sleep(REQUEST_DELAY_MS);
  }
  const finished = analyzed.filter(g => g.total_kills != null);
  console.error(`       ${finished.length} games com kills extraídos (${analyzed.length - finished.length} falharam)`);

  // 3. constrói avgs de time + liga (usa histórico + range alvo, mas EXCLUI o próprio jogo do cálculo do avg)
  const teamHist = new Map();   // team_code → total_kills_por_jogo[] (fix 2026-05-17: total, não kills próprios)
  const leagueHist = new Map(); // liga → kills_por_time[]
  for (const g of finished) {
    if (!teamHist.has(g.team_blue)) teamHist.set(g.team_blue, []);
    if (!teamHist.has(g.team_red))  teamHist.set(g.team_red, []);
    const totalKills = g.kills_blue + g.kills_red;
    teamHist.get(g.team_blue).push(totalKills);
    teamHist.get(g.team_red).push(totalKills);
    if (!leagueHist.has(g.league)) leagueHist.set(g.league, []);
    leagueHist.get(g.league).push(g.kills_blue, g.kills_red);
  }
  const teamAvg = new Map();
  for (const [t, arr] of teamHist) {
    teamAvg.set(t, arr.reduce((a,b)=>a+b,0)/arr.length);
  }
  const leagueAvg = new Map(); // média de kills POR TIME (não soma) → fairLeague = leagueAvg*2
  for (const [l, arr] of leagueHist) {
    leagueAvg.set(l, arr.reduce((a,b)=>a+b,0)/arr.length);
  }
  console.error(`[3/4] avgs construídas: ${teamAvg.size} times, ${leagueAvg.size} ligas`);
  for (const [l, v] of leagueAvg) {
    console.error(`       ${l}: avg=${v.toFixed(2)} kills/time → fair_baseline=${(v*2).toFixed(2)}`);
  }

  // 4. para cada jogo NO RANGE alvo, calcula fair
  // Hierarquia (2026-05-23):
  //   1) Pinnacle manual (cron-data/YYYY-MM-DD-fair-pinnacle.json, via /log-fair)
  //   2) Fórmula: (avg_total_kills_blue + avg_total_kills_red) / 2, round .5
  //   3) Fallback 29.5
  // Ambas (pinnacle + formula) são persistidas no output pra A/B futuro.

  // Pré-carrega pinnacle por data (cache em Map para não reler o mesmo arquivo)
  const pinnacleCache = new Map(); // date → { byMatchId, byAnchor }
  function getPinnacle(date) {
    if (!pinnacleCache.has(date)) pinnacleCache.set(date, loadFairPinnacle(date));
    return pinnacleCache.get(date);
  }

  function fairForGame(g) {
    // 1) Pinnacle manual
    const pin = getPinnacle(g.match_date);
    const fairPinnacle = pin.byMatchId.get(String(g.match_id)) ?? null;

    // 2) Fórmula: (blueAvgTotal + redAvgTotal) / 2
    const blueKills = teamHist.get(g.team_blue) || [];
    const redKills  = teamHist.get(g.team_red)  || [];
    const totalKillsGame = g.kills_blue + g.kills_red;
    // leave-one-out: exclui o próprio jogo
    const blueAvgEx = blueKills.length > 1
      ? (blueKills.reduce((a,b)=>a+b,0) - totalKillsGame) / (blueKills.length - 1)
      : null;
    const redAvgEx  = redKills.length > 1
      ? (redKills.reduce((a,b)=>a+b,0) - totalKillsGame)  / (redKills.length - 1)
      : null;
    const lAvgPerSide = leagueAvg.get(g.league) ?? 14.5;
    const lAvgTotal = lAvgPerSide * 2;
    const blueAvg = (blueKills.length - 1 >= MIN_SAMPLE_TEAM) ? blueAvgEx : lAvgTotal;
    const redAvg  = (redKills.length  - 1 >= MIN_SAMPLE_TEAM) ? redAvgEx  : lAvgTotal;
    const blueSrc = (blueKills.length - 1 >= MIN_SAMPLE_TEAM) ? 'team' : 'league';
    const redSrc  = (redKills.length  - 1 >= MIN_SAMPLE_TEAM) ? 'team' : 'league';

    let fairFormula = null;
    let fairFormulaRaw = null;
    if (blueAvg != null && redAvg != null) {
      const raw = blueAvg + redAvg;
      fairFormula = Math.round(raw / 2 - 0.5) + 0.5;
      fairFormulaRaw = +raw.toFixed(2);
    }

    // Qual fonte usar no método
    const fairFinal = fairPinnacle ?? fairFormula ?? 29.5;
    const fairSource = fairPinnacle != null
      ? 'pinnacle_manual'
      : fairFormula != null
        ? `formula(${blueSrc}+${redSrc})/2`
        : 'fallback_29.5';

    const leagueBaseline = +(lAvgTotal).toFixed(2);
    return {
      fair: fairFinal,
      fair_pinnacle: fairPinnacle,
      fair_formula: fairFormula,
      fair_source: fairSource,       // qual foi usada
      fair_source_used: fairSource,
      fair_raw: fairFormulaRaw,
      fair_adjusted: fairFormula,
      blue_avg: blueAvg != null ? +blueAvg.toFixed(2) : null,
      red_avg: redAvg != null ? +redAvg.toFixed(2) : null,
      blue_sample_n: blueKills.length - 1,
      red_sample_n: redKills.length - 1,
      league_baseline: leagueBaseline,
      vs_league: fairFormula != null ? +(fairFormula - leagueBaseline).toFixed(2) : null,
    };
  }

  const inRange = finished.filter(g => g.match_date >= FROM && g.match_date <= TO);
  console.error(`[4/4] processando ${inRange.length} games no range ${FROM}→${TO}...`);

  const byDay = new Map();
  for (const g of inRange) {
    const f = fairForGame(g);
    const purePeels = (isPurePeel(g.sup_blue) ? 1 : 0) + (isPurePeel(g.sup_red) ? 1 : 0);
    const flexEngages = [g.sup_blue, g.sup_red].filter(isFlexEngage);
    let triggerType = null;
    if (purePeels === 2) triggerType = '2peel';
    else if (purePeels === 1 && flexEngages.length >= 1) triggerType = '1peel+flex';
    const peelBucket = purePeels === 2 ? '2peel' : (purePeels === 1 ? '1peel' : '0peel');

    const result = {
      league: g.league,
      match_id: g.match_id,
      game_id: g.game_id,
      map_number: g.game_number,
      team_blue: g.team_blue, team_red: g.team_red,
      kills_blue: g.kills_blue, kills_red: g.kills_red,
      total_kills: g.total_kills,
      sup_blue: g.sup_blue, sup_red: g.sup_red,
      peel_count: purePeels, peel_bucket: peelBucket,
      flex_engages: flexEngages,
      trigger_type: triggerType,
      matchup_fair: f.fair,
      fair_pinnacle: f.fair_pinnacle,
      fair_formula: f.fair_formula,
      fair_source: f.fair_source,
      fair_raw: f.fair_raw,
      fair_adjusted: f.fair_adjusted,
      blue_avg: f.blue_avg, red_avg: f.red_avg,
      blue_sample_n: f.blue_sample_n, red_sample_n: f.red_sample_n,
      league_baseline: f.league_baseline,
      vs_league: f.vs_league,
      under_hit: g.total_kills < f.fair,
    };
    if (!byDay.has(g.match_date)) byDay.set(g.match_date, []);
    byDay.get(g.match_date).push(result);
  }

  // salva 1 arquivo por dia
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = { range: { from: FROM, to: TO }, days: {} };
  for (const [day, results] of byDay) {
    const out = {
      date: day,
      analyzed_at: new Date().toISOString(),
      ligas: Object.keys(LEAGUE_IDS),
      count: results.length,
      results,
    };
    const outFile = path.join(OUT_DIR, `${day}-results.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    summary.days[day] = {
      games: results.length,
      with_2peel: results.filter(r => r.trigger_type === '2peel').length,
      with_1peel_flex: results.filter(r => r.trigger_type === '1peel+flex').length,
      under_hits_2peel: results.filter(r => r.trigger_type === '2peel' && r.under_hit).length,
    };
    console.error(`       ${day}: ${results.length} games salvos em ${outFile}`);
  }
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error('ERRO:', e.message); console.error(e.stack); process.exit(1); });
