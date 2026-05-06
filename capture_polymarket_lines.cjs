// Captura linhas pré-jogo do Polymarket (Total Kills) pras 4 majors.
// Roda no GitHub Actions todo dia. Resultado vai pra cron-data/YYYY-MM-DD-polymarket-lines.json
//
// Lógica:
//   1. Lista matches dos próximos 36h + completed últimos 12h nas 4 majors via lolesports
//   2. Pra cada match, constrói slug Polymarket candidato (lol-<a>-<b>-<date>) e tenta as duas ordens
//   3. Se achar event, extrai markets onde question contém "total kills" + outcomes Over/Under
//   4. Agrupa por game_number; se houver múltiplas linhas pro mesmo jogo, escolhe a mais próxima
//      de odd 1.83 (regra CEO)
//   5. Salva resumo em cron-data/{date}-polymarket-lines.json
//
// Importante: Polymarket é geo-blocked no BR. Esse script só funciona em runner US/EU
// (GitHub Actions OK). Localmente em BR sempre vai falhar com ECONNREFUSED — esperado.
//
// Uso:
//   node capture_polymarket_lines.cjs           → range padrão (-12h a +36h)
//   node capture_polymarket_lines.cjs --from 2026-05-07 --to 2026-05-07
//   node capture_polymarket_lines.cjs --debug   → loga response cru de 1 match (1ª iteração)

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, 'cron-data');
const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const TARGET_ODD = 1.83; // regra CEO: linha do Polymarket mais próxima dessa odd
const TARGET_PROB = 1 / TARGET_ODD;

const LEAGUE_IDS = {
  LCK:   '98767991310872058',
  LPL:   '98767991314006698',
  LEC:   '98767991302996019',
  CBLOL: '98767991332355509',
};

// Mapping lolesports team code → polymarket slug fragment.
// Confirmado: WBG→wb, WE→we (lol-wb-we-2026-05-07).
// Pros demais, lowercase do code lolesports na maioria dos casos. Fallback heurístico abaixo.
const POLYMARKET_TEAM = {
  // LPL
  'WBG':'wb','BLG':'blg','JDG':'jdg','TES':'tes','WE':'we','IG':'ig','AL':'al',
  'RNG':'rng','EDG':'edg','FPX':'fpx','LNG':'lng','OMG':'omg','NIP':'nip',
  'TT':'tt','LGD':'lgd','RA':'ra','UP':'up',
  // LCK
  'T1':'t1','GEN':'gen','KT':'kt','HLE':'hle','DK':'dk','BRO':'bro','NS':'ns',
  'DRX':'drx','KRX':'krx','DNS':'dns','BFX':'bfx',
  // LEC
  'G2':'g2','FNC':'fnc','MAD':'mad','KOI':'koi','MKOI':'mkoi','BDS':'bds',
  'GX':'gx','TH':'th','KC':'kc','KCB':'kcb','LR':'lr','VIT':'vit','RGE':'rge',
  'NAVI':'navi','SHFT':'shft','SK':'sk',
  // CBLOL
  'LOUD':'loud','PNG':'png','PAIN':'pain','FUR':'fur','RED':'red','KBM':'kbm',
  'VKS':'vks','INTZ':'intz','ITZ':'itz','FLX':'flx','LEV':'lev','FX':'fx','LOS':'los',
};

const argv = process.argv.slice(2);
const DEBUG = argv.includes('--debug');
function getArg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i+1];
  return (!v || v.startsWith('--')) ? null : v;
}

const ymd = d => d.toISOString().slice(0,10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (apostas-lol-data cron)',
        'Accept': 'application/json',
        ...headers,
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function pmTeam(code) {
  if (!code) return null;
  const up = code.toUpperCase();
  return POLYMARKET_TEAM[up] || up.toLowerCase();
}

async function listMatchesForLeague(league, leagueId, fromDate, toDate) {
  const out = [];
  let pageToken = null;
  for (let pi = 0; pi < 4; pi++) {
    const url = `https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}` + (pageToken ? `&pageToken=${pageToken}` : '');
    let r;
    try { r = await fetchJson(url, { 'x-api-key': LOLES_KEY }); }
    catch (e) { console.error(`[${league}] schedule p${pi}: ${e.message}`); break; }
    const events = r?.data?.schedule?.events || [];
    let oldest = '9999-99-99';
    for (const ev of events) {
      if (!ev.match?.id || !ev.startTime) continue;
      const d = ev.startTime.slice(0,10);
      if (d < oldest) oldest = d;
      if (d < fromDate || d > toDate) continue;
      out.push({
        league,
        match_id: ev.match.id,
        start_time: ev.startTime,
        match_date: d,
        team_a: ev.match.teams[0]?.code,
        team_b: ev.match.teams[1]?.code,
      });
    }
    if (oldest < fromDate) break;
    if (!r?.data?.schedule?.pages?.older) break;
    pageToken = r.data.schedule.pages.older;
    await sleep(80);
  }
  return out;
}

// Tenta achar event Polymarket pra um match, testando ambas ordens de team
async function findPolymarketEvent(match) {
  const a = pmTeam(match.team_a);
  const b = pmTeam(match.team_b);
  if (!a || !b) return null;
  const date = match.match_date;
  const candidates = [
    `lol-${a}-${b}-${date}`,
    `lol-${b}-${a}-${date}`,
  ];
  for (const slug of candidates) {
    try {
      const r = await fetchJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
      if (r && r.markets && r.markets.length > 0) return { slug, event: r };
    } catch (e) {
      // 404 retorna null; outros errors logam
      console.error(`  [pm] ${slug} fetch err: ${e.message}`);
    }
    await sleep(60);
  }
  return null;
}

function parseLine(market) {
  if (typeof market.line === 'number') return market.line;
  // fallback: regex na question (ex "over 27.5", "Total Kills 25.5")
  const m = (market.question || '').match(/(\d+\.\d+|\d+)/);
  return m ? parseFloat(m[1]) : null;
}

function parseGameNumber(question) {
  if (!question) return null;
  const m = question.match(/Game\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function isTotalKillsMarket(market) {
  const q = (market.question || '').toLowerCase();
  if (!q.includes('total kills')) return false;
  if (q.includes('odd') || q.includes('even')) return false; // odd/even kills market: ignora
  // outcomes deve ser ["Over","Under"]
  let outcomes;
  try { outcomes = JSON.parse(market.outcomes); } catch { return false; }
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
  const lower = outcomes.map(o => String(o).toLowerCase());
  return lower.includes('over') && lower.includes('under');
}

function extractTotalKillsMarkets(event) {
  const result = []; // { game_number, line, under_price, over_price, market_id, question }
  for (const m of event.markets || []) {
    if (!isTotalKillsMarket(m)) continue;
    if (m.closed || m.archived) continue;
    const line = parseLine(m);
    if (line == null) continue;
    let prices;
    try { prices = JSON.parse(m.outcomePrices || '[]'); } catch { continue; }
    let outcomes;
    try { outcomes = JSON.parse(m.outcomes); } catch { continue; }
    if (prices.length !== 2 || outcomes.length !== 2) continue;
    const idxOver = outcomes.findIndex(o => String(o).toLowerCase() === 'over');
    const idxUnder = outcomes.findIndex(o => String(o).toLowerCase() === 'under');
    if (idxOver < 0 || idxUnder < 0) continue;
    const overPrice = parseFloat(prices[idxOver]);
    const underPrice = parseFloat(prices[idxUnder]);
    if (!isFinite(overPrice) || !isFinite(underPrice)) continue;
    result.push({
      game_number: parseGameNumber(m.question),
      line,
      under_price: underPrice,
      over_price: overPrice,
      under_odd: underPrice > 0 ? +(1/underPrice).toFixed(3) : null,
      over_odd: overPrice > 0 ? +(1/overPrice).toFixed(3) : null,
      market_id: m.id,
      question: m.question,
      sportsMarketType: m.sportsMarketType || null,
    });
  }
  return result;
}

// Pra um conjunto de markets (mesmo game ou match-level), escolhe o mais próximo de odd 1.83
function pickClosestToTargetOdd(markets) {
  if (markets.length === 0) return null;
  if (markets.length === 1) return { ...markets[0], selected_via: 'single_line' };
  let best = null;
  let bestDist = Infinity;
  for (const m of markets) {
    const dUnder = m.under_odd != null ? Math.abs(m.under_odd - TARGET_ODD) : Infinity;
    const dOver  = m.over_odd  != null ? Math.abs(m.over_odd  - TARGET_ODD) : Infinity;
    const dist = Math.min(dUnder, dOver);
    if (dist < bestDist) { bestDist = dist; best = m; }
  }
  return { ...best, selected_via: `closest_to_${TARGET_ODD}_odd`, distance_to_target: +bestDist.toFixed(3) };
}

(async () => {
  // Range padrão: agora a +30h (só pré-jogo upcoming).
  // Jogos já encerrados não têm Total Kills aberto no Polymarket — descartar evita
  // logs ruidosos de NO_EVENT/NO_TK pra matches que já fecharam mercado.
  const fromArg = getArg('from');
  const toArg = getArg('to');
  const now = new Date();
  const FROM = fromArg || ymd(now);
  const TO   = toArg   || ymd(new Date(now.getTime() + 30*3600*1000));

  console.error(`[setup] capture range ${FROM} → ${TO}`);

  // 1. lista matches via lolesports + filtra só os que ainda não começaram (pré-jogo)
  const cutoffTs = now.getTime();
  const allMatches = [];
  for (const [league, leagueId] of Object.entries(LEAGUE_IDS)) {
    const matches = await listMatchesForLeague(league, leagueId, FROM, TO);
    const upcoming = matches.filter(m => new Date(m.start_time).getTime() > cutoffTs);
    const skipped = matches.length - upcoming.length;
    console.error(`[1/3] ${league}: ${upcoming.length} upcoming (${skipped} já iniciados, ignorados)`);
    allMatches.push(...upcoming);
  }
  console.error(`[1/3] total ${allMatches.length} upcoming matches`);

  // 2. busca cada match no Polymarket
  const captured = [];
  let debugLogged = false;
  for (const m of allMatches) {
    const found = await findPolymarketEvent(m);
    if (!found) {
      captured.push({
        match_id_lolesports: m.match_id,
        league: m.league,
        match_date: m.match_date,
        team_a: m.team_a, team_b: m.team_b,
        polymarket_event_slug: null,
        reason: 'event_not_found_on_polymarket',
      });
      continue;
    }
    if (DEBUG && !debugLogged) {
      console.error(`[debug] event payload (${found.slug}):`);
      console.error(JSON.stringify(found.event, null, 2).slice(0, 4000));
      debugLogged = true;
    }
    const tkMarkets = extractTotalKillsMarkets(found.event);
    // agrupa por game_number (null = match-level)
    const byGame = new Map();
    for (const tk of tkMarkets) {
      const k = tk.game_number ?? 'match';
      if (!byGame.has(k)) byGame.set(k, []);
      byGame.get(k).push(tk);
    }
    const games = [];
    for (const [gn, list] of byGame) {
      const picked = pickClosestToTargetOdd(list);
      if (picked) games.push({ game_number: gn === 'match' ? null : gn, ...picked, alternatives_count: list.length });
    }
    captured.push({
      match_id_lolesports: m.match_id,
      league: m.league,
      match_date: m.match_date,
      match_start_utc: m.start_time,
      team_a: m.team_a, team_b: m.team_b,
      polymarket_event_slug: found.slug,
      polymarket_event_title: found.event.title,
      total_kills_markets_found: tkMarkets.length,
      games,
    });
    await sleep(100);
  }

  // 3. salva
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${ymd(now)}-polymarket-lines.json`);
  const summary = {
    captured_at: now.toISOString(),
    range: { from: FROM, to: TO },
    target_odd: TARGET_ODD,
    matches_total: captured.length,
    matches_with_polymarket_event: captured.filter(c => c.polymarket_event_slug).length,
    matches_with_total_kills: captured.filter(c => (c.games || []).length > 0).length,
    captured,
  };
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.error(`[3/3] wrote ${outFile}`);
  console.error(`       matches: ${summary.matches_total} | with PM event: ${summary.matches_with_polymarket_event} | with TK lines: ${summary.matches_with_total_kills}`);

  // log resumido pra stdout
  console.log(JSON.stringify({
    captured_at: summary.captured_at,
    matches_total: summary.matches_total,
    matches_with_polymarket_event: summary.matches_with_polymarket_event,
    matches_with_total_kills: summary.matches_with_total_kills,
    sample: captured.filter(c => (c.games||[]).length > 0).slice(0, 3),
  }, null, 2));
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
