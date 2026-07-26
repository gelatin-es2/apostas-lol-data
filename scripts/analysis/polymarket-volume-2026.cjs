// Análise: volume mensal de mercados de LoL na Polymarket em 2026.
// Pergunta do CEO (2026-07-25): "o valor médio mensal pra ver se tem pessoas usando" —
// a liquidez é real e crescente, ou é mercado morto?
//
// Reusa as pegadinhas descobertas em scripts/polymarket-history.cjs (2026-07-25):
//   - gamma SEM param `closed` retorna SÓ abertos → 2 queries (closed=false + closed=true)
//   - start_date_min/max filtram pela data de CRIAÇÃO do evento (~1-2 semanas antes do
//     jogo), NÃO pelo horário do jogo → janela de criação começa 2025-11-01 pra cobrir
//     jogos de janeiro; filtro autoritativo é client-side por eventDate
//   - paginação limit/offset até esgotar (order=id&ascending=true pra estabilidade)
//   - profundidade do histórico VERIFICADA na sondagem 2026-07-25: gamma serve eventos
//     fechados com eventDate desde 2025-11-09 → cobertura de 2026 é completa
//
// Buckets por mês (mês do JOGO = eventDate):
//   tier1 = LCK/LPL/LEC/LCS/CBLOL/LCP + internacionais (MSI/EWC/First Stand/Worlds)
//   resto = tier 2 / academy / cups (KeSPA Cup fica no "resto" por decisão do
//           coordenador, mas é reportado separado porque distorce a leitura)
//
// Uso:  node scripts/analysis/polymarket-volume-2026.cjs
// Output: audit-output/29-polymarket-volume-2026.json + tabela no stderr
// Read-only externo (GETs públicos). Node built-ins only.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractLeague, extractTournament } = require('../polymarket-history.cjs');

const GAMMA = 'https://gamma-api.polymarket.com';
const SERIES_ID_LOL = '10311';
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_FILE = path.join(ROOT, 'audit-output', '29-polymarket-volume-2026.json');
const CAPTURE_DIR = path.join(ROOT, 'cron-data', 'polymarket-history');

const YEAR_START = '2026-01-01';
const TODAY = new Date().toISOString().slice(0, 10);
// criação começa antes do ano porque mercado é criado ~1-2 semanas antes do jogo
const CREATION_MIN = '2025-11-01';

const TIER1_CODES = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'LCP', 'MSI', 'EWC', 'WORLDS']);

function fetchJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (apostas-lol-data polymarket-volume-2026)', 'Accept': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  }).catch(async err => {
    if (attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 500 * attempt));
    return fetchJson(url, attempt + 1);
  });
}

async function fetchAllPages(params) {
  const out = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    // gamma retorna 422 "offset too large" perto de offset ~2000 — quem chama precisa
    // fatiar a janela pra ficar abaixo disso (ver fetchClosedByMonthlyWindows)
    const page = await fetchJson(`${GAMMA}/events?series_id=${SERIES_ID_LOL}&limit=${LIMIT}&offset=${offset}&order=id&ascending=true&${params}`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    process.stderr.write(`\r  ${params.slice(0, 60)}... ${out.length} eventos`);
    if (page.length < LIMIT) break;
    offset += LIMIT;
  }
  process.stderr.write('\n');
  return out;
}

// gamma capa offset (~2000, HTTP 422) → fatia a janela de CRIAÇÃO em meses,
// cada fatia fica bem abaixo do cap (~200-600 eventos/mês). Dedupe por id no chamador.
async function fetchClosedByMonthlyWindows(creationMin, creationMax) {
  const out = [];
  let lo = creationMin;
  while (lo < creationMax) {
    const d = new Date(lo + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1);
    const hi = d.toISOString().slice(0, 10) < creationMax ? d.toISOString().slice(0, 10) : creationMax;
    out.push(...await fetchAllPages(`closed=true&start_date_min=${lo}&start_date_max=${hi}`));
    lo = hi;
  }
  return out;
}

function classify(ev) {
  const code = extractLeague(ev.title);
  const tournament = extractTournament(ev.title) || '';
  if (TIER1_CODES.has(code) || /first stand/i.test(tournament)) return { code, bucket: 'tier1' };
  return { code, bucket: 'resto' };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const r0 = n => Math.round(n || 0);

// sanity: campo `volume` da gamma vs valores capturados hoje (cron-data) + soma dos mercados
async function sanityChecks() {
  const checks = [];
  const known = [
    'lol-vit-g2-2026-07-25',   // LEC — capturado hoje com vol ~$1.66M
    'lol-g2-mkoi-2026-07-24',  // LEC — ~$3.81M
    'lol-blg-tt-2026-07-23',   // LPL — ~$3.49M
  ];
  for (const slug of known) {
    let captured = null;
    if (fs.existsSync(CAPTURE_DIR)) {
      const f = fs.readdirSync(CAPTURE_DIR).find(x => x.endsWith(`${slug}.json`));
      if (f) captured = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f))).event.volume_usd;
    }
    const evs = await fetchJson(`${GAMMA}/events?slug=${slug}`);
    const ev = evs[0];
    if (!ev) { checks.push({ slug, ok: false, note: 'evento não encontrado' }); continue; }
    const sumMarkets = (ev.markets || []).reduce((s, m) => s + (parseFloat(m.volume) || 0), 0);
    const gammaVol = +ev.volume || 0;
    // volume só cresce → gamma_agora >= capturado_hoje (tolerância 1%); e soma dos mercados ≈ volume do evento (±5%)
    const okVsCaptured = captured == null || gammaVol >= captured * 0.99;
    const okVsMarkets = sumMarkets > 0 ? Math.abs(gammaVol - sumMarkets) / gammaVol < 0.05 : null;
    checks.push({
      slug,
      gamma_volume_usd: r0(gammaVol),
      captured_today_usd: captured != null ? r0(captured) : null,
      sum_markets_usd: r0(sumMarkets),
      ok: okVsCaptured && okVsMarkets !== false,
      note: `gamma>=capturado: ${okVsCaptured}; |evento-Σmercados|/evento < 5%: ${okVsMarkets}`,
    });
  }
  return checks;
}

async function main() {
  console.error(`[1/4] puxando eventos LoL (abertos + fechados, criação >= ${CREATION_MIN})...`);
  const open = await fetchAllPages('closed=false');
  const closed = await fetchClosedByMonthlyWindows(CREATION_MIN, TODAY);
  const byId = new Map();
  for (const ev of [...open, ...closed]) byId.set(ev.id, ev);
  const all = [...byId.values()];

  const noDate = all.filter(ev => !ev.eventDate);
  const before2026 = all.filter(ev => ev.eventDate && ev.eventDate < YEAR_START);
  const upcoming = all.filter(ev => ev.eventDate && ev.eventDate > TODAY);
  const inRange = all.filter(ev => ev.eventDate && ev.eventDate >= YEAR_START && ev.eventDate <= TODAY);
  const earliest = all.filter(e => e.eventDate).map(e => e.eventDate).sort()[0] || null;

  console.error(`[2/4] ${all.length} eventos únicos | 2026 até hoje: ${inRange.length} | pré-2026: ${before2026.length} | futuros: ${upcoming.length} | sem eventDate: ${noDate.length}`);
  console.error(`      eventDate mais antigo servido pela gamma: ${earliest} (cobertura de 2026 ${earliest <= YEAR_START ? 'COMPLETA' : 'PARCIAL — não extrapolar'})`);

  console.error('[3/4] sanity do campo volume...');
  const sanity = await sanityChecks();
  for (const c of sanity) console.error(`      ${c.ok ? 'ok  ' : 'FAIL'} ${c.slug}: gamma=$${c.gamma_volume_usd.toLocaleString('en-US')} capturado=$${(c.captured_today_usd || 0).toLocaleString('en-US')} Σmercados=$${c.sum_markets_usd.toLocaleString('en-US')}`);

  // agregação mensal
  const months = {};
  const leagueTotals = {};
  for (const ev of inRange) {
    const month = ev.eventDate.slice(0, 7);
    const vol = +ev.volume || 0;
    const { code, bucket } = classify(ev);
    if (!months[month]) {
      months[month] = {
        n: 0, vols: [],
        tier1: { n: 0, vols: [] }, resto: { n: 0, vols: [] },
        kespa: { n: 0, vol: 0 }, // subset do resto — reportado separado
      };
    }
    const m = months[month];
    m.n++; m.vols.push(vol);
    m[bucket].n++; m[bucket].vols.push(vol);
    if (code === 'KESPA') { m.kespa.n++; m.kespa.vol += vol; }
    if (!leagueTotals[code]) leagueTotals[code] = { n: 0, vol: 0, bucket };
    leagueTotals[code].n++; leagueTotals[code].vol += vol;
  }

  const monthly = Object.keys(months).sort().map(month => {
    const m = months[month];
    const tot = m.vols.reduce((a, b) => a + b, 0);
    const t1 = m.tier1.vols.reduce((a, b) => a + b, 0);
    return {
      month,
      events: m.n,
      volume_total_usd: r0(tot),
      volume_mean_usd: r0(tot / m.n),
      volume_median_usd: r0(median(m.vols)),
      tier1: {
        events: m.tier1.n,
        volume_total_usd: r0(t1),
        volume_mean_usd: m.tier1.n ? r0(t1 / m.tier1.n) : 0,
        volume_median_usd: r0(median(m.tier1.vols)),
      },
      resto: {
        events: m.resto.n,
        volume_total_usd: r0(tot - t1),
        volume_mean_usd: m.resto.n ? r0((tot - t1) / m.resto.n) : 0,
        volume_median_usd: r0(median(m.resto.vols)),
        of_which_kespa: { events: m.kespa.n, volume_total_usd: r0(m.kespa.vol) },
      },
      pct_tier1_volume: tot ? +(t1 / tot * 100).toFixed(1) : 0,
    };
  });

  const output = {
    generated_at: new Date().toISOString(),
    question: 'volume mensal de mercados LoL na Polymarket em 2026 — mercado vivo ou morto?',
    source: `${GAMMA}/events?series_id=${SERIES_ID_LOL} (closed=false sem bounds + closed=true com janela de criação ${CREATION_MIN}→${TODAY}; filtro client-side por eventDate)`,
    coverage: {
      range_analyzed: { from: YEAR_START, to: TODAY },
      earliest_event_date_served: earliest,
      complete_2026: earliest <= YEAR_START,
      events_total_fetched: all.length,
      events_in_range: inRange.length,
      excluded: { before_2026: before2026.length, upcoming_after_today: upcoming.length, no_event_date: noDate.length },
    },
    tier1_definition: [...TIER1_CODES, 'FIRST STAND'],
    note_kespa: 'KeSPA Cup (times LCK) classificado como "resto" por decisão do coordenador; reportado separado em resto.of_which_kespa porque tem volume de tier 1.',
    sanity_volume_field: sanity,
    monthly,
    league_totals_2026: Object.fromEntries(Object.entries(leagueTotals)
      .sort((a, b) => b[1].vol - a[1].vol)
      .map(([k, v]) => [k, { events: v.n, volume_total_usd: r0(v.vol), bucket: v.bucket }])),
  };

  const outDir = path.dirname(OUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.error(`[4/4] gravado ${OUT_FILE}`);

  // tabela no stderr
  const fm = n => n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n / 1e3) + 'k';
  console.error('\nmês      | jogos | vol total | médio  | mediano | %vol tier1 | (kespa no resto)');
  for (const r of monthly) {
    console.error(
      `${r.month}  | ${String(r.events).padStart(5)} | ${fm(r.volume_total_usd).padStart(9)} | ${fm(r.volume_mean_usd).padStart(6)} | ${fm(r.volume_median_usd).padStart(7)} | ${String(r.pct_tier1_volume + '%').padStart(10)} | ${r.resto.of_which_kespa.events ? fm(r.resto.of_which_kespa.volume_total_usd) : '—'}`
    );
  }
  console.log(JSON.stringify({ out: OUT_FILE, months: monthly.length, events_in_range: inRange.length, complete_2026: output.coverage.complete_2026 }, null, 2));
}

main().catch(e => { console.error('ERRO:', e.message, e.stack); process.exitCode = 1; });
