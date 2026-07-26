// Coleta CURVA HISTÓRICA de odds de LoL na Polymarket (série temporal, não snapshot).
// Pedido do CEO 2026-07-25: "pegar a odd em jogos de tier 1 que tem liquidez da polymarket,
// fazer gráfico da odd do jogo e salvar pra analisar depois".
//
// Fluxo:
//   1. Descobre eventos LoL na gamma-api (series_id=10311) no range de datas pedido.
//      IMPORTANTE: gamma SEM param `closed` só retorna abertos — precisa de 2 queries
//      (closed=false + closed=true) e merge. Testado 2026-07-25.
//   2. Filtra por volume mínimo (--min-volume, default $1000) e opcionalmente por liga.
//   3. Pra cada mercado moneyline (série) e child_moneyline (por mapa): puxa o histórico
//      de preço de CADA outcome token no CLOB público:
//        GET https://clob.polymarket.com/prices-history?market=<tokenId>&...
//      Duas passadas por token (achado empírico 2026-07-25):
//        a) interval=max&fidelity=10  → curva completa desde a criação do mercado.
//           O servidor CAPA em ~2000 pontos; com interval=max, fidelity 1/5/10 devolvem
//           a MESMA granularidade (~10min). fidelity=60 devolve horária.
//        b) startTs/endTs explícitos (janela startTime-2h → startTime+10h) + fidelity=1
//           → 1 ponto/MINUTO dentro da janela do jogo. fidelity=1 SÓ funciona fino com
//           janela explícita, não com interval=max.
//      Merge por timestamp (fino sobrescreve grosso). Funciona também pra mercado FECHADO
//      (testado com lol-blg-tt-2026-07-23: 1143 pontos coarse + 448 fine).
//   4. Salva cron-data/polymarket-history/YYYY-MM-DD-<slug>.json (1 arquivo por evento).
//      Idempotente: re-rodar sobrescreve o arquivo com a curva completa re-buscada —
//      re-run depois do jogo completa a curva de um evento capturado ao vivo.
//
// Uso:
//   node scripts/polymarket-history.cjs                          → eventos de HOJE (UTC)
//   node scripts/polymarket-history.cjs --date=2026-07-24        → eventos daquele dia
//   node scripts/polymarket-history.cjs --days=7                 → últimos 7 dias (até hoje)
//   node scripts/polymarket-history.cjs --days=3 --date=2026-07-24 → 3 dias terminando em 24/07
//   node scripts/polymarket-history.cjs --min-volume=50000       → só eventos com vol >= $50k
//   node scripts/polymarket-history.cjs --league=LEC,LPL,LCK,LCS → só essas ligas
//   node scripts/polymarket-history.cjs --dry-run                → só lista/distribuição, não baixa
//
// MANUTENÇÃO DIÁRIA (rodar junto do briefing até automatizar no cron) — 1 linha:
//   node scripts/polymarket-history.cjs --days=2 && node scripts/polymarket-chart.cjs --days=7
// (--days=2 re-captura ontem+hoje: completa curvas de jogos que estavam ao vivo/pré-jogo)
//
// Read-only externo (só GETs públicos, sem auth). Node built-ins only.

const fs = require('fs');
const path = require('path');
const https = require('https');

const SERIES_ID_LOL = '10311'; // série "League of Legends" na gamma-api
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'cron-data', 'polymarket-history');

const COARSE_FIDELITY = 10; // min/ponto na curva completa (interval=max ignora valores menores)
const FINE_FIDELITY = 1;    // min/ponto na janela do jogo (só funciona com startTs/endTs)
const FINE_BEFORE_H = 2;    // janela fina começa 2h antes do startTime
const FINE_AFTER_H = 10;    // e termina 10h depois (BO5 longo cabe)
const REQUEST_DELAY_MS = 120;
const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (apostas-lol-data polymarket-history tool)',
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
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  }).catch(async err => {
    if (attempt >= 3) throw err;
    await sleep(500 * attempt);
    return fetchJson(url, attempt + 1);
  });
}

// ---------- args ----------
function parseArgs(argv) {
  const args = { date: null, days: 1, minVolume: 1000, leagues: null, dryRun: false };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--date=(\d{4}-\d{2}-\d{2})$/))) args.date = m[1];
    else if ((m = a.match(/^--days=(\d+)$/))) args.days = Math.max(1, parseInt(m[1], 10));
    else if ((m = a.match(/^--min-volume=(\d+(?:\.\d+)?)$/))) args.minVolume = parseFloat(m[1]);
    else if ((m = a.match(/^--league=(.+)$/))) args.leagues = m[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`arg desconhecido: ${a}`); process.exit(1); }
  }
  return args;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- descoberta gamma ----------
async function fetchEventsPage(params) {
  const out = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    const url = `${GAMMA}/events?series_id=${SERIES_ID_LOL}&limit=${LIMIT}&offset=${offset}&${params}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < LIMIT) break;
    offset += LIMIT;
  }
  return out;
}

// gamma sem `closed` retorna SÓ abertos → 2 queries (closed=false + closed=true) e merge por id.
// PEGADINHA (descoberta 2026-07-25): start_date_min/max filtram pelo campo `startDate`, que é a
// data de CRIAÇÃO do evento na Polymarket (~1-2 semanas antes do jogo), NÃO o horário do jogo
// (startTime). Então: query aberta SEM bounds (é pequena, ~90 eventos) + query fechada com
// padding de 28 dias na criação. O filtro autoritativo é client-side por eventDate.
async function discoverEvents(dateFrom, dateTo) {
  const [open, closed] = [
    await fetchEventsPage(`closed=false`),
    await fetchEventsPage(`closed=true&start_date_min=${addDays(dateFrom, -28)}&start_date_max=${addDays(dateTo, 2)}`),
  ];
  const byId = new Map();
  for (const ev of [...open, ...closed]) byId.set(ev.id, ev);
  // filtro autoritativo client-side: eventDate dentro do range pedido
  return [...byId.values()].filter(ev => ev.eventDate >= dateFrom && ev.eventDate <= dateTo);
}

// ---------- metadados ----------
// "LoL: Team A vs Team B (BO3) - LEC Regular Season" → tournament="LEC Regular Season", league="LEC"
const LEAGUE_PATTERNS = [
  [/^LCK\b/, 'LCK'], [/^LPL\b/, 'LPL'], [/^LEC\b/, 'LEC'], [/^LCS\b/, 'LCS'],
  [/^LTA\b/, 'LTA'], [/^CBLOL/, 'CBLOL'], [/^Circuito Desafiante/, 'CD'], [/^LFL\b/, 'LFL'],
  [/^LCP\b/, 'LCP'], [/^LJL\b/, 'LJL'], [/^LES\b/, 'LES'], [/^LIT\b/, 'LIT'],
  [/^Mid-Season Invitational/i, 'MSI'], [/^Worlds|^World Championship/i, 'WORLDS'],
  [/^Esports World Cup|^EWC/i, 'EWC'], [/^Prime League/i, 'PRM'],
  [/^Road Of Legends/i, 'RL'], [/^North American Challengers/i, 'NACL'],
  [/^Asia Masters/i, 'AM'], [/^EMEA Masters/i, 'EM'],
];
function extractTournament(title) {
  const idx = (title || '').indexOf(' - ');
  return idx >= 0 ? title.slice(idx + 3).trim() : null;
}
function extractLeague(title) {
  const t = extractTournament(title);
  if (!t) return null;
  for (const [re, code] of LEAGUE_PATTERNS) if (re.test(t)) return code;
  return t.split(/\s+/)[0].toUpperCase(); // fallback: primeiro token do torneio
}

function toOdd(p) {
  if (!isFinite(p) || p <= 0) return null;
  return +(1 / p).toFixed(3);
}

// ---------- histórico CLOB ----------
async function fetchTokenHistory(tokenId, startTimeUtc) {
  // a) curva completa (grossa, ~10min/ponto, capada em ~2000 pontos pelo servidor)
  const coarse = (await fetchJson(
    `${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=${COARSE_FIDELITY}`
  )).history || [];
  await sleep(REQUEST_DELAY_MS);

  // b) janela fina do jogo (1min/ponto) — só se souber o startTime
  let fine = [];
  if (startTimeUtc) {
    const st = Math.floor(new Date(startTimeUtc).getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    const startTs = st - FINE_BEFORE_H * 3600;
    const endTs = Math.min(now, st + FINE_AFTER_H * 3600);
    if (endTs > startTs) {
      fine = (await fetchJson(
        `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${FINE_FIDELITY}`
      )).history || [];
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // merge por timestamp — fino sobrescreve grosso onde coincidir
  const byT = new Map();
  for (const pt of coarse) byT.set(pt.t, pt.p);
  for (const pt of fine) byT.set(pt.t, pt.p);
  const series = [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p, odd: toOdd(p) }));
  return { series, points_coarse: coarse.length, points_fine: fine.length };
}

function parseMarketTokens(m) {
  let outcomes, tokens;
  try {
    outcomes = JSON.parse(m.outcomes);
    tokens = JSON.parse(m.clobTokenIds);
  } catch { return null; }
  if (!Array.isArray(outcomes) || !Array.isArray(tokens) || outcomes.length !== 2 || tokens.length !== 2) return null;
  return outcomes.map((name, i) => ({ name, token_id: tokens[i] }));
}

async function captureEvent(ev) {
  const wanted = (ev.markets || []).filter(m =>
    m.sportsMarketType === 'moneyline' || m.sportsMarketType === 'child_moneyline');

  const markets = [];
  for (const m of wanted) {
    const outs = parseMarketTokens(m);
    if (!outs) { console.error(`    ! mercado sem tokens parseáveis: ${m.question}`); continue; }
    const gameMatch = (m.question || '').match(/Game\s*(\d+)/i);
    const rec = {
      question: m.question,
      market_id: m.id,
      type: m.sportsMarketType,
      game_number: m.sportsMarketType === 'child_moneyline' && gameMatch ? parseInt(gameMatch[1], 10) : null,
      closed: !!m.closed,
      volume_usd: m.volume != null ? +m.volume : null,
      liquidity_usd: m.liquidity != null ? +m.liquidity : null,
      outcomes: [],
    };
    for (const o of outs) {
      const h = await fetchTokenHistory(o.token_id, ev.startTime);
      rec.outcomes.push({
        name: o.name,
        token_id: o.token_id,
        points: h.series.length,
        points_coarse: h.points_coarse,
        points_fine: h.points_fine,
        series: h.series,
      });
    }
    markets.push(rec);
  }

  return {
    captured_at: new Date().toISOString(),
    source: {
      discovery: `${GAMMA}/events?series_id=${SERIES_ID_LOL}`,
      history: `${CLOB}/prices-history (coarse: interval=max fidelity=${COARSE_FIDELITY} | fine: startTs/endTs ±janela do jogo fidelity=${FINE_FIDELITY})`,
    },
    event: {
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      league: extractLeague(ev.title),
      tournament: extractTournament(ev.title),
      team_a: ev.teams?.[0]?.name || null,
      team_b: ev.teams?.[1]?.name || null,
      teams: (ev.teams || []).map(t => ({ name: t.name, abbreviation: t.abbreviation || null })),
      event_date: ev.eventDate,
      start_time_utc: ev.startTime || null,
      live: !!ev.live,
      ended: !!ev.ended,
      closed: !!ev.closed,
      score: ev.score || null,
      volume_usd: ev.volume != null ? +ev.volume : null,
      volume_24h_usd: ev.volume24hr != null ? +ev.volume24hr : null,
      liquidity_usd: ev.liquidity != null ? +ev.liquidity : null,
      polymarket_url: `https://polymarket.com/event/${ev.slug}`,
    },
    markets,
  };
}

// sanity: soma das probs dos 2 outcomes no último ponto ~1.0
function sanityLastSum(marketRec) {
  const lasts = marketRec.outcomes.map(o => o.series.length ? o.series[o.series.length - 1].p : null);
  if (lasts.some(p => p == null)) return null;
  return +(lasts[0] + lasts[1]).toFixed(4);
}

function fmtUsd(n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const dateTo = args.date || today;
  const dateFrom = addDays(dateTo, -(args.days - 1));

  console.error(`[1/3] descobrindo eventos LoL na gamma-api: ${dateFrom} → ${dateTo} (UTC)...`);
  const events = (await discoverEvents(dateFrom, dateTo))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0));

  if (events.length === 0) {
    console.error('nenhum evento LoL encontrado no range.');
    return;
  }

  // distribuição de volume (pra calibrar --min-volume)
  console.error(`\n[2/3] ${events.length} evento(s) no range — distribuição de volume:`);
  console.error('  PASS?  vol_total     liga   data        título');
  const selected = [];
  for (const ev of events) {
    const league = extractLeague(ev.title);
    const passVol = (ev.volume || 0) >= args.minVolume;
    const passLeague = !args.leagues || args.leagues.includes(league);
    const pass = passVol && passLeague;
    if (pass) selected.push(ev);
    console.error(`  ${pass ? ' ok ' : 'SKIP'}  ${fmtUsd(ev.volume).padStart(11)}  ${String(league || '?').padEnd(6)} ${ev.eventDate}  ${ev.title}`);
  }
  const vols = events.map(e => e.volume || 0).sort((a, b) => a - b);
  const median = vols[Math.floor(vols.length / 2)];
  console.error(`  → volume: min=${fmtUsd(vols[0])} mediana=${fmtUsd(median)} max=${fmtUsd(vols[vols.length - 1])} | filtro: >= ${fmtUsd(args.minVolume)}${args.leagues ? ' & liga em ' + args.leagues.join(',') : ''} → ${selected.length}/${events.length} passam`);

  if (args.dryRun) { console.error('\n--dry-run: parando antes do download.'); return; }
  if (selected.length === 0) { console.error('nenhum evento passa o filtro.'); return; }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.error(`\n[3/3] baixando histórico de preços (${selected.length} eventos)...`);
  const summary = [];
  for (const ev of selected) {
    console.error(`  ${ev.eventDate} ${ev.title} (${fmtUsd(ev.volume)})`);
    let data;
    try {
      data = await captureEvent(ev);
    } catch (e) {
      console.error(`    ERRO: ${e.message} — pulando evento`);
      continue;
    }
    const outFile = path.join(OUT_DIR, `${ev.eventDate}-${ev.slug}.json`);
    fs.writeFileSync(outFile, JSON.stringify(data)); // compacto: séries são grandes
    const ml = data.markets.find(m => m.type === 'moneyline');
    const mlPts = ml ? ml.outcomes.map(o => o.points).join('+') : '—';
    const sum = ml ? sanityLastSum(ml) : null;
    console.error(`    → ${path.basename(outFile)} | mercados: ${data.markets.length} | pontos moneyline: ${mlPts} | soma probs último ponto: ${sum ?? '—'}`);
    summary.push({
      file: path.basename(outFile),
      event_date: ev.eventDate,
      title: ev.title,
      league: data.event.league,
      volume_usd: data.event.volume_usd,
      markets: data.markets.length,
      moneyline_points: ml ? ml.outcomes.map(o => o.points) : null,
      prob_sum_last: sum,
    });
  }

  console.log(JSON.stringify({
    range: { from: dateFrom, to: dateTo },
    min_volume: args.minVolume,
    leagues: args.leagues,
    discovered: events.length,
    captured: summary.length,
    out_dir: OUT_DIR,
    events: summary,
  }, null, 2));
}

module.exports = { discoverEvents, extractLeague, extractTournament, toOdd };

if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message, e.stack); process.exitCode = 1; });
}
