// MÉTODO OVER — Fase 1+2. READ-ONLY, ISOLADO (não toca rebuild/cron/dashboard).
// Objetivo: planilha de TODOS os supports do Split 2 rankeados por performance OVER.
//
// Decisões travadas (CEO 2026-06-05):
//  - Fair = MESMA fórmula do Under (fairForGame copiada verbatim de rebuild_dashboard_stats_cron.cjs),
//    EXCETO o override "bet do Elvis" (prioridade 0) — esse troca a fair pela linha apostada, não é
//    a régua do modelo. Usamos só Pinnacle manual > fórmula (total+total)/2 round .5 > fallback 29.5.
//  - Odd 1.83 → breakeven 54.6%.
//  - Ligas: todas cobertas pela API (LEC/LCK/LPL/CBLOL/LCS/LFL/LES/LIT).
//  - Janela: Split 2 (>= 2026-04-01).
//  - SKIP dos jogos que acionam Under (2peel / 1peel+flex) no ranking de supports — universo Over
//    é o complementar (instrução CEO). G3 calibração mostra os dois universos.
//
// Uso:
//   node analyze_over_supports.cjs            # usa cache se existir
//   node analyze_over_supports.cjs --refresh  # re-captura tudo via API

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../..');
const { loadFairPinnacle } = require(path.join(ROOT, 'lib/loadFairPinnacle.cjs'));

const ALIAS_MAP = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/team-aliases.json'), 'utf8')).aliases) || {}; }
  catch { return {}; }
})();
function resolveCanonical(name) { return name && ALIAS_MAP[name] ? ALIAS_MAP[name] : name; }

const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SPLIT2_START = '2026-04-01';
const FALLBACK_LINE = 29.5;
const MIN_SAMPLE_TEAM = 5;
const ODD = 1.83;                       // CEO 2026-06-05
const BREAKEVEN = 100 / ODD;            // 54.64%

// Listas canônicas (verbatim de rebuild_dashboard_stats_cron.cjs:29,323) — pra classificar trigger Under e PULAR
const PEEL = ['Soraka','Sona','Janna','Lulu','Yuumi','Karma','Seraphine','Renata','RenataGlasc','Nami','Milio'];
const FLEX = ['Bard','Rakan','Lux','Anivia'];

const LEAGUES = [
  { id: '98767991302996019', name: 'LEC' },
  { id: '98767991310872058', name: 'LCK' },
  { id: '98767991314006698', name: 'LPL' },
  { id: '98767991332355509', name: 'CBLOL' },
  { id: '98767991299243165', name: 'LCS' },
  { id: '105266103462388553', name: 'LFL' },
  { id: '105266074488398661', name: 'LES' },
  { id: '105266094998946936', name: 'LIT' },   // tier 2 — incluído por "todas cobertas pela API"
];

const CACHE = path.join(ROOT, '.claude', 'tmp', 'over-games-cache-split2.json');
const OUT_CSV = path.join(ROOT, 'cron-data', 'over-supports-split2.csv');

function fetchJsonSafe(host, path_, headers) {
  return new Promise((resolve, reject) => {
    https.get({ host, path: path_, headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
async function fetchTeamsMap() {
  const r = await fetchJsonSafe('esports-api.lolesports.com', '/persisted/gw/getTeams?hl=en-US', { 'x-api-key': LOLES });
  const map = new Map();
  for (const t of r.data.teams) map.set(t.id, t.name);
  return map;
}
async function fetchAllMatches() {
  const out = [];
  for (const lg of LEAGUES) {
    let pageToken = null;
    for (let pi = 0; pi < 8; pi++) {
      const url = `/persisted/gw/getSchedule?hl=en-US&leagueId=${lg.id}` + (pageToken ? `&pageToken=${pageToken}` : '');
      let r;
      try { r = await fetchJsonSafe('esports-api.lolesports.com', url, { 'x-api-key': LOLES }); }
      catch (e) { console.error(`  schedule ${lg.name} ERR: ${e.message}`); break; }
      if (!r.data?.schedule?.events) break;
      let oldestDate = '9999-12-31';
      for (const e of r.data.schedule.events) {
        if (!e.match?.id || !e.startTime) continue;
        const date = e.startTime.slice(0, 10);
        if (date < oldestDate) oldestDate = date;
        if (e.state === 'completed' && date >= SPLIT2_START) {
          out.push({ lg: lg.name, matchId: e.match.id, date });
        }
      }
      if (!r.data.schedule.pages?.older) break;
      if (oldestDate < SPLIT2_START) break;
      pageToken = r.data.schedule.pages.older;
    }
  }
  return out;
}
function nowMinus60TS() {
  const d = new Date(Date.now() - 60000);
  d.setSeconds(d.getSeconds() - (d.getSeconds() % 10));
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.000Z$/, 'Z');
}
async function fetchGameMeta(gameId) {
  try {
    const ts = nowMinus60TS();
    const r = await fetchJsonSafe('feed.lolesports.com', `/livestats/v1/window/${gameId}?startingTime=${ts}`, { 'x-api-key': LOLES });
    if (!r.gameMetadata || !r.frames?.length) return null;
    const blueMeta = r.gameMetadata.blueTeamMetadata;
    const redMeta = r.gameMetadata.redTeamMetadata;
    const lastFrame = r.frames[r.frames.length - 1];
    const kBlue = lastFrame.blueTeam?.totalKills || 0;
    const kRed = lastFrame.redTeam?.totalKills || 0;
    const picks = (md) => {
      const p = md.participantMetadata;
      const get = (role) => p.find(x => x.role === role)?.championId || null;
      return { support: get('support') };
    };
    return {
      blueTeamId: blueMeta.esportsTeamId,
      redTeamId: redMeta.esportsTeamId,
      supBlue: picks(blueMeta).support,
      supRed: picks(redMeta).support,
      kBlue, kRed,
      gameState: lastFrame.gameState,
    };
  } catch { return null; }
}

async function captureGames() {
  console.error('[1/3] teams map...');
  const teamsMap = await fetchTeamsMap();
  console.error('[2/3] matches split 2...');
  const matches = await fetchAllMatches();
  console.error(`  ${matches.length} matches completed >= ${SPLIT2_START}`);
  console.error('[3/3] games per match (livestats)...');
  const games = [];
  let mIdx = 0;
  for (const m of matches) {
    mIdx++;
    if (mIdx % 30 === 0) console.error(`  match ${mIdx}/${matches.length}`);
    try {
      const det = await fetchJsonSafe('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${m.matchId}`, { 'x-api-key': LOLES });
      for (const g of det.data.event.match.games) {
        if (g.state !== 'completed') continue;
        const meta = await fetchGameMeta(g.id);
        if (!meta) continue;
        games.push({
          lg: m.lg, matchId: m.matchId, gameId: g.id, mapNum: g.number, date: m.date,
          blueTeamId: meta.blueTeamId, redTeamId: meta.redTeamId,
          blueName: resolveCanonical(teamsMap.get(meta.blueTeamId) || meta.blueTeamId),
          redName: resolveCanonical(teamsMap.get(meta.redTeamId) || meta.redTeamId),
          supBlue: meta.supBlue, supRed: meta.supRed,
          kBlue: meta.kBlue, kRed: meta.kRed, kills: meta.kBlue + meta.kRed,
        });
      }
    } catch { console.error(`  match ${m.matchId} ERR`); }
  }
  console.error(`  ${games.length} games captured`);
  return games;
}

// ---- fair (verbatim do rebuild, SEM override de user_bet) ----
function buildFair(games) {
  const teamKillsList = new Map();
  const leagueKillsList = new Map();
  for (const g of games) {
    if (!teamKillsList.has(g.blueName)) teamKillsList.set(g.blueName, []);
    if (!teamKillsList.has(g.redName)) teamKillsList.set(g.redName, []);
    teamKillsList.get(g.blueName).push(g.kills);
    teamKillsList.get(g.redName).push(g.kills);
    if (!leagueKillsList.has(g.lg)) leagueKillsList.set(g.lg, []);
    leagueKillsList.get(g.lg).push(g.kBlue, g.kRed);
  }
  const leagueAvg = new Map();
  for (const [l, arr] of leagueKillsList) leagueAvg.set(l, arr.reduce((a, b) => a + b, 0) / arr.length);

  const pinCache = new Map();
  const getPin = (date) => { if (!pinCache.has(date)) pinCache.set(date, loadFairPinnacle(date)); return pinCache.get(date); };

  for (const g of games) {
    const pin = getPin(g.date);
    const fairPin = pin.byMatchId.get(String(g.matchId)) ?? null;
    const blueArr = teamKillsList.get(g.blueName) || [];
    const redArr = teamKillsList.get(g.redName) || [];
    const blueAvgEx = blueArr.length > 1 ? (blueArr.reduce((a, b) => a + b, 0) - g.kills) / (blueArr.length - 1) : null;
    const redAvgEx = redArr.length > 1 ? (redArr.reduce((a, b) => a + b, 0) - g.kills) / (redArr.length - 1) : null;
    const lAvg = leagueAvg.get(g.lg) != null ? leagueAvg.get(g.lg) * 2 : null;
    const blueAvg = (blueArr.length - 1 >= MIN_SAMPLE_TEAM) ? blueAvgEx : lAvg;
    const redAvg = (redArr.length - 1 >= MIN_SAMPLE_TEAM) ? redAvgEx : lAvg;
    let fairFormula = null;
    if (blueAvg != null && redAvg != null) fairFormula = Math.round((blueAvg + redAvg) / 2 - 0.5) + 0.5;
    g.line = fairPin ?? fairFormula ?? FALLBACK_LINE;
    g.fairSource = fairPin != null ? 'pinnacle_manual' : fairFormula != null ? 'formula' : 'fallback';
  }
}

function trigger(g) {
  const b = g.supBlue, r = g.supRed;
  if (PEEL.includes(b) && PEEL.includes(r)) return '2peel';
  const bP = PEEL.includes(b), rP = PEEL.includes(r), bF = FLEX.includes(b), rF = FLEX.includes(r);
  if ((bP && rF) || (rP && bF)) return '1peel+flex';
  return 'none';
}

// Wilson score interval 95%
function wilson(w, n) {
  if (n === 0) return [0, 0];
  const z = 1.96, p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [100 * (c - m) / d, 100 * (c + m) / d];
}
const roiPct = (w, n) => n === 0 ? 0 : (ODD * w / n - 1) * 100;
const flag = (n) => n >= 15 ? 'OK' : n >= 10 ? 'MARG' : 'RUIDO';

(async () => {
  const refresh = process.argv.includes('--refresh');
  let games;
  if (!refresh && fs.existsSync(CACHE)) {
    games = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.error(`(cache) ${games.length} games de ${CACHE}`);
  } else {
    games = await captureGames();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(games));
    console.error(`cache salvo: ${CACHE}`);
  }

  buildFair(games);
  for (const g of games) { g.trigger = trigger(g); g.over = g.kills > g.line; }

  const underTrig = new Set(['2peel', '1peel+flex']);
  const nonUnder = games.filter(g => !underTrig.has(g.trigger));

  // ---- G3 calibração ----
  const cal = (arr) => { const n = arr.length, w = arr.filter(g => g.over).length; return { n, pct: n ? 100 * w / n : 0 }; };
  console.log('\n# MÉTODO OVER — supports split 2');
  console.log(`Odd ${ODD} | breakeven ${BREAKEVEN.toFixed(1)}% | fair = pinnacle>formula>${FALLBACK_LINE}\n`);
  console.log('## G3 — Calibração da fair (Over-hit = kills > fair)');
  const cAll = cal(games), cNU = cal(nonUnder);
  console.log(`  Universo TOTAL   n=${cAll.n}  Over=${cAll.pct.toFixed(1)}%   [~50% se fair não-enviesada]`);
  console.log(`  Universo nonUnder n=${cNU.n}  Over=${cNU.pct.toFixed(1)}%   (exclui 2peel+1peel+flex)`);
  console.log(`  Jogos pulados (Under trigger): ${games.length - nonUnder.length}\n`);

  // ---- planilha de supports (universo nonUnder, support de qualquer lado) ----
  const sup = new Map(); // champ -> {games:[]}
  for (const g of nonUnder) {
    for (const s of [g.supBlue, g.supRed]) {
      if (!s) continue;
      if (!sup.has(s)) sup.set(s, []);
      sup.get(s).push(g);
    }
  }
  const rows = [];
  for (const [champ, gs] of sup) {
    const n = gs.length;
    const w = gs.filter(g => g.over).length;
    const overPct = 100 * w / n;
    const [lo, hi] = wilson(w, n);
    const avgKills = gs.reduce((a, g) => a + g.kills, 0) / n;
    const avgFair = gs.reduce((a, g) => a + g.line, 0) / n;
    const isPeel = PEEL.includes(champ);
    rows.push({
      champ, n, overW: w, overPct, ci_lo: lo, ci_hi: hi,
      roi: roiPct(w, n), avgKills, avgFair, delta: avgKills - avgFair,
      flag: flag(n), peel: isPeel ? 'PEEL' : '',
    });
  }
  rows.sort((a, b) => b.overPct - a.overPct || b.n - a.n);

  // CSV
  const head = 'champion,n,over_wins,over_hit_pct,ci95_lo,ci95_hi,roi_pct_@1.83,avg_kills,avg_fair,delta_kills_minus_fair,sample_flag,is_peel';
  const lines = rows.map(r => [
    r.champ, r.n, r.overW, r.overPct.toFixed(1), r.ci_lo.toFixed(1), r.ci_hi.toFixed(1),
    r.roi.toFixed(1), r.avgKills.toFixed(1), r.avgFair.toFixed(1), r.delta.toFixed(2), r.flag, r.peel,
  ].join(','));
  fs.writeFileSync(OUT_CSV, head + '\n' + lines.join('\n') + '\n');
  console.log(`## Planilha salva: ${OUT_CSV} (${rows.length} supports)\n`);

  // print tabela markdown (todos, é a planilha)
  console.log('## Supports rankeados por Over-hit% (universo nonUnder)');
  console.log('| # | champ | n | over% | CI95 | ROI@1.83 | Δ(k-fair) | flag | peel |');
  console.log('|---|-------|---|-------|------|----------|-----------|------|------|');
  rows.forEach((r, i) => {
    console.log(`| ${i + 1} | ${r.champ} | ${r.n} | ${r.overPct.toFixed(1)}% | ${r.ci_lo.toFixed(0)}-${r.ci_hi.toFixed(0)} | ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}% | ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)} | ${r.flag} | ${r.peel} |`);
  });

  // G7 — cross-check: dump 3 jogos do support nº1 com n OK
  const top = rows.find(r => r.flag === 'OK');
  if (top) {
    console.log(`\n## G7 cross-check — 3 jogos crus de "${top.champ}" (n=${top.n})`);
    sup.get(top.champ).slice(0, 3).forEach(g => {
      console.log(`  ${g.date} ${g.lg} ${g.blueName}(${g.supBlue}) vs ${g.redName}(${g.supRed}) m${g.mapNum} | kills ${g.kills} fair ${g.line} (${g.fairSource}) | over=${g.over} trig=${g.trigger}`);
    });
  }
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
