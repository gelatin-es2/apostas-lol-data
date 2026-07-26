// scripts/analysis/camille-sweep.cjs
//
// Follow-up do dono: Camille support "começou a aparecer bastante agora" — o sinal
// Over dela (e do par Rell+Nautilus) segura com amostra de TODAS as ligas da
// lolesports API + MSI, período 2026-04-01 → 2026-07-21?
//
// Fonte: audit-output/00-universe-allregions.json (scripts/analysis/camille-collect.cjs
// — TODAS as ~43 ligas da API, período unificado 04-01→07-21, inclui as 6 ligas do
// split2 JÁ com dado extra de julho).
//
// *** ANTI-DOUBLE-COUNT — o CORAÇÃO deste script ***
// O universo allregions inclui as 6 ligas originais (LCK/LPL/LEC/CBLOL/LCS/LFL) pro
// período INTEIRO 04-01→07-21, que SE SOBREPÕE ao que já foi contado em
// split1 (jan-mar) + split2 (abr-jun) nos scripts anteriores desta sessão. Pra não
// contar o mesmo jogo 2x nos totais "atualizados":
//   NEW_INCREMENT = allregions.filter(g =>
//     !(g.league_id ∈ ORIGINAL_6_IDS && g.date < '2026-07-01')
//   )
// ou seja: exclui jogos das 6 ligas originais com data ANTES de 01/07 (esses já
// estão em split1+split2). Mantém: jogos de julho das 6 ligas originais (genuinamente
// novos) + TODOS os jogos de qualquer liga NOVA (MSI, EWC, LCP, VCS, etc, qualquer
// data no período).
// Pra Rell+Naut / Rell / Nautilus / engage×engage: total ATUALIZADO = OLD (já
// reportado em 12/13/14-*.json) + NEW_INCREMENT (calculado aqui), SOMADOS — nunca
// recalculados do zero misturando os dois.
// Pra Camille support: não existe "OLD" utilizável (n=11 no split2, nunca passou do
// threshold n≥20 de nenhuma tabela anterior) — reportada direto do allregions
// completo (sem necessidade de somar com nada).
//
// Fair leave-one-out POR LIGA (não por split) — CRITÉRIO DIFERENTE do resto da sessão:
// time com n<5 jogos anteriores (na MESMA liga) → cai pra média da liga. Ligas
// cross-region de torneio curto (MSI, First Stand, EWC, Worlds Qualifying Series,
// Americas Cup, LTA Cross-Conference, Kespa Cup) têm poucos jogos por time — fallback
// rate alto é ESPERADO ali, flagado explicitamente, não é bug.
//
// Uso: node scripts/analysis/camille-sweep.cjs
// Output: audit-output/17-camille-sweep.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { LEAGUE_IDS, PEEL_PURE } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');
const { getLeagues } = require('../audit/lib/api-cache.cjs'); // cache já quente (leagues.json) — chamada aqui é grátis

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '17-camille-sweep.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const OVER_ODD = 1.8;
const OVER_BE = 55.6;
const Z95 = 1.96;
const SMALL_N = 10;
const FALLBACK_MIN_N = 5; // CRITÉRIO DESTE SCRIPT: n<5 jogos anteriores → média da liga
const JULY_CUTOFF = '2026-07-01'; // jogos das 6 ligas originais ANTES disso já contados em split1/split2

const ORIGINAL_6_IDS = new Set(Object.values(LEAGUE_IDS));

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const ENGAGE_LIST = [
  'alistar', 'nautilus', 'rell', 'leona', 'pyke', 'thresh', 'blitzcrank', 'rakan',
  'amumu', 'camille', 'elise', 'gragas', 'pantheon', 'skarner', 'tahmkench', 'taric', 'morgana',
];
const ENGAGE_SET = new Set(ENGAGE_LIST.map(normChamp));

function fmt1(n) {
  return Number.isFinite(n) ? +n.toFixed(1) : null;
}
function loadJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: ${file} não existe. Rode scripts/analysis/camille-collect.cjs primeiro.`);
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
function cellStats(rows, odd) {
  const n = rows.length;
  const wins = rows.filter((r) => r.over_hit).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd), small_sample: n < SMALL_N };
}
function combineStats(oldStats, newStats, odd) {
  const n = oldStats.n + newStats.n;
  const wins = oldStats.wins + newStats.wins;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd), small_sample: n < SMALL_N };
}

// ============================================================================
// Fair leave-one-out POR LIGA — critério n<5 (não n===0 como no resto da sessão).
// ============================================================================
function computeFairPerLeague(populationAll) {
  const byLeague = new Map(); // league_id -> games[]
  for (const g of populationAll) {
    const key = g.league_id || g.league;
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(g);
  }
  const fairMap = new Map(); // game_id -> fair
  const leagueQuality = new Map(); // league_id -> {league_name, n_games, n_team_refs, n_fallback, fallback_rate_pct}
  for (const [leagueKey, games] of byLeague) {
    const teamHist = new Map();
    for (const g of games) {
      for (const raw of [g.team_blue, g.team_red]) {
        const t = normalizeTeam(raw);
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push({ game_id: g.game_id, total_kills: g.total_kills });
      }
    }
    const leagueAvgTotal = games.reduce((a, g) => a + g.total_kills, 0) / games.length;
    let fallbackCount = 0;
    let totalRefs = 0;
    for (const g of games) {
      const teamA = normalizeTeam(g.team_blue);
      const teamB = normalizeTeam(g.team_red);
      const avgFor = (team) => {
        totalRefs++;
        const arr = (teamHist.get(team) || []).filter((x) => x.game_id !== g.game_id);
        if (arr.length < FALLBACK_MIN_N) {
          fallbackCount++;
          return leagueAvgTotal;
        }
        return arr.reduce((a, b) => a + b.total_kills, 0) / arr.length;
      };
      const raw = (avgFor(teamA) + avgFor(teamB)) / 2;
      const fair = Math.round(raw - 0.5) + 0.5;
      fairMap.set(g.game_id, fair);
    }
    leagueQuality.set(leagueKey, {
      league_name: games[0].league,
      n_games: games.length,
      n_team_refs: totalRefs,
      n_fallback: fallbackCount,
      fallback_rate_pct: totalRefs ? fmt1((100 * fallbackCount) / totalRefs) : null,
    });
  }
  return { fairMap, leagueQuality };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('CAMILLE SWEEP — todas as ligas + MSI, 2026-04-01 → 2026-07-21');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  console.log(`\nUniverso bruto (todas as ligas): ${universeRaw.length} | suspect: ${universeRaw.filter((g) => g.suspect).length} | fetch_error: ${universeRaw.filter((g) => g.fetch_error).length}`);
  console.log(`População válida: ${populationAll.length}`);

  // --- Tabela de coleta por liga ---
  const byLeagueRaw = new Map();
  for (const g of universeRaw) {
    const key = g.league_id || g.league;
    if (!byLeagueRaw.has(key)) byLeagueRaw.set(key, { league: g.league, league_id: g.league_id, games: 0, suspects: 0, fetch_errors: 0, trigger: 0, dates: [] });
    const e = byLeagueRaw.get(key);
    e.games++;
    if (g.suspect) e.suspects++;
    if (g.fetch_error) e.fetch_errors++;
    if (g.trigger_type) e.trigger++;
    if (g.date) e.dates.push(g.date);
  }
  const collectionTable = [...byLeagueRaw.values()].map((e) => {
    e.dates.sort();
    return { league: e.league, league_id: e.league_id, games: e.games, valid: e.games - e.suspects, trigger: e.trigger, suspects: e.suspects, fetch_errors: e.fetch_errors, date_range: e.dates.length ? `${e.dates[0].slice(0, 10)}..${e.dates[e.dates.length - 1].slice(0, 10)}` : 'sem_dado', is_original_6: ORIGINAL_6_IDS.has(String(e.league_id)) };
  }).sort((a, b) => b.games - a.games);

  // Ligas tentadas mas com ZERO games no período — não aparecem em universeRaw (nenhum
  // game record gerado), então precisam ser cruzadas contra a lista COMPLETA da API.
  let zeroGameLeagues = [];
  try {
    const leaguesRaw = await getLeagues();
    const allLeagues = leaguesRaw?.data?.leagues || [];
    const seenIds = new Set(collectionTable.map((t) => String(t.league_id)));
    zeroGameLeagues = allLeagues.filter((l) => l.slug !== 'tft_esports' && !seenIds.has(String(l.id))).map((l) => ({ league: l.name, league_id: l.id, games: 0 }));
  } catch (e) {
    console.error(`[AVISO] não consegui buscar getLeagues() pra listar ligas com 0 games: ${e.message}`);
  }

  console.log(`\n### Coleta por liga (${collectionTable.length} ligas com ≥1 game; ${zeroGameLeagues.length} ligas tentadas sem NENHUM game no período)\n`);
  console.log('| liga | games | válidos | trigger | suspects | fetch_errors | range | original_6 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const t of collectionTable) {
    console.log(`| ${t.league} | ${t.games} | ${t.valid} | ${t.trigger} | ${t.suspects} | ${t.fetch_errors} | ${t.date_range} | ${t.is_original_6 ? 'sim' : ''} |`);
  }
  for (const t of zeroGameLeagues) {
    console.log(`| ${t.league} | 0 | 0 | 0 | 0 | 0 | sem_dado_no_periodo | |`);
  }

  // --- Fair per league ---
  const { fairMap, leagueQuality } = computeFairPerLeague(populationAll);
  const rows = populationAll.map((g) => {
    const fair = fairMap.get(g.game_id);
    return {
      game_id: g.game_id,
      league: g.league,
      league_id: g.league_id,
      date: g.date,
      month: (g.date || '').slice(0, 7),
      team_blue: normalizeTeam(g.team_blue),
      team_red: normalizeTeam(g.team_red),
      sup_blue: g.sup_blue,
      sup_red: g.sup_red,
      total_kills: g.total_kills,
      fair,
      over_hit: g.total_kills > fair,
      is_original_6: ORIGINAL_6_IDS.has(String(g.league_id)),
    };
  });

  console.log('\n### Qualidade da fair por liga (fallback rate — times com n<5 jogos anteriores)\n');
  const qualitySorted = [...leagueQuality.values()].sort((a, b) => b.fallback_rate_pct - a.fallback_rate_pct);
  console.log('| liga | n_games | fallback_rate% | flag |');
  console.log('|---|---|---|---|');
  for (const q of qualitySorted) {
    const flag = q.fallback_rate_pct >= 50 ? 'CROSS-REGION/TORNEIO CURTO — fair pouco confiável' : '';
    console.log(`| ${q.league_name} | ${q.n_games} | ${q.fallback_rate_pct ?? '-'} | ${flag} |`);
  }

  // --- NEW_INCREMENT: exclui jogos das 6 ligas originais com data < 01/07 (já contados) ---
  const newIncrement = rows.filter((r) => !(r.is_original_6 && (r.date || '') < JULY_CUTOFF));
  const excludedAsDuplicate = rows.length - newIncrement.length;
  console.log(`\nNEW_INCREMENT (exclui 6 ligas originais com data<01/07, já contadas em split1+split2): ${newIncrement.length} de ${rows.length} (excluídos como duplicata: ${excludedAsDuplicate})`);

  // ==========================================================================
  // 4a. CAMILLE SUPPORT — direto do allregions completo (sem OLD pra somar)
  // ==========================================================================
  console.log('\n\n## 4a. CAMILLE SUPPORT — Over @ fair, odd 1.80, BE 55.6%\n');
  const camilleRows = rows.filter((r) => normChamp(r.sup_blue) === 'camille' || normChamp(r.sup_red) === 'camille');
  const camilleByLeague = new Map();
  for (const r of camilleRows) {
    if (!camilleByLeague.has(r.league)) camilleByLeague.set(r.league, []);
    camilleByLeague.get(r.league).push(r);
  }
  console.log('| liga | n | hit% | CI95% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|');
  const camilleByLeagueOut = [];
  for (const [league, rs] of camilleByLeague) {
    const s = cellStats(rs, OVER_ODD);
    camilleByLeagueOut.push({ league, ...s });
    console.log(`| ${league} | ${s.n} | ${s.hit_pct ?? '-'} | [${s.wilson_ci_95.lower ?? '-'}, ${s.wilson_ci_95.upper ?? '-'}] | ${s.roi_pct ?? '-'} | ${s.small_sample ? 'small_sample' : ''} |`);
  }
  const camillePooled = cellStats(camilleRows, OVER_ODD);
  console.log(`| **POOLED (todas as ligas)** | ${camillePooled.n} | ${camillePooled.hit_pct ?? '-'} | [${camillePooled.wilson_ci_95.lower ?? '-'}, ${camillePooled.wilson_ci_95.upper ?? '-'}] | ${camillePooled.roi_pct ?? '-'} | ${camillePooled.small_sample ? 'small_sample' : ''} |`);

  const camilleByMonth = new Map();
  for (const r of camilleRows) camilleByMonth.set(r.month, (camilleByMonth.get(r.month) || 0) + 1);
  const camilleMonths = [...camilleByMonth.keys()].sort();
  console.log('\n### Timeline mensal — n de Camille support (valida "apareceu agora")\n');
  console.log('| mês | n |');
  console.log('|---|---|');
  for (const m of camilleMonths) console.log(`| ${m} | ${camilleByMonth.get(m)} |`);
  console.log(`\nSplit1 (jan-mar, já sabido): 0 jogos com Camille support (confirmado em análises anteriores).`);

  // ==========================================================================
  // 4b. PAR RELL+NAUTILUS (ambos) — OLD (n=33) + NEW_INCREMENT
  // ==========================================================================
  console.log('\n\n## 4b. Par Rell+Nautilus (ambos supports) — Over @ fair, odd 1.80\n');
  const OLD_RELL_NAUT = { n: 33, wins: 20 }; // audit-output/14-over-pairs.json rule2_strict_rell_nautilus.pooled
  const rellNautNew = newIncrement.filter((r) => {
    const a = normChamp(r.sup_blue);
    const b = normChamp(r.sup_red);
    return (a === 'rell' && b === 'nautilus') || (a === 'nautilus' && b === 'rell');
  });
  const rellNautNewStats = cellStats(rellNautNew, OVER_ODD);
  const rellNautCombined = combineStats(OLD_RELL_NAUT, rellNautNewStats, OVER_ODD);
  console.log('| fonte | n | hit% | CI95% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|');
  console.log(`| OLD (split1+split2, over-pairs.cjs) | ${OLD_RELL_NAUT.n} | ${fmt1((100 * OLD_RELL_NAUT.wins) / OLD_RELL_NAUT.n)} | — | — | |`);
  console.log(`| NEW_INCREMENT (esta coleta) | ${rellNautNewStats.n} | ${rellNautNewStats.hit_pct ?? '-'} | [${rellNautNewStats.wilson_ci_95.lower ?? '-'}, ${rellNautNewStats.wilson_ci_95.upper ?? '-'}] | ${rellNautNewStats.roi_pct ?? '-'} | ${rellNautNewStats.small_sample ? 'small_sample' : ''} |`);
  console.log(`| **COMBINADO (atualizado)** | **${rellNautCombined.n}** | **${rellNautCombined.hit_pct}** | [${rellNautCombined.wilson_ci_95.lower}, ${rellNautCombined.wilson_ci_95.upper}] | ${rellNautCombined.roi_pct} | ${rellNautCombined.small_sample ? 'small_sample' : ''} |`);

  // ==========================================================================
  // 4c. Rell qualquer / Nautilus qualquer — OLD + NEW_INCREMENT
  // ==========================================================================
  console.log('\n\n## 4c. Rell qualquer / Nautilus qualquer (qualquer lado) — Over @ fair, odd 1.80\n');
  const OLD_RELL_ANY = { n: 128, wins: 75 }; // 13-over-by-support.json Rell.pooled
  const OLD_NAUT_ANY = { n: 248, wins: 143 }; // 13-over-by-support.json Nautilus.pooled
  function anyChampRows(champNorm, rowsArr) {
    return rowsArr.filter((r) => normChamp(r.sup_blue) === champNorm || normChamp(r.sup_red) === champNorm);
  }
  const rellNewAny = anyChampRows('rell', newIncrement);
  const nautNewAny = anyChampRows('nautilus', newIncrement);
  const rellNewAnyStats = cellStats(rellNewAny, OVER_ODD);
  const nautNewAnyStats = cellStats(nautNewAny, OVER_ODD);
  const rellCombined = combineStats(OLD_RELL_ANY, rellNewAnyStats, OVER_ODD);
  const nautCombined = combineStats(OLD_NAUT_ANY, nautNewAnyStats, OVER_ODD);
  console.log('| champion | fonte | n | hit% | CI95% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|---|');
  console.log(`| Rell | OLD | ${OLD_RELL_ANY.n} | ${fmt1((100 * OLD_RELL_ANY.wins) / OLD_RELL_ANY.n)} | — | — | |`);
  console.log(`| Rell | NEW_INCREMENT | ${rellNewAnyStats.n} | ${rellNewAnyStats.hit_pct ?? '-'} | [${rellNewAnyStats.wilson_ci_95.lower ?? '-'}, ${rellNewAnyStats.wilson_ci_95.upper ?? '-'}] | ${rellNewAnyStats.roi_pct ?? '-'} | ${rellNewAnyStats.small_sample ? 'small_sample' : ''} |`);
  console.log(`| Rell | **COMBINADO** | **${rellCombined.n}** | **${rellCombined.hit_pct}** | [${rellCombined.wilson_ci_95.lower}, ${rellCombined.wilson_ci_95.upper}] | ${rellCombined.roi_pct} | ${rellCombined.small_sample ? 'small_sample' : ''} |`);
  console.log(`| Nautilus | OLD | ${OLD_NAUT_ANY.n} | ${fmt1((100 * OLD_NAUT_ANY.wins) / OLD_NAUT_ANY.n)} | — | — | |`);
  console.log(`| Nautilus | NEW_INCREMENT | ${nautNewAnyStats.n} | ${nautNewAnyStats.hit_pct ?? '-'} | [${nautNewAnyStats.wilson_ci_95.lower ?? '-'}, ${nautNewAnyStats.wilson_ci_95.upper ?? '-'}] | ${nautNewAnyStats.roi_pct ?? '-'} | ${nautNewAnyStats.small_sample ? 'small_sample' : ''} |`);
  console.log(`| Nautilus | **COMBINADO** | **${nautCombined.n}** | **${nautCombined.hit_pct}** | [${nautCombined.wilson_ci_95.lower}, ${nautCombined.wilson_ci_95.upper}] | ${nautCombined.roi_pct} | ${nautCombined.small_sample ? 'small_sample' : ''} |`);

  // ==========================================================================
  // 4d. BÔNUS — matriz engage×engage atualizada
  // ==========================================================================
  console.log('\n\n## 4d. Bônus — ENGAGE×ENGAGE (2xEngage) atualizado — Over @ fair, odd 1.80\n');
  const OLD_2XENGAGE = { n: 270, wins: 140 }; // 12-over-v2.json tables_by_context.pooled['2xEngage'].fair
  function classify(champRaw) {
    const c = normChamp(champRaw);
    if (!c) return null;
    if (c === 'braum') return 'ENGAGE';
    if (PEEL_SET.has(c)) return 'PEEL';
    if (ENGAGE_SET.has(c)) return 'ENGAGE';
    return 'OUTRO';
  }
  const engageEngageNew = newIncrement.filter((r) => classify(r.sup_blue) === 'ENGAGE' && classify(r.sup_red) === 'ENGAGE');
  const engageEngageNewStats = cellStats(engageEngageNew, OVER_ODD);
  const engageEngageCombined = combineStats(OLD_2XENGAGE, engageEngageNewStats, OVER_ODD);
  console.log('| fonte | n | hit% | CI95% | ROI% | flag |');
  console.log('|---|---|---|---|---|---|');
  console.log(`| OLD (split1+split2, over-method-v2.cjs, @odd 1.83 orig.) | ${OLD_2XENGAGE.n} | ${fmt1((100 * OLD_2XENGAGE.wins) / OLD_2XENGAGE.n)} | — | — | |`);
  console.log(`| NEW_INCREMENT (esta coleta) | ${engageEngageNewStats.n} | ${engageEngageNewStats.hit_pct ?? '-'} | [${engageEngageNewStats.wilson_ci_95.lower ?? '-'}, ${engageEngageNewStats.wilson_ci_95.upper ?? '-'}] | ${engageEngageNewStats.roi_pct ?? '-'} | ${engageEngageNewStats.small_sample ? 'small_sample' : ''} |`);
  console.log(`| **COMBINADO (atualizado)** | **${engageEngageCombined.n}** | **${engageEngageCombined.hit_pct}** | [${engageEngageCombined.wilson_ci_95.lower}, ${engageEngageCombined.wilson_ci_95.upper}] | ${engageEngageCombined.roi_pct} | ${engageEngageCombined.small_sample ? 'small_sample' : ''} |`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: {
      over_odd: OVER_ODD, over_be_pct: OVER_BE, z_score_95: Z95, small_sample_n: SMALL_N,
      fair_fallback_min_n: FALLBACK_MIN_N,
      july_cutoff: JULY_CUTOFF,
      note: 'Fair leave-one-out POR LIGA, fallback se time tem <5 jogos anteriores NA MESMA LIGA (critério diferente do resto da sessão, que usa n===0). Instrução explícita desta tarefa.',
    },
    meta: {
      universe_raw_n: universeRaw.length,
      population_n: populationAll.length,
      new_increment_n: newIncrement.length,
      excluded_as_duplicate_of_split1_split2: excludedAsDuplicate,
    },
    collection_by_league: collectionTable,
    collection_zero_game_leagues: zeroGameLeagues,
    fair_quality_by_league: qualitySorted,
    camille_support: { by_league: camilleByLeagueOut, pooled: camillePooled, monthly_n: Object.fromEntries(camilleMonths.map((m) => [m, camilleByMonth.get(m)])) },
    rell_nautilus_pair: { old: OLD_RELL_NAUT, new_increment: rellNautNewStats, combined: rellNautCombined },
    rell_any: { old: OLD_RELL_ANY, new_increment: rellNewAnyStats, combined: rellCombined },
    nautilus_any: { old: OLD_NAUT_ANY, new_increment: nautNewAnyStats, combined: nautCombined },
    engage_x_engage: { old: OLD_2XENGAGE, new_increment: engageEngageNewStats, combined: engageEngageCombined },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
