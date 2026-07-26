// scripts/analysis/bard-flex-definitivo.cjs
//
// ANÁLISE DEFINITIVA DO BARD COMO FLEX DO MÉTODO UNDER (pedido do CEO 2026-07-26:
// "o Bard é under mesmo quando tem +1 peel do outro lado? split 3 e split 2
// separados e juntos"). Complemento do mesmo dia: profundidade máxima — controle de
// confundidores (liga, comp inimiga, patch/mês), mecanismo (duração/pace), robustez
// (bootstrap + comparações múltiplas), teste out-of-sample e impacto em R$ real.
//
// ============================================================================
// FONTES (tudo cache/disco; API só foi usada na coleta do split 3, à parte)
// ============================================================================
//   audit-output/00-universe-split1.json          — jan–mar, 6 ligas (696 games)
//   audit-output/00-universe-allregions.json      — 04-01 → 07-21, ~30 ligas
//   audit-output/00-universe-split3-window.json   — 07-21 → 07-26, ~43 ligas (coleta 26/07)
//   audit-cache/window-{gameId}.json              — 10 picks + role + patchVersion
//   audit-cache/event-{matchId}.json              — VOD startMillis/endMillis → duração
//   cron-data/YYYY-MM-DD-fair-pinnacle.json       — fair Pinnacle manual (POR match_id)
//   Supabase `bets`                               — READ-ONLY, só pro bloco de R$ real
//
// ============================================================================
// RECORTES DE TEMPO (convenção deste relatório — declarada porque diverge do
// shen-under.cjs, que chamou "split3" tudo de julho)
// ============================================================================
//   split1  = 2026-01-14 → 2026-03-30   (universo split1, 6 ligas)
//   split2  = 2026-04-01 → 2026-06-30
//   julpre  = 2026-07-01 → 2026-07-20   (MSI/EWC/tier-2 — ligas majors paradas)
//   split3  = 2026-07-21 → hoje         (volta das ligas; recorte que o CEO pediu)
//
// ============================================================================
// TRÊS RÉGUAS DE FAIR (o coração da reconciliação 67.2% × 58.1%)
// ============================================================================
//   A) fair_loo   — leave-one-out por liga (convenção do repo: camille-sweep.cjs,
//                   shen-under.cjs, les-complete.cjs). Usa TODO o período, tirando
//                   só o jogo avaliado. É a régua que produziu o 67.2%.
//   B) fair_trail — trailing estritamente causal: só jogos ANTERIORES do time na
//                   liga (min 5, senão média trailing da liga). Nenhuma informação
//                   do futuro. É a régua honesta pra "dava pra saber na hora?".
//   C) fair_pinn  — fair Pinnacle manual do Elvis, lookup SÓ por lolesports_match_id
//                   (o lookup por NOME tem bug de substring — proibido aqui).
//
// Régua de odds do Elvis: Under na fair @1.83 (BE 54.6%) · Under na fair+1 @1.72
// (BE 58.1%, entrada padrão).
//
// Regras invioláveis aplicadas: stats por MAPA (game_id) · times via getTeams (já
// resolvido na coleta) · célula n<10 = "não é base de dados" · Wilson CI em toda
// taxa · splits separados (anti-leakage) · Supabase read-only.
//
// Uso: node scripts/analysis/bard-flex-definitivo.cjs [--no-bets]
// Output: audit-output/34-bard-flex.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, FLEX_ENGAGE } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const CRON_DIR = path.join(ROOT, 'cron-data');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '34-bard-flex.json');
const DERIVED_CACHE = path.join(AUDIT_CACHE, '_derived-gameinfo.json');
const DERIVED_CACHE_VERSION = 1;

const SPLIT1_FILE = path.join(AUDIT_OUTPUT, '00-universe-split1.json');
const ALLREGIONS_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');
const SPLIT3_FILE = path.join(AUDIT_OUTPUT, '00-universe-split3-window.json');

const Z95 = 1.96;
const SMALL_N = 10;
const FALLBACK_MIN_N = 5; // sync: camille-sweep.cjs / shen-under.cjs / les-complete.cjs
const BOOTSTRAP_ITERS = 1000;

const SPLIT2_FROM = '2026-04-01';
const JULPRE_FROM = '2026-07-01';
const SPLIT3_FROM = '2026-07-21';

const RUNGS = {
  fair: { odd: 1.83, be_pct: 54.6, label: 'Under na fair @1.83 (BE 54.6%)' },
  fairp1: { odd: 1.72, be_pct: 58.1, label: 'Under na fair+1 @1.72 (BE 58.1%)' },
};

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const FLEX_SET = new Set(FLEX_ENGAGE.map(normChamp));
// sync: shen-under.cjs ENGAGE_LIST / camille-sweep.cjs
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric',
  'morgana', 'braum',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));
// campeões de teamfight/engage fora do suporte (pra medir "comp inimiga engage")
const TEAMFIGHT_SET = new Set(
  ['malphite', 'kennen', 'ornn', 'sion', 'wukong', 'vi', 'jarvaniv', 'sejuani', 'zac',
   'ksante', 'gnar', 'nocturne', 'yone', 'yasuo', 'orianna', 'galio', 'amumu',
   'hecarim', 'rengar', 'diana', 'lillia', 'ambessa'].map(normChamp)
);

// ============================================================================
// utilitários numéricos
// ============================================================================
const fmt1 = (n) => (Number.isFinite(n) ? +n.toFixed(1) : null);
const fmt2 = (n) => (Number.isFinite(n) ? +n.toFixed(2) : null);

function loadJson(file, fatal = true) {
  if (!fs.existsSync(file)) {
    if (fatal) {
      console.error(`FATAL: ${file} não existe.`);
      process.exit(1);
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fatal) {
      console.error(`FATAL: ${file} inválido: ${e.message}`);
      process.exit(1);
    }
    return null;
  }
}

function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lower: fmt1(100 * Math.max(0, center - margin)),
    upper: fmt1(100 * Math.min(1, center + margin)),
  };
}

function roiPct(wins, n, odd) {
  if (!n) return null;
  return fmt1((100 * (wins * (odd - 1) - (n - wins))) / n);
}

// PRNG determinístico (mulberry32) — bootstrap reprodutível entre runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bootstrap não-paramétrico do hit% (reamostragem com reposição dos MAPAS).
function bootstrapHit(hits, iters = BOOTSTRAP_ITERS, seed = 42) {
  const n = hits.length;
  if (!n) return { p2_5: null, p50: null, p97_5: null, iters: 0 };
  const rnd = mulberry32(seed);
  const out = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let w = 0;
    for (let i = 0; i < n; i++) w += hits[(rnd() * n) | 0] ? 1 : 0;
    out[it] = (100 * w) / n;
  }
  out.sort((a, b) => a - b);
  const q = (p) => out[Math.min(iters - 1, Math.max(0, Math.floor(p * iters)))];
  return { p2_5: fmt1(q(0.025)), p50: fmt1(q(0.5)), p97_5: fmt1(q(0.975)), iters };
}

// log-gama (Lanczos) → binomial exata estável pra n grande.
function lgamma(z) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const logChoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

// p-valor one-sided: P(X >= wins | n, p0). p0 = BE. "Esse hit é melhor que o BE?"
function binomTailP(wins, n, p0) {
  if (!n) return null;
  let s = 0;
  for (let k = wins; k <= n; k++) {
    s += Math.exp(logChoose(n, k) + k * Math.log(p0) + (n - k) * Math.log(1 - p0));
  }
  return Math.min(1, s);
}

// Benjamini-Hochberg: retorna quantas hipóteses sobrevivem a FDR=q.
function benjaminiHochberg(pvals, q = 0.05) {
  const arr = pvals
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const m = arr.length;
  let kMax = -1;
  for (let k = 0; k < m; k++) if (arr[k].p <= ((k + 1) / m) * q) kMax = k;
  const survivors = new Set(arr.slice(0, kMax + 1).map((x) => x.i));
  return { m, survivors, threshold_p: kMax >= 0 ? arr[kMax].p : null };
}

// Teste de 2 proporções (z) — usado pra comparar célula vs baseline controlado.
function twoPropZ(x1, n1, x2, n2) {
  if (!n1 || !n2) return { z: null, p_two_sided: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: null, p_two_sided: null };
  const z = (p1 - p2) / se;
  // aproximação da normal (Abramowitz-Stegun 7.1.26 via erf)
  const erf = (x) => {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-x * x);
    return s * y;
  };
  const pTwo = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { z: fmt2(z), p_two_sided: pTwo < 1e-6 ? 1e-6 : +pTwo.toFixed(4) };
}

// ============================================================================
// cellStats — bloco padrão de estatística de uma célula, nas 2 réguas de odd.
// fairKey escolhe qual das 3 fairs usar (fair_loo | fair_trail | fair_pinn).
// ============================================================================
function cellStats(rows, fairKey = 'fair_loo', opts = {}) {
  const usable = rows.filter((r) => Number.isFinite(r[fairKey]));
  const n = usable.length;
  const base = {
    n,
    n_sem_fair: rows.length - n,
    small_sample: n < SMALL_N,
    avg_kills: null,
    avg_fair: null,
    avg_delta: null,
    avg_duration_min: null,
    avg_kills_per_min: null,
    fair: null,
    fairp1: null,
  };
  if (!n) return base;

  base.avg_kills = fmt1(usable.reduce((a, r) => a + r.total_kills, 0) / n);
  base.avg_fair = fmt1(usable.reduce((a, r) => a + r[fairKey], 0) / n);
  base.avg_delta = fmt2(usable.reduce((a, r) => a + (r.total_kills - r[fairKey]), 0) / n);

  const withDur = usable.filter((r) => Number.isFinite(r.duration_min));
  if (withDur.length) {
    base.avg_duration_min = fmt1(withDur.reduce((a, r) => a + r.duration_min, 0) / withDur.length);
    base.avg_kills_per_min = fmt2(
      withDur.reduce((a, r) => a + r.total_kills / r.duration_min, 0) / withDur.length
    );
    base.n_com_duracao = withDur.length;
  }

  for (const key of ['fair', 'fairp1']) {
    const { odd, be_pct } = RUNGS[key];
    const hitArr = usable.map((r) =>
      key === 'fair' ? r.total_kills < r[fairKey] : r.total_kills < r[fairKey] + 1
    );
    const wins = hitArr.filter(Boolean).length;
    const ci = wilsonCI(wins, n);
    const cell = {
      wins,
      hit_pct: fmt1((100 * wins) / n),
      wilson_ci_95: ci,
      roi_pct: roiPct(wins, n, odd),
      be_pct,
      pass_ci_lower_above_be: ci.lower != null && ci.lower > be_pct,
      p_value_vs_be: binomTailP(wins, n, be_pct / 100),
    };
    if (opts.bootstrap) cell.bootstrap = bootstrapHit(hitArr, BOOTSTRAP_ITERS, opts.seed || 42);
    base[key] = cell;
  }
  return base;
}

function printCellRow(label, s, flagExtra = '') {
  if (!s || !s.n) {
    console.log(`| ${label} | 0 | - | - | - | - | - | - | ${flagExtra} |`);
    return;
  }
  const f = s.fair;
  const f1 = s.fairp1;
  console.log(
    `| ${label} | ${s.n} | ${s.avg_kills} | ${s.avg_delta > 0 ? '+' : ''}${s.avg_delta} | ` +
      `${f.hit_pct}% [${f.wilson_ci_95.lower}–${f.wilson_ci_95.upper}] | ${f.roi_pct}% | ` +
      `${f1.hit_pct}% [${f1.wilson_ci_95.lower}–${f1.wilson_ci_95.upper}] | ${f1.roi_pct}% | ` +
      `${s.small_sample ? 'n<10 — NÃO é base de dados' : ''}${flagExtra} |`
  );
}
function tableHeader() {
  console.log(
    '| célula | n | kills méd | delta (kills−fair) | Under@fair hit [CI95] | ROI@1.83 | Under@fair+1 hit [CI95] | ROI@1.72 | flag |'
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
}

// ============================================================================
// FAIR A — leave-one-out por liga (sync: camille-sweep.cjs computeFairPerLeague)
// ============================================================================
function computeFairLOO(population) {
  const byLeague = new Map();
  for (const g of population) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map();
  for (const [, games] of byLeague) {
    const teamHist = new Map();
    for (const g of games) {
      for (const raw of [g.team_blue, g.team_red]) {
        const t = normalizeTeam(raw);
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
      }
    }
    const leagueAvg = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const avgFor = (teamRaw) => {
        const arr = (teamHist.get(normalizeTeam(teamRaw)) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvg;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return fairMap;
}

// ============================================================================
// FAIR B — trailing estritamente causal (só jogos ANTERIORES do time na liga).
// Sem essa régua não dá pra afirmar "dava pra saber na hora" — a LOO usa futuro.
// ============================================================================
function computeFairTrailing(population) {
  const byLeague = new Map();
  for (const g of population) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map();
  for (const [, gamesRaw] of byLeague) {
    const games = [...gamesRaw].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const teamHist = new Map();
    const leagueKills = [];
    const leagueOverall = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const leagueTrailing = leagueKills.length
        ? leagueKills.reduce((a, b) => a + b, 0) / leagueKills.length
        : leagueOverall;
      const avgFor = (teamRaw) => {
        const arr = teamHist.get(normalizeTeam(teamRaw)) || [];
        if (arr.length < FALLBACK_MIN_N) return leagueTrailing;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
      };
      const raw = (avgFor(g.team_blue) + avgFor(g.team_red)) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
      // só DEPOIS de gravar a fair o jogo entra no histórico (causalidade)
      for (const t of [g.team_blue, g.team_red]) {
        const k = normalizeTeam(t);
        if (!teamHist.has(k)) teamHist.set(k, []);
        teamHist.get(k).push(g.total_kills);
      }
      leagueKills.push(g.total_kills);
    }
  }
  return fairMap;
}

// ============================================================================
// FAIR C — Pinnacle manual, SÓ por lolesports_match_id (lookup por nome tem bug
// de substring — proibido nesta análise).
// ============================================================================
function loadFairPinnacleByMatchId() {
  const byMatch = new Map();
  if (!fs.existsSync(CRON_DIR)) return byMatch;
  const files = fs.readdirSync(CRON_DIR).filter((f) => /-fair-pinnacle\.json$/.test(f));
  for (const f of files) {
    const j = loadJson(path.join(CRON_DIR, f), false);
    for (const e of j?.fair_lines || []) {
      if (e.fair_line == null || !e.lolesports_match_id) continue;
      byMatch.set(String(e.lolesports_match_id), e.fair_line);
    }
  }
  return { byMatch, files_n: files.length };
}

// ============================================================================
// Enriquecimento por jogo a partir do cache (picks/roles, patch, duração).
// Cacheado em audit-cache/_derived-gameinfo.json pra re-run rápido.
// ============================================================================
function buildDerivedInfo(gameIds, matchIdByGame) {
  let cache = loadJson(DERIVED_CACHE, false);
  if (!cache || cache.version !== DERIVED_CACHE_VERSION) cache = { version: DERIVED_CACHE_VERSION, games: {} };

  // duração: uma passada nos event-*.json (1 arquivo cobre vários games)
  const durByGame = new Map();
  const neededMatch = new Set();
  for (const gid of gameIds) if (!cache.games[gid]) neededMatch.add(String(matchIdByGame.get(gid)));
  for (const mid of neededMatch) {
    const p = path.join(AUDIT_CACHE, `event-${mid}.json`);
    if (!fs.existsSync(p)) continue;
    const j = loadJson(p, false);
    for (const g of j?.data?.event?.match?.games || []) {
      const v = (g.vods || []).find(
        (x) => Number.isFinite(x.startMillis) && Number.isFinite(x.endMillis) && x.endMillis > x.startMillis
      );
      if (v) durByGame.set(String(g.id), (v.endMillis - v.startMillis) / 60000);
    }
  }

  let built = 0;
  for (const gid of gameIds) {
    if (cache.games[gid]) continue;
    const p = path.join(AUDIT_CACHE, `window-${gid}.json`);
    const info = { patch: null, blue: {}, red: {}, duration_min: durByGame.get(String(gid)) ?? null };
    if (fs.existsSync(p)) {
      const w = loadJson(p, false);
      info.patch = w?.gameMetadata?.patchVersion || null;
      const pick = (md) => {
        const o = {};
        for (const x of md?.participantMetadata || []) o[x.role] = x.championId;
        return o;
      };
      info.blue = pick(w?.gameMetadata?.blueTeamMetadata);
      info.red = pick(w?.gameMetadata?.redTeamMetadata);
    }
    cache.games[gid] = info;
    built++;
  }
  if (built) {
    try {
      fs.writeFileSync(DERIVED_CACHE, JSON.stringify(cache));
    } catch { /* cache é otimização — falhar aqui não invalida a análise */ }
  }
  return { cache, built };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  const noBets = process.argv.includes('--no-bets');
  const TODAY = new Date().toISOString().slice(0, 10);

  console.log('='.repeat(90));
  console.log('BARD FLEX — ANÁLISE DEFINITIVA (Under total kills)');
  console.log('='.repeat(90));

  // --------------------------------------------------------------------------
  // 1. Carga dos universos
  // --------------------------------------------------------------------------
  const uni1 = loadJson(SPLIT1_FILE).filter((g) => !g.suspect && g.total_kills != null);
  const uniAll = loadJson(ALLREGIONS_FILE).filter((g) => !g.suspect && g.total_kills != null);
  const uni3raw = loadJson(SPLIT3_FILE, false);
  const uni3 = (uni3raw || []).filter((g) => !g.suspect && g.total_kills != null);
  if (!uni3raw) {
    console.log(
      '\n⚠️  AVISO: 00-universe-split3-window.json ausente — split 3 vai sair vazio. ' +
        'Rode: node scripts/analysis/camille-collect.cjs --from=2026-07-21 --to=<amanhã> ' +
        '--out=00-universe-split3-window.json --fresh-schedule'
    );
  }

  // Pool moderno = allregions ∪ split3 (dedup por game_id; 21/07 aparece nos dois).
  const seen = new Set();
  const poolModern = [];
  for (const g of [...uniAll, ...uni3]) {
    if (seen.has(g.game_id)) continue;
    seen.add(g.game_id);
    poolModern.push(g);
  }
  const dupCount = uniAll.length + uni3.length - poolModern.length;

  // Fair calculada DENTRO de cada coleção (split1 tem a sua; pool moderno a sua).
  const fairLoo1 = computeFairLOO(uni1);
  const fairTrail1 = computeFairTrailing(uni1);
  const fairLooM = computeFairLOO(poolModern);
  const fairTrailM = computeFairTrailing(poolModern);
  const { byMatch: pinnByMatch, files_n: pinnFiles } = loadFairPinnacleByMatchId();

  // Enriquecimento (patch, 10 picks, duração)
  const allGames = [...uni1, ...poolModern];
  const matchIdByGame = new Map(allGames.map((g) => [String(g.game_id), String(g.match_id)]));
  const { cache: derived, built } = buildDerivedInfo(allGames.map((g) => String(g.game_id)), matchIdByGame);

  const splitOf = (dateStr, isSplit1) => {
    if (isSplit1) return 'split1';
    const d = (dateStr || '').slice(0, 10);
    if (d < SPLIT2_FROM) return 'pre';
    if (d < JULPRE_FROM) return 'split2';
    if (d < SPLIT3_FROM) return 'julpre';
    return 'split3';
  };

  const mkRow = (g, isSplit1) => {
    const gid = String(g.game_id);
    const info = derived.games[gid] || { patch: null, blue: {}, red: {}, duration_min: null };
    const fairLoo = (isSplit1 ? fairLoo1 : fairLooM).get(g.game_id);
    const fairTrail = (isSplit1 ? fairTrail1 : fairTrailM).get(g.game_id);
    const fairPinn = pinnByMatch.get(String(g.match_id));
    return {
      game_id: gid,
      match_id: String(g.match_id),
      league: g.league,
      league_id: g.league_id || null,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      split: splitOf(g.date, isSplit1),
      map_number: g.map_number,
      team_blue: normalizeTeam(g.team_blue),
      team_red: normalizeTeam(g.team_red),
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      picks_blue: info.blue || {},
      picks_red: info.red || {},
      patch: info.patch,
      duration_min: Number.isFinite(info.duration_min) ? info.duration_min : null,
      total_kills: g.total_kills,
      winner_side: g.winner_side,
      fair_loo: Number.isFinite(fairLoo) ? fairLoo : null,
      fair_trail: Number.isFinite(fairTrail) ? fairTrail : null,
      fair_pinn: Number.isFinite(fairPinn) ? fairPinn : null,
    };
  };

  const rows = [...uni1.map((g) => mkRow(g, true)), ...poolModern.map((g) => mkRow(g, false))].filter(
    (r) => Number.isFinite(r.fair_loo)
  );

  const SPLITS = ['split1', 'split2', 'julpre', 'split3'];
  const countBy = (arr, f) => {
    const m = {};
    for (const x of arr) m[f(x)] = (m[f(x)] || 0) + 1;
    return m;
  };

  console.log(`\nPopulação total (mapas válidos, não-suspeitos, com fair): ${rows.length}`);
  console.log(
    '  por recorte: ' +
      SPLITS.map((s) => `${s}=${rows.filter((r) => r.split === s).length}`).join(' · ') +
      ` · fora dos recortes (pre)=${rows.filter((r) => r.split === 'pre').length}`
  );
  console.log(
    `  dupes de game_id removidos no merge allregions×split3: ${dupCount} · ` +
      `derivados construídos nesta run: ${built} · com duração (VOD): ${rows.filter((r) => r.duration_min != null).length} ` +
      `(${fmt1((100 * rows.filter((r) => r.duration_min != null).length) / rows.length)}%) · ` +
      `com patch: ${rows.filter((r) => r.patch).length}`
  );
  console.log(
    `  fair Pinnacle manual: ${pinnFiles} arquivos, ${pinnByMatch.size} matches indexados → ` +
      `${rows.filter((r) => r.fair_pinn != null).length} mapas da população cobertos`
  );
  console.log(
    `  janela real do split 3: ${SPLIT3_FROM} → ${TODAY} · datas presentes: ` +
      Object.keys(countBy(rows.filter((r) => r.split === 'split3'), (r) => r.date.slice(0, 10)))
        .sort()
        .join(', ')
  );

  // --------------------------------------------------------------------------
  // 2. Definições de célula
  // --------------------------------------------------------------------------
  const supsOf = (r) => [normChamp(r.sup_blue), normChamp(r.sup_red)];
  const bardSide = (r) => (normChamp(r.sup_blue) === 'bard' ? 'blue' : normChamp(r.sup_red) === 'bard' ? 'red' : null);
  const hasBardSup = (r) => bardSide(r) !== null;
  const enemyPeelOf = (r) => {
    const side = bardSide(r);
    if (!side) return null;
    const enemy = side === 'blue' ? normChamp(r.sup_red) : normChamp(r.sup_blue);
    return PEEL_SET.has(enemy) ? enemy : null;
  };
  // BARD FLEX = trigger 1peel+flex tendo o Bard COMO flex (peel puro do outro lado).
  const isBardFlex = (r) => hasBardSup(r) && enemyPeelOf(r) !== null;
  const champFlex = (c) => (r) => {
    const [a, b] = supsOf(r);
    return (a === c && PEEL_SET.has(b)) || (b === c && PEEL_SET.has(a));
  };
  const is2peel = (r) => {
    const [a, b] = supsOf(r);
    return PEEL_SET.has(a) && PEEL_SET.has(b);
  };
  const hasTrigger = (r) => {
    const [a, b] = supsOf(r);
    const peels = (PEEL_SET.has(a) ? 1 : 0) + (PEEL_SET.has(b) ? 1 : 0);
    const flexes = (FLEX_SET.has(a) ? 1 : 0) + (FLEX_SET.has(b) ? 1 : 0);
    return peels === 2 || (peels === 1 && flexes >= 1);
  };

  const bardFlex = rows.filter(isBardFlex);
  const twoPeel = rows.filter(is2peel);
  const anyTrigger = rows.filter(hasTrigger);
  const noTrigger = rows.filter((r) => !hasTrigger(r));

  const out = {
    generated_at: new Date().toISOString(),
    params: {
      rungs: RUNGS,
      z_score_95: Z95,
      small_sample_n: SMALL_N,
      fair_fallback_min_n: FALLBACK_MIN_N,
      bootstrap_iters: BOOTSTRAP_ITERS,
      splits: {
        split1: 'audit-output/00-universe-split1.json (2026-01-14 → 2026-03-30, 6 ligas)',
        split2: '2026-04-01 → 2026-06-30 (allregions, ~30 ligas)',
        julpre: '2026-07-01 → 2026-07-20 (MSI/EWC/tier-2 — majors paradas)',
        split3: `2026-07-21 → ${TODAY} (coleta 26/07, ~43 ligas)`,
      },
      fair_rulers: {
        fair_loo: 'leave-one-out por liga (convenção do repo; usa período inteiro)',
        fair_trail: 'trailing causal (só jogos anteriores do time na liga; min 5)',
        fair_pinn: 'Pinnacle manual do Elvis, lookup SÓ por lolesports_match_id',
      },
      definicao_bard_flex:
        'Bard support de um lado E support PEEL_PURE do outro lado (= trigger 1peel+flex com o Bard sendo o flex)',
      peel_pure: PEEL_PURE,
      flex_engage: FLEX_ENGAGE,
      engage_list: ENGAGE_LIST,
    },
    meta: {
      population_n: rows.length,
      by_split_n: Object.fromEntries(SPLITS.map((s) => [s, rows.filter((r) => r.split === s).length])),
      dupes_removed: dupCount,
      coverage_duration_pct: fmt1((100 * rows.filter((r) => r.duration_min != null).length) / rows.length),
      coverage_patch_pct: fmt1((100 * rows.filter((r) => r.patch).length) / rows.length),
      pinnacle_files: pinnFiles,
      pinnacle_matches_indexed: pinnByMatch.size,
      pinnacle_maps_covered: rows.filter((r) => r.fair_pinn != null).length,
      bard_flex_n: bardFlex.length,
      two_peel_n: twoPeel.length,
    },
  };

  // --------------------------------------------------------------------------
  // 3. RECORTE PRINCIPAL — Bard flex por split (LOO) + pooled + bootstrap
  // --------------------------------------------------------------------------
  console.log('\n\n## 1. Bard como FLEX (1 peel do outro lado) — por recorte de tempo\n');
  console.log('Régua principal: fair leave-one-out por liga. Stats por MAPA.\n');
  tableHeader();
  const bardBySplit = {};
  for (const sp of SPLITS) {
    const s = cellStats(bardFlex.filter((r) => r.split === sp), 'fair_loo', { bootstrap: true });
    bardBySplit[sp] = s;
    printCellRow(`Bard flex — ${sp}`, s);
  }
  const bardPooledAll = cellStats(bardFlex, 'fair_loo', { bootstrap: true });
  const bardPooled23 = cellStats(bardFlex.filter((r) => r.split === 'split2' || r.split === 'split3'), 'fair_loo', { bootstrap: true });
  const bardPooled123 = cellStats(
    bardFlex.filter((r) => ['split1', 'split2', 'split3'].includes(r.split)),
    'fair_loo',
    { bootstrap: true }
  );
  printCellRow('**Bard flex — POOLED split2+split3**', bardPooled23);
  printCellRow('**Bard flex — POOLED split1+2+3**', bardPooled123);
  printCellRow('Bard flex — POOLED tudo (inclui julpre)', bardPooledAll);
  printCellRow('benchmark 2peel — POOLED tudo', cellStats(twoPeel, 'fair_loo', { bootstrap: true }));
  printCellRow('benchmark: universo SEM trigger', cellStats(noTrigger, 'fair_loo'));

  console.log('\n### Bootstrap (1000 reamostragens dos mapas) — hit @ fair+1\n');
  console.log('| recorte | n | hit pontual | bootstrap p2.5 | bootstrap mediana | bootstrap p97.5 | BE 58.1 dentro do intervalo? |');
  console.log('|---|---|---|---|---|---|---|');
  const bootRows = [
    ['split1', bardBySplit.split1],
    ['split2', bardBySplit.split2],
    ['julpre', bardBySplit.julpre],
    ['split3', bardBySplit.split3],
    ['POOLED 2+3', bardPooled23],
    ['POOLED 1+2+3', bardPooled123],
  ];
  for (const [label, s] of bootRows) {
    if (!s.n) { console.log(`| ${label} | 0 | - | - | - | - | - |`); continue; }
    const b = s.fairp1.bootstrap;
    const inside = b.p2_5 <= 58.1 && b.p97_5 >= 58.1;
    console.log(
      `| ${label} | ${s.n} | ${s.fairp1.hit_pct}% | ${b.p2_5}% | ${b.p50}% | ${b.p97_5}% | ${inside ? 'SIM (não separa do BE)' : 'NÃO (separa do BE)'} |`
    );
  }

  // Escada completa de linha (pra recomendação graduada: "Bard só na fair"?)
  // Odds de referência da escada real do Elvis (mesma tabela de les-complete.cjs).
  console.log('\n### Escada completa de linha — Bard flex pooled (onde a célula ainda paga)\n');
  const LADDER = [
    { delta: -2, odd: 2.05, label: 'fair−2' },
    { delta: -1, odd: 1.95, label: 'fair−1' },
    { delta: 0, odd: 1.83, label: 'fair' },
    { delta: 1, odd: 1.72, label: 'fair+1' },
    { delta: 2, odd: 1.62, label: 'fair+2' },
  ];
  const ladderOut = [];
  console.log('| degrau | odd de referência | BE | n | hit | CI95 | ROI | passa? |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const L of LADDER) {
    const usable = bardFlex.filter((r) => Number.isFinite(r.fair_loo));
    const wins = usable.filter((r) => r.total_kills < r.fair_loo + L.delta).length;
    const n = usable.length;
    const be = fmt1(100 / L.odd);
    const ci = wilsonCI(wins, n);
    const roi = roiPct(wins, n, L.odd);
    const passa = ci.lower > be;
    ladderOut.push({ degrau: L.label, odd: L.odd, be_pct: be, n, wins, hit_pct: fmt1((100 * wins) / n), wilson_ci_95: ci, roi_pct: roi, passa });
    console.log(`| ${L.label} | ${L.odd} | ${be}% | ${n} | ${fmt1((100 * wins) / n)}% | [${ci.lower}–${ci.upper}] | ${roi}% | ${passa ? '**SIM**' : 'não'} |`);
  }
  out.escada_linha = ladderOut;

  // Mensal (estabilidade no tempo)
  console.log('\n### Bard flex mês a mês (o efeito é estável ou é artefato de um período?)\n');
  tableHeader();
  const monthly = {};
  const monthsSorted = [...new Set(bardFlex.map((r) => r.month))].sort();
  for (const m of monthsSorted) {
    const s = cellStats(bardFlex.filter((r) => r.month === m), 'fair_loo');
    monthly[m] = s;
    printCellRow(m, s);
  }

  // Patch
  console.log('\n### Bard flex por patch (metadado do próprio jogo)\n');
  tableHeader();
  const byPatch = {};
  const patches = [...new Set(bardFlex.map((r) => r.patch).filter(Boolean))].sort();
  for (const p of patches) {
    const s = cellStats(bardFlex.filter((r) => r.patch === p), 'fair_loo');
    byPatch[p] = s;
    if (s.n >= 5) printCellRow(`patch ${p}`, s);
  }

  out.bard_flex = {
    by_split: bardBySplit,
    pooled_split2_3: bardPooled23,
    pooled_split1_2_3: bardPooled123,
    pooled_tudo: bardPooledAll,
    monthly,
    by_patch: byPatch,
    benchmark_2peel_pooled: cellStats(twoPeel, 'fair_loo'),
    benchmark_sem_trigger: cellStats(noTrigger, 'fair_loo'),
  };

  // --------------------------------------------------------------------------
  // 4. RECONCILIAÇÃO 67.2% × 58.1%
  // --------------------------------------------------------------------------
  console.log('\n\n## 2. Reconciliação 67.2% × 58.1%\n');

  // (a) reproduzir o 67.2 — allregions puro (04-01→07-21), 1peel+bard, LOO, fair+1
  const allregionsIds = new Set(uniAll.map((g) => String(g.game_id)));
  const bardAllregions = bardFlex.filter((r) => allregionsIds.has(r.game_id) && r.split !== 'split1');
  const repro672 = cellStats(bardAllregions, 'fair_loo');

  // (b) mesmas 3 réguas de fair na MESMA população (só mapas cobertos pelas 3)
  const bardComPinn = bardFlex.filter((r) => r.fair_pinn != null);
  const ruler = {
    loo_pop_completa: cellStats(bardFlex, 'fair_loo'),
    trail_pop_completa: cellStats(bardFlex, 'fair_trail'),
    loo_pop_com_pinnacle: cellStats(bardComPinn, 'fair_loo'),
    trail_pop_com_pinnacle: cellStats(bardComPinn, 'fair_trail'),
    pinn_pop_com_pinnacle: cellStats(bardComPinn, 'fair_pinn'),
  };
  console.log('### (a) Mesma população, réguas de fair diferentes\n');
  tableHeader();
  printCellRow('Bard flex — fair LOO (todos os mapas)', ruler.loo_pop_completa);
  printCellRow('Bard flex — fair TRAILING causal (todos)', ruler.trail_pop_completa);
  printCellRow('Bard flex — fair LOO (só mapas c/ Pinnacle)', ruler.loo_pop_com_pinnacle);
  printCellRow('Bard flex — fair TRAILING (só mapas c/ Pinnacle)', ruler.trail_pop_com_pinnacle);
  printCellRow('Bard flex — fair PINNACLE manual', ruler.pinn_pop_com_pinnacle);

  // (c) escopo de liga
  const ORIGINAL_6 = new Set(['LCK', 'LPL', 'LEC', 'CBLOL', 'LCS', 'LFL', 'La Ligue Française']);
  const scope = {
    todas_ligas_abr_jul21: repro672,
    seis_ligas_originais: cellStats(bardAllregions.filter((r) => ORIGINAL_6.has(r.league)), 'fair_loo'),
    seis_ligas_split2_only: cellStats(
      bardFlex.filter((r) => ORIGINAL_6.has(r.league) && r.split === 'split2'),
      'fair_loo'
    ),
  };
  console.log('\n### (b) Mesma régua (LOO/fair+1), escopos de liga/período diferentes\n');
  tableHeader();
  printCellRow('allregions 04-01→07-21, TODAS as ligas (= o 67.2 citado)', scope.todas_ligas_abr_jul21);
  printCellRow('só as 6 ligas originais (mesmo período)', scope.seis_ligas_originais);
  printCellRow('só as 6 ligas originais, só split 2', scope.seis_ligas_split2_only);

  out.reconciliacao = { ruler, scope };

  // --------------------------------------------------------------------------
  // 5. QUEBRAS
  // --------------------------------------------------------------------------
  console.log('\n\n## 3. Quebras\n');

  // (a) por peel inimigo
  console.log('### (a) Bard flex × peel inimigo específico (todos os splits, LOO)\n');
  tableHeader();
  const byEnemyPeel = [];
  const enemyGroups = new Map();
  for (const r of bardFlex) {
    const e = enemyPeelOf(r);
    if (!enemyGroups.has(e)) enemyGroups.set(e, []);
    enemyGroups.get(e).push(r);
  }
  for (const [peel, rs] of [...enemyGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = cellStats(rs, 'fair_loo', { bootstrap: rs.length >= SMALL_N });
    const perSplit = Object.fromEntries(
      SPLITS.map((sp) => [sp, cellStats(rs.filter((r) => r.split === sp), 'fair_loo')])
    );
    byEnemyPeel.push({ peel, ...s, by_split: perSplit });
    printCellRow(`Bard vs ${peel}`, s);
  }

  // Lulu/Karma nos 3 recortes (a regra de skip)
  console.log('\n### (a2) Regra de SKIP Bard×Lulu e Bard×Karma — recorte por recorte\n');
  tableHeader();
  const skipCheck = {};
  for (const peel of ['lulu', 'karma']) {
    const rs = enemyGroups.get(peel) || [];
    skipCheck[peel] = {
      pooled: cellStats(rs, 'fair_loo', { bootstrap: true }),
      by_split: Object.fromEntries(SPLITS.map((sp) => [sp, cellStats(rs.filter((r) => r.split === sp), 'fair_loo')])),
      trailing: cellStats(rs, 'fair_trail'),
      seis_ligas: cellStats(rs.filter((r) => ORIGINAL_6.has(r.league)), 'fair_loo'),
    };
    printCellRow(`Bard vs ${peel} — POOLED`, skipCheck[peel].pooled);
    for (const sp of SPLITS) printCellRow(`  ↳ ${peel} — ${sp}`, skipCheck[peel].by_split[sp]);
    printCellRow(`  ↳ ${peel} — só 6 ligas originais`, skipCheck[peel].seis_ligas);
    printCellRow(`  ↳ ${peel} — fair TRAILING causal`, skipCheck[peel].trailing);
  }
  const bardSemLuluKarma = bardFlex.filter((r) => !['lulu', 'karma'].includes(enemyPeelOf(r)));
  printCellRow('**Bard flex SEM Lulu/Karma (regra aplicada)**', cellStats(bardSemLuluKarma, 'fair_loo', { bootstrap: true }));

  // (b) lado do Bard
  console.log('\n### (b) De que lado está o Bard (1 sup por time ⇒ Bard e peel NUNCA no mesmo time)\n');
  tableHeader();
  const sideStats = {
    bard_blue: cellStats(bardFlex.filter((r) => bardSide(r) === 'blue'), 'fair_loo'),
    bard_red: cellStats(bardFlex.filter((r) => bardSide(r) === 'red'), 'fair_loo'),
    bard_venceu: cellStats(bardFlex.filter((r) => r.winner_side && r.winner_side === bardSide(r)), 'fair_loo'),
    bard_perdeu: cellStats(bardFlex.filter((r) => r.winner_side && r.winner_side !== bardSide(r)), 'fair_loo'),
  };
  printCellRow('Bard no lado AZUL', sideStats.bard_blue);
  printCellRow('Bard no lado VERMELHO', sideStats.bard_red);
  printCellRow('time do Bard VENCEU o mapa', sideStats.bard_venceu);
  printCellRow('time do Bard PERDEU o mapa', sideStats.bard_perdeu);

  // (c) por liga + baseline DA MESMA liga (controle de confundidor)
  console.log('\n### (c) Bard flex por liga — contra o baseline DA PRÓPRIA LIGA (n≥10)\n');
  console.log('| liga | n Bard flex | hit@fair+1 Bard | baseline liga (todos os mapas) | n baseline | delta pp | p (2 prop.) |');
  console.log('|---|---|---|---|---|---|---|');
  const byLeague = [];
  const leagueGroups = new Map();
  for (const r of bardFlex) {
    if (!leagueGroups.has(r.league)) leagueGroups.set(r.league, []);
    leagueGroups.get(r.league).push(r);
  }
  for (const [lg, rs] of [...leagueGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = cellStats(rs, 'fair_loo');
    const baseRows = rows.filter((r) => r.league === lg);
    const b = cellStats(baseRows, 'fair_loo');
    const test = s.n && b.n ? twoPropZ(s.fairp1.wins, s.n, b.fairp1.wins, b.n) : { p_two_sided: null };
    const entry = {
      league: lg,
      ...s,
      baseline_liga: { n: b.n, hit_pct: b.n ? b.fairp1.hit_pct : null, avg_kills: b.avg_kills },
      delta_pp: s.n && b.n ? fmt1(s.fairp1.hit_pct - b.fairp1.hit_pct) : null,
      p_two_sided: test.p_two_sided,
    };
    byLeague.push(entry);
    if (s.n >= SMALL_N) {
      console.log(
        `| ${lg} | ${s.n} | ${s.fairp1.hit_pct}% | ${b.fairp1.hit_pct}% | ${b.n} | ${entry.delta_pp > 0 ? '+' : ''}${entry.delta_pp} | ${test.p_two_sided} |`
      );
    }
  }
  // baseline global ponderado pela distribuição de ligas do Bard (padronização direta)
  let wHit = 0;
  let wN = 0;
  for (const e of byLeague) {
    if (!e.n || !e.baseline_liga.n) continue;
    wHit += e.baseline_liga.hit_pct * e.n;
    wN += e.n;
  }
  const baselineLigaPadronizado = wN ? fmt1(wHit / wN) : null;
  console.log(
    `\n**Controle de liga:** baseline padronizado (média das ligas ponderada pela distribuição de jogos do Bard) = ` +
      `${baselineLigaPadronizado}% · Bard flex pooled = ${ruler.loo_pop_completa.fairp1.hit_pct}% · ` +
      `delta = ${fmt1(ruler.loo_pop_completa.fairp1.hit_pct - baselineLigaPadronizado)}pp. ` +
      `(Se o delta some, o "under do Bard" era só a liga.)`
  );

  // (c2) só as LIGAS QUE O ELVIS OPERA (o número operacionalmente relevante) + por mapa
  const LIGAS_OPERADAS = new Set([
    'LCK', 'LPL', 'LEC', 'CBLOL', 'LCS', 'La Ligue Française', 'LFL', 'LES',
    'Prime League', 'EMEA Masters', 'LCP',
  ]);
  console.log('\n### (c2) Recorte operacional — só ligas que o Elvis opera hoje, e por mapa\n');
  tableHeader();
  const operacional = {
    ligas_operadas: cellStats(bardFlex.filter((r) => LIGAS_OPERADAS.has(r.league)), 'fair_loo', { bootstrap: true }),
    ligas_nao_operadas: cellStats(bardFlex.filter((r) => !LIGAS_OPERADAS.has(r.league)), 'fair_loo', { bootstrap: true }),
    seis_majors: cellStats(
      bardFlex.filter((r) => ['LCK', 'LPL', 'LEC', 'CBLOL', 'LCS', 'La Ligue Française'].includes(r.league)),
      'fair_loo',
      { bootstrap: true }
    ),
    ligas_operadas_trailing: cellStats(bardFlex.filter((r) => LIGAS_OPERADAS.has(r.league)), 'fair_trail'),
    mapa1: cellStats(bardFlex.filter((r) => r.map_number === 1), 'fair_loo'),
    mapa2: cellStats(bardFlex.filter((r) => r.map_number === 2), 'fair_loo'),
    mapa3plus: cellStats(bardFlex.filter((r) => r.map_number >= 3), 'fair_loo'),
    by_split: {},
  };
  printCellRow('Bard flex — SÓ ligas operadas', operacional.ligas_operadas);
  printCellRow('  ↳ mesma célula, fair TRAILING causal', operacional.ligas_operadas_trailing);
  printCellRow('Bard flex — ligas NÃO operadas', operacional.ligas_nao_operadas);
  printCellRow('Bard flex — só as 6 majors originais', operacional.seis_majors);
  printCellRow('Bard flex — mapa 1', operacional.mapa1);
  printCellRow('Bard flex — mapa 2', operacional.mapa2);
  printCellRow('Bard flex — mapa 3+', operacional.mapa3plus);
  console.log('\n### (c3) Ligas operadas, recorte a recorte\n');
  tableHeader();
  for (const sp of SPLITS) {
    const s = cellStats(bardFlex.filter((r) => LIGAS_OPERADAS.has(r.league) && r.split === sp), 'fair_loo');
    operacional.by_split[sp] = s;
    printCellRow(`ligas operadas — ${sp}`, s);
  }

  // (d) Bard em outra role
  console.log('\n### (d) Bard em role diferente de support\n');
  const bardRoleOf = (r) => {
    for (const side of ['picks_blue', 'picks_red']) {
      for (const [role, ch] of Object.entries(r[side] || {})) if (normChamp(ch) === 'bard') return role;
    }
    return null;
  };
  const bardAnywhere = rows.filter((r) => bardRoleOf(r) !== null);
  const bardNaoSup = bardAnywhere.filter((r) => !hasBardSup(r));
  tableHeader();
  printCellRow('Bard em QUALQUER role (qualquer contexto)', cellStats(bardAnywhere, 'fair_loo'));
  printCellRow('Bard support (qualquer contexto, sem exigir peel)', cellStats(rows.filter(hasBardSup), 'fair_loo'));
  printCellRow('Bard fora do support', cellStats(bardNaoSup, 'fair_loo'));
  const roleDist = countBy(bardAnywhere, bardRoleOf);
  console.log(`\nDistribuição de role do Bard: ${JSON.stringify(roleDist)}`);

  out.quebras = {
    por_peel_inimigo: byEnemyPeel,
    skip_lulu_karma: skipCheck,
    bard_flex_sem_lulu_karma: cellStats(bardSemLuluKarma, 'fair_loo'),
    por_lado: sideStats,
    por_liga: byLeague,
    recorte_operacional: operacional,
    baseline_liga_padronizado_pct: baselineLigaPadronizado,
    bard_por_role: {
      distribuicao: roleDist,
      qualquer_role: cellStats(bardAnywhere, 'fair_loo'),
      support_qualquer_contexto: cellStats(rows.filter(hasBardSup), 'fair_loo'),
      fora_do_support: cellStats(bardNaoSup, 'fair_loo'),
    },
  };

  // --------------------------------------------------------------------------
  // 6. RANKING DOS 4 FLEX (mesma régua)
  // --------------------------------------------------------------------------
  console.log('\n\n## 4. Ranking dos 4 flex — mesma régua (LOO, fair+1), com 1 peel do outro lado\n');
  tableHeader();
  const flexRanking = [];
  for (const c of ['bard', 'rakan', 'lux', 'anivia']) {
    const rs = rows.filter(champFlex(c));
    const s = cellStats(rs, 'fair_loo', { bootstrap: rs.length >= SMALL_N });
    const perSplit = Object.fromEntries(SPLITS.map((sp) => [sp, cellStats(rs.filter((r) => r.split === sp), 'fair_loo')]));
    flexRanking.push({ champ: c, ...s, by_split: perSplit });
    printCellRow(`1peel+${c}`, s);
  }
  const twoPeelStats = cellStats(twoPeel, 'fair_loo', { bootstrap: true });
  printCellRow('**benchmark 2peel (core do método)**', twoPeelStats);
  printCellRow('todos os triggers juntos', cellStats(anyTrigger, 'fair_loo'));

  console.log('\n### Os 4 flex, recorte por recorte (fair+1)\n');
  console.log('| flex | split1 | split2 | julpre | split3 | pooled |');
  console.log('|---|---|---|---|---|---|');
  for (const f of flexRanking) {
    const cell = (sp) => {
      const s = f.by_split[sp];
      return s.n ? `${s.fairp1.hit_pct}% (n=${s.n})${s.small_sample ? '⚠️' : ''}` : '—';
    };
    console.log(`| ${f.champ} | ${cell('split1')} | ${cell('split2')} | ${cell('julpre')} | ${cell('split3')} | ${f.fairp1.hit_pct}% (n=${f.n}) |`);
  }
  out.ranking_flex = { flex: flexRanking, benchmark_2peel: twoPeelStats, todos_triggers: cellStats(anyTrigger, 'fair_loo') };

  // --------------------------------------------------------------------------
  // 7. CONFUNDIDORES — comp inimiga
  // --------------------------------------------------------------------------
  console.log('\n\n## 5. Confundidores — comp do time inimigo\n');
  const enemyPicksOf = (r) => (bardSide(r) === 'blue' ? r.picks_red : r.picks_blue);
  const ownPicksOf = (r) => (bardSide(r) === 'blue' ? r.picks_blue : r.picks_red);
  const engageCount = (picks) =>
    Object.values(picks || {}).filter((c) => ENGAGE_SET.has(normChamp(c)) || TEAMFIGHT_SET.has(normChamp(c))).length;
  const hasChamp = (picks, c) => Object.values(picks || {}).some((x) => normChamp(x) === c);

  const bardComPicks = bardFlex.filter((r) => Object.keys(r.picks_blue || {}).length && Object.keys(r.picks_red || {}).length);
  console.log(`Mapas de Bard flex com os 10 picks no cache: ${bardComPicks.length}/${bardFlex.length}\n`);
  tableHeader();
  const enemyComp = {};
  for (const [label, filt] of [
    ['comp inimiga 0-1 engage/teamfight', (r) => engageCount(enemyPicksOf(r)) <= 1],
    ['comp inimiga 2 engage/teamfight', (r) => engageCount(enemyPicksOf(r)) === 2],
    ['comp inimiga 3+ engage/teamfight', (r) => engageCount(enemyPicksOf(r)) >= 3],
    ['Camille em qualquer lado', (r) => hasChamp(r.picks_blue, 'camille') || hasChamp(r.picks_red, 'camille')],
    ['Shen em qualquer lado', (r) => hasChamp(r.picks_blue, 'shen') || hasChamp(r.picks_red, 'shen')],
    ['Milio é o peel inimigo', (r) => enemyPeelOf(r) === 'milio'],
    ['peel inimigo != Milio', (r) => enemyPeelOf(r) !== 'milio'],
    ['comp DO BARD 3+ engage/teamfight', (r) => engageCount(ownPicksOf(r)) >= 3],
  ]) {
    const s = cellStats(bardComPicks.filter(filt), 'fair_loo');
    enemyComp[label] = s;
    printCellRow(label, s);
  }
  out.confundidores_comp = enemyComp;

  // --------------------------------------------------------------------------
  // 8. MECANISMO — duração e pace
  // --------------------------------------------------------------------------
  console.log('\n\n## 6. Mecanismo — o Bard alonga o jogo (pace) ou reduz o total?\n');
  console.log(
    'Duração = janela do VOD oficial (startMillis→endMillis do getEventDetails). Inclui um overhead ' +
      'constante de pré-jogo, então vale como comparação RELATIVA entre células, não como duração absoluta.\n'
  );
  const mech = (label, rs) => {
    const withDur = rs.filter((r) => Number.isFinite(r.duration_min));
    if (!withDur.length) return { label, n: 0 };
    const dur = withDur.reduce((a, r) => a + r.duration_min, 0) / withDur.length;
    const kpm = withDur.reduce((a, r) => a + r.total_kills / r.duration_min, 0) / withDur.length;
    const kills = withDur.reduce((a, r) => a + r.total_kills, 0) / withDur.length;
    return { label, n: withDur.length, avg_duration_min: fmt1(dur), avg_kills: fmt1(kills), avg_kills_per_min: fmt2(kpm) };
  };
  const mechRows = [
    mech('Bard flex', bardFlex),
    mech('2peel (core)', twoPeel),
    mech('1peel+rakan', rows.filter(champFlex('rakan'))),
    mech('Bard sup sem peel do outro lado', rows.filter((r) => hasBardSup(r) && !isBardFlex(r))),
    mech('universo sem trigger', noTrigger),
    mech('universo inteiro', rows),
  ];
  console.log('| célula | n c/ duração | duração média (min) | kills médio | kills/min |');
  console.log('|---|---|---|---|---|');
  for (const m of mechRows) console.log(`| ${m.label} | ${m.n} | ${m.avg_duration_min ?? '-'} | ${m.avg_kills ?? '-'} | ${m.avg_kills_per_min ?? '-'} |`);

  const baseMech = mechRows.find((m) => m.label === 'universo inteiro');
  const bardMech = mechRows[0];
  let mechVerdict = 'sem dado de duração suficiente';
  if (bardMech.n && baseMech.n) {
    const dDur = bardMech.avg_duration_min - baseMech.avg_duration_min;
    const dKpm = bardMech.avg_kills_per_min - baseMech.avg_kills_per_min;
    const dKills = bardMech.avg_kills - baseMech.avg_kills;
    // decomposição: quanto do delta de kills vem de duração vs de pace
    const fromDur = dDur * baseMech.avg_kills_per_min;
    const fromPace = dKpm * baseMech.avg_duration_min;
    mechVerdict =
      `delta kills = ${fmt2(dKills)} · atribuível a DURAÇÃO ≈ ${fmt2(fromDur)} · ` +
      `atribuível a PACE (kills/min) ≈ ${fmt2(fromPace)} · resíduo ${fmt2(dKills - fromDur - fromPace)}`;
    console.log(`\n**Decomposição vs universo inteiro:** ${mechVerdict}`);
  }
  out.mecanismo = { celulas: mechRows, decomposicao: mechVerdict };

  // --------------------------------------------------------------------------
  // 9. OUT-OF-SAMPLE
  // --------------------------------------------------------------------------
  console.log('\n\n## 7. Teste out-of-sample (foi o que matou o método Over engage)\n');
  const oos = [];
  const oosPair = (label, trainRows, testRows) => {
    const tr = cellStats(trainRows, 'fair_loo');
    const te = cellStats(testRows, 'fair_loo', { bootstrap: testRows.length >= SMALL_N });
    const entry = {
      label,
      treino: { n: tr.n, hit_fairp1: tr.n ? tr.fairp1.hit_pct : null, roi: tr.n ? tr.fairp1.roi_pct : null },
      teste: {
        n: te.n,
        hit_fairp1: te.n ? te.fairp1.hit_pct : null,
        ci: te.n ? te.fairp1.wilson_ci_95 : null,
        roi: te.n ? te.fairp1.roi_pct : null,
        acima_do_be: te.n ? te.fairp1.hit_pct > RUNGS.fairp1.be_pct : null,
      },
      queda_pp: tr.n && te.n ? fmt1(te.fairp1.hit_pct - tr.fairp1.hit_pct) : null,
    };
    oos.push(entry);
    return entry;
  };
  oosPair('treina split1 → testa split2+julpre+split3', bardFlex.filter((r) => r.split === 'split1'), bardFlex.filter((r) => ['split2', 'julpre', 'split3'].includes(r.split)));
  oosPair('treina split1+2 → testa julpre+split3', bardFlex.filter((r) => ['split1', 'split2'].includes(r.split)), bardFlex.filter((r) => ['julpre', 'split3'].includes(r.split)));
  oosPair('treina split2 → testa split3', bardFlex.filter((r) => r.split === 'split2'), bardFlex.filter((r) => r.split === 'split3'));
  oosPair('treina split1+2+julpre → testa split3', bardFlex.filter((r) => ['split1', 'split2', 'julpre'].includes(r.split)), bardFlex.filter((r) => r.split === 'split3'));
  console.log('| desenho | n treino | hit treino | n teste | hit teste [CI95] | ROI teste @1.72 | passou o BE? | queda |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const e of oos) {
    console.log(
      `| ${e.label} | ${e.treino.n} | ${e.treino.hit_fairp1 ?? '-'}% | ${e.teste.n} | ` +
        `${e.teste.hit_fairp1 ?? '-'}%${e.teste.ci ? ` [${e.teste.ci.lower}–${e.teste.ci.upper}]` : ''} | ` +
        `${e.teste.roi ?? '-'}% | ${e.teste.acima_do_be === null ? '-' : e.teste.acima_do_be ? 'SIM' : 'NÃO'} | ` +
        `${e.queda_pp == null ? '-' : `${e.queda_pp > 0 ? '+' : ''}${e.queda_pp}pp`} |`
    );
  }
  // out-of-sample da REGRA de skip Lulu/Karma
  const oosSkip = [];
  for (const [label, trainSp, testSp] of [
    ['skip Lulu/Karma: split1+2 → split3+julpre', ['split1', 'split2'], ['julpre', 'split3']],
    ['skip Lulu/Karma: split1 → split2', ['split1'], ['split2']],
  ]) {
    const trRule = bardFlex.filter((r) => trainSp.includes(r.split) && ['lulu', 'karma'].includes(enemyPeelOf(r)));
    const trRest = bardFlex.filter((r) => trainSp.includes(r.split) && !['lulu', 'karma'].includes(enemyPeelOf(r)));
    const teRule = bardFlex.filter((r) => testSp.includes(r.split) && ['lulu', 'karma'].includes(enemyPeelOf(r)));
    const teRest = bardFlex.filter((r) => testSp.includes(r.split) && !['lulu', 'karma'].includes(enemyPeelOf(r)));
    oosSkip.push({
      label,
      treino: { lulu_karma: cellStats(trRule, 'fair_loo'), resto: cellStats(trRest, 'fair_loo') },
      teste: { lulu_karma: cellStats(teRule, 'fair_loo'), resto: cellStats(teRest, 'fair_loo') },
    });
  }
  console.log('\n### Out-of-sample da REGRA de skip (Lulu/Karma pior que o resto se sustenta fora da amostra?)\n');
  console.log('| desenho | treino: Lulu/Karma | treino: resto | teste: Lulu/Karma | teste: resto | regra sobrevive? |');
  console.log('|---|---|---|---|---|---|');
  for (const e of oosSkip) {
    const f = (s) => (s.n ? `${s.fairp1.hit_pct}% (n=${s.n})${s.small_sample ? '⚠️' : ''}` : 'n=0');
    let survives = 'sem amostra no teste';
    if (e.teste.lulu_karma.n && e.teste.resto.n) {
      const gap = e.teste.lulu_karma.fairp1.hit_pct - e.teste.resto.fairp1.hit_pct;
      const acimaBe = e.teste.lulu_karma.fairp1.hit_pct > RUNGS.fairp1.be_pct;
      // A regra só "sobrevive" se, FORA da amostra, a célula Lulu/Karma for pior
      // que o resto POR MARGEM ÚTIL (≥5pp) E ficar abaixo do BE — senão skipar é
      // jogar dinheiro fora numa célula que ainda paga.
      survives =
        gap <= -5 && !acimaBe
          ? `SOBREVIVE (gap ${fmt1(gap)}pp e abaixo do BE)`
          : gap > 0
          ? `NÃO — célula Lulu/Karma foi MELHOR (${fmt1(gap)}pp)`
          : `NÃO — gap só ${fmt1(gap)}pp e a célula segue ${acimaBe ? 'ACIMA' : 'abaixo'} do BE`;
      e.verdict = survives;
      e.gap_pp = fmt1(gap);
      e.teste_acima_do_be = acimaBe;
    }
    console.log(`| ${e.label} | ${f(e.treino.lulu_karma)} | ${f(e.treino.resto)} | ${f(e.teste.lulu_karma)} | ${f(e.teste.resto)} | ${survives} |`);
  }
  out.out_of_sample = { bard_flex: oos, regra_skip: oosSkip };

  // --------------------------------------------------------------------------
  // 10. COMPARAÇÕES MÚLTIPLAS
  // --------------------------------------------------------------------------
  console.log('\n\n## 8. Comparações múltiplas (quantas células passariam por acaso)\n');
  const tested = [];
  const push = (family, label, s) => {
    if (!s || s.n < SMALL_N) return;
    tested.push({ family, label, n: s.n, hit: s.fairp1.hit_pct, p: s.fairp1.p_value_vs_be });
  };
  for (const e of byEnemyPeel) push('peel inimigo', `Bard vs ${e.peel}`, e);
  for (const e of byLeague) push('liga', `Bard flex ${e.league}`, e);
  for (const [k, s] of Object.entries(enemyComp)) push('comp inimiga', k, s);
  for (const [k, s] of Object.entries(monthly)) push('mês', k, s);
  for (const [k, s] of Object.entries(byPatch)) push('patch', k, s);
  for (const [k, s] of Object.entries(sideStats)) push('lado', k, s);
  const pvals = tested.map((t) => t.p);
  const bh = benjaminiHochberg(pvals, 0.05);
  const naive = tested.filter((t) => t.p != null && t.p < 0.05);
  console.log(
    `Células testadas (n≥10): **${tested.length}**. Passariam por acaso a 5%: ~${fmt1(tested.length * 0.05)}. ` +
      `Passam no teste ingênuo (p<0.05 vs BE 58.1%): **${naive.length}**. ` +
      `Sobrevivem à correção Benjamini-Hochberg (FDR 5%): **${bh.survivors.size}**.`
  );
  if (bh.survivors.size) {
    console.log('\n| célula sobrevivente | família | n | hit@fair+1 | p |');
    console.log('|---|---|---|---|---|');
    for (const i of [...bh.survivors].sort((a, b) => pvals[a] - pvals[b])) {
      const t = tested[i];
      console.log(`| ${t.label} | ${t.family} | ${t.n} | ${t.hit}% | ${t.p < 1e-4 ? '<0.0001' : t.p.toFixed(4)} |`);
    }
  }
  out.comparacoes_multiplas = {
    celulas_testadas: tested.length,
    esperado_por_acaso_5pct: fmt1(tested.length * 0.05),
    passam_ingenuo: naive.length,
    sobrevivem_bh_fdr5: bh.survivors.size,
    bh_threshold_p: bh.threshold_p,
    sobreviventes: [...bh.survivors].map((i) => tested[i]),
    todas: tested,
  };

  // --------------------------------------------------------------------------
  // 11. R$ REAL (Supabase read-only)
  // --------------------------------------------------------------------------
  let betsBlock = { skipped: true };
  if (!noBets) {
    try {
      const { loadAllBets } = require('../audit/lib/audit-common.cjs');
      const bets = await loadAllBets();
      const isBardBet = (b) => {
        const mc = b.raw_extraction?.match_context || {};
        const a = normChamp(mc.blue_picks?.support);
        const c = normChamp(mc.red_picks?.support);
        if (a !== 'bard' && c !== 'bard') return false;
        const enemy = a === 'bard' ? c : a;
        return PEEL_SET.has(enemy);
      };
      const settled = bets.filter((b) => b.status === 'green' || b.status === 'red');
      const isUnder = (b) => /under|menos\s*de/i.test(b.pick || '');
      const bardBetsAll = settled.filter(isBardBet);
      const bardBets = bardBetsAll.filter(isUnder); // método = Under; Over/ML ficam de fora
      const foraDoMetodo = bardBetsAll.filter((b) => !isUnder(b));
      const bardReal = bardBets.filter((b) => b.bookmaker !== 'SIMULATED');
      const bardSim = bardBets.filter((b) => b.bookmaker === 'SIMULATED');

      const sumProfit = (arr) => arr.reduce((a, b) => a + (parseFloat(b.profit) || 0), 0);
      const sumStake = (arr) => arr.reduce((a, b) => a + (parseFloat(b.stake) || 0), 0);
      const peelOfBet = (b) => {
        const mc = b.raw_extraction?.match_context || {};
        const a = normChamp(mc.blue_picks?.support);
        const c = normChamp(mc.red_picks?.support);
        return a === 'bard' ? c : a;
      };
      const mapsOf = (arr) => new Set(arr.map((b) => String(b.raw_extraction?.match_context?.lolesports_game_id || b.id))).size;

      // hit POR MAPA (regra inviolável: 1 stake/mapa) — réplica do aggBy de
      // lib/analiseStats.cjs: ordena por bet_datetime desc e a 1ª bet define o mapa.
      const hitPorMapa = (arr) => {
        const byMap = new Map();
        for (const b of [...arr].sort((x, y) => String(y.bet_datetime || '').localeCompare(String(x.bet_datetime || '')))) {
          const gid = String(b.raw_extraction?.match_context?.lolesports_game_id || b.id);
          if (!byMap.has(gid)) byMap.set(gid, b.status === 'green');
        }
        const n = byMap.size;
        const w = [...byMap.values()].filter(Boolean).length;
        return { mapas: n, mapas_green: w, hit_por_mapa_pct: n ? fmt1((100 * w) / n) : null };
      };

      const grupo = (arr) => {
        const hm = hitPorMapa(arr);
        return {
          bets: arr.length,
          ...hm,
          green: arr.filter((b) => b.status === 'green').length,
          red: arr.filter((b) => b.status === 'red').length,
          hit_por_bet_pct: arr.length ? fmt1((100 * arr.filter((b) => b.status === 'green').length) / arr.length) : null,
          stake_total: fmt1(sumStake(arr)),
          pl_total: fmt1(sumProfit(arr)),
          roi_pct: sumStake(arr) ? fmt1((100 * sumProfit(arr)) / sumStake(arr)) : null,
        };
      };

      const comMilio = bardReal.filter((b) => peelOfBet(b) === 'milio');
      const semMilio = bardReal.filter((b) => peelOfBet(b) !== 'milio');
      const luluKarma = bardReal.filter((b) => ['lulu', 'karma'].includes(peelOfBet(b)));
      const restoPeel = bardReal.filter((b) => !['lulu', 'karma', 'milio'].includes(peelOfBet(b)));

      console.log('\n\n## 9. Impacto em R$ REAL (Supabase, read-only)\n');
      console.log('| recorte | bets | mapas | G | R | hit% por bet | hit% por MAPA | stake total | P/L | ROI |');
      console.log('|---|---|---|---|---|---|---|---|---|---|');
      const linhas = [
        ['Bard flex — bets REAIS (todas)', grupo(bardReal)],
        ['  ↳ com Milio como peel (sinal extra)', grupo(comMilio)],
        ['  ↳ sem Milio', grupo(semMilio)],
        ['  ↳ vs Lulu/Karma (deveria ser SKIP)', grupo(luluKarma)],
        ['  ↳ resto dos peels', grupo(restoPeel)],
        ['Bard flex — SIMULATED', grupo(bardSim)],
        ['(fora do método: Over/ML em jogo de Bard flex)', grupo(foraDoMetodo.filter((b) => b.bookmaker !== 'SIMULATED'))],
      ];
      for (const [lb, g] of linhas) {
        console.log(
          `| ${lb} | ${g.bets} | ${g.mapas} | ${g.green} | ${g.red} | ${g.hit_por_bet_pct ?? '-'}% | ${g.hit_por_mapa_pct ?? '-'}% | R$${g.stake_total} | R$${g.pl_total} | ${g.roi_pct ?? '-'}% |`
        );
      }
      const cf = grupo(bardReal);
      console.log(
        `\n**Contrafactual "Bard nunca foi flex":** essas ${cf.bets} bets reais viram skip → o Elvis ` +
          `${cf.pl_total >= 0 ? 'DEIXARIA DE GANHAR' : 'TERIA ECONOMIZADO'} R$${Math.abs(cf.pl_total).toLocaleString('pt-BR')} ` +
          `(stake exposta R$${cf.stake_total.toLocaleString('pt-BR')}).`
      );
      const cfSemLK = grupo(bardReal.filter((b) => !['lulu', 'karma'].includes(peelOfBet(b))));
      console.log(
        `**Contrafactual "skip Lulu/Karma respeitado":** P/L iria de R$${cf.pl_total.toLocaleString('pt-BR')} ` +
          `para R$${cfSemLK.pl_total.toLocaleString('pt-BR')} (delta R$${fmt1(cfSemLK.pl_total - cf.pl_total).toLocaleString('pt-BR')}).`
      );

      // ----------------------------------------------------------------------
      // DECOMPOSIÇÃO DA LINHA — o pedaço que fecha a reconciliação 67 × 58.
      // Para as MESMAS apostas reais: quanto o hit muda quando trocamos "linha
      // que o Elvis pegou" por "linha sintética fair+1 do backtest".
      // ----------------------------------------------------------------------
      const rowByGame = new Map(rows.map((r) => [r.game_id, r]));
      const linhaRows = [];
      const seenMap = new Set();
      // dedup idêntica ao fetchAndDedup() de lib/analiseStats.cjs: se o mapa tem bet
      // REAL, a SIMULATED do mesmo game_id é descartada (senão a simulada "rouba" o
      // mapa na ordenação e o recorte "só reais" fica menor do que é).
      const gidsComReal = new Set(
        bardBets
          .filter((b) => b.bookmaker !== 'SIMULATED')
          .map((b) => String(b.raw_extraction?.match_context?.lolesports_game_id || ''))
          .filter(Boolean)
      );
      const bardBetsDedup = bardBets.filter((b) => {
        if (b.bookmaker !== 'SIMULATED') return true;
        const g = String(b.raw_extraction?.match_context?.lolesports_game_id || '');
        return !g || !gidsComReal.has(g);
      });
      for (const b of [...bardBetsDedup].sort((a, b2) => String(b2.bet_datetime || '').localeCompare(String(a.bet_datetime || '')))) {
        const mc = b.raw_extraction?.match_context || {};
        const gid = mc.lolesports_game_id ? String(mc.lolesports_game_id) : null;
        if (!gid || seenMap.has(gid)) continue; // 1 stake por mapa (aggBy)
        const r = rowByGame.get(gid);
        if (!r) continue;
        seenMap.add(gid);
        // linha efetiva: réplica de getBetSimulation()/split2-improve.cjs
        let baseLine = mc.pick_line ?? null;
        if (baseLine == null) {
          const mm = (b.pick || '').match(/(\d+(?:[.,]\d+)?)/g);
          if (mm) baseLine = parseFloat(mm[mm.length - 1].replace(',', '.'));
        }
        if (b.bookmaker !== 'SIMULATED') {
          const realOdd = parseFloat(b.odd);
          if (Number.isFinite(realOdd) && realOdd < 1.72 && baseLine != null) baseLine -= 1;
        }
        if (baseLine == null) continue;
        const isOver = /over|mais de/i.test(b.pick || '');
        const rawLine = mc.pick_line ?? baseLine;
        linhaRows.push({
          bet_id: b.id,
          real: b.bookmaker !== 'SIMULATED',
          status: b.status,
          game_id: gid,
          league: r.league,
          date: r.date,
          kills: r.total_kills,
          fair_loo: r.fair_loo,
          linha_crua: rawLine,
          linha_efetiva: baseLine, // pick_line ajustada pela regra odd<1.72 → −1 (analiseStats)
          gap_linha_crua_vs_fair: fmt1(rawLine - r.fair_loo),
          gap_linha_vs_fair: fmt1(baseLine - r.fair_loo),
          odd: parseFloat(b.odd) || null,
          // ground truth pra bet real = o status do banco; pra SIMULATED = a linha simulada
          venceu_na_linha_real:
            b.bookmaker !== 'SIMULATED'
              ? b.status === 'green'
              : isOver
              ? r.total_kills > baseLine
              : r.total_kills < baseLine,
          venceria_em_fair_mais_1: r.total_kills < r.fair_loo + 1,
          venceria_na_fair: r.total_kills < r.fair_loo,
          is_over: isOver,
        });
      }
      const lr = linhaRows.filter((x) => !x.is_over);
      const pct = (arr, f) => (arr.length ? fmt1((100 * arr.filter(f).length) / arr.length) : null);
      const decomposicao = {
        n_mapas: lr.length,
        n_mapas_reais: lr.filter((x) => x.real).length,
        hit_na_linha_que_o_elvis_pegou: pct(lr, (x) => x.venceu_na_linha_real),
        hit_se_fosse_sempre_fair_mais_1: pct(lr, (x) => x.venceria_em_fair_mais_1),
        hit_se_fosse_sempre_na_fair: pct(lr, (x) => x.venceria_na_fair),
        gap_medio_linha_vs_fair: fmt2(lr.reduce((a, x) => a + (x.linha_efetiva - x.fair_loo), 0) / (lr.length || 1)),
        distribuicao_gap: countBy(lr, (x) => {
          const g = x.linha_efetiva - x.fair_loo;
          if (g <= -1.5) return '<= fair-2';
          if (g <= -0.5) return 'fair-1';
          if (g < 0.5) return 'fair';
          if (g < 1.5) return 'fair+1';
          return '>= fair+2';
        }),
        hit_por_gap: {},
      };
      for (const [label, filt] of [
        ['<= fair-2', (x) => x.linha_efetiva - x.fair_loo <= -1.5],
        ['fair-1', (x) => { const g = x.linha_efetiva - x.fair_loo; return g > -1.5 && g <= -0.5; }],
        ['fair', (x) => Math.abs(x.linha_efetiva - x.fair_loo) < 0.5],
        ['fair+1', (x) => { const g = x.linha_efetiva - x.fair_loo; return g >= 0.5 && g < 1.5; }],
        ['>= fair+2', (x) => x.linha_efetiva - x.fair_loo >= 1.5],
      ]) {
        const sub = lr.filter(filt);
        decomposicao.hit_por_gap[label] = { n: sub.length, hit_pct: pct(sub, (x) => x.venceu_na_linha_real) };
      }
      // mesma decomposição SÓ com bets reais (sem SIMULATED) — é o dinheiro de verdade
      const lrReal = lr.filter((x) => x.real);
      decomposicao.so_reais = {
        n_mapas: lrReal.length,
        hit_na_linha_que_o_elvis_pegou: pct(lrReal, (x) => x.venceu_na_linha_real),
        hit_se_fosse_sempre_fair_mais_1: pct(lrReal, (x) => x.venceria_em_fair_mais_1),
        hit_se_fosse_sempre_na_fair: pct(lrReal, (x) => x.venceria_na_fair),
        gap_medio_linha_crua_vs_fair: fmt2(
          lrReal.reduce((a, x) => a + (x.linha_crua - x.fair_loo), 0) / (lrReal.length || 1)
        ),
        por_gap_linha_crua: {},
      };
      for (const [label, filt] of [
        ['linha ABAIXO da fair', (x) => x.linha_crua - x.fair_loo <= -0.5],
        ['linha NA fair', (x) => Math.abs(x.linha_crua - x.fair_loo) < 0.5],
        ['linha ACIMA da fair', (x) => x.linha_crua - x.fair_loo >= 0.5],
      ]) {
        const sub = lrReal.filter(filt);
        decomposicao.so_reais.por_gap_linha_crua[label] = {
          n: sub.length,
          hit_real_pct: pct(sub, (x) => x.venceu_na_linha_real),
          hit_fair_mais_1_pct: pct(sub, (x) => x.venceria_em_fair_mais_1),
        };
      }

      console.log('\n### Decomposição da LINHA (mesmos mapas, réguas diferentes) — Under, 1 stake/mapa\n');
      console.log(
        `Mapas de Bard flex com bet (real+SIMULATED) casados com o universo: **${decomposicao.n_mapas}** ` +
          `(reais: ${decomposicao.n_mapas_reais}). Bet real usa o status do banco como verdade; ` +
          `SIMULATED usa a linha simulada.\n`
      );
      console.log('| régua | hit% (todos os mapas c/ bet) | hit% (só mapas com bet REAL) |');
      console.log('|---|---|---|');
      console.log(
        `| linha que o Elvis REALMENTE pegou | ${decomposicao.hit_na_linha_que_o_elvis_pegou}% | ${decomposicao.so_reais.hit_na_linha_que_o_elvis_pegou}% |`
      );
      console.log(
        `| se a linha fosse SEMPRE fair+1 (backtest) | ${decomposicao.hit_se_fosse_sempre_fair_mais_1}% | ${decomposicao.so_reais.hit_se_fosse_sempre_fair_mais_1}% |`
      );
      console.log(
        `| se a linha fosse SEMPRE a fair | ${decomposicao.hit_se_fosse_sempre_na_fair}% | ${decomposicao.so_reais.hit_se_fosse_sempre_na_fair}% |`
      );
      console.log(
        `\nGap médio (linha pega − fair LOO) = ${decomposicao.gap_medio_linha_vs_fair} kills (só bets reais, linha crua: ` +
          `${decomposicao.so_reais.gap_medio_linha_crua_vs_fair}). Distribuição: ${JSON.stringify(decomposicao.distribuicao_gap)}`
      );
      console.log('\n| linha pega vs fair | n mapas | hit% na linha real |');
      console.log('|---|---|---|');
      for (const [k, v] of Object.entries(decomposicao.hit_por_gap)) console.log(`| ${k} | ${v.n} | ${v.hit_pct ?? '-'}% |`);
      console.log('\n**Só bets REAIS, pela linha CRUA (sem o ajuste odd<1.72):**\n');
      console.log('| linha crua vs fair | n mapas | hit% real | hit% se fosse fair+1 |');
      console.log('|---|---|---|---|');
      for (const [k, v] of Object.entries(decomposicao.so_reais.por_gap_linha_crua)) {
        console.log(`| ${k} | ${v.n} | ${v.hit_real_pct ?? '-'}% | ${v.hit_fair_mais_1_pct ?? '-'}% |`);
      }

      // EFEITO DE SELEÇÃO: os mapas que o Elvis escolheu apostar se comportam como
      // a população de Bard flex, ou ele anti-seleciona (pega justo os piores)?
      const popHit = (ruler.loo_pop_completa.fairp1.hit_pct || 0) / 100;
      const selWins = lrReal.filter((x) => x.venceria_em_fair_mais_1).length;
      const selN = lrReal.length;
      const selP = selN ? binomTailP(selN - selWins, selN, 1 - popHit) : null; // cauda inferior
      decomposicao.efeito_selecao = {
        n_mapas_apostados: selN,
        hit_fair_mais_1_nos_mapas_apostados: selN ? fmt1((100 * selWins) / selN) : null,
        hit_fair_mais_1_na_populacao: ruler.loo_pop_completa.fairp1.hit_pct,
        p_valor_uma_cauda: selP,
        leitura:
          selN && selP != null && selP < 0.05
            ? 'Os mapas escolhidos foram significativamente PIORES que a população — seleção adversa, não é só azar.'
            : 'Diferença dentro do que a variância explica (não dá pra afirmar anti-seleção).',
      };
      console.log('\n### Efeito de seleção — os mapas que viraram bet são representativos?\n');
      console.log(
        `Na população inteira de Bard flex o hit @fair+1 é **${ruler.loo_pop_completa.fairp1.hit_pct}%**. ` +
          `Nos **${selN}** mapas que o Elvis realmente apostou, a MESMA régua daria ` +
          `**${decomposicao.efeito_selecao.hit_fair_mais_1_nos_mapas_apostados}%** ` +
          `(p uma cauda = ${selP == null ? '-' : selP.toFixed(4)}). ${decomposicao.efeito_selecao.leitura}`
      );

      betsBlock = {
        skipped: false,
        total_bets_banco: bets.length,
        settled: settled.length,
        decomposicao_linha: decomposicao,
        bard_flex_real: grupo(bardReal),
        bard_flex_com_milio: grupo(comMilio),
        bard_flex_sem_milio: grupo(semMilio),
        bard_flex_vs_lulu_karma: grupo(luluKarma),
        bard_flex_resto_peels: grupo(restoPeel),
        bard_flex_simulated: grupo(bardSim),
        contrafactual_sem_bard_flex_pl: cf.pl_total,
        contrafactual_skip_lulu_karma_pl: cfSemLK.pl_total,
        por_liga: Object.entries(
          bardReal.reduce((m, b) => {
            const k = b.league || '?';
            (m[k] = m[k] || []).push(b);
            return m;
          }, {})
        ).map(([lg, arr]) => ({ league: lg, ...grupo(arr) })),
      };
    } catch (e) {
      console.log(`\n\n## 9. Impacto em R$ real — FALHOU: ${e.message}`);
      betsBlock = { skipped: true, error: e.message };
    }
  }
  out.bets_reais = betsBlock;

  // --------------------------------------------------------------------------
  // 12. VEREDITO AUTOMÁTICO
  // --------------------------------------------------------------------------
  const crit = {
    pooled_1_2_3_n: bardPooled123.n,
    pooled_1_2_3_hit_fairp1: bardPooled123.n ? bardPooled123.fairp1.hit_pct : null,
    pooled_1_2_3_ci_lower: bardPooled123.n ? bardPooled123.fairp1.wilson_ci_95.lower : null,
    pooled_pass_ci_above_be: bardPooled123.n ? bardPooled123.fairp1.pass_ci_lower_above_be : false,
    split1_hit: bardBySplit.split1.n ? bardBySplit.split1.fairp1.hit_pct : null,
    split2_hit: bardBySplit.split2.n ? bardBySplit.split2.fairp1.hit_pct : null,
    split3_n: bardBySplit.split3.n,
    split3_hit: bardBySplit.split3.n ? bardBySplit.split3.fairp1.hit_pct : null,
    split3_amostra_valida: bardBySplit.split3.n >= SMALL_N,
    coerencia_2_splits:
      bardBySplit.split1.n && bardBySplit.split2.n
        ? bardBySplit.split1.fairp1.hit_pct > RUNGS.fairp1.be_pct && bardBySplit.split2.fairp1.hit_pct > RUNGS.fairp1.be_pct
        : null,
    trailing_causal_hit: ruler.trail_pop_completa.n ? ruler.trail_pop_completa.fairp1.hit_pct : null,
    trailing_causal_ci_lower: ruler.trail_pop_completa.n ? ruler.trail_pop_completa.fairp1.wilson_ci_95.lower : null,
    pinnacle_hit: ruler.pinn_pop_com_pinnacle.n ? ruler.pinn_pop_com_pinnacle.fairp1.hit_pct : null,
    pinnacle_n: ruler.pinn_pop_com_pinnacle.n,
    delta_vs_baseline_liga_pp: baselineLigaPadronizado
      ? fmt1(ruler.loo_pop_completa.fairp1.hit_pct - baselineLigaPadronizado)
      : null,
    vs_2peel_pp: fmt1(ruler.loo_pop_completa.fairp1.hit_pct - twoPeelStats.fairp1.hit_pct),
  };
  console.log('\n\n## 10. Critérios computados (entrada no método)\n');
  console.log(JSON.stringify(crit, null, 2));
  out.criterios = crit;

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
