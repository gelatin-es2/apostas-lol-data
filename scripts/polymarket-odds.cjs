// Consulta odds AO VIVO de LoL na Polymarket (gamma-api.polymarket.com, público, sem key).
// Foco: MONEYLINE — série (quem ganha o match) e mapa/game (child_moneyline) — fase 2 do
// estudo ML do Elvis.
//
// Endpoint correto (achado por engenharia reversa 2026-07-24, ressureição pós-descontinuação
// 2026-05-23 — ver CLAUDE.md e cron-data/*-polymarket-lines.json):
//   GET https://gamma-api.polymarket.com/events?series_id=10311&closed=false
//   series_id 10311 = série "League of Legends" (slug league-of-legends).
//
// `?tag=esports` (tentativa ingênua) NÃO funciona — a tag "esports" (id 64) engloba tudo
// (política de mercados de apostas em geral é uma tag genérica não relacionada, o teste
// original retornou lixo porque o param nem é filtro válido no endpoint /tags). O filtro
// certo é por SÉRIE, achado via /public-search?q=league%20of%20legends e inspecionando
// `event.series[0].id` no payload de um evento de LoL conhecido.
//
// A antiga captura (capture_polymarket_lines.cjs, deletada no commit 1961f37) construía
// slugs candidatos (lol-<a>-<b>-<date>) a partir do calendário lolesports e tentava
// /events/slug/<slug> um por um — funcional mas cego (não descobria eventos que não
// batessem o slug exato) e só extraía Total Kills. Esse script lista TUDO de uma vez via
// series_id e cobre moneyline (série + mapa).
//
// Uso:
//   node scripts/polymarket-odds.cjs                 → lista tudo aberto HOJE (UTC)
//   node scripts/polymarket-odds.cjs --all            → lista TODOS os eventos LoL abertos
//   node scripts/polymarket-odds.cjs al lgd           → busca partida por código/nome dos times
//   node scripts/polymarket-odds.cjs --json [...]     → output JSON cru (pra outro script consumir)
//
// Sem estado, sem key, sem dependência — só `https` nativo.

const https = require('https');

const SERIES_ID_LOL = '10311'; // "League of Legends" na Polymarket (gamma-api)
const GAMMA = 'https://gamma-api.polymarket.com';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (apostas-lol-data polymarket-odds tool)',
        'Accept': 'application/json',
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Lista todos os eventos de LoL abertos (não fechados) na Polymarket, paginando.
async function fetchAllOpenLolEvents() {
  const out = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    const url = `${GAMMA}/events?series_id=${SERIES_ID_LOL}&closed=false&limit=${LIMIT}&offset=${offset}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < LIMIT) break;
    offset += LIMIT;
  }
  return out;
}

// Probabilidade implícita (0-1) → odd decimal. 0/1 = mercado já resolvido, sem edge útil.
function toOdd(price) {
  const p = parseFloat(price);
  if (!isFinite(p) || p <= 0 || p >= 1) return null;
  return +(1 / p).toFixed(3);
}

function leagueOf(ev) {
  try {
    const meta = typeof ev.eventMetadata === 'string' ? JSON.parse(ev.eventMetadata) : ev.eventMetadata;
    if (meta && meta.league) return meta.league;
  } catch { /* ignora */ }
  const parts = (ev.title || '').split(' - ');
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function parseMarket(m) {
  let outcomes, prices;
  try {
    outcomes = JSON.parse(m.outcomes);
    prices = JSON.parse(m.outcomePrices);
  } catch { return null; }
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;
  return {
    question: m.question,
    market_id: m.id,
    closed: !!m.closed,
    outcomes: outcomes.map((name, i) => ({
      name,
      prob: parseFloat(prices[i]),
      odd: toOdd(prices[i]),
    })),
  };
}

// Extrai moneyline de série (1 mercado) e de mapa/game (N mercados, um por game).
function extractMoneylines(ev) {
  const markets = ev.markets || [];
  const seriesRaw = markets.find(m => m.sportsMarketType === 'moneyline');
  const maps = markets
    .filter(m => m.sportsMarketType === 'child_moneyline')
    .map(parseMarket)
    .filter(Boolean)
    .sort((a, b) => a.question.localeCompare(b.question));
  return { series: seriesRaw ? parseMarket(seriesRaw) : null, maps };
}

function normTeamKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesQuery(ev, needleA, needleB) {
  const teams = ev.teams || [];
  if (teams.length < 2) return false;
  const [a, b] = teams;
  const hit = (needle, team) => {
    const n = normTeamKey(needle);
    return normTeamKey(team.abbreviation) === n || normTeamKey(team.name).includes(n);
  };
  return (hit(needleA, a) && hit(needleB, b)) || (hit(needleA, b) && hit(needleB, a));
}

function buildSummary(ev) {
  const { series, maps } = extractMoneylines(ev);
  return {
    slug: ev.slug,
    title: ev.title,
    league: leagueOf(ev),
    team_a: ev.teams?.[0]?.name || null,
    team_b: ev.teams?.[1]?.name || null,
    start_time_utc: ev.startTime || null,
    event_date: ev.eventDate || null,
    live: !!ev.live,
    ended: !!ev.ended,
    score: ev.score || null,
    volume_total_usd: ev.volume || 0,
    volume_24h_usd: ev.volume24hr || 0,
    moneyline_series: series,
    moneyline_maps: maps,
    polymarket_url: `https://polymarket.com/event/${ev.slug}`,
  };
}

function fmtMarket(mk, label) {
  if (!mk) return `  ${label}: (sem mercado)`;
  const outs = mk.outcomes
    .map(o => `${o.name} ${(o.prob * 100).toFixed(1)}% (odd ${o.odd ?? '—'})`)
    .join('  |  ');
  return `  ${label}: ${outs}${mk.closed ? '  [FECHADO]' : ''}`;
}

function fmtUsd(n) {
  return '$' + Math.round(n || 0).toLocaleString('en-US');
}

async function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const wantAll = argv.includes('--all');
  const teamArgs = argv.filter(a => !a.startsWith('--') && a.toLowerCase() !== 'today');

  let events;
  try {
    events = await fetchAllOpenLolEvents();
  } catch (e) {
    console.error(`ERRO ao consultar ${GAMMA}: ${e.message}`);
    console.error('Se for ECONNREFUSED/timeout: Polymarket pode estar geo-bloqueando o IP atual');
    console.error('(histórico: bloqueado no BR pelo menos até maio/2026 — ver comentário no script antigo).');
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  let filtered = events;
  let scopeLabel;

  if (teamArgs.length === 2) {
    filtered = events.filter(ev => matchesQuery(ev, teamArgs[0], teamArgs[1]));
    scopeLabel = `busca "${teamArgs[0]} vs ${teamArgs[1]}"`;
    if (filtered.length === 0) {
      console.error(`Nenhum evento aberto encontrado pra "${teamArgs[0]}" vs "${teamArgs[1]}".`);
      console.error(`(${events.length} eventos LoL abertos no total na Polymarket agora — rode sem args ou com --all pra listar todos)`);
      process.exitCode = 0;
      return;
    }
  } else if (teamArgs.length === 1) {
    console.error(`Uso: passe 2 times ("node scripts/polymarket-odds.cjs al lgd") ou nenhum arg (lista hoje) ou --all.`);
    process.exitCode = 1;
    return;
  } else if (wantAll) {
    scopeLabel = 'todos os eventos abertos';
  } else {
    filtered = events.filter(ev => ev.eventDate === today);
    scopeLabel = `hoje (${today} UTC)`;
  }

  filtered.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  const results = filtered.map(buildSummary);

  if (wantJson) {
    console.log(JSON.stringify({ scope: scopeLabel, count: results.length, events: results }, null, 2));
    return;
  }

  console.log(`Polymarket LoL — ${results.length} evento(s) — ${scopeLabel}\n`);
  if (results.length === 0) {
    console.log('(nenhum evento aberto nesse escopo)');
    return;
  }
  for (const r of results) {
    console.log(`${r.team_a} vs ${r.team_b}  [${r.league || '?'}]`);
    const status = r.ended ? 'ENCERRADO' : r.live ? `AO VIVO (${r.score || '?'})` : 'pre-jogo';
    console.log(`  inicio: ${r.start_time_utc}  status: ${status}  vol total: ${fmtUsd(r.volume_total_usd)}  (24h: ${fmtUsd(r.volume_24h_usd)})`);
    console.log(fmtMarket(r.moneyline_series, 'Serie (moneyline)'));
    for (const mk of r.moneyline_maps) {
      const gameLabel = (mk.question.match(/Game\s*\d+/i) || ['mapa'])[0];
      console.log(fmtMarket(mk, gameLabel));
    }
    console.log(`  ${r.polymarket_url}`);
    console.log('');
  }
}

module.exports = { fetchAllOpenLolEvents, buildSummary, leagueOf, extractMoneylines, matchesQuery, toOdd };

if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message, e.stack); process.exitCode = 1; });
}
