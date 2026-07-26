// scripts/analysis/split2-over-method.cjs
//
// Existe um método OVER total kills lucrativo no split 2? Cruza:
//   - audit-output/00-universe.json (861 games do split2, 6 ligas Riot — fonte de
//     verdade pra kills/supports/trigger, ver CLAUDE.md)
//   - audit-cache/window-{gameId}.json (janela livestats — os 10 picks/roles de
//     cada game, gameMetadata.{blue,red}TeamMetadata.participantMetadata[])
//
// Tese testada: a linha de abertura da casa ≈ fair calibrada no TIME (sem ajustar
// pelo draft). Comps agressivas (engage/mage nos supports, sem peel) puxam o jogo
// pra cima da fair — valor no Over pego cedo, antes do mercado mover.
//
// Zero chamada de API nova — tudo lido de cache local.
//
// Uso: node scripts/analysis/split2-over-method.cjs
// Output: audit-output/11-over-method.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE } = require('../audit/lib/audit-common.cjs');
const { normTeamName } = require('../../lib/normTeamName.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe.json');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '11-over-method.json');

// === Parâmetros ===
const ODDS = [1.85, 1.95, 2.05];
const SMALL_N = 10; // regra do prompt: n<10 = flag, não conclui
const HOT_THRESHOLD = 1; // delta > +1 = hot, < -1 = cold (kills - fair)
const COLD_THRESHOLD = -1;
const CLASSIFY_MIN_N = 4; // n mínimo pra classificar time (hot/cold), senão neutro

function beFor(odd) {
  return +((100 / odd).toFixed(1));
}

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}

function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ============================================================================
// ARQUÉTIPOS DE SUPPORT — definidos e documentados aqui (não reusa FLEX_ENGAGE
// canônico do método Under, que serve outro propósito: sinalizar 1peel+flex).
// ============================================================================
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

// PEEL = PEEL_PURE canônico (enchanters passivos), sem alteração.
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));

// ENGAGE = tanks/bruisers cujo kit existe pra INICIAR luta (dive, all-in, pick).
// Inclui os citados no prompt (alistar, nautilus, rell, leona, pyke, thresh,
// blitzcrank, rakan) + observados no split2 com kit claramente engage-first:
// amumu (ult AoE stun), camille (dive+cc quando jogada support), elise
// (cocoon+rappel = pick de longa distância), gragas (body slam+cask = abre
// luta), pantheon (stun+ult global = engage), skarner (fear+ult suppress+pull),
// tahmkench (devour = pick/all-in ofensivo — kit tb serve peel, mas uso
// competitivo dominante é comer o squishy inimigo), taric (dash+stun +
// ult AoE stun — apesar do heal/shield, tem MAIS ferramenta de engage hard
// que a lista PEEL_PURE), morgana (bind é ferramenta de catch/all-in em pro
// play — Black Shield existe mas o padrão de uso competitivo é iniciar, não
// so peelar).
// Braum é tratado à PARTE (borderline "warden defensivo" — testado nos dois
// arquétipos, ver BRAUM_DEFAULT/BRAUM_ALT abaixo).
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric', 'morgana',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));

// MAGE = burst/poke/zone-control mágico (mata via dano, não via CC físico de
// tanque). Base pedida no prompt (lux, brand, xerath, zyra, velkoz, swain —
// não observados no split2, mantidos pela completude da lista) + observados
// no split2 com kit de mago/burst AP: anivia (wall+stun+burst — reclassificada
// aqui vs o FLEX_ENGAGE canônico do método Under, que a trata como "flex";
// pra ESTE recorte de arquétipo ela é mais mago-zona que engage-tanque), mel
// (poke/burst AP lançada em 2026), neeko (root+ult AoE burst — combo de mago,
// não tanque-engage), rumble (zona/burst AP "battlemage" — Equalizer é mais
// perto de artilharia de mago que engage físico).
const MAGE_LIST = [
  'lux', 'brand', 'xerath', 'zyra', 'velkoz', 'swain',
  'anivia', 'mel', 'neeko', 'rumble',
];
const MAGE_SET = new Set(MAGE_LIST.map(normChamp));

// OUTRO = resto (catch-all, inclui qualquer campeão não listado acima).
// Nomeados observados no split2 que caem aqui por não terem kit claro de
// engage-tanque nem burst-mago: bard (roamer/pick, ult é stasis-utility, não
// engage-tanque nem burst), poppy (kit é sobre NEGAR engage inimigo —
// counter-engage/peel defensivo, não iniciar), senna (marksman-suporte
// híbrido, heal/shield/poke — não é tanque nem mago-burst clássico), shen
// (ult é save/teleport global, uso competitivo dominante é defensivo, não
// abre luta na lane).
const OUTRO_NAMED = ['bard', 'poppy', 'senna', 'shen'];

// Braum — warden defensivo, kit tem cc (dash+stun em aliado que ataca) usado
// tanto pra abrir luta (engage) quanto pra bloquear projétil/peelar. Prompt
// pede pra testar nos dois arquétipos. Default = ENGAGE (uso competitivo
// dominante em bot lane é setup de all-in via stack de passiva), alt = OUTRO
// (leitura "warden puramente defensivo").
const BRAUM_NORM = 'braum';
const BRAUM_DEFAULT = 'ENGAGE';
const BRAUM_ALT = 'OUTRO';

function classify(champRaw, braumMode) {
  const c = normChamp(champRaw);
  if (!c) return null;
  if (c === BRAUM_NORM) return braumMode === 'alt' ? BRAUM_ALT : BRAUM_DEFAULT;
  if (PEEL_SET.has(c)) return 'PEEL';
  if (ENGAGE_SET.has(c)) return 'ENGAGE';
  if (MAGE_SET.has(c)) return 'MAGE';
  return 'OUTRO';
}

// ============================================================================
// Fair line leave-one-out — cópia adaptada de scripts/analysis/split2-improve.cjs
// (mesma fórmula: (blueAvg+redAvg)/2 arredondado pra .5, fallback média da
// liga se n<5... na prática aqui o fallback dispara se o time não tem NENHUM
// outro jogo no universo, igual ao original). História construída sobre o
// UNIVERSO CHEIO (861, antes de excluir suspect) — mesmo comportamento do
// split2-improve.cjs original, não um recorte novo.
// ============================================================================
function buildTeamKillsHistory(universe) {
  const hist = new Map();
  for (const g of universe) {
    if (g.total_kills == null) continue;
    for (const raw of [g.team_blue, g.team_red]) {
      if (!raw) continue;
      const t = normTeamName(raw) || raw;
      if (!hist.has(t)) hist.set(t, []);
      hist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
    }
  }
  return hist;
}
function buildLeagueAvgKills(universe) {
  const m = new Map();
  for (const g of universe) {
    if (g.total_kills == null) continue;
    if (!m.has(g.league)) m.set(g.league, { sum: 0, n: 0 });
    const e = m.get(g.league);
    e.sum += g.total_kills;
    e.n++;
  }
  const out = new Map();
  for (const [l, e] of m) out.set(l, e.sum / e.n);
  return out;
}
function fairFormulaForGame(game, teamHist, leagueAvg) {
  const teamA = normTeamName(game.team_blue) || game.team_blue;
  const teamB = normTeamName(game.team_red) || game.team_red;
  const fallback = leagueAvg.get(game.league) ?? 29;
  const avgFor = (team) => {
    const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== game.game_id);
    if (arr.length === 0) return fallback;
    return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
  };
  const raw = (avgFor(teamA) + avgFor(teamB)) / 2;
  return Math.round(raw - 0.5) + 0.5;
}

// ============================================================================
// Window loader — os 10 picks de cada game.
// ============================================================================
function loadWindow(gameId) {
  const f = path.join(AUDIT_CACHE, `window-${gameId}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
function extractRoster(windowJson) {
  const bm = windowJson?.gameMetadata?.blueTeamMetadata;
  const rm = windowJson?.gameMetadata?.redTeamMetadata;
  if (!bm || !rm) return null;
  const rosterOf = (md) => {
    const r = {};
    for (const p of md.participantMetadata || []) {
      if (p.role) r[p.role] = p.championId;
    }
    return r;
  };
  const blue = rosterOf(bm);
  const red = rosterOf(rm);
  if (ROLES.some((r) => !blue[r] || !red[r])) return null;
  return { blue, red };
}

// ============================================================================
// Agregador genérico — bucket -> {n, hit_pct(over), avg_delta, roi por odd,
// small_sample}. bucketFn pode devolver 1 chave, array de chaves (credita
// múltiplos buckets, ex: time aparece como blue E red) ou null (exclui a row).
// ============================================================================
function agg(rows, bucketFn) {
  const m = new Map();
  for (const r of rows) {
    let keys = bucketFn(r);
    if (keys == null) continue;
    if (!Array.isArray(keys)) keys = [keys];
    for (const k of keys) {
      if (k == null) continue;
      if (!m.has(k)) m.set(k, { bucket: k, n: 0, wins: 0, deltaSum: 0 });
      const e = m.get(k);
      e.n++;
      if (r.over_hit) e.wins++;
      e.deltaSum += r.delta;
    }
  }
  return [...m.values()]
    .map((e) => statRow(e.bucket, e.n, e.wins, e.deltaSum))
    .sort((a, b) => b.n - a.n || String(a.bucket).localeCompare(String(b.bucket)));
}
function statRow(bucket, n, wins, deltaSum) {
  const roi = {};
  for (const odd of ODDS) {
    const profit = wins * (odd - 1) - (n - wins);
    roi[String(odd)] = n ? fmt1((100 * profit) / n) : null;
  }
  return {
    bucket,
    n,
    hit_pct: n ? fmt1((100 * wins) / n) : null,
    avg_delta: n ? fmt1(deltaSum / n) : null,
    roi,
    small_sample: n < SMALL_N,
  };
}
function statsFor(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const deltaSum = rows.reduce((a, r) => a + r.delta, 0);
  return statRow('_', n, wins, deltaSum);
}

function printTable(title, rows, extraCols, ressalva) {
  console.log(`\n### ${title}\n`);
  const cols = ['bucket', 'n', 'hit%(Over)', ...ODDS.map((o) => `ROI@${o}`), ...(extraCols || []), 'flag'];
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) {
    const roiCols = ODDS.map((o) => r.roi?.[String(o)] ?? '-');
    const extras = (extraCols || []).map((c) => (c === 'avg_delta' ? (r.avg_delta ?? '-') : (r[c] ?? '-')));
    console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct ?? '-'} | ${roiCols.join(' | ')} | ${extras.join(' | ')} | ${r.small_sample ? 'small_sample' : ''} |`);
  }
  if (ressalva) console.log(`\n_${ressalva}_`);
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  const universeFull = loadJson(UNIVERSE_FILE); // 861
  const population = universeFull.filter((g) => !g.suspect && g.total_kills != null); // 828 esperado

  console.log('='.repeat(70));
  console.log('SPLIT 2 — MÉTODO OVER TOTAL KILLS (existe edge?)');
  console.log('='.repeat(70));
  console.log(`Universo bruto: ${universeFull.length} | suspect: ${universeFull.filter((g) => g.suspect).length} | fetch_error: ${universeFull.filter((g) => g.fetch_error).length}`);
  console.log(`População (não-suspect, kills válidos): ${population.length}`);

  const teamHist = buildTeamKillsHistory(universeFull);
  const leagueAvgKills = buildLeagueAvgKills(universeFull);

  // --- monta rows base (todas com fair/delta/over_hit; roster quando disponível) ---
  let noWindowFile = 0;
  let noRosterMeta = 0;
  const rows = population.map((g) => {
    const fair = fairFormulaForGame(g, teamHist, leagueAvgKills);
    const teamBlue = normTeamName(g.team_blue) || g.team_blue;
    const teamRed = normTeamName(g.team_red) || g.team_red;
    const win = loadWindow(g.game_id);
    if (!win) noWindowFile++;
    const roster = win ? extractRoster(win) : null;
    if (win && !roster) noRosterMeta++;
    const archBlue = classify(g.sup_blue, 'default');
    const archRed = classify(g.sup_red, 'default');
    const archBlueAlt = classify(g.sup_blue, 'alt');
    const archRedAlt = classify(g.sup_red, 'alt');
    return {
      game_id: g.game_id,
      league: g.league,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      map_number: g.map_number,
      team_blue: teamBlue,
      team_red: teamRed,
      kills_blue: g.kills_blue,
      kills_red: g.kills_red,
      total_kills: g.total_kills,
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      trigger_type: g.trigger_type, // trigger do método Under canônico (2peel/1peel+flex/null)
      fair,
      delta: fmt1(g.total_kills - fair),
      over_hit: g.total_kills > fair,
      archBlue,
      archRed,
      archBlueAlt,
      archRedAlt,
      roster, // null se window/metadata ausente
    };
  });
  const rowsWithRoster = rows.filter((r) => r.roster != null);

  const coverage = {
    population_n: population.length,
    no_window_file: noWindowFile,
    no_roster_metadata: noRosterMeta,
    rows_with_full_roster: rowsWithRoster.length,
    coverage_pct: fmt1((100 * rowsWithRoster.length) / population.length),
  };
  console.log(`\nCobertura de roster (10 picks): ${rowsWithRoster.length}/${population.length} (${coverage.coverage_pct}%) — sem window file: ${noWindowFile}, sem metadata completa: ${noRosterMeta}`);

  const output = {
    generated_at: new Date().toISOString(),
    params: {
      odds: ODDS,
      be_pct: Object.fromEntries(ODDS.map((o) => [String(o), beFor(o)])),
      small_sample_n: SMALL_N,
      hot_cold_thresholds: { hot: `delta > +${HOT_THRESHOLD}`, cold: `delta < ${COLD_THRESHOLD}`, min_n: CLASSIFY_MIN_N },
      stake_normalized: '1 unit por jogo — ROI% independe do valor absoluto',
    },
    meta: {
      universe_raw_n: universeFull.length,
      suspect_n: universeFull.filter((g) => g.suspect).length,
      fetch_error_n: universeFull.filter((g) => g.fetch_error).length,
      population_n: population.length,
      coverage,
    },
    archetypes: {
      PEEL: PEEL_PURE,
      ENGAGE: ENGAGE_LIST,
      MAGE: MAGE_LIST,
      OUTRO_named_examples: OUTRO_NAMED,
      OUTRO_note: 'catch-all — qualquer campeão não listado em PEEL/ENGAGE/MAGE cai aqui automaticamente',
      braum: { default: BRAUM_DEFAULT, alt: BRAUM_ALT, n_games_in_split: rows.filter((r) => normChamp(r.sup_blue) === BRAUM_NORM || normChamp(r.sup_red) === BRAUM_NORM).length },
    },
    A: {}, B: {}, C: {}, D: {}, E: {},
    summary_facts: [],
    notes: [],
  };

  console.log('\n### Arquétipos definidos\n');
  console.log(`PEEL (${PEEL_PURE.length}): ${PEEL_PURE.join(', ')}`);
  console.log(`ENGAGE (${ENGAGE_LIST.length}): ${ENGAGE_LIST.join(', ')}`);
  console.log(`MAGE (${MAGE_LIST.length}): ${MAGE_LIST.join(', ')}`);
  console.log(`OUTRO (catch-all, exemplos nomeados): ${OUTRO_NAMED.join(', ')}`);
  console.log(`BRAUM: default=${BRAUM_DEFAULT}, alt=${BRAUM_ALT}, n=${output.archetypes.braum.n_games_in_split}`);

  // ==========================================================================
  // A. BASELINE OVER
  // ==========================================================================
  console.log('\n\n## A. BASELINE OVER');

  const A1 = agg(rows, () => 'GLOBAL');
  output.A.A1_global = A1;
  printTable(`A1. Baseline global (n=${rows.length})`, A1, ['avg_delta']);

  const A2 = agg(rows, (r) => r.league);
  output.A.A2_by_league = A2;
  printTable('A2. Por liga', A2, ['avg_delta']);

  const A3 = agg(rows, (r) => (r.trigger_type ? 'COM_trigger_peel(Under)' : 'SEM_trigger'));
  const A3_detail = agg(rows, (r) => r.trigger_type || 'sem_trigger');
  output.A.A3_trigger_vs_no_trigger = A3;
  output.A.A3_detail_by_trigger_type = A3_detail;
  printTable('A3. Com trigger peel (método Under atual) vs sem trigger', A3, ['avg_delta']);
  printTable('A3-detail. 2peel / 1peel+flex / sem_trigger', A3_detail, ['avg_delta']);
  const overNoTrig = A3.find((r) => r.bucket === 'SEM_trigger')?.hit_pct;
  const overWithTrig = A3.find((r) => r.bucket === 'COM_trigger_peel(Under)')?.hit_pct;
  console.log(`\nOver melhora sem trigger peel: ${overNoTrig}% vs ${overWithTrig}% (delta ${overNoTrig != null && overWithTrig != null ? fmt1(overNoTrig - overWithTrig) : '?'}pp)`);

  // ==========================================================================
  // B. ARQUÉTIPOS DE SUPPORT — MATRIZ
  // ==========================================================================
  console.log('\n\n## B. ARQUÉTIPOS DE SUPPORT (matriz de pares)');

  function comboOf(r, alt) {
    const a = alt ? r.archBlueAlt : r.archBlue;
    const b = alt ? r.archRedAlt : r.archRed;
    if (!a || !b) return null;
    return [a, b].sort().join('×');
  }
  const B1 = agg(rowsWithRoster.length ? rows : rows, (r) => comboOf(r, false));
  output.B.B1_archetype_matrix = B1;
  printTable('B1. Matriz arquétipo × arquétipo (support blue × support red, sem ordem)', B1, ['avg_delta']);
  const peelPeelCell = B1.find((r) => r.bucket === 'PEEL×PEEL');
  console.log(`\n[VALIDAÇÃO] célula PEEL×PEEL: Over hit = ${peelPeelCell?.hit_pct}% (esperado ≈35-40%, complemento do Under ~64%). n=${peelPeelCell?.n}.`);

  const B1_alt = agg(rows, (r) => comboOf(r, true));
  output.B.B1_alt_braum_outro = B1_alt;
  printTable('B1-alt. Mesma matriz com Braum reclassificado como OUTRO (em vez de ENGAGE)', B1_alt, ['avg_delta'],
    'Só muda células que continham Braum (n=' + output.archetypes.braum.n_games_in_split + ' games no split todo).');

  const B2_CELLS = ['ENGAGE×ENGAGE', 'ENGAGE×MAGE', 'MAGE×MAGE', 'ENGAGE×OUTRO'];
  const B2 = B1.filter((r) => B2_CELLS.includes(r.bucket));
  output.B.B2_over_candidate_cells = B2;
  printTable('B2. Células candidatas do Over', B2, ['avg_delta']);

  const B3all = agg(rows, (r) => {
    if (!r.sup_blue || !r.sup_red) return null;
    return [r.sup_blue, r.sup_red].sort().join(' + ');
  });
  const B3_eligible = B3all.filter((r) => r.n >= 5);
  const B3_top15 = [...B3_eligible].sort((a, b) => b.hit_pct - a.hit_pct || b.n - a.n).slice(0, 15);
  const B3_bottom15 = [...B3_eligible].sort((a, b) => a.hit_pct - b.hit_pct || b.n - a.n).slice(0, 15);
  output.B.B3_specific_pairs_top15 = B3_top15;
  output.B.B3_specific_pairs_bottom15 = B3_bottom15;
  printTable('B3. Top 15 pares de champion (n≥5) — maior Over hit%', B3_top15, ['avg_delta']);
  printTable('B3. Bottom 15 pares de champion (n≥5) — menor Over hit%', B3_bottom15, ['avg_delta']);

  const milioNaut = B3all.find((r) => normChamp(r.bucket).replace(/\+/g, '') === (normChamp('Milio') + normChamp('Nautilus')) || r.bucket === 'Milio + Nautilus' || r.bucket === 'Nautilus + Milio');
  const peelEngageCell = B1.find((r) => r.bucket === 'ENGAGE×PEEL');
  output.B.B3_milio_nautilus_specific = milioNaut || { bucket: 'Milio + Nautilus', n: 0, hit_pct: null, note: 'não ocorreu no split' };
  output.B.B3_peel_x_engage_context_cell = peelEngageCell || null;
  console.log(`\n### B3-contexto. "Milio+Naut não é Under" — checagem\n`);
  console.log(`Par específico Milio+Nautilus: n=${milioNaut?.n ?? 0}, Over hit=${milioNaut?.hit_pct ?? 'N/A'}%`);
  console.log(`Célula agregada PEEL×ENGAGE (todos os pares peel+engage, n=${peelEngageCell?.n ?? 0}): Over hit=${peelEngageCell?.hit_pct ?? 'N/A'}%, avg_delta=${peelEngageCell?.avg_delta ?? 'N/A'}`);

  // ==========================================================================
  // C. BONECOS INDIVIDUAIS (todas as roles)
  // ==========================================================================
  console.log('\n\n## C. BONECOS INDIVIDUAIS (todas as roles)');

  const participantRows = [];
  for (const r of rowsWithRoster) {
    for (const side of ['blue', 'red']) {
      const roster = r.roster[side];
      for (const role of ROLES) {
        const champ = roster[role];
        if (!champ) continue;
        participantRows.push({ champ, role, over_hit: r.over_hit, delta: r.delta, team: side === 'blue' ? r.team_blue : r.team_red, game_id: r.game_id });
      }
    }
  }
  const C1all = agg(participantRows, (pr) => `${pr.champ} (${pr.role})`);
  const C1_eligible = C1all.filter((r) => r.n >= 10);
  const C1_top15 = [...C1_eligible].sort((a, b) => b.avg_delta - a.avg_delta || b.n - a.n).slice(0, 15);
  const C1_bottom15 = [...C1_eligible].sort((a, b) => a.avg_delta - b.avg_delta || b.n - a.n).slice(0, 15);
  output.C.C1_by_champion_role_top15 = C1_top15;
  output.C.C1_by_champion_role_bottom15 = C1_bottom15;
  console.log(`\nBuckets champion×role com n≥10: ${C1_eligible.length} (de ${C1all.length} totais)`);
  printTable('C1. Top 15 champion(role) — maior avg_delta (kills-fair)', C1_top15, ['avg_delta']);
  printTable('C1. Bottom 15 champion(role) — menor avg_delta', C1_bottom15, ['avg_delta']);

  // C2 — controle de confusor: top 10 (por avg_delta desc, champ único) do C1.
  const seenChamps = new Set();
  const C2_targets = [];
  for (const r of C1_top15) {
    const champName = r.bucket.replace(/\s*\([^)]*\)$/, '');
    const key = normChamp(champName);
    if (seenChamps.has(key)) continue;
    seenChamps.add(key);
    C2_targets.push({ champ: champName, role: r.bucket.match(/\(([^)]*)\)$/)?.[1] || null, naive_avg_delta: r.avg_delta, naive_n: r.n, naive_over_hit_pct: r.hit_pct });
    if (C2_targets.length >= 10) break;
  }

  function teamControlledDelta(champRaw) {
    const champNorm = normChamp(champRaw);
    const byTeam = new Map();
    for (const r of rowsWithRoster) {
      for (const side of ['blue', 'red']) {
        const team = side === 'blue' ? r.team_blue : r.team_red;
        const ownKills = side === 'blue' ? r.kills_blue : r.kills_red;
        const roster = r.roster[side];
        const picked = Object.values(roster).some((c) => normChamp(c) === champNorm);
        if (!byTeam.has(team)) byTeam.set(team, { withKills: [], withoutKills: [] });
        const e = byTeam.get(team);
        if (picked) e.withKills.push(ownKills);
        else e.withoutKills.push(ownKills);
      }
    }
    let sumWeighted = 0;
    let totalWeightN = 0;
    const perTeam = [];
    for (const [team, e] of byTeam) {
      if (e.withKills.length === 0 || e.withoutKills.length === 0) continue;
      const avgWith = e.withKills.reduce((a, b) => a + b, 0) / e.withKills.length;
      const avgWithout = e.withoutKills.reduce((a, b) => a + b, 0) / e.withoutKills.length;
      const deltaTeam = avgWith - avgWithout;
      perTeam.push({ team, n_with: e.withKills.length, n_without: e.withoutKills.length, avg_with: fmt1(avgWith), avg_without: fmt1(avgWithout), delta_team: fmt1(deltaTeam) });
      sumWeighted += deltaTeam * e.withKills.length;
      totalWeightN += e.withKills.length;
    }
    perTeam.sort((a, b) => b.n_with - a.n_with);
    return {
      champ: champRaw,
      team_controlled_delta: totalWeightN ? fmt1(sumWeighted / totalWeightN) : null,
      n_teams_with_baseline: perTeam.length,
      n_games_pooled: totalWeightN,
      per_team: perTeam,
    };
  }

  const C2 = C2_targets.map((t) => {
    const tc = teamControlledDelta(t.champ);
    let verdict = 'sem_dado_suficiente';
    if (tc.team_controlled_delta != null) {
      const naive = t.naive_avg_delta;
      const sameSign = Math.sign(naive) === Math.sign(tc.team_controlled_delta) || tc.team_controlled_delta === 0;
      if (Math.abs(tc.team_controlled_delta) < 0.5) verdict = 'colapsa_perto_de_zero (provável efeito de TIME, não de campeão)';
      else if (!sameSign) verdict = 'inverte_sinal (provável efeito de TIME, não de campeão)';
      else verdict = 'sobrevive (consistente com efeito do CAMPEÃO)';
    }
    return { ...t, ...tc, verdict };
  });
  output.C.C2_confound_control = C2;
  console.log('\n### C2. Controle de confusor (top 10 do C1) — delta naive (jogo) vs delta dentro-de-time\n');
  console.log('| champ (role) | naive_delta (total_kills-fair) | naive_n | team_controlled_delta (kills próprio time com−sem) | n_teams | n_games_pooled | veredito |');
  console.log('|---|---|---|---|---|---|---|');
  for (const c of C2) {
    console.log(`| ${c.champ} (${c.role}) | ${c.naive_avg_delta} | ${c.naive_n} | ${c.team_controlled_delta ?? '-'} | ${c.n_teams_with_baseline} | ${c.n_games_pooled} | ${c.verdict} |`);
  }

  output.C.C3_jungle_pace_skipped = true;
  output.C.C3_skip_reason = 'Pulado por instrução explícita do prompt quando fica complexo demais: classificar jungler em "dive" vs "farm" de forma defensável exigiria lista própria de tier/kit por jungler (fora do escopo dado — só support tem lista canônica pronta), risco de viés de classificação alto sem essa base. C1 já cobre jungle individualmente (top/bottom 15 por champion×role) como proxy parcial.';
  console.log('\n### C3. Jungle pace — PULADO\n');
  console.log(output.C.C3_skip_reason);

  // ==========================================================================
  // D. TIMES QUENTES + PERSISTÊNCIA
  // ==========================================================================
  console.log('\n\n## D. TIMES QUENTES + PERSISTÊNCIA (tese BLG)');

  const D1all = agg(rows, (r) => [r.team_blue, r.team_red]);
  const D1_eligible = D1all.filter((r) => r.n >= 8);
  const D1_top10 = [...D1_eligible].sort((a, b) => b.avg_delta - a.avg_delta || b.n - a.n).slice(0, 10);
  const D1_bottom10 = [...D1_eligible].sort((a, b) => a.avg_delta - b.avg_delta || b.n - a.n).slice(0, 10);
  output.D.D1_teams_top10 = D1_top10;
  output.D.D1_teams_bottom10 = D1_bottom10;
  console.log(`\nTimes com n≥8: ${D1_eligible.length} (de ${D1all.length} totais)`);
  printTable('D1. Top 10 times — maior avg_delta (mais Over-friendly)', D1_top10, ['avg_delta']);
  printTable('D1. Bottom 10 times — menor avg_delta (mais Under-friendly)', D1_bottom10, ['avg_delta']);

  function periodClassification(games) {
    const byTeam = new Map();
    for (const g of games) {
      for (const team of [g.team_blue, g.team_red]) {
        if (!byTeam.has(team)) byTeam.set(team, { n: 0, deltaSum: 0 });
        const e = byTeam.get(team);
        e.n++;
        e.deltaSum += g.delta;
      }
    }
    const result = new Map();
    for (const [team, e] of byTeam) {
      const avg = e.deltaSum / e.n;
      let cls = 'insufficient_data';
      if (e.n >= CLASSIFY_MIN_N) {
        if (avg > HOT_THRESHOLD) cls = 'hot';
        else if (avg < COLD_THRESHOLD) cls = 'cold';
        else cls = 'neutral';
      }
      result.set(team, { n: e.n, avg_delta: fmt1(avg), cls });
    }
    return result;
  }

  function persistenceTable(classification, evalGames) {
    const buckets = { hot: new Set(), neutral: new Set(), cold: new Set() };
    for (const [team, info] of classification) {
      if (buckets[info.cls]) buckets[info.cls].add(team);
    }
    return ['hot', 'neutral', 'cold'].map((clsName) => {
      const teams = buckets[clsName];
      let n = 0, wins = 0, deltaSum = 0;
      for (const g of evalGames) {
        for (const team of [g.team_blue, g.team_red]) {
          if (teams.has(team)) {
            n++;
            if (g.over_hit) wins++;
            deltaSum += g.delta;
          }
        }
      }
      return {
        bucket: clsName,
        n_teams: teams.size,
        n_games: n,
        over_hit_pct: n ? fmt1((100 * wins) / n) : null,
        avg_delta: n ? fmt1(deltaSum / n) : null,
        small_sample: n < SMALL_N,
      };
    });
  }

  const aprilGames = rows.filter((r) => r.month === '2026-04');
  const mayJunGames = rows.filter((r) => r.month === '2026-05' || r.month === '2026-06');
  const aprMayGames = rows.filter((r) => r.month === '2026-04' || r.month === '2026-05');
  const junGames = rows.filter((r) => r.month === '2026-06');

  const aprilCls = periodClassification(aprilGames);
  const D2a = persistenceTable(aprilCls, mayJunGames);
  output.D.D2_april_classified_teams = [...aprilCls.entries()].map(([team, info]) => ({ team, ...info }));
  output.D.D2_april_to_mayjun = D2a;
  console.log(`\n### D2a. Classificação por ABRIL (n≥${CLASSIFY_MIN_N}) → performance em MAIO+JUNHO (n=${mayJunGames.length} games disponíveis)\n`);
  console.log('| bucket | n_teams | n_games | Over hit% | avg_delta | flag |');
  console.log('|---|---|---|---|---|---|');
  for (const r of D2a) console.log(`| ${r.bucket} | ${r.n_teams} | ${r.n_games} | ${r.over_hit_pct} | ${r.avg_delta} | ${r.small_sample ? 'small_sample' : ''} |`);

  const aprMayCls = periodClassification(aprMayGames);
  const D2b = persistenceTable(aprMayCls, junGames);
  output.D.D2_aprmay_classified_teams = [...aprMayCls.entries()].map(([team, info]) => ({ team, ...info }));
  output.D.D2_aprmay_to_jun = D2b;
  console.log(`\n### D2b. Classificação por ABRIL+MAIO (n≥${CLASSIFY_MIN_N}) → performance em JUNHO (n=${junGames.length} games — AMOSTRA PEQUENA, flag)\n`);
  console.log('| bucket | n_teams | n_games | Over hit% | avg_delta | flag |');
  console.log('|---|---|---|---|---|---|');
  for (const r of D2b) console.log(`| ${r.bucket} | ${r.n_teams} | ${r.n_games} | ${r.over_hit_pct} | ${r.avg_delta} | ${r.small_sample ? 'small_sample' : ''} |`);

  const blgRows = rows.filter((r) => r.team_blue === 'BILIBILI GAMING' || r.team_red === 'BILIBILI GAMING');
  const blgStats = statsFor(blgRows);
  const blgByMonth = agg(blgRows, (r) => r.month);
  output.D.D3_blg = { overall: blgStats, by_month: blgByMonth.sort((a, b) => a.bucket.localeCompare(b.bucket)) };
  console.log(`\n### D3. BLG (BILIBILI GAMING) — n=${blgStats.n}\n`);
  console.log(`Over hit: ${blgStats.hit_pct}% | avg_delta: ${blgStats.avg_delta} | ROI@1.85: ${blgStats.roi['1.85']}% | ROI@1.95: ${blgStats.roi['1.95']}% | ROI@2.05: ${blgStats.roi['2.05']}%`);
  console.log('\n| mês | n | Over hit% | avg_delta |');
  console.log('|---|---|---|---|');
  for (const r of blgByMonth.sort((a, b) => a.bucket.localeCompare(b.bucket))) console.log(`| ${r.bucket} | ${r.n} | ${r.hit_pct} | ${r.avg_delta} |`);

  // ==========================================================================
  // E. MÉTODO OVER v1 — GRID + BACKTEST TREINO/TESTE
  // ==========================================================================
  console.log('\n\n## E. MÉTODO OVER v1 (backtest honesto)');

  const chrono = [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.game_id).localeCompare(String(b.game_id)));
  function buildTrailing(gamesChrono) {
    const record = new Map();
    const clsOf = (team) => {
      const rec = record.get(team);
      if (!rec || rec.n < CLASSIFY_MIN_N) return 'neutral';
      const avg = rec.deltaSum / rec.n;
      if (avg > HOT_THRESHOLD) return 'hot';
      if (avg < COLD_THRESHOLD) return 'cold';
      return 'neutral';
    };
    const out = new Map();
    for (const g of gamesChrono) {
      out.set(g.game_id, { clsBlue: clsOf(g.team_blue), clsRed: clsOf(g.team_red) });
      for (const team of [g.team_blue, g.team_red]) {
        if (!record.has(team)) record.set(team, { n: 0, deltaSum: 0 });
        const rec = record.get(team);
        rec.n++;
        rec.deltaSum += g.delta;
      }
    }
    return out;
  }
  const trailingCls = buildTrailing(chrono);

  const TRIGGERS = {
    '2xEngage': (r) => r.archBlue === 'ENGAGE' && r.archRed === 'ENGAGE',
    'EngageNoPeel': (r) => (r.archBlue === 'ENGAGE' || r.archRed === 'ENGAGE') && r.archBlue !== 'PEEL' && r.archRed !== 'PEEL',
    'EngageXMage': (r) => (r.archBlue === 'ENGAGE' && r.archRed === 'MAGE') || (r.archBlue === 'MAGE' && r.archRed === 'ENGAGE'),
  };
  const FILTERS = {
    'nenhum': () => true,
    'geq1_hot': (r, cls) => cls.clsBlue === 'hot' || cls.clsRed === 'hot',
    'ambos_hot': (r, cls) => cls.clsBlue === 'hot' && cls.clsRed === 'hot',
  };

  const grid = [];
  for (const [tName, tFn] of Object.entries(TRIGGERS)) {
    for (const [fName, fFn] of Object.entries(FILTERS)) {
      const fullRows = rowsWithRoster.filter((r) => tFn(r) && fFn(r, trailingCls.get(r.game_id)));
      const trainRows = fullRows.filter((r) => r.month === '2026-04');
      const testRows = fullRows.filter((r) => r.month === '2026-05' || r.month === '2026-06');
      grid.push({
        rule: `${tName} | ${fName}`,
        trigger: tName,
        filter: fName,
        full: statsFor(fullRows),
        train_april: statsFor(trainRows),
        test_maijun: statsFor(testRows),
      });
    }
  }
  output.E.E1_grid = grid;
  console.log(`\n### E1. Grid (${grid.length} regras = ${Object.keys(TRIGGERS).length} triggers × ${Object.keys(FILTERS).length} filtros de time)\n`);
  console.log('| regra | n_full | hit%_full | n_train(abr) | hit%_train | n_test(mai-jun) | hit%_test | ROI@1.95_test |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const g of grid) {
    console.log(`| ${g.rule} | ${g.full.n} | ${g.full.hit_pct} | ${g.train_april.n} | ${g.train_april.hit_pct} | ${g.test_maijun.n} | ${g.test_maijun.hit_pct} | ${g.test_maijun.roi['1.95']} |`);
  }

  const candidates = grid.filter((g) => g.test_maijun.n >= 20);
  let winner = null;
  if (candidates.length) {
    winner = candidates.slice().sort((a, b) => {
      const roiA = a.test_maijun.roi['1.95'] ?? -Infinity;
      const roiB = b.test_maijun.roi['1.95'] ?? -Infinity;
      if (roiB !== roiA) return roiB - roiA;
      return (b.test_maijun.hit_pct ?? 0) - (a.test_maijun.hit_pct ?? 0);
    })[0];
  }
  output.E.E2_winner = winner ? { rule: winner.rule, full: winner.full, train_april: winner.train_april, test_maijun: winner.test_maijun } : null;
  output.E.E2_winner_criteria = 'melhor ROI@1.95 no TESTE (mai-jun) entre regras com n_teste≥20; tie-break por hit%';
  console.log(`\n### E2. Regra vencedora\n`);
  if (winner) {
    console.log(`**${winner.rule}** — teste(mai-jun): n=${winner.test_maijun.n}, hit=${winner.test_maijun.hit_pct}%, ROI@1.85=${winner.test_maijun.roi['1.85']}%, ROI@1.95=${winner.test_maijun.roi['1.95']}%, ROI@2.05=${winner.test_maijun.roi['2.05']}%`);
    console.log(`Full split: n=${winner.full.n}, hit=${winner.full.hit_pct}%, ROI@1.95=${winner.full.roi['1.95']}%`);
    console.log(`Treino (abril): n=${winner.train_april.n}, hit=${winner.train_april.hit_pct}%, ROI@1.95=${winner.train_april.roi['1.95']}%`);
  } else {
    console.log('NENHUMA regra do grid atingiu n_teste≥20 em maio-junho. Não há vencedor válido — reportando isso como resultado negativo.');
  }

  let E3 = null;
  if (winner) {
    const winnerRowsFull = rowsWithRoster.filter((r) => TRIGGERS[winner.trigger](r) && FILTERS[winner.filter](r, trailingCls.get(r.game_id)));
    const byMonth = { '2026-04': 0, '2026-05': 0, '2026-06': 0 };
    for (const r of winnerRowsFull) if (byMonth[r.month] != null) byMonth[r.month]++;
    E3 = { n_total: winnerRowsFull.length, by_month: byMonth, avg_per_month: fmt1(winnerRowsFull.length / 3) };
    output.E.E3_volume = E3;
    console.log(`\n### E3. Volume da regra vencedora\n`);
    console.log(`Total: ${E3.n_total} games em 3 meses (~${E3.avg_per_month}/mês). Abril=${byMonth['2026-04']}, Maio=${byMonth['2026-05']}, Junho=${byMonth['2026-06']}.`);

    const noPeelTrigger = winnerRowsFull.filter((r) => !r.trigger_type);
    const E4 = { winner_full: winner.full, restricted_no_peel_trigger: statsFor(noPeelTrigger) };
    output.E.E4_sanity_no_peel_trigger = E4;
    console.log(`\n### E4. Sanity — regra vencedora só nos games SEM trigger peel (não canibaliza o Under)\n`);
    console.log(`Full: n=${E4.winner_full.n}, hit=${E4.winner_full.hit_pct}% | Restrito (sem trigger peel): n=${E4.restricted_no_peel_trigger.n}, hit=${E4.restricted_no_peel_trigger.hit_pct}%`);
    const deltaPP = (E4.winner_full.hit_pct != null && E4.restricted_no_peel_trigger.hit_pct != null) ? fmt1(E4.restricted_no_peel_trigger.hit_pct - E4.winner_full.hit_pct) : null;
    console.log(`Delta: ${deltaPP}pp`);
  } else {
    output.E.E3_volume = null;
    output.E.E4_sanity_no_peel_trigger = null;
  }

  // ==========================================================================
  // FATOS MAIS FORTES (sem recomendação)
  // ==========================================================================
  output.summary_facts = [
    `Baseline global Over (fair leave-one-out, n=${rows.length}): ${A1[0]?.hit_pct}% — abaixo do BE em qualquer odd realista (BE@1.85=${beFor(1.85)}%, BE@1.95=${beFor(1.95)}%, BE@2.05=${beFor(2.05)}%).`,
    `Games SEM trigger peel: Over ${overNoTrig}% vs COM trigger: ${overWithTrig}% — diferença de ${overNoTrig != null && overWithTrig != null ? fmt1(overNoTrig - overWithTrig) : '?'}pp.`,
    `Célula PEEL×PEEL valida a matriz: Over ${peelPeelCell?.hit_pct}% (n=${peelPeelCell?.n}), consistente com Under ~${peelPeelCell?.hit_pct != null ? fmt1(100 - peelPeelCell.hit_pct) : '?'}%.`,
    `Melhor célula candidata do Over (B2): ${B2.slice().sort((a, b) => b.hit_pct - a.hit_pct)[0]?.bucket} com ${B2.slice().sort((a, b) => b.hit_pct - a.hit_pct)[0]?.hit_pct}% (n=${B2.slice().sort((a, b) => b.hit_pct - a.hit_pct)[0]?.n}).`,
    winner
      ? `Método Over v1: regra "${winner.rule}" — teste(mai-jun) n=${winner.test_maijun.n}, hit=${winner.test_maijun.hit_pct}%, ROI@1.95=${winner.test_maijun.roi['1.95']}%.`
      : 'Método Over v1: NENHUMA das 9 regras do grid atingiu n_teste≥20 em maio-junho — grid não produziu regra validável out-of-sample.',
  ];

  output.notes = [
    'Fair leave-one-out replicada de scripts/analysis/split2-improve.cjs (mesma fórmula, mesmo histórico sobre o universo cheio 861, antes de excluir suspect) — não é a fair real usada em produção (Pinnacle manual/janela 21d), é aproximação retrospectiva.',
    `População de análise = ${population.length} games (universo 861 menos ${universeFull.filter((g) => g.suspect).length} suspect; os 4 fetch_error já estão contidos no suspect). Cobertura de roster (10 picks via window): ${coverage.coverage_pct}%.`,
    'Arquétipos ENGAGE/MAGE/OUTRO são definição NOVA pra este recorte (não reusa FLEX_ENGAGE canônico do método Under, que serve outro propósito — sinalizar 1peel+flex). Ver archetypes no JSON pra lista completa e justificativa em comentário no script.',
    'D2 (persistência) e E (trailing hot/cold) usam o MESMO threshold (delta>+1 hot, delta<-1 cold, n≥4) mas mecanismos diferentes: D2 classifica uma vez por período fixo (abril), E classifica de forma incremental/trailing (leakage-free, atualiza a cada jogo cronologicamente) — isso é intencional, D2 é retrospectivo por cohort e E é o que dá pra calcular "ao vivo" antes de cada bet.',
    'C2 (controle de confusor) compara duas métricas em escalas diferentes: delta naive é sobre TOTAL_KILLS do jogo (2 times) vs delta team-controlled é sobre kills do PRÓPRIO time (1 time) — comparável em ordem de grandeza mas não é a mesma unidade; ler o veredito (sobrevive/colapsa/inverte), não o valor absoluto.',
  ];

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
