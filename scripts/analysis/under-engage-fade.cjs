// scripts/analysis/under-engage-fade.cjs
//
// Tese do dono (2026-07-26, literal): "o mercado sobe 4 linhas todo jogo que tá
// tendo Rell vs Leona, Rell vs Naut, Leona vs Naut etc — se o over kill desses
// drafts não se paga, vamos de under [na linha inflada]".
//
// O que isso testa: NÃO é um edge sobre o jogo — é um edge sobre a REAÇÃO do
// mercado. O método Over duplo-engage já foi REPROVADO (51.9% pooled = moeda),
// ou seja, kills em duplo engage ficam PERTO da fair pré-draft. Se o mercado
// sobe a linha 3-4 pontos pós-draft e os kills não acompanham, Under na linha
// de MERCADO ganha. Aqui medimos:
//   1. Distribuição kills − fair nos mapas de duplo engage (por split + pooled)
//   2. Escada sintética: P(kills < fair+k) pra k=0..4, com Wilson CI
//   3. Controles: mesma escada em 2peel e no universo geral (o valor do fade
//      depende do mercado só inflar em engage — a escada de kills sozinha é
//      parecida em todo lugar; o que muda é ONDE a casa oferece fair+3)
//   4. Validação LIMITADA da premissa de mercado: bets reais do dono em mapas
//      de duplo engage (Supabase read-only) → linha tomada − fair Pinnacle
//      pré-match do dia. Amostra pequena e enviesada (ele só aposta linha que
//      gosta) — é evidência anedótica, dita como tal.
//   5. Pares específicos (Rell×Leona, Rell×Naut, Leona×Naut) com n≥10
//   6. Sensibilidade operacional: ROI histórico da regra "duplo engage →
//      Under fair+k" pra k=2/3/4 × odd 1.75/1.80/1.85/1.90
//
// ENGAGE_SET (definição desta análise, escolha do dono ANTES de ver resultado):
//   rell, nautilus, leona, alistar, thresh
//   — NÃO inclui rakan/bard (FLEX_ENGAGE do método Under) nem pyke (perfil
//   over próprio, variante over_pyke_watch já em observação).
// Duplo engage = AMBOS os sups no set. Variante relaxada (sensibilidade):
//   ≥1 sup no set — EXCLUINDO mapas onde o outro sup é Camille (janela Camille
//   é OVER; esses mapas não entram no fade — contamos quantos saíram).
//
// Fair leave-one-out POR LIGA — MESMA função de under-stress-line.cjs /
// camille-sweep.cjs / multi-league-mining.cjs (fallback média da liga se time
// tem <5 jogos na mesma liga). Recalculada POR SPLIT no universo do split.
//
// Splits (zero coleta nova — tudo de cache):
//   split1 = audit-output/00-universe-split1.json        (jan–mar, 6 ligas)
//   split2 = audit-output/00-universe-allregions.json    (abr–21/jul, 30 ligas)
//   split3 = audit-output/00-universe-split3-window.json (21–26/jul, dedup vs split2)
//
// Uso: node scripts/analysis/under-engage-fade.cjs
// Output: audit-output/36-under-engage-fade.json + tabelas markdown no stdout.
// Supabase: READ-ONLY (só GET em /rest/v1/bets). Se .env faltar, seção 4 vira null.

'use strict';

const fs = require('fs');
const path = require('path');

// Silencia o aviso repetitivo do normalizeTeam ("X não encontrado em team-aliases")
// — pra times sem alias, retornar o nome original É o comportamento certo aqui
// (o LOO agrupa por nome consistente dentro do mesmo universo). Sem tocar na lib.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.startsWith('[AVISO] normalizeTeam:')) return true;
  return _origStderrWrite(chunk, ...args);
};

const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '36-under-engage-fade.json');

const Z95 = 1.96;
const FALLBACK_MIN_N = 5; // sync: under-stress-line.cjs / camille-sweep.cjs
const PAIR_MIN_N = 10; // pedido do dono: combos só com n≥10
const KS = [0, 1, 2, 3, 4]; // degraus da escada: Under na fair+k

// Break-evens de referência (odd de Under na linha inflada, juice dos 2 lados
// pós-movimento ~1.83–1.90; 1.85 = premissa central da simulação operacional)
const BE_REF = { '1.83': 54.6, '1.85': 54.1, '1.90': 52.6 };
const CENTRAL_ODD = 1.85;
const CENTRAL_BE = 54.1;

const SENS_ODDS = [1.75, 1.8, 1.85, 1.9];
const SENS_KS = [2, 3, 4];

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const ENGAGE_DISPLAY = ['Rell', 'Nautilus', 'Leona', 'Alistar', 'Thresh'];
const ENGAGE_SET = new Set(ENGAGE_DISPLAY.map(normChamp));
const CAMILLE = 'camille';

// Ligas operadas/teste hoje (2026-07-26-set-ligas-definitivo.md) — nomes como
// aparecem nos universos (allregions usa nome longo pra LFL e KCL).
const OPERATED_LEAGUES = new Set([
  'LCK', 'LPL', 'LEC', 'CBLOL', 'LCS',
  'LFL', 'La Ligue Française',
  'Prime League', 'LCK Challengers', 'LES', 'EMEA Masters', 'LCP',
]);

const SPLITS = [
  { key: 'split1', file: '00-universe-split1.json', label: 'split1 (jan–mar 2026, 6 ligas)' },
  { key: 'split2', file: '00-universe-allregions.json', label: 'split2 (abr–21/jul 2026, 30 ligas)' },
  { key: 'split3', file: '00-universe-split3-window.json', label: 'split3 window (21–26/jul, dedup vs split2)' },
];

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function fmt2(n) {
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}
function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: fmt1(100 * Math.max(0, center - margin)), upper: fmt1(100 * Math.min(1, center + margin)) };
}
function roiPct(wins, n, odd) {
  if (!n) return null;
  const profit = wins * (odd - 1) - (n - wins);
  return fmt1((100 * profit) / n);
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

// ============================================================================
// Fair leave-one-out POR LIGA — sync: under-stress-line.cjs computeFairPerLeague
// (mesmo critério, n<5 fallback pra média da liga).
// ============================================================================
function computeFairPerLeague(populationAll) {
  const byLeague = new Map();
  for (const g of populationAll) {
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
    const leagueAvgTotal = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    for (const g of games) {
      const avgFor = (team) => {
        const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) return leagueAvgTotal;
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(normalizeTeam(g.team_blue)) + avgFor(normalizeTeam(g.team_red))) / 2;
      fairMap.set(g.game_id, Math.round(raw - 0.5) + 0.5);
    }
  }
  return fairMap;
}

// ============================================================================
// Escada + delta stats
// ============================================================================
function ladderFor(rows) {
  const n = rows.length;
  const out = {};
  for (const k of KS) {
    const wins = rows.filter((r) => r.total_kills < r.fair + k).length;
    out[`fair_plus_${k}`] = {
      n,
      wins,
      hit_pct: n ? fmt1((100 * wins) / n) : null,
      wilson_ci_95: wilsonCI(wins, n),
    };
  }
  return out;
}
function deltaStats(rows) {
  const deltas = rows.map((r) => r.total_kills - r.fair);
  return {
    n: deltas.length,
    mean: fmt2(mean(deltas)),
    median: deltas.length ? median(deltas) : null,
    stdev: fmt2(stdev(deltas)),
    pct_over_fair: deltas.length ? fmt1((100 * deltas.filter((d) => d > 0).length) / deltas.length) : null,
  };
}

// ============================================================================
// Grupos
// ============================================================================
const isDblEngage = (r) => ENGAGE_SET.has(normChamp(r.sup_blue)) && ENGAGE_SET.has(normChamp(r.sup_red));
// relaxada: ≥1 sup engage; mapas com Camille no outro lado NÃO entram (janela Over)
const isRelaxed = (r) => {
  const a = normChamp(r.sup_blue);
  const b = normChamp(r.sup_red);
  if (a === CAMILLE || b === CAMILLE) return false;
  return ENGAGE_SET.has(a) || ENGAGE_SET.has(b);
};
const isCamilleVsEngage = (r) => {
  const a = normChamp(r.sup_blue);
  const b = normChamp(r.sup_red);
  return (a === CAMILLE && ENGAGE_SET.has(b)) || (b === CAMILLE && ENGAGE_SET.has(a));
};

// ============================================================================
// Seção 4 — validação (limitada) da premissa de mercado via bets reais
// ============================================================================
async function marketPremiseCheck(gameSupIndex, matchMapSupIndex) {
  let cfg;
  try {
    const { loadConfig } = require(path.join(ROOT, '.claude', 'scripts', '_load-config.cjs'));
    cfg = loadConfig();
  } catch (e) {
    return { available: false, reason: `sem config Supabase: ${e.message}` };
  }
  const { supabaseGet } = require(path.join(ROOT, 'lib', 'supabaseQuery.cjs'));
  const rows = await supabaseGet(
    cfg.supabaseUrl,
    cfg.supabaseKey,
    '/rest/v1/bets?select=id,bookmaker,league,team_a,team_b,market,pick,odd,stake,status,is_map_bet,map_number,bet_datetime,fair_pinnacle,fair_formula,fair_line_source,raw_extraction&bookmaker=neq.SIMULATED&limit=5000'
  );
  const mapKillBets = rows.filter((r) => r.is_map_bet && /kill/i.test(r.market || ''));

  const BRT_OFFSET_MS = 3 * 3600 * 1000;
  const pinnacleCache = new Map();
  const getPinnacle = (d) => {
    if (!pinnacleCache.has(d)) pinnacleCache.set(d, loadFairPinnacle(d));
    return pinnacleCache.get(d);
  };

  const parseLine = (pick) => {
    const m = (pick || '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  };
  const sideOf = (pick) => (/under|menos/i.test(pick || '') ? 'under' : /over|mais/i.test(pick || '') ? 'over' : null);

  const enriched = [];
  for (const b of mapKillBets) {
    const mc = b.raw_extraction?.match_context || {};
    // sups: do próprio bet (enriquecido) ou do universo por game_id / match_id+mapa
    let supA = mc.blue_picks?.support || null;
    let supB = mc.red_picks?.support || null;
    if (!supA || !supB) {
      const gid = mc.lolesports_game_id ? String(mc.lolesports_game_id) : null;
      const fromGid = gid ? gameSupIndex.get(gid) : null;
      const mid = mc.lolesports_match_id ? String(mc.lolesports_match_id) : null;
      const fromMid = mid && b.map_number != null ? matchMapSupIndex.get(`${mid}|${b.map_number}`) : null;
      const src = fromGid || fromMid;
      if (src) {
        supA = src.sup_blue;
        supB = src.sup_red;
      }
    }
    if (!supA || !supB) continue;

    const line = parseLine(b.pick);
    if (line == null) continue;

    // fair pré-match: coluna fair_pinnacle > arquivo do dia (BRT, fallback UTC) > fair_formula
    let fair = b.fair_pinnacle ?? null;
    let fairSource = fair != null ? 'pinnacle_col' : null;
    const mid = mc.lolesports_match_id ? String(mc.lolesports_match_id) : null;
    if (fair == null && mid && b.bet_datetime) {
      const dBrt = new Date(new Date(b.bet_datetime).getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
      const dUtc = b.bet_datetime.slice(0, 10);
      for (const d of dBrt === dUtc ? [dBrt] : [dBrt, dUtc]) {
        const v = getPinnacle(d).byMatchId.get(mid);
        if (v != null) {
          fair = v;
          fairSource = 'pinnacle_file';
          break;
        }
      }
    }
    if (fair == null && b.fair_formula != null) {
      fair = b.fair_formula;
      fairSource = 'formula';
    }
    if (fair == null) continue;

    enriched.push({
      id: b.id,
      date: (b.bet_datetime || '').slice(0, 10),
      league: b.league,
      match: `${b.team_a} vs ${b.team_b}`,
      map: b.map_number,
      pick: b.pick,
      side: sideOf(b.pick),
      odd: b.odd,
      status: b.status,
      line,
      fair,
      fair_source: fairSource,
      delta_line_vs_fair: fmt1(line - fair),
      sup_a: supA,
      sup_b: supB,
      dbl_engage: ENGAGE_SET.has(normChamp(supA)) && ENGAGE_SET.has(normChamp(supB)),
    });
  }

  const dbl = enriched.filter((e) => e.dbl_engage);
  const rest = enriched.filter((e) => !e.dbl_engage);
  const dblPin = dbl.filter((e) => e.fair_source !== 'formula');
  const restPin = rest.filter((e) => e.fair_source !== 'formula');
  const summarize = (arr) => ({
    n: arr.length,
    delta_mean: fmt2(mean(arr.map((e) => e.delta_line_vs_fair))),
    delta_median: arr.length ? median(arr.map((e) => e.delta_line_vs_fair)) : null,
  });

  return {
    available: true,
    caveat:
      'Amostra pequena e ENVIESADA: são as linhas que o dono ACEITOU apostar, não o topo da linha ofertada pós-draft. ' +
      'Não existe histórico sistemático de linha de mercado por mapa — a tese das "4 linhas" vem da observação dele em tela. ' +
      'Isso aqui só mede se, nos casos observáveis, a linha tomada em duplo engage ficou acima da fair pré-match (e quanto).',
    bets_map_kills_total: mapKillBets.length,
    bets_com_sups_e_fair: enriched.length,
    dbl_engage: { ...summarize(dbl), so_fair_pinnacle: summarize(dblPin), bets: dbl },
    nao_engage_baseline: { ...summarize(rest), so_fair_pinnacle: summarize(restPin) },
  };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('UNDER FADE DO DUPLO ENGAGE — escada P(kills < fair+k), k=0..4');
  console.log('='.repeat(70));
  console.log(`\nENGAGE_SET = {${ENGAGE_DISPLAY.join(', ')}} — duplo engage = AMBOS os sups no set.`);
  console.log('Camille sup de qualquer lado = FORA do fade (janela Over).\n');

  // --- carregar splits, dedup split3 vs split2 ---
  const splitData = [];
  let split2Ids = new Set();
  for (const s of SPLITS) {
    const raw = loadJson(path.join(AUDIT_OUTPUT, s.file));
    let valid = raw.filter((g) => !g.suspect && g.total_kills != null);
    let deduped = 0;
    if (s.key === 'split2') split2Ids = new Set(valid.map((g) => g.game_id));
    if (s.key === 'split3') {
      const before = valid.length;
      valid = valid.filter((g) => !split2Ids.has(g.game_id));
      deduped = before - valid.length;
    }
    const fairMap = computeFairPerLeague(valid);
    const rows = valid.map((g) => ({
      game_id: g.game_id,
      match_id: g.match_id,
      league: g.league,
      date: g.date,
      map_number: g.map_number,
      team_blue: g.team_blue,
      team_red: g.team_red,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      trigger_type: g.trigger_type,
      total_kills: g.total_kills,
      fair: fairMap.get(g.game_id),
    }));
    splitData.push({ ...s, rows, deduped });
    console.log(`${s.label}: população=${rows.length}${deduped ? ` (dedup: -${deduped} já no split2)` : ''}`);
  }
  const pooledRows = splitData.flatMap((s) => s.rows);

  // --- grupos ---
  const groupsOf = (rows) => ({
    dbl_engage: rows.filter(isDblEngage),
    relaxed_1plus: rows.filter(isRelaxed),
    ctrl_2peel: rows.filter((r) => r.trigger_type === '2peel'),
    ctrl_all: rows,
  });
  const camilleExcluded = pooledRows.filter(isCamilleVsEngage).length;

  // --- 1+2+3: escada por grupo, por split + pooled ---
  const GROUP_LABELS = {
    dbl_engage: 'DUPLO ENGAGE (ambos sups no set)',
    relaxed_1plus: 'RELAXADA (≥1 sup engage, sem Camille no outro lado)',
    ctrl_2peel: 'CONTROLE 2peel (método Under)',
    ctrl_all: 'CONTROLE universo geral',
  };
  const results = {};
  for (const gk of Object.keys(GROUP_LABELS)) {
    results[gk] = { label: GROUP_LABELS[gk], by_split: {}, pooled: null };
    for (const s of splitData) {
      const rows = groupsOf(s.rows)[gk];
      results[gk].by_split[s.key] = { n: rows.length, ladder: ladderFor(rows), delta: deltaStats(rows) };
    }
    const rowsPooled = groupsOf(pooledRows)[gk];
    results[gk].pooled = { n: rowsPooled.length, ladder: ladderFor(rowsPooled), delta: deltaStats(rowsPooled) };
  }

  for (const gk of Object.keys(GROUP_LABELS)) {
    console.log(`\n### ${GROUP_LABELS[gk]}\n`);
    console.log('| recorte | n | delta kills−fair (média/mediana/desvio) | k=0 | k=+1 | k=+2 | k=+3 | k=+4 |');
    console.log('|---|---|---|---|---|---|---|---|');
    const printRow = (name, cell) => {
      const d = cell.delta;
      const cells = KS.map((k) => {
        const c = cell.ladder[`fair_plus_${k}`];
        return c.n ? `${c.hit_pct}% [${c.wilson_ci_95.lower},${c.wilson_ci_95.upper}]` : '-';
      });
      console.log(`| ${name} | ${cell.n} | ${d.mean ?? '-'} / ${d.median ?? '-'} / ${d.stdev ?? '-'} | ${cells.join(' | ')} |`);
    };
    for (const s of splitData) printRow(s.key, results[gk].by_split[s.key]);
    printRow('POOLED', results[gk].pooled);
  }

  // --- sensibilidade: só ligas operadas/teste (pooled, duplo engage) ---
  const operatedDbl = pooledRows.filter((r) => isDblEngage(r) && OPERATED_LEAGUES.has(r.league));
  const operatedCell = { n: operatedDbl.length, ladder: ladderFor(operatedDbl), delta: deltaStats(operatedDbl) };
  console.log('\n### Sensibilidade: duplo engage SÓ nas ligas operadas/teste (pooled)\n');
  console.log(`n=${operatedCell.n} | delta média=${operatedCell.delta.mean} | k=+3: ${operatedCell.ladder.fair_plus_3.hit_pct}% [${operatedCell.ladder.fair_plus_3.wilson_ci_95.lower},${operatedCell.ladder.fair_plus_3.wilson_ci_95.upper}]`);

  // --- 5: pares específicos ---
  console.log('\n### Pares específicos (pooled, stats só com n≥' + PAIR_MIN_N + ')\n');
  const pairMap = new Map();
  for (const r of pooledRows.filter(isDblEngage)) {
    const key = [normChamp(r.sup_blue), normChamp(r.sup_red)].sort().join('+');
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key).push(r);
  }
  const pairs = [...pairMap.entries()]
    .map(([key, rows]) => ({ pair: key, n: rows.length, ladder: ladderFor(rows), delta: deltaStats(rows), eligible: rows.length >= PAIR_MIN_N }))
    .sort((a, b) => b.n - a.n);
  console.log('| par | n | delta média | k=0 | k=+3 | k=+4 | obs |');
  console.log('|---|---|---|---|---|---|---|');
  for (const p of pairs) {
    const c = (k) => (p.eligible ? `${p.ladder[`fair_plus_${k}`].hit_pct}% [${p.ladder[`fair_plus_${k}`].wilson_ci_95.lower},${p.ladder[`fair_plus_${k}`].wilson_ci_95.upper}]` : '-');
    console.log(`| ${p.pair} | ${p.n} | ${p.eligible ? p.delta.mean : '-'} | ${c(0)} | ${c(3)} | ${c(4)} | ${p.eligible ? '' : 'n<' + PAIR_MIN_N}|`);
  }

  // --- 5b: recortes pré-declarados do set — trio literal do Elvis vs Alistar drag ---
  // O trio {Rell, Nautilus, Leona} é o que o Elvis LITERALMENTE citou na tese;
  // Alistar/Thresh entraram como "parentes diretos" na definição pré-registrada.
  // Reportar os dois recortes NÃO é data dredging: a separação já existia na tese.
  const TRIO = new Set(['rell', 'nautilus', 'leona']);
  const trioRows = pooledRows.filter((r) => TRIO.has(normChamp(r.sup_blue)) && TRIO.has(normChamp(r.sup_red)));
  const trioCell = { n: trioRows.length, ladder: ladderFor(trioRows), delta: deltaStats(trioRows) };
  const alistarRows = pooledRows.filter((r) => isDblEngage(r) && (normChamp(r.sup_blue) === 'alistar' || normChamp(r.sup_red) === 'alistar'));
  const alistarCell = { n: alistarRows.length, ladder: ladderFor(alistarRows), delta: deltaStats(alistarRows) };
  console.log('\n### Recortes pré-declarados do set (pooled)\n');
  console.log('| recorte | n | delta média | k=0 | k=+3 | k=+4 |');
  console.log('|---|---|---|---|---|---|');
  for (const [name, c] of [['TRIO literal Elvis (Rell/Naut/Leona ambos lados)', trioCell], ['Alistar em qualquer lado (dentro do duplo engage)', alistarCell]]) {
    const f = (k) => `${c.ladder[`fair_plus_${k}`].hit_pct}% [${c.ladder[`fair_plus_${k}`].wilson_ci_95.lower},${c.ladder[`fair_plus_${k}`].wilson_ci_95.upper}]`;
    console.log(`| ${name} | ${c.n} | ${c.delta.mean} | ${f(0)} | ${f(3)} | ${f(4)} |`);
  }

  // --- 6: simulação operacional ROI (pooled duplo engage) ---
  console.log('\n### Simulação operacional — ROI% se a casa oferecer Under fair+k @ odd (pooled duplo engage)\n');
  console.log('ATENÇÃO: condicional à premissa NÃO validada de que o mercado oferece essa linha nesses mapas.\n');
  const pooledDbl = groupsOf(pooledRows).dbl_engage;
  const sensTable = [];
  console.log('| linha | ' + SENS_ODDS.map((o) => `@${o} (BE ${fmt1(100 / o)}%)`).join(' | ') + ' |');
  console.log('|---|' + SENS_ODDS.map(() => '---').join('|') + '|');
  for (const k of SENS_KS) {
    const wins = pooledDbl.filter((r) => r.total_kills < r.fair + k).length;
    const row = { line: `fair+${k}`, n: pooledDbl.length, wins, hit_pct: fmt1((100 * wins) / pooledDbl.length), roi_by_odd: {} };
    for (const o of SENS_ODDS) row.roi_by_odd[String(o)] = roiPct(wins, pooledDbl.length, o);
    sensTable.push(row);
    console.log(`| fair+${k} (hit ${row.hit_pct}%) | ` + SENS_ODDS.map((o) => `${row.roi_by_odd[String(o)]}%`).join(' | ') + ' |');
  }

  // --- 4: premissa de mercado (Supabase read-only) ---
  console.log('\n### Validação (LIMITADA) da premissa de mercado — bets reais em duplo engage\n');
  const gameSupIndex = new Map();
  const matchMapSupIndex = new Map();
  for (const r of pooledRows) {
    gameSupIndex.set(String(r.game_id), { sup_blue: r.sup_blue, sup_red: r.sup_red });
    if (r.match_id != null && r.map_number != null) {
      matchMapSupIndex.set(`${r.match_id}|${r.map_number}`, { sup_blue: r.sup_blue, sup_red: r.sup_red });
    }
  }
  let market;
  try {
    market = await marketPremiseCheck(gameSupIndex, matchMapSupIndex);
  } catch (e) {
    market = { available: false, reason: e.message };
  }
  if (!market.available) {
    console.log(`(indisponível: ${market.reason})`);
  } else {
    console.log(market.caveat + '\n');
    console.log(`Bets reais de kills por mapa: ${market.bets_map_kills_total} | com sups+fair identificados: ${market.bets_com_sups_e_fair}`);
    console.log(`\nDUPLO ENGAGE: n=${market.dbl_engage.n} | delta linha−fair: média ${market.dbl_engage.delta_mean}, mediana ${market.dbl_engage.delta_median} (só Pinnacle: n=${market.dbl_engage.so_fair_pinnacle.n}, média ${market.dbl_engage.so_fair_pinnacle.delta_mean})`);
    console.log(`BASELINE não-engage: n=${market.nao_engage_baseline.n} | delta média ${market.nao_engage_baseline.delta_mean}, mediana ${market.nao_engage_baseline.delta_median} (só Pinnacle: n=${market.nao_engage_baseline.so_fair_pinnacle.n}, média ${market.nao_engage_baseline.so_fair_pinnacle.delta_mean})`);
    if (market.dbl_engage.bets.length) {
      console.log('\n| data | liga | match | mapa | pick | odd | fair (fonte) | delta | sups | status |');
      console.log('|---|---|---|---|---|---|---|---|---|---|');
      for (const b of market.dbl_engage.bets) {
        console.log(`| ${b.date} | ${b.league} | ${b.match} | M${b.map} | ${b.pick} | ${b.odd} | ${b.fair} (${b.fair_source}) | ${b.delta_line_vs_fair > 0 ? '+' : ''}${b.delta_line_vs_fair} | ${b.sup_a}×${b.sup_b} | ${b.status} |`);
      }
    }
  }

  // --- veredito ---
  const p3 = results.dbl_engage.pooled.ladder.fair_plus_3;
  const s1p3 = results.dbl_engage.by_split.split1.ladder.fair_plus_3;
  const s2p3 = results.dbl_engage.by_split.split2.ladder.fair_plus_3;
  const s3p3 = results.dbl_engage.by_split.split3.ladder.fair_plus_3;
  const ciLowerOk = p3.wilson_ci_95.lower != null && p3.wilson_ci_95.lower > CENTRAL_BE;
  const splitsOk = [s1p3, s2p3].every((c) => c.hit_pct != null && c.hit_pct >= CENTRAL_BE); // split3 n pequeno: reporta, não trava
  let verdict;
  if (ciLowerOk && splitsOk) verdict = 'PROPOR_VARIANTE_SIMULADA';
  else if (p3.hit_pct != null && p3.hit_pct >= CENTRAL_BE) verdict = 'INCERTO';
  else verdict = 'REPROVADO';

  console.log('\n' + '='.repeat(70));
  console.log(`VEREDITO (kills-side, Under fair+3 @${CENTRAL_ODD}, BE ${CENTRAL_BE}%): ${verdict}`);
  console.log(`  pooled: ${p3.hit_pct}% [${p3.wilson_ci_95.lower},${p3.wilson_ci_95.upper}] n=${p3.n} | split1 ${s1p3.hit_pct}% | split2 ${s2p3.hit_pct}% | split3 ${s3p3.hit_pct}% (n=${s3p3.n})`);
  console.log(`  Camille×engage excluídos do fade (janela Over): ${camilleExcluded} mapas`);
  console.log('='.repeat(70));

  // --- output ---
  const output = {
    generated_at: new Date().toISOString(),
    tese:
      'Fade da reação do mercado: em duplo engage o mercado sobe a linha ~3-4 pontos (observação do dono em tela), ' +
      'mas kills ficam perto da fair pré-draft (Over duplo engage reprovado, 51.9% pooled) → Under na linha inflada.',
    params: {
      engage_set: ENGAGE_DISPLAY,
      excluded_from_set: { rakan_bard: 'FLEX_ENGAGE do método Under', pyke: 'perfil over próprio (over_pyke_watch)', camille: 'janela Over — mapas Camille×engage fora do fade' },
      fair: 'leave-one-out por liga, recalculada por split (sync under-stress-line.cjs, fallback n<5 → média da liga)',
      ks: KS,
      be_ref: BE_REF,
      central: { odd: CENTRAL_ODD, be_pct: CENTRAL_BE, line: 'fair+3' },
      pair_min_n: PAIR_MIN_N,
      verdict_rule: `PROPOR_VARIANTE_SIMULADA se CI95 inferior pooled(fair+3) > ${CENTRAL_BE} E split1/split2 hit ≥ ${CENTRAL_BE} (split3 só reporta, n pequeno); INCERTO se central ≥ BE; senão REPROVADO`,
      splits: splitData.map((s) => ({ key: s.key, label: s.label, n: s.rows.length, deduped_vs_split2: s.deduped })),
    },
    meta: {
      pooled_n: pooledRows.length,
      camille_x_engage_excluded: camilleExcluded,
      caveat_central:
        'A escada mede SÓ o lado dos kills. O edge da tese depende do mercado realmente ofertar fair+3/+4 em duplo engage — ' +
        'premissa NÃO validada sistematicamente (sem histórico de linha de mercado por mapa; seção market_premise é anedótica).',
    },
    groups: results,
    operated_leagues_only_dbl_engage: operatedCell,
    pre_declared_cuts: {
      trio_literal_elvis_rell_naut_leona: trioCell,
      alistar_any_side_within_dbl: alistarCell,
      note: 'Trio = o que o Elvis citou literalmente; Alistar/Thresh entraram como parentes na definição pré-registrada. Separação existia ANTES do resultado.',
    },
    pairs,
    roi_sensitivity_pooled_dbl_engage: { note: 'condicional ao mercado ofertar a linha', table: sensTable },
    market_premise: market,
    verdict,
  };
  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
