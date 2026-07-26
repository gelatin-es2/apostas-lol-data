// Gera página HTML local com gráficos das curvas de odds capturadas por
// scripts/polymarket-history.cjs (cron-data/polymarket-history/*.json).
//
// Um card por evento: gráfico principal = moneyline da SÉRIE (prob 0-100% de cada time,
// eixo com equivalente em odd decimal), mini-gráficos por mapa (child_moneyline),
// marcador de virada (cruzamento de 0.5), volume no rodapé, tooltip com crosshair,
// tabela de valores (acessibilidade — tooltip nunca é o único caminho pro dado).
//
// SVG inline puro gerado aqui — zero dependência externa, zero CDN, abre offline.
// Tema claro/escuro via prefers-color-scheme (+ override data-theme).
//
// Uso:
//   node scripts/polymarket-chart.cjs                → últimos 7 dias
//   node scripts/polymarket-chart.cjs --days=3
//   node scripts/polymarket-chart.cjs --date=2026-07-25   → só aquele dia
//   node scripts/polymarket-chart.cjs --days=3 --date=2026-07-24 → 3 dias terminando 24/07
//
// Output: polymarket-charts/index.html (gitignored — artefato local de análise).
// Com mais de 24 gráficos e múltiplos dias, divide em index.html (hub com resumo por dia:
// jogos, volume, viradas, maior swing) + day-YYYY-MM-DD.html por dia.
//
// Rodapé de cada gráfico marca as VARIAÇÕES pro CEO avaliar:
//   - maior swing: maior Δprob em ≤20min (time que subiu, de→pra, horário BRT)
//   - range odd: min–max da odd decimal de cada lado na janela
//
// MANUTENÇÃO DIÁRIA — ver header de scripts/polymarket-history.cjs (1 linha, 2 comandos)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'cron-data', 'polymarket-history');
const OUT_DIR = path.join(ROOT, 'polymarket-charts');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

const BRT_OFFSET_S = -3 * 3600; // BRT fixo (Brasil sem horário de verão desde 2019)

// geometria — minis têm viewBox próprio menor (senão o texto escala pra ~4px na coluna)
const W = 860, ML = 64, MR = 70, MT = 14, MB = 26;
const W_MINI = 400, ML_MINI = 40, MR_MINI = 48;
const MAIN_PLOT_H = 190, MINI_PLOT_H = 110;
const MAX_PLOT_POINTS = 500; // downsample por série só pro desenho (JSON mantém tudo)
const MAX_TABLE_ROWS = 80;

function parseArgs(argv) {
  const args = { date: null, days: 7 };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--date=(\d{4}-\d{2}-\d{2})$/))) { args.date = m[1]; if (!argv.some(x => x.startsWith('--days='))) args.days = 1; }
    else if ((m = a.match(/^--days=(\d+)$/))) args.days = Math.max(1, parseInt(m[1], 10));
    else { console.error(`arg desconhecido: ${a}`); process.exit(1); }
  }
  return args;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtUsd(n) {
  if (n == null) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}

function brtParts(epoch) {
  const d = new Date((epoch + BRT_OFFSET_S) * 1000);
  return {
    hm: String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'),
    dm: String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0'),
  };
}

function fmtOdd(p) {
  if (!isFinite(p) || p <= 0) return '—';
  const o = 1 / p;
  return o >= 100 ? Math.round(o).toString() : o >= 10 ? o.toFixed(1) : o.toFixed(2);
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function dayHeader(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// ---------- dados ----------
function loadEvents(dateFrom, dateTo) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.json$/);
    if (!m || m[1] < dateFrom || m[1] > dateTo) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
    } catch (e) {
      console.error(`  ! ignorando ${f}: ${e.message}`);
    }
  }
  return out;
}

function inWindow(series, t0, t1) {
  return series.filter(pt => pt.t >= t0 && pt.t <= t1);
}

function downsample(pts, max) {
  if (pts.length <= max) return pts;
  const stride = Math.ceil(pts.length / max);
  const out = pts.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

// maior swing: maior |Δprob| entre dois pontos com até 20min de distância na janela.
// O ponto de PARTIDA precisa ser preço "vivo" (0.02-0.98) — senão o vencedor seria sempre
// o colapso pós-resolução; a chegada pode ir ao extremo (virada que fecha o jogo é sinal real).
const SWING_WINDOW_S = 20 * 60;
function biggestSwing(pts) {
  let best = null;
  let i = 0;
  for (let j = 1; j < pts.length; j++) {
    while (pts[j].t - pts[i].t > SWING_WINDOW_S) i++;
    for (let k = i; k < j; k++) {
      if (pts[k].p < 0.02 || pts[k].p > 0.98) continue;
      const d = pts[j].p - pts[k].p;
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { d, from: pts[k], to: pts[j] };
    }
  }
  return best;
}

// range min-max de probabilidade de uma série (pra reportar range de odd decimal)
function probRange(pts) {
  if (!pts.length) return null;
  let mn = 1, mx = 0;
  for (const pt of pts) { if (pt.p < mn) mn = pt.p; if (pt.p > mx) mx = pt.p; }
  return { pMin: mn, pMax: mx };
}

// cruzamentos de 0.5 na série do time A → [{t, up}] (up = time A virou favorito)
function findCrossings(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].p - 0.5, b = pts[i].p - 0.5;
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      const frac = Math.abs(a) / (Math.abs(a) + Math.abs(b));
      out.push({ t: pts[i - 1].t + frac * (pts[i].t - pts[i - 1].t), up: b > 0 });
    }
  }
  return out;
}

// grade de tempo alinhada (união dos timestamps, step-interpolação) — tooltip + tabela
function alignGrid(seriesList, t0, t1, maxN) {
  const set = new Set();
  for (const s of seriesList) for (const pt of s) if (pt.t >= t0 && pt.t <= t1) set.add(pt.t);
  let times = [...set].sort((a, b) => a - b);
  if (times.length > maxN) {
    const stride = Math.ceil(times.length / maxN);
    times = times.filter((_, i) => i % stride === 0);
  }
  const vals = seriesList.map(s => {
    const sorted = s;
    let j = 0;
    return times.map(t => {
      while (j + 1 < sorted.length && sorted[j + 1].t <= t) j++;
      return (sorted.length && sorted[j].t <= t) ? sorted[j].p : null;
    });
  });
  return { times, vals };
}

function xTicks(t0, t1, mini) {
  const span = t1 - t0;
  let step = span <= 3 * 3600 ? 1800 : span <= 8 * 3600 ? 3600 : span <= 24 * 3600 ? 3 * 3600 : span <= 3 * 86400 ? 12 * 3600 : 86400;
  if (mini) step *= 2; // mini tem metade da largura útil → metade dos ticks
  const ticks = [];
  const first = Math.ceil(t0 / step) * step;
  for (let t = first; t <= t1; t += step) ticks.push(t);
  return { ticks, multiDay: span > 20 * 3600 };
}

// corta a cauda flat pós-resolução: acha o último ponto "vivo" (p fora dos extremos)
// e devolve o fim da janela = esse t + 15min. Pré-jogo/ao vivo (sem extremo no fim) → sem corte.
function trimResolvedTail(seriesList, tEnd) {
  let lastAlive = -Infinity;
  for (const s of seriesList) {
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].p > 0.002 && s[i].p < 0.998) { lastAlive = Math.max(lastAlive, s[i].t); break; }
    }
  }
  if (!isFinite(lastAlive)) return tEnd;
  return Math.min(tEnd, lastAlive + 900);
}

// ---------- SVG ----------
let chartSeq = 0;

function renderChart({ label, seriesA, seriesB, t0, t1, plotH, crossings, showEndLabels, mini }) {
  const id = 'c' + (++chartSeq);
  const w = mini ? W_MINI : W, ml = mini ? ML_MINI : ML, mr = mini ? MR_MINI : MR;
  const H = MT + plotH + MB;
  const x = t => ml + (t - t0) / (t1 - t0) * (w - ml - mr);
  const y = p => MT + (1 - p) * plotH;
  const pathOf = pts => pts.map((pt, i) => (i ? 'L' : 'M') + x(pt.t).toFixed(1) + ' ' + y(pt.p).toFixed(1)).join('');

  const dsA = downsample(seriesA, MAX_PLOT_POINTS);
  const dsB = downsample(seriesB, MAX_PLOT_POINTS);

  // gridlines Y: prob% com equivalente em odd decimal — UMA escala, dois rótulos da mesma grandeza
  const gridRows = mini
    ? [
      { p: 0.0, lab: '0%', odd: '' },
      { p: 0.5, lab: '50%', odd: '' },
      { p: 1.0, lab: '100%', odd: '' },
    ]
    : [
      { p: 0.0, lab: '0%', odd: '' },
      { p: 0.25, lab: '25%', odd: '4.00' },
      { p: 0.5, lab: '50%', odd: '2.00' },
      { p: 0.75, lab: '75%', odd: '1.33' },
      { p: 1.0, lab: '100%', odd: '' },
    ];
  let g = '';
  for (const r of gridRows) {
    const yy = y(r.p).toFixed(1);
    g += `<line x1="${ml}" x2="${w - mr}" y1="${yy}" y2="${yy}" class="${r.p === 0.5 ? 'grid50' : 'grid'}"/>`;
    g += `<text x="${ml - 8}" y="${yy}" class="tick" text-anchor="end" dominant-baseline="middle">${r.lab}${r.odd ? ` · ${r.odd}` : ''}</text>`;
  }
  const { ticks, multiDay } = xTicks(t0, t1, mini);
  for (const t of ticks) {
    const xx = x(t).toFixed(1);
    const b = brtParts(t);
    g += `<line x1="${xx}" x2="${xx}" y1="${MT}" y2="${MT + plotH}" class="grid"/>`;
    g += `<text x="${xx}" y="${MT + plotH + 16}" class="tick" text-anchor="middle">${multiDay ? b.dm + ' ' + b.hm : b.hm}</text>`;
  }

  // marcador de virada: dot na linha de 50% com anel de superfície, cor do time que virou favorito
  let cross = '';
  for (const c of crossings) {
    if (c.t < t0 || c.t > t1) continue;
    cross += `<circle cx="${x(c.t).toFixed(1)}" cy="${y(0.5).toFixed(1)}" r="6" class="ring"/>` +
      `<circle cx="${x(c.t).toFixed(1)}" cy="${y(0.5).toFixed(1)}" r="4" fill="var(${c.up ? '--series-1' : '--series-2'})"/>`;
  }

  // rótulo direto no fim da linha: odd decimal final (seletivo — só endpoint)
  let endLabels = '';
  if (showEndLabels) {
    const ends = [[dsA, '--series-1'], [dsB, '--series-2']].filter(([s]) => s.length);
    const placed = [];
    for (const [s, color] of ends) {
      const last = s[s.length - 1];
      let yy = Math.max(MT + 8, Math.min(MT + plotH - 4, y(last.p)));
      for (const py of placed) if (Math.abs(yy - py) < 14) yy = py + (yy >= py ? 14 : -14);
      placed.push(yy);
      endLabels += `<circle cx="${(w - mr + 8).toFixed(1)}" cy="${yy.toFixed(1)}" r="3.5" fill="var(${color})"/>` +
        `<text x="${w - mr + 15}" y="${yy.toFixed(1)}" class="endlab" dominant-baseline="middle">${fmtOdd(last.p)}</text>`;
    }
  }

  const lineA = dsA.length ? `<path d="${pathOf(dsA)}" class="line" stroke="var(--series-1)"/>` : '';
  const lineB = dsB.length ? `<path d="${pathOf(dsB)}" class="line" stroke="var(--series-2)"/>` : '';

  return {
    id,
    html:
      `<div class="chartwrap">` +
      (label ? `<div class="chartlabel">${esc(label)}</div>` : '') +
      `<svg id="${id}" class="chart" viewBox="0 0 ${w} ${H}" data-t0="${t0}" data-t1="${t1}" data-w="${w}" data-ml="${ml}" data-mr="${mr}" data-mt="${MT}" data-ph="${plotH}" tabindex="0" role="img" aria-label="${esc(label || 'curva de odds')}">` +
      g + lineA + lineB + cross + endLabels +
      `<line class="xhair" x1="0" x2="0" y1="${MT}" y2="${MT + plotH}" style="display:none"/>` +
      `</svg></div>`,
  };
}

// ---------- card por evento ----------
function renderEventCard(data) {
  const ev = data.event;
  const markets = data.markets || [];
  const main = markets.find(m => m.type === 'moneyline') || markets.find(m => m.type === 'child_moneyline' && m.game_number === 1) || markets[0];
  if (!main || main.outcomes.length !== 2) return { html: '', stats: null };

  const teamA = main.outcomes[0].name, teamB = main.outcomes[1].name;
  const sA = main.outcomes[0].series, sB = main.outcomes[1].series;
  const allT = [...sA, ...sB].map(pt => pt.t);
  if (!allT.length) return { html: '', stats: null };
  const dataMin = Math.min(...allT), dataMax = Math.max(...allT);
  const st = ev.start_time_utc ? Math.floor(new Date(ev.start_time_utc).getTime() / 1000) : null;
  let t0 = st ? Math.max(dataMin, st - 2 * 3600) : dataMin;
  // corta a cauda flat pós-resolução (mercado resolvido segue reportando 0.9995/0.0005 por horas)
  let t1 = Math.max(trimResolvedTail([sA, sB], dataMax), t0 + 1800);

  let wA = inWindow(sA, t0, t1), wB = inWindow(sB, t0, t1);
  let preGameWindow = false;
  if (wA.length < 2 && wB.length < 2) {
    // jogo ainda não começou (janela do jogo vazia) → mostra o drift pré-jogo das últimas 24h
    t0 = Math.max(dataMin, dataMax - 24 * 3600);
    t1 = Math.max(dataMax, t0 + 1800);
    wA = inWindow(sA, t0, t1); wB = inWindow(sB, t0, t1);
    preGameWindow = true;
    if (wA.length < 2 && wB.length < 2) return { html: '', stats: null };
  }

  const crossings = findCrossings(wA);
  const mainChart = renderChart({ label: null, seriesA: wA, seriesB: wB, t0, t1, plotH: MAIN_PLOT_H, crossings, showEndLabels: true });

  // grade alinhada → tooltip + tabela + sanity
  const grid = alignGrid([sA, sB], t0, t1, 600);
  let probSum = null;
  for (let i = grid.times.length - 1; i >= 0; i--) {
    if (grid.vals[0][i] != null && grid.vals[1][i] != null) { probSum = +(grid.vals[0][i] + grid.vals[1][i]).toFixed(3); break; }
  }

  // minis por mapa
  let minis = '';
  const tooltipData = [];
  const childs = markets.filter(m => m !== main && m.type === 'child_moneyline').sort((a, b) => (a.game_number || 9) - (b.game_number || 9));
  for (const m of childs) {
    const cA = inWindow(m.outcomes[0].series, t0, t1), cB = inWindow(m.outcomes[1].series, t0, t1);
    if (cA.length < 2 || cA.every(pt => pt.p === cA[0].p)) continue; // mapa não jogado / sem trade
    const c = renderChart({
      label: `Mapa ${m.game_number ?? '?'}`, seriesA: cA, seriesB: cB, t0, t1,
      plotH: MINI_PLOT_H, crossings: findCrossings(cA), showEndLabels: true, mini: true,
    });
    minis += c.html;
    const cg = alignGrid([m.outcomes[0].series, m.outcomes[1].series], t0, t1, 400);
    tooltipData.push({ id: c.id, times: cg.times, a: cg.vals[0], b: cg.vals[1] });
  }
  tooltipData.push({ id: mainChart.id, times: grid.times, a: grid.vals[0], b: grid.vals[1] });

  // tabela (acessibilidade — dado alcançável sem hover)
  const stride = Math.max(1, Math.ceil(grid.times.length / MAX_TABLE_ROWS));
  let rows = '';
  for (let i = 0; i < grid.times.length; i += stride) {
    const b = brtParts(grid.times[i]);
    const pa = grid.vals[0][i], pb = grid.vals[1][i];
    rows += `<tr><td>${b.dm} ${b.hm}</td><td>${pa != null ? (pa * 100).toFixed(1) + '% (' + fmtOdd(pa) + ')' : '—'}</td><td>${pb != null ? (pb * 100).toFixed(1) + '% (' + fmtOdd(pb) + ')' : '—'}</td></tr>`;
  }

  // variações: maior swing (em qualquer direção — reporta o time que SUBIU) + range de odd por lado
  const swingRaw = biggestSwing(wA);
  let swing = null;
  if (swingRaw && Math.abs(swingRaw.d) >= 0.05) {
    const up = swingRaw.d > 0; // subiu = time A; desceu = time B subiu (soma ≈ 1)
    const pFrom = up ? swingRaw.from.p : 1 - swingRaw.from.p;
    const pTo = up ? swingRaw.to.p : 1 - swingRaw.to.p;
    swing = {
      team: up ? teamA : teamB,
      from_pct: +(pFrom * 100).toFixed(1), to_pct: +(pTo * 100).toFixed(1),
      delta_pct: +(Math.abs(swingRaw.d) * 100).toFixed(1),
      from_hm: brtParts(swingRaw.from.t).hm, to_hm: brtParts(swingRaw.to.t).hm,
      from_t: swingRaw.from.t, to_t: swingRaw.to.t,
    };
  }
  const rgA = probRange(wA), rgB = probRange(wB);
  const oddRange = r => r ? `${fmtOdd(r.pMax)}–${fmtOdd(r.pMin)}` : '—';

  const startBrt = st ? brtParts(st) : null;
  // score cru vem tipo "000-000|2-1|Bo3" — o placar da série é o segmento do meio
  const scoreParts = String(ev.score || '').split('|');
  const serieScore = scoreParts.find((s, i) => i > 0 && /^\d+-\d+$/.test(s)) || (/^\d+-\d+$/.test(scoreParts[0]) ? scoreParts[0] : null);
  const status = ev.ended || ev.closed ? (serieScore ? `final ${esc(serieScore)}` : 'encerrado') : ev.live ? 'AO VIVO na captura' : 'pré-jogo na captura';
  const windowNote = preGameWindow ? ' · janela: drift pré-jogo 24h' : '';
  const npts = sA.length + sB.length + childs.reduce((n, m) => n + m.outcomes.reduce((k, o) => k + o.points, 0), 0);

  const html = `
<article class="card">
  <div class="cardhead">
    <div>
      <h3>${esc(ev.league || '?')} — ${esc(teamA)} × ${esc(teamB)}</h3>
      <div class="sub">${esc(ev.tournament || '')}${startBrt ? ` · início ${startBrt.hm} BRT` : ''} · ${status}${windowNote}</div>
    </div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>${esc(teamA)}</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>${esc(teamB)}</span>
      ${crossings.length ? `<span class="key"><span class="dotkey"></span>virada (0.5)</span>` : ''}
    </div>
  </div>
  ${mainChart.html}
  ${minis ? `<div class="minis">${minis}</div>` : ''}
  <div class="cardfoot vari">
    ${swing ? `<span><strong>maior swing:</strong> ${esc(swing.team)} ${swing.from_pct}% → ${swing.to_pct}% (${swing.from_hm}–${swing.to_hm} BRT, Δ${swing.delta_pct}pp)</span>` : '<span>maior swing: &lt;5pp (sem movimento relevante)</span>'}
    <span><strong>range odd:</strong> ${esc(teamA)} ${oddRange(rgA)} · ${esc(teamB)} ${oddRange(rgB)}</span>
  </div>
  <div class="cardfoot">
    <span>Volume ${fmtUsd(ev.volume_usd)}</span><span>Liquidez ${fmtUsd(ev.liquidity_usd)}</span>
    <span>${npts.toLocaleString('pt-BR')} pontos</span>
    ${probSum != null ? `<span>Σprob ${probSum.toFixed(2)}</span>` : ''}
    <a href="${esc(ev.polymarket_url)}" target="_blank" rel="noopener">polymarket ↗</a>
  </div>
  <details class="tablev"><summary>Tabela de valores</summary>
    <table><thead><tr><th>hora BRT</th><th>${esc(teamA)}</th><th>${esc(teamB)}</th></tr></thead><tbody>${rows}</tbody></table>
  </details>
  <script type="application/json" class="chartdata">${JSON.stringify({ teamA, teamB, charts: tooltipData }).replace(/</g, '\\u003c')}</script>
</article>`;

  return {
    html,
    stats: {
      title: `${ev.league} ${teamA}×${teamB}`,
      league: ev.league || '?',
      date: ev.event_date,
      volume_usd: ev.volume_usd || 0,
      windowPts: [wA.length, wB.length],
      totalPts: npts,
      probSum,
      crossings: crossings.length,
      maps: (minis.match(/class="chartlabel"/g) || []).length,
      swing,
    },
  };
}

// ---------- página ----------
const CSS = `
:root{color-scheme:light;
  --page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
  --grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);
  --series-1:#2a78d6;--series-2:#eb6834;}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
  --grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
  --series-1:#3987e5;--series-2:#d95926;}}
:root[data-theme=dark]{color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
  --grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
  --series-1:#3987e5;--series-2:#d95926;}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:0 0 2px}
.meta{color:var(--ink2);font-size:13px;margin-bottom:18px}
h2{font-size:15px;color:var(--ink2);margin:28px 0 10px;text-transform:capitalize}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 14px 10px;margin-bottom:14px}
.cardhead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h3{font-size:15px;margin:0}
.sub{color:var(--ink2);font-size:12.5px;margin-top:2px}
.legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--ink2)}
.key{display:inline-flex;align-items:center;gap:6px}
.swatch{display:inline-block;width:14px;height:3px;border-radius:2px}
.dotkey{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--series-1);box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--axis)}
.chartwrap{position:relative}
.chartlabel{font-size:12px;color:var(--ink2);margin:8px 0 0}
svg.chart{width:100%;height:auto;display:block;outline:none}
svg.chart:focus-visible{outline:2px solid var(--series-1);outline-offset:2px}
.grid{stroke:var(--grid);stroke-width:1}
.grid50{stroke:var(--axis);stroke-width:1}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.endlab{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.ring{fill:var(--surface)}
.xhair{stroke:var(--axis);stroke-width:1}
.minis{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 14px}
.minis .chartwrap{max-width:470px}
.cardfoot{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12.5px;margin-top:6px}
.cardfoot a{color:var(--ink2)}
.cardfoot.vari{color:var(--ink2)}
.cardfoot.vari strong{font-weight:600;color:var(--ink)}
.hub{border-collapse:collapse;width:100%;font-size:13.5px}
.hub th,.hub td{text-align:left;padding:8px 14px 8px 0;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}
.hub th{color:var(--ink2);font-weight:600}
.hub a{color:var(--ink);font-weight:600}
.meta a{color:var(--ink2)}
.tablev{margin-top:8px;font-size:12.5px}
.tablev summary{cursor:pointer;color:var(--ink2)}
.tablev table{border-collapse:collapse;margin-top:8px;width:100%}
.tablev th,.tablev td{text-align:left;padding:3px 10px 3px 0;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}
.tablev th{color:var(--ink2);font-weight:600}
#tooltip{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;z-index:10;min-width:150px}
#tooltip .tt-time{color:var(--muted);margin-bottom:4px;font-variant-numeric:tabular-nums}
#tooltip .tt-row{display:flex;align-items:center;gap:7px;margin-top:2px}
#tooltip .tt-key{width:12px;height:2.5px;border-radius:2px;flex:none}
#tooltip .tt-val{font-weight:600;font-variant-numeric:tabular-nums}
#tooltip .tt-name{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
.empty{color:var(--muted);padding:30px 0;text-align:center}
`;

// crosshair + tooltip: acha o X mais próximo, mostra as DUAS séries naquele t (valor lidera).
// textContent sempre — nomes de time são dado não-confiável.
const JS = `
(function(){
  var tip=document.createElement('div');tip.id='tooltip';document.body.appendChild(tip);
  var BRT=-3*3600;
  function fmtT(t){var d=new Date((t+BRT)*1000);function z(n){return String(n).padStart(2,'0')}
    return z(d.getUTCDate())+'/'+z(d.getUTCMonth()+1)+' '+z(d.getUTCHours())+':'+z(d.getUTCMinutes())+' BRT'}
  function fmtOdd(p){if(!(p>0))return '—';var o=1/p;return o>=100?Math.round(o):o>=10?o.toFixed(1):o.toFixed(2)}
  function nearest(times,t){var lo=0,hi=times.length-1;while(hi-lo>1){var mid=(lo+hi)>>1;(times[mid]<t)?lo=mid:hi=mid}
    return (Math.abs(times[lo]-t)<=Math.abs(times[hi]-t))?lo:hi}
  document.querySelectorAll('article.card').forEach(function(card){
    var dataEl=card.querySelector('script.chartdata');if(!dataEl)return;
    var data=JSON.parse(dataEl.textContent);
    data.charts.forEach(function(cd){
      var svg=document.getElementById(cd.id);if(!svg||!cd.times.length)return;
      var t0=+svg.dataset.t0,t1=+svg.dataset.t1,ml=+svg.dataset.ml,mr=+svg.dataset.mr,vw=+svg.dataset.w;
      var xhair=svg.querySelector('.xhair');
      var idx=cd.times.length-1;
      function show(clientX,clientY){
        var r=svg.getBoundingClientRect();
        var px=(clientX-r.left)/r.width*vw;
        var t=t0+(px-ml)/(vw-ml-mr)*(t1-t0);
        idx=nearest(cd.times,Math.max(t0,Math.min(t1,t)));
        render(clientX,clientY,r);
      }
      function render(cx,cy,r){
        var t=cd.times[idx];
        var px=(ml+(t-t0)/(t1-t0)*(vw-ml-mr))/vw*r.width;
        xhair.setAttribute('x1',ml+(t-t0)/(t1-t0)*(vw-ml-mr));
        xhair.setAttribute('x2',ml+(t-t0)/(t1-t0)*(vw-ml-mr));
        xhair.style.display='';
        while(tip.firstChild)tip.removeChild(tip.firstChild);
        var tt=document.createElement('div');tt.className='tt-time';tt.textContent=fmtT(t);tip.appendChild(tt);
        [[data.teamA,cd.a[idx],'--series-1'],[data.teamB,cd.b[idx],'--series-2']].forEach(function(row){
          var div=document.createElement('div');div.className='tt-row';
          var k=document.createElement('span');k.className='tt-key';k.style.background='var('+row[2]+')';div.appendChild(k);
          var v=document.createElement('span');v.className='tt-val';
          v.textContent=row[1]!=null?(row[1]*100).toFixed(1)+'% · '+fmtOdd(row[1]):'—';div.appendChild(v);
          var n=document.createElement('span');n.className='tt-name';n.textContent=row[0];div.appendChild(n);
          tip.appendChild(div);
        });
        tip.style.display='block';
        var tw=tip.offsetWidth,th=tip.offsetHeight;
        var lx=(cx!=null?cx:r.left+px)+14,ly=(cy!=null?cy:r.top+40);
        if(lx+tw>window.innerWidth-8)lx=lx-tw-28;
        if(ly+th>window.innerHeight-8)ly=window.innerHeight-th-8;
        tip.style.left=lx+'px';tip.style.top=ly+'px';
      }
      function hide(){tip.style.display='none';xhair.style.display='none'}
      svg.addEventListener('pointermove',function(e){show(e.clientX,e.clientY)});
      svg.addEventListener('pointerleave',hide);
      svg.addEventListener('focus',function(){render(null,null,svg.getBoundingClientRect())});
      svg.addEventListener('blur',hide);
      svg.addEventListener('keydown',function(e){
        if(e.key==='ArrowLeft'){idx=Math.max(0,idx-1)}
        else if(e.key==='ArrowRight'){idx=Math.min(cd.times.length-1,idx+1)}
        else return;
        e.preventDefault();render(null,null,svg.getBoundingClientRect());
      });
    });
  });
})();
`;

// quantos gráficos numa página só antes de dividir por dia (hub + day-*.html)
const SPLIT_THRESHOLD = 24;

function pageHtml({ title, metaLine, body, withJs, backLink }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>${esc(title)}</h1>
<div class="meta">${backLink ? `<a href="index.html">← índice</a> · ` : ''}${metaLine}</div>
${body}
</div>${withJs ? `<script>${JS}</script>` : ''}</body></html>`;
}

const META_TAIL = 'eixo Y: probabilidade implícita (% · odd decimal) · hora em BRT · fonte: clob.polymarket.com';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const dateTo = args.date || today;
  const dateFrom = addDays(dateTo, -(args.days - 1));

  const events = loadEvents(dateFrom, dateTo);
  console.error(`[1/2] ${events.length} evento(s) em ${DATA_DIR} no range ${dateFrom} → ${dateTo}`);

  // ordena: dia desc, dentro do dia por horário asc
  const byDay = new Map();
  for (const d of events) {
    const day = d.event.event_date;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d);
  }
  const days = [...byDay.keys()].sort().reverse();

  const dayBlocks = []; // { day, cards, stats[] }
  const allStats = [];
  for (const day of days) {
    const list = byDay.get(day).sort((a, b) =>
      (a.event.start_time_utc || '9') < (b.event.start_time_utc || '9') ? -1 : 1);
    let cards = '';
    const dayStats = [];
    for (const d of list) {
      const { html, stats } = renderEventCard(d);
      cards += html;
      if (stats) { dayStats.push(stats); allStats.push(stats); }
    }
    if (cards) dayBlocks.push({ day, cards, stats: dayStats });
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const gen = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const pages = [];
  const multiPage = allStats.length > SPLIT_THRESHOLD && dayBlocks.length > 1;

  if (multiPage) {
    // uma página por dia + hub com resumo (muitos jogos numa página só fica pesado de navegar)
    const rows = [];
    for (const b of dayBlocks) {
      const file = `day-${b.day}.html`;
      const vol = b.stats.reduce((s, x) => s + x.volume_usd, 0);
      fs.writeFileSync(path.join(OUT_DIR, file), pageHtml({
        title: `Polymarket LoL — ${dayHeader(b.day)}`,
        metaLine: `${b.stats.length} jogo(s) · gerado ${gen} · ${META_TAIL}`,
        body: b.cards, withJs: true, backLink: true,
      }));
      pages.push(file);
      const best = b.stats.filter(s => s.swing).sort((a, c) => c.swing.delta_pct - a.swing.delta_pct)[0];
      const viradas = b.stats.reduce((s, x) => s + x.crossings, 0);
      rows.push(`<tr><td><a href="${file}">${dayHeader(b.day)}</a></td><td>${b.stats.length}</td><td>${fmtUsd(vol)}</td><td>${viradas}</td><td>${best && best.swing ? `${esc(best.title)}: ${esc(best.swing.team)} ${best.swing.from_pct}%→${best.swing.to_pct}% (${best.swing.from_hm}–${best.swing.to_hm})` : '—'}</td></tr>`);
    }
    const hubBody = dayBlocks.length
      ? `<table class="hub"><thead><tr><th>dia</th><th>jogos</th><th>volume</th><th>viradas</th><th>maior swing do dia</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : `<div class="empty">Nenhum dado no range ${dateFrom} → ${dateTo}.</div>`;
    fs.writeFileSync(OUT_FILE, pageHtml({
      title: 'Polymarket LoL — curvas de odds',
      metaLine: `${dateFrom} → ${dateTo} · ${allStats.length} jogo(s) em ${dayBlocks.length} dia(s) · gerado ${gen} · ${META_TAIL}`,
      body: hubBody, withJs: false, backLink: false,
    }));
    console.error(`[2/2] gerado ${OUT_FILE} (índice) + ${pages.length} página(s) de dia em ${OUT_DIR}`);
  } else {
    const body = dayBlocks.length
      ? dayBlocks.map(b => `<h2>${dayHeader(b.day)}</h2>${b.cards}`).join('')
      : `<div class="empty">Nenhum dado em cron-data/polymarket-history/ pro range ${dateFrom} → ${dateTo}.<br>Rode: node scripts/polymarket-history.cjs --days=${args.days}</div>`;
    const html = pageHtml({
      title: 'Polymarket LoL — curvas de odds',
      metaLine: `${dateFrom} → ${dateTo} · ${allStats.length} jogo(s) · gerado ${gen} · ${META_TAIL}`,
      body, withJs: true, backLink: false,
    });
    fs.writeFileSync(OUT_FILE, html);
    console.error(`[2/2] gerado ${OUT_FILE} (${(html.length / 1024).toFixed(0)} KB)`);
  }

  const topSwings = allStats.filter(s => s.swing)
    .sort((a, b) => b.swing.delta_pct - a.swing.delta_pct)
    .slice(0, 5)
    .map(s => ({ date: s.date, game: s.title, ...s.swing }));

  console.log(JSON.stringify({
    out: OUT_FILE,
    pages: multiPage ? pages : [path.basename(OUT_FILE)],
    range: { from: dateFrom, to: dateTo },
    charts: allStats.length,
    top_swings: topSwings,
    events: allStats,
  }, null, 2));
}

main();
