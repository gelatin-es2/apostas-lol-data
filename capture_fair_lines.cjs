// Captura fair lines pré-jogo das ligas alvo
// Uso: node capture_fair_lines.cjs lck,lpl
//   ou: node capture_fair_lines.cjs lec,cblol
//
// Para cada série agendada hoje, calcula matchup_fair = avg(team_A) + avg(team_B)
// usando histórico Oracle's Elixir (CSV baixado em datasets/).
//
// Output: cron-data/YYYY-MM-DD-fair-pre.json (cumulativo: cada execução mescla)

const fs = require('fs');
const path = require('path');
const https = require('https');

const ORACLE_CSV = process.env.ORACLE_CSV || path.resolve(__dirname, '..', 'year_backtest/datasets/2026_oracle.csv');
const OUT_DIR = path.join(__dirname, 'cron-data');

// === DoH bypass (provedor BR bloqueia DNS Polymarket) ===
const ipCache = new Map();
function dohResolve(host) {
  return new Promise((resolve, reject) => {
    https.get(`https://1.1.1.1/dns-query?name=${host}&type=A`, { headers: { accept: 'application/dns-json' } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        try { const j = JSON.parse(body); const a = (j.Answer || []).find(x => x.type === 1); if (!a) return reject(new Error(`No A for ${host}`)); resolve(a.data); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
async function fetchDoH(url) {
  const u = new URL(url);
  if (!ipCache.has(u.hostname)) ipCache.set(u.hostname, await dohResolve(u.hostname));
  const ip = ipCache.get(u.hostname);
  return new Promise((resolve, reject) => {
    https.get({ host: ip, port: 443, path: u.pathname + u.search, headers: { Host: u.hostname, 'User-Agent': 'Mozilla/5.0', accept: 'application/json' }, servername: u.hostname }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}
async function fetchPolymarketLolEvents() {
  const nowMinus4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  let events;
  try {
    events = await fetchDoH(`https://gamma-api.polymarket.com/events?tag_slug=esports&closed=false&active=true&end_date_min=${nowMinus4h}&limit=200`);
  } catch (e) { console.error('  Polymarket fetch failed:', e.message); return []; }
  const lolKw = ['league of legends', 'lol:', ' lol ', 'lpl', ' lck', ' lec', ' lcs', 'cblol'];
  return events.filter(e => {
    if (e.closed || e.archived) return false;
    const t = (e.title || '').toLowerCase();
    return lolKw.some(k => t.includes(k));
  });
}
function extractPolymarketLines(ev) {
  // markets: pega só "Total Kills Over/Under X in Game N"
  const markets = ev.markets || [];
  const byMap = {};
  for (const m of markets) {
    if (m.closed || m.archived) continue;
    const q = (m.question || '').toLowerCase();
    if (!q.includes('total kills')) continue;
    const lineMatch = (m.question || '').match(/(?:over|under)\s*(\d+(?:\.\d+)?)/i);
    const mapMatch = (m.question || '').match(/(?:game|map)\s*(\d+)/i);
    if (!lineMatch || !mapMatch) continue;
    const line = parseFloat(lineMatch[1]);
    const mapN = parseInt(mapMatch[1], 10);
    let outcomes = m.outcomes, prices = m.outcomePrices;
    if (typeof outcomes === 'string') try { outcomes = JSON.parse(outcomes); } catch {}
    if (typeof prices === 'string') try { prices = JSON.parse(prices); } catch {}
    let yesPrice = null;
    if (Array.isArray(outcomes) && Array.isArray(prices)) {
      const i = outcomes.findIndex(o => /^(yes|over)$/i.test(o));
      if (i >= 0) yesPrice = parseFloat(prices[i]);
    }
    // Filtrar live polarizado (yes ≥0.95 ou ≤0.05) — não é fair de mercado real
    if (yesPrice == null || yesPrice >= 0.95 || yesPrice <= 0.05) continue;
    if (!byMap[mapN]) byMap[mapN] = [];
    byMap[mapN].push({ line, yes_over: yesPrice, vol24h: m.volume24hr || null });
  }
  return byMap;
}
function matchPolymarketEvent(events, teamA, teamB) {
  const a = teamA?.toLowerCase(), b = teamB?.toLowerCase();
  if (!a || !b) return null;
  return events.find(ev => {
    const t = (ev.title || '').toLowerCase();
    return t.includes(a) && t.includes(b);
  });
}

const LIGAS_ALVO = (process.argv[2] || 'lck,lpl').toLowerCase().split(',');
const TODAY = new Date().toISOString().slice(0, 10);
const MIN_TEAM_MAPS = 10;

// API lolesports unofficial (chave pública conhecida — memória reference_lolesports_api.md)
const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Mapeia liga → leagueId no lolesports
const LEAGUE_IDS = {
  lpl: '98767991314006698',
  lck: '98767991310872058',
  lec: '98767991302996019',
  cblol: '98767991325878492',
  lcs: '98767991299243165',
};

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://lolesports.com',
      'Referer': 'https://lolesports.com/',
      ...headers,
    };
    https.get(url, { headers: browserHeaders }, res => {
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

console.error('[1/3] Carregando histórico Oracle pra calcular fair...');
if (!fs.existsSync(ORACLE_CSV)) {
  console.error(`ERRO: CSV não encontrado em ${ORACLE_CSV}`);
  process.exit(1);
}
const lines = fs.readFileSync(ORACLE_CSV, 'utf8').split(/\r?\n/);
const header = parseCSVLine(lines[0]).map(h => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

// Build team profiles (avg kills por mapa, do ano 2026 inteiro)
const teamProfile = new Map();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const c = parseCSVLine(lines[i]);
  if (c.length < header.length - 2) continue;
  if (c[idx.position] !== 'team') continue;
  const team = c[idx.teamname];
  const tk = num(c[idx.teamkills]);
  if (!team || tk == null) continue;
  if (!teamProfile.has(team)) teamProfile.set(team, { kills: [] });
  teamProfile.get(team).kills.push(tk);
}
for (const [, p] of teamProfile) {
  p.n = p.kills.length;
  p.avg = p.kills.reduce((a,b)=>a+b,0) / p.n;
}
console.error(`  ${teamProfile.size} times com perfil de kills`);

// Match flexível: lolesports usa "BRO", oracle usa "HANJIN BRION"
const _norm = s => s ? s.toLowerCase().replace(/\s+/g,'') : '';
function findTeam(name) {
  if (!name) return null;
  if (teamProfile.has(name)) return teamProfile.get(name);
  const target = _norm(name);
  for (const [oracleName, p] of teamProfile) {
    const o = _norm(oracleName);
    if (o.includes(target) || target.includes(o)) return p;
  }
  return null;
}

(async () => {
console.error('[2/3] Buscando schedule no lolesports + Polymarket...');
const polymarketEvents = await fetchPolymarketLolEvents();
console.error(`  Polymarket: ${polymarketEvents.length} eventos LoL futuros`);
const fairLines = [];
for (const liga of LIGAS_ALVO) {
  const leagueId = LEAGUE_IDS[liga];
  if (!leagueId) { console.error(`  liga ${liga} sem ID mapeado, pulando`); continue; }
  let schedule;
  try {
    schedule = await fetch(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=pt-BR&leagueId=${leagueId}`, {
      'x-api-key': LOLESPORTS_KEY,
    });
  } catch (e) {
    console.error(`  ${liga}: lolesports falhou (${e.message}). Pulando — TODO: fallback liquipedia.`);
    continue;
  }
  const events = schedule?.data?.schedule?.events || [];
  console.error(`  ${liga}: ${events.length} events no schedule`);
  for (const ev of events) {
    if (!ev.startTime) continue;
    const evDate = ev.startTime.slice(0, 10);
    if (evDate !== TODAY) continue;
    if (ev.state === 'completed') continue;
    const teams = ev.match?.teams || [];
    if (teams.length !== 2) continue;
    const t1 = teams[0]?.code || teams[0]?.name;
    const t2 = teams[1]?.code || teams[1]?.name;
    if (!t1 || !t2) continue;

    const p1 = findTeam(t1) || findTeam(teams[0]?.name);
    const p2 = findTeam(t2) || findTeam(teams[1]?.name);
    let avg1 = p1 && p1.n >= MIN_TEAM_MAPS ? p1.avg : null;
    let avg2 = p2 && p2.n >= MIN_TEAM_MAPS ? p2.avg : null;
    const fair = (avg1 != null && avg2 != null) ? Math.round((avg1 + avg2) - 0.5) + 0.5 : null;

    // Tentar matchar evento Polymarket pelos times
    const pmEvent = matchPolymarketEvent(polymarketEvents, t1, t2)
      || matchPolymarketEvent(polymarketEvents, teams[0]?.name, teams[1]?.name);
    const polymarketLines = pmEvent ? extractPolymarketLines(pmEvent) : null;

    fairLines.push({
      league: liga.toUpperCase(),
      league_id: leagueId,
      event_id: ev.match?.id || ev.id,
      start_time: ev.startTime,
      team_a: t1, team_b: t2,
      team_a_avg: avg1, team_b_avg: avg2,
      fair_calculated: fair,
      fair_team_a_n: p1?.n, fair_team_b_n: p2?.n,
      bo: ev.match?.strategy?.count || null,
      polymarket_event: pmEvent ? { id: pmEvent.id, slug: pmEvent.slug, title: pmEvent.title } : null,
      polymarket_lines_per_map: polymarketLines,
    });
  }
}

console.error('[3/3] Salvando JSON...');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${TODAY}-fair-pre.json`);

// Mescla com existente se ja rodou hoje (LCK+LPL de manha + LEC+CBLOL ao meio-dia)
let existing = { date: TODAY, captures: [] };
if (fs.existsSync(outFile)) {
  try { existing = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
}
existing.captures.push({
  captured_at: new Date().toISOString(),
  ligas: LIGAS_ALVO.map(l => l.toUpperCase()),
  fair_lines: fairLines,
});
fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));
console.error(`Wrote: ${outFile}`);
console.error(`Fair lines capturadas: ${fairLines.length}`);
fairLines.forEach(f => console.error(`  ${f.league} ${f.team_a} vs ${f.team_b} → fair=${f.fair_per_map}`));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
