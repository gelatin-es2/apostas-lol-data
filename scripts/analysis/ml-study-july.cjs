// scripts/analysis/ml-study-july.cjs
//
// Follow-up de scripts/analysis/ml-study-phase1.cjs (B1): a tabela de champion
// winrate por role era do período INTEIRO — o dono quer SÓ JULHO/2026 (patch atual,
// split 3), pra ver quem segue forte/fraco no patch novo vs quem já não existe mais.
//
// Mesma máquina do B1 (merge dos 3 universos, dedup por game_id, winner_side +
// roster via windows cacheados). n≥8 (julho é pequeno, ~350 games — corte menor que
// o n≥20 do período completo). TUDO aqui é amostra-de-patch (1 mês só) — tratar como
// early-read, não conclusão.
//
// Zero chamada de API — tudo em cache.
//
// Uso: node scripts/analysis/ml-study-july.cjs
// Output: audit-output/25-ml-july.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '25-ml-july.json');

const Z95 = 1.96;
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
const JULY_MIN_N = 8;
const JULY_TOP_N = 8;
const JULY_BOTTOM_N = 5;

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function loadJsonSafe(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function wilsonCI(x, n, z = Z95) {
  if (!n) return { lower: null, upper: null };
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: fmt1(100 * Math.max(0, center - margin)), upper: fmt1(100 * Math.min(1, center + margin)) };
}
function winRateCell(nWins, n) {
  const winPct = n ? fmt1((100 * nWins) / n) : null;
  const ci = wilsonCI(nWins, n);
  return { n, wins: nWins, win_pct: winPct, wilson_ci_95: ci, passes_50: ci.lower != null && ci.lower > 50 };
}

function loadWindow(gameId) {
  const f = path.join(AUDIT_CACHE, `window-${gameId}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
function extractRoster(windowJson) {
  const bm = windowJson?.gameMetadata?.blueTeamMetadata;
  const rm = windowJson?.gameMetadata?.redTeamMetadata;
  if (!bm || !rm) return null;
  const rosterOf = (md) => {
    const r = {};
    for (const p of md.participantMetadata || []) if (p.role) r[p.role] = p.championId;
    return r;
  };
  const blue = rosterOf(bm);
  const red = rosterOf(rm);
  if (ROLES.some((r) => !blue[r] || !red[r])) return null;
  return { blue, red };
}

function champRoleTable(rows) {
  const byKey = new Map();
  for (const p of rows) {
    const key = `${p.champ}|${p.role}`;
    if (!byKey.has(key)) byKey.set(key, { champ: p.champ, role: p.role, rows: [] });
    byKey.get(key).rows.push(p);
  }
  const out = new Map(); // key -> stats
  for (const [key, e] of byKey) out.set(key, winRateCell(e.rows.filter((r) => r.won).length, e.rows.length));
  return out;
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CHAMPION WINRATE POR ROLE — SÓ JULHO/2026 (patch atual)');
  console.log('='.repeat(70));

  const sources = [
    path.join(AUDIT_OUTPUT, '00-universe-allregions.json'),
    path.join(AUDIT_OUTPUT, '00-universe-split1.json'),
    path.join(AUDIT_OUTPUT, '00-universe.json'),
  ];
  const byId = new Map();
  for (const src of sources) {
    for (const g of loadJsonSafe(src)) {
      if (!byId.has(g.game_id)) byId.set(g.game_id, g);
    }
  }
  // sync: ml-study-phase1.cjs — normaliza LFL (split1/split2 gravam "LFL",
  // all-regions grava "La Ligue Française" pro mesmo league_id).
  const LEAGUE_LABEL_NORM = { 'La Ligue Française': 'LFL' };
  for (const g of byId.values()) {
    if (LEAGUE_LABEL_NORM[g.league]) g.league = LEAGUE_LABEL_NORM[g.league];
  }
  const merged = [...byId.values()];
  const population = merged.filter((g) => !g.suspect && g.total_kills != null && g.winner_side);
  console.log(`\nPopulação (winner_side válido): ${population.length}`);

  let noWindow = 0;
  let noRoster = 0;
  const participantRows = [];
  for (const g of population) {
    const win = loadWindow(g.game_id);
    if (!win) {
      noWindow++;
      continue;
    }
    const roster = extractRoster(win);
    if (!roster) {
      noRoster++;
      continue;
    }
    const month = (g.date || '').slice(0, 7);
    for (const side of ['blue', 'red']) {
      const won = g.winner_side === side;
      for (const role of ROLES) {
        const champ = roster[side][role];
        if (!champ) continue;
        participantRows.push({ champ, role, won, month });
      }
    }
  }
  console.log(`Cobertura de roster: sem window: ${noWindow}, sem roster completo: ${noRoster} (de ${population.length}).`);

  const julyRows = participantRows.filter((p) => p.month === '2026-07');
  const julyGamesN = new Set(population.filter((g) => (g.date || '').slice(0, 7) === '2026-07').map((g) => g.game_id)).size;
  console.log(`Julho: ${julyGamesN} games, ${julyRows.length} picks (10/game esperado).`);

  const fullTable = champRoleTable(participantRows); // período inteiro, sem corte de n — usado só pro delta
  const julyTable = champRoleTable(julyRows);

  const byRoleJuly = {};
  for (const role of ROLES) {
    const entries = [...julyTable.entries()].filter(([key]) => key.endsWith(`|${role}`)).map(([key, stats]) => ({ champ: key.split('|')[0], role, ...stats }));
    const eligible = entries.filter((e) => e.n >= JULY_MIN_N).sort((a, b) => b.win_pct - a.win_pct);
    const top = eligible.slice(0, JULY_TOP_N);
    const bottom = eligible.slice(-JULY_BOTTOM_N).reverse();
    byRoleJuly[role] = { eligible_total: eligible.length, top, bottom };
  }

  console.log(`\nChampions elegíveis (n≥${JULY_MIN_N}) por role: ${ROLES.map((r) => `${r}=${byRoleJuly[r].eligible_total}`).join(', ')}`);
  const anyPasses50 = ROLES.some((r) => [...byRoleJuly[r].top, ...byRoleJuly[r].bottom].some((c) => c.passes_50));
  console.log(`Alguma célula com CI inferior >50% (✅)? ${anyPasses50 ? 'SIM' : 'NÃO — esperado com n pequeno, CIs largos.'}`);

  const allMovements = [];
  for (const role of ROLES) {
    console.log(`\n### ${role} — julho (n≥${JULY_MIN_N}, de ${byRoleJuly[role].eligible_total} elegíveis)\n`);
    console.log('Top 8:\n');
    console.log('| champion | n | win% | CI95% | ✅ | delta vs período completo |');
    console.log('|---|---|---|---|---|---|');
    for (const c of byRoleJuly[role].top) {
      const fullKey = `${c.champ}|${role}`;
      const full = fullTable.get(fullKey);
      const delta = full && full.win_pct != null && c.win_pct != null ? fmt1(c.win_pct - full.win_pct) : null;
      const deltaStr = full ? `${delta > 0 ? '+' : ''}${delta}pp (período: ${full.win_pct}%, n=${full.n})` : 'sem dado no período completo';
      console.log(`| ${c.champ} | ${c.n} | ${c.win_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] | ${c.passes_50 ? '✅' : ''} | ${deltaStr} |`);
      if (full && delta != null) allMovements.push({ champ: c.champ, role, july_win_pct: c.win_pct, july_n: c.n, full_win_pct: full.win_pct, full_n: full.n, delta, list: 'top' });
    }
    console.log('\nBottom 5:\n');
    console.log('| champion | n | win% | CI95% | ✅ | delta vs período completo |');
    console.log('|---|---|---|---|---|---|');
    for (const c of byRoleJuly[role].bottom) {
      const fullKey = `${c.champ}|${role}`;
      const full = fullTable.get(fullKey);
      const delta = full && full.win_pct != null && c.win_pct != null ? fmt1(c.win_pct - full.win_pct) : null;
      const deltaStr = full ? `${delta > 0 ? '+' : ''}${delta}pp (período: ${full.win_pct}%, n=${full.n})` : 'sem dado no período completo';
      console.log(`| ${c.champ} | ${c.n} | ${c.win_pct} | [${c.wilson_ci_95.lower}, ${c.wilson_ci_95.upper}] | ${c.passes_50 ? '✅' : ''} | ${deltaStr} |`);
      if (full && delta != null) allMovements.push({ champ: c.champ, role, july_win_pct: c.win_pct, july_n: c.n, full_win_pct: full.win_pct, full_n: full.n, delta, list: 'bottom' });
    }
  }

  // Top 5 movimentos de patch (maior |delta|, priorizando n razoável dos 2 lados).
  const topMovements = [...allMovements].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
  console.log('\n\n## Top 5 movimentos de patch (maior |delta| vs período completo)\n');
  console.log('| champion (role) | julho | período completo | delta |');
  console.log('|---|---|---|---|');
  for (const m of topMovements) console.log(`| ${m.champ} (${m.role}) | ${m.july_win_pct}% (n=${m.july_n}) | ${m.full_win_pct}% (n=${m.full_n}) | ${m.delta > 0 ? '+' : ''}${m.delta}pp |`);

  // Casos específicos citados pelo dono — Vayne top, TF top, Yasuo top.
  console.log('\n### Casos específicos citados\n');
  for (const [champ, role] of [['Vayne', 'top'], ['TwistedFate', 'top'], ['Yasuo', 'top']]) {
    const julyEntry = julyTable.get(`${champ}|${role}`);
    const fullEntry = fullTable.get(`${champ}|${role}`);
    if (!julyEntry) {
      console.log(`${champ} (${role}): NÃO aparece em julho — sumiu do patch (ou n=0 nos dados coletados). Período completo: ${fullEntry ? `${fullEntry.win_pct}% (n=${fullEntry.n})` : 'também sem dado'}.`);
    } else {
      console.log(`${champ} (${role}): julho ${julyEntry.win_pct}% (n=${julyEntry.n}) vs período completo ${fullEntry ? `${fullEntry.win_pct}% (n=${fullEntry.n})` : 'sem dado'}.`);
    }
  }

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: { z_score_95: Z95, july_min_n: JULY_MIN_N, july_top_n: JULY_TOP_N, july_bottom_n: JULY_BOTTOM_N, pass_50_rule: 'CI95% inferior > 50%' },
    meta: { population_n: population.length, july_games_n: julyGamesN, no_window: noWindow, no_roster: noRoster, any_passes_50: anyPasses50 },
    by_role_july: byRoleJuly,
    top5_patch_movements: topMovements,
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
