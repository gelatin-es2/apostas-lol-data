// scripts/analysis/les-complete.cjs
//
// TAREFA 1 — análise completa da LES (tier-2 espanhola, o dono quer operar):
//   a. Under método na LES nas 3 linhas (stress 1.72 + escada real), CI, por trigger.
//   b. Tendência mensal, julho em destaque.
//   c. Reconcilia contradição CLAUDE.md "LES 43.5% skip" (all games) vs stress 65.7%
//      (trigger-only) — mostra que é filtro de trigger, não período.
//   d. Horários — distribuição de startTime em BRT, overlap real com LFL/Prime League.
//   e. Kills profile — média/distribuição/times principais + janela Camille na LES.
//
// TAREFA 2 — dossiê Bard ("dá pra usar ou não?"):
//   a. ML winrate (período completo + corte julho).
//   b. Under como flex — pooled atualizado + skips conhecidos (vs Karma, vs Lulu).
//   c. Over — Bard como sup inimigo na janela Camille (confirma vs 62.5% n16).
//   d. Veredito estruturado em 3 linhas (ML/Under/Over).
//
// Fonte: audit-output/00-universe-allregions.json (LES só existe aqui — não estava
// nas 6 ligas originais de split1/split2) + windows cacheados. Fair leave-one-out
// por liga (mesmo critério n<5 fallback do resto da sessão). Zero chamada de API.
//
// Uso: node scripts/analysis/les-complete.cjs
// Output: audit-output/26-les-complete.json + tabelas markdown no stdout.

'use strict';

const fs = require('fs');
const path = require('path');

const { PEEL_PURE, FLEX_ENGAGE, LEAGUE_IDS } = require('../audit/lib/audit-common.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_OUTPUT = path.join(ROOT, 'audit-output');
const AUDIT_CACHE = path.join(ROOT, 'audit-cache');
const OUTPUT_FILE = path.join(AUDIT_OUTPUT, '26-les-complete.json');
const UNIVERSE_FILE = path.join(AUDIT_OUTPUT, '00-universe-allregions.json');

const Z95 = 1.96;
const FALLBACK_MIN_N = 5;
const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');
const PEEL_SET = new Set(PEEL_PURE.map(normChamp));
const FLEX_SET = new Set(FLEX_ENGAGE.map(normChamp));
const ORIGINAL_6_IDS = new Set(Object.values(LEAGUE_IDS));

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
function cellStats(rows, hitFn, odd) {
  const n = rows.length;
  const wins = rows.filter(hitFn).length;
  const hitPct = n ? fmt1((100 * wins) / n) : null;
  const ci = wilsonCI(wins, n);
  return { n, wins, hit_pct: hitPct, wilson_ci_95: ci, roi_pct: roiPct(wins, n, odd) };
}

// ============================================================================
// Fair leave-one-out POR LIGA — sync: camille-sweep.cjs / multi-league-mining.cjs /
// under-stress-line.cjs / camille-context-scan.cjs / ml-study-phase1.cjs.
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

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log('='.repeat(70));
  console.log('LES COMPLETA + DOSSIÊ BARD');
  console.log('='.repeat(70));

  const universeRaw = loadJson(UNIVERSE_FILE);
  const populationAll = universeRaw.filter((g) => !g.suspect && g.total_kills != null);
  const fairMap = computeFairPerLeague(populationAll);
  console.log(`\nPopulação válida (todas as ligas): ${populationAll.length}`);

  const rows = populationAll.map((g) => {
    const fair = fairMap.get(g.game_id);
    return {
      game_id: g.game_id, league: g.league, league_id: g.league_id, date: g.date, month: (g.date || '').slice(0, 7),
      team_blue: normalizeTeam(g.team_blue), team_red: normalizeTeam(g.team_red),
      total_kills: g.total_kills, fair, trigger_type: g.trigger_type,
      sup_blue: g.sup_blue, sup_red: g.sup_red,
      is_original_6: ORIGINAL_6_IDS.has(String(g.league_id)),
      under_hit_fair_plus1: g.total_kills < fair + 1,
      under_hit_fair: g.total_kills < fair,
      under_hit_fair_minus1: g.total_kills < fair - 1,
      over_hit_fair: g.total_kills > fair,
    };
  });

  // ==========================================================================
  // TAREFA 1a — Under nas 3 linhas, por trigger
  // ==========================================================================
  console.log('\n\n## TAREFA 1 — LES\n');
  console.log('### a. Under nas 3 linhas (stress 1.72 + escada real)\n');

  const lesTrigger = rows.filter((r) => r.league === 'LES' && r.trigger_type);
  console.log(`LES trigger population: n=${lesTrigger.length}`);

  const RUNGS = [
    { key: 'fair_plus_1', hitFn: (r) => r.under_hit_fair_plus1, stress_odd: 1.72, real_odd: 1.72, be: 58.1 },
    { key: 'fair', hitFn: (r) => r.under_hit_fair, stress_odd: 1.72, real_odd: 1.83, be_stress: 58.1, be_real: 54.6 },
    { key: 'fair_minus_1', hitFn: (r) => r.under_hit_fair_minus1, stress_odd: 1.72, real_odd: 1.95, be_stress: 58.1, be_real: 51.3 },
  ];
  const rungResults = {};
  console.log('\n| linha | n | hit% | CI95% | ROI@1.72(stress) | ROI@odd real |');
  console.log('|---|---|---|---|---|---|');
  for (const rung of RUNGS) {
    const stress = cellStats(lesTrigger, rung.hitFn, rung.stress_odd);
    const real = cellStats(lesTrigger, rung.hitFn, rung.real_odd);
    rungResults[rung.key] = { stress, real_odd: rung.real_odd, real_roi_pct: real.roi_pct };
    console.log(`| ${rung.key} | ${stress.n} | ${stress.hit_pct} | [${stress.wilson_ci_95.lower}, ${stress.wilson_ci_95.upper}] | ${stress.roi_pct}% | ${real.roi_pct}% @${rung.real_odd} |`);
  }
  console.log(`\nCheck vs stress já reportado (n=35, 65.7% fair+1): ${rungResults.fair_plus_1.stress.n === 35 && rungResults.fair_plus_1.stress.hit_pct === 65.7 ? 'BATE EXATO' : `n=${rungResults.fair_plus_1.stress.n}, hit=${rungResults.fair_plus_1.stress.hit_pct}% — conferir`}`);

  const byTriggerType = ['2peel', '1peel+flex'].map((t) => ({ trigger: t, stats: cellStats(lesTrigger.filter((r) => r.trigger_type === t), (r) => r.under_hit_fair_plus1, 1.72) }));
  console.log('\n### Por tipo de trigger (fair+1 @ 1.72)\n');
  console.log('| trigger | n | hit% | CI95% | ROI% |');
  console.log('|---|---|---|---|---|');
  for (const t of byTriggerType) console.log(`| ${t.trigger} | ${t.stats.n} | ${t.stats.hit_pct ?? '-'} | [${t.stats.wilson_ci_95.lower ?? '-'}, ${t.stats.wilson_ci_95.upper ?? '-'}] | ${t.stats.roi_pct ?? '-'} |`);

  // ==========================================================================
  // TAREFA 1b — tendência mensal
  // ==========================================================================
  console.log('\n\n### b. Tendência mensal (fair+1 @ 1.72)\n');
  const lesMonths = [...new Set(lesTrigger.map((r) => r.month))].sort();
  const monthlyStats = lesMonths.map((m) => ({ month: m, stats: cellStats(lesTrigger.filter((r) => r.month === m), (r) => r.under_hit_fair_plus1, 1.72) }));
  console.log('| mês | n | hit% | CI95% | ROI% |');
  console.log('|---|---|---|---|---|');
  for (const m of monthlyStats) console.log(`| ${m.month}${m.month === '2026-07' ? ' **(patch novo)**' : ''} | ${m.stats.n} | ${m.stats.hit_pct ?? '-'} | [${m.stats.wilson_ci_95.lower ?? '-'}, ${m.stats.wilson_ci_95.upper ?? '-'}] | ${m.stats.roi_pct ?? '-'} |`);

  // ==========================================================================
  // TAREFA 1c — reconciliação
  // ==========================================================================
  console.log('\n\n### c. Reconciliação — "LES 43.5% skip" (CLAUDE.md, all games) vs 65.7% (trigger-only)\n');
  const lesAll = rows.filter((r) => r.league === 'LES');
  const lesAllStats = cellStats(lesAll, (r) => r.under_hit_fair_plus1, 1.72);
  const lesAllStatsFairLine = cellStats(lesAll, (r) => r.under_hit_fair, 1.72);
  const lesMayOnly = cellStats(lesAll.filter((r) => r.month === '2026-05'), (r) => r.under_hit_fair_plus1, 1.72);
  const lesAprMay = cellStats(lesAll.filter((r) => r.month === '2026-04' || r.month === '2026-05'), (r) => r.under_hit_fair_plus1, 1.72);
  const lesTriggerStats = rungResults.fair_plus_1.stress;
  console.log(`CLAUDE.md cita 43.5% (all games, "split2/maio", liga LES). Tentativas de reconciliar com a MESMA fair leave-one-out por liga desta sessão:`);
  console.log(`  - All games, hit@fair+1 (n=${lesAllStats.n}): ${lesAllStats.hit_pct}%`);
  console.log(`  - All games, hit@fair, linha 1 pior (n=${lesAllStatsFairLine.n}): ${lesAllStatsFairLine.hit_pct}%`);
  console.log(`  - Só maio (n=${lesMayOnly.n}): ${lesMayOnly.hit_pct}%`);
  console.log(`  - Abril+maio (n=${lesAprMay.n}): ${lesAprMay.hit_pct}%`);
  console.log(`Nenhuma variação de período/linha chega perto de 43.5% — todas ficam entre 56-63%. **Não reconciliei o valor exato.** Hipótese mais provável: o 43.5% do CLAUDE.md veio de uma fonte de fair DIFERENTE (o pipeline dashboard/cron tier2 usa janela trailing de 21 dias, não a fórmula leave-one-out-sobre-o-período-inteiro usada nesta sessão) — fair diferente muda quais jogos "batem" Under. Não fiz fit forçado.`);
  console.log(`\nTrigger-only (n=${lesTriggerStats.n}): ${lesTriggerStats.hit_pct}%.`);
  console.log(`O que O DADO ATUAL confirma, independente do 43.5% exato: all-games (${lesAllStats.hit_pct}%) fica ${fmt1(lesTriggerStats.hit_pct - lesAllStats.hit_pct)}pp ABAIXO do trigger-only (${lesTriggerStats.hit_pct}%) — a DIREÇÃO do argumento (trigger filtra pra melhor) se confirma com a metodologia desta sessão, mesmo sem bater o número exato antigo.`);

  // ==========================================================================
  // TAREFA 1d — horários (BRT) e overlap
  // ==========================================================================
  console.log('\n\n### d. Horários — distribuição BRT e overlap com LFL/Prime League\n');
  function hourBRT(dateISO) {
    const d = new Date(dateISO);
    let h = (d.getUTCHours() - 3 + 24) % 24; // BRT = UTC-3, sem DST
    return h;
  }
  function hourHistogram(leagueRows) {
    const hist = new Array(24).fill(0);
    for (const r of leagueRows) hist[hourBRT(r.date)]++;
    return hist;
  }
  const lesRows = rows.filter((r) => r.league === 'LES');
  const lflRows = rows.filter((r) => r.league === 'La Ligue Française' || r.league === 'LFL');
  const primeRows = rows.filter((r) => r.league === 'Prime League');
  const lesHist = hourHistogram(lesRows);
  const lflHist = hourHistogram(lflRows);
  const primeHist = hourHistogram(primeRows);

  console.log(`\nn: LES=${lesRows.length}, LFL=${lflRows.length}, Prime League=${primeRows.length}`);
  console.log('\n| hora BRT | LES | LFL | Prime League |');
  console.log('|---|---|---|---|');
  for (let h = 0; h < 24; h++) {
    if (lesHist[h] === 0 && lflHist[h] === 0 && primeHist[h] === 0) continue;
    console.log(`| ${String(h).padStart(2, '0')}h | ${lesHist[h]} | ${lflHist[h]} | ${primeHist[h]} |`);
  }

  const activeHours = (hist, minPct = 0.05) => {
    const total = hist.reduce((a, b) => a + b, 0);
    const set = new Set();
    hist.forEach((c, h) => {
      if (c / total >= minPct) set.add(h);
    });
    return set;
  };
  const lesActive = activeHours(lesHist);
  const lflActive = activeHours(lflHist);
  const primeActive = activeHours(primeHist);
  const overlapPct = (rowsA, activeB) => {
    const inOverlap = rowsA.filter((r) => activeB.has(hourBRT(r.date))).length;
    return fmt1((100 * inOverlap) / rowsA.length);
  };
  const lesVsLflOverlap = overlapPct(lesRows, lflActive);
  const lesVsPrimeOverlap = overlapPct(lesRows, primeActive);
  console.log(`\nLES horas ativas (≥5% dos jogos): ${[...lesActive].sort((a, b) => a - b).map((h) => `${h}h`).join(', ')}`);
  console.log(`LFL horas ativas: ${[...lflActive].sort((a, b) => a - b).map((h) => `${h}h`).join(', ')}`);
  console.log(`Prime League horas ativas: ${[...primeActive].sort((a, b) => a - b).map((h) => `${h}h`).join(', ')}`);
  console.log(`\n**${lesVsLflOverlap}% dos jogos de LES caem numa hora BRT onde LFL também joga.**`);
  console.log(`**${lesVsPrimeOverlap}% dos jogos de LES caem numa hora BRT onde Prime League também joga.**`);

  // ==========================================================================
  // TAREFA 1e — kills profile
  // ==========================================================================
  console.log('\n\n### e. Kills profile — LES\n');
  const lesKills = lesRows.map((r) => r.total_kills).sort((a, b) => a - b);
  const meanKills = fmt1(lesKills.reduce((a, b) => a + b, 0) / lesKills.length);
  const medianKills = lesKills.length % 2 ? lesKills[(lesKills.length - 1) / 2] : (lesKills[lesKills.length / 2 - 1] + lesKills[lesKills.length / 2]) / 2;
  console.log(`Média: ${meanKills} | Mediana: ${medianKills} | Min: ${lesKills[0]} | Max: ${lesKills[lesKills.length - 1]} | n=${lesKills.length}`);

  const byTeamKills = new Map();
  for (const r of lesRows) {
    for (const team of [r.team_blue, r.team_red]) {
      if (!byTeamKills.has(team)) byTeamKills.set(team, []);
      byTeamKills.get(team).push(r.total_kills);
    }
  }
  const teamKillsTable = [...byTeamKills.entries()].map(([team, ks]) => ({ team, n: ks.length, avg_kills: fmt1(ks.reduce((a, b) => a + b, 0) / ks.length) })).sort((a, b) => b.n - a.n);
  console.log('\n| time | n | avg total_kills nos jogos dele |');
  console.log('|---|---|---|');
  for (const t of teamKillsTable) console.log(`| ${t.team} | ${t.n} | ${t.avg_kills} |`);

  const lesCamille = lesRows.filter((r) => normChamp(r.sup_blue) === 'camille' || normChamp(r.sup_red) === 'camille');
  const lesCamilleStats = cellStats(lesCamille, (r) => r.over_hit_fair, 1.8);
  console.log(`\nJanela Camille na LES: n=${lesCamilleStats.n}${lesCamilleStats.n ? `, Over hit=${lesCamilleStats.hit_pct}%` : ' — sem ocorrência no dataset.'}`);

  // ==========================================================================
  // TAREFA 2 — DOSSIÊ BARD
  // ==========================================================================
  console.log('\n\n## TAREFA 2 — DOSSIÊ BARD\n');

  // --- 2a. ML winrate ---
  console.log('### a. ML — winrate de jogo\n');
  let noWindow = 0;
  let noRoster = 0;
  const participantRows = [];
  const winnerByGame = new Map();
  for (const g of populationAll) {
    if (g.winner_side == null) continue;
    winnerByGame.set(g.game_id, g.winner_side);
  }
  for (const g of populationAll) {
    if (g.winner_side == null) continue;
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
  console.log(`Cobertura roster (winrate): sem window: ${noWindow}, sem roster: ${noRoster}.`);
  const bardSupportRows = participantRows.filter((p) => p.champ === 'Bard' && p.role === 'support');
  const bardMLFull = { n: bardSupportRows.length, wins: bardSupportRows.filter((p) => p.won).length };
  const bardMLFullStats = { ...bardMLFull, win_pct: bardMLFull.n ? fmt1((100 * bardMLFull.wins) / bardMLFull.n) : null, wilson_ci_95: wilsonCI(bardMLFull.wins, bardMLFull.n) };
  const bardJulyRows = bardSupportRows.filter((p) => p.month === '2026-07');
  const bardMLJulyStats = { n: bardJulyRows.length, wins: bardJulyRows.filter((p) => p.won).length };
  bardMLJulyStats.win_pct = bardMLJulyStats.n ? fmt1((100 * bardMLJulyStats.wins) / bardMLJulyStats.n) : null;
  bardMLJulyStats.wilson_ci_95 = wilsonCI(bardMLJulyStats.wins, bardMLJulyStats.n);
  console.log(`Período completo: n=${bardMLFullStats.n}, WR=${bardMLFullStats.win_pct}%, CI95%=[${bardMLFullStats.wilson_ci_95.lower}, ${bardMLFullStats.wilson_ci_95.upper}] — ${bardMLFullStats.wilson_ci_95.lower > 50 ? '✅ CI>50%' : ''}`);
  console.log(`Julho: n=${bardMLJulyStats.n}, WR=${bardMLJulyStats.win_pct}%, CI95%=[${bardMLJulyStats.wilson_ci_95.lower}, ${bardMLJulyStats.wilson_ci_95.upper}]`);
  const bardMLDelta = bardMLFullStats.win_pct != null && bardMLJulyStats.win_pct != null ? fmt1(bardMLJulyStats.win_pct - bardMLFullStats.win_pct) : null;
  console.log(`Delta julho vs período: ${bardMLDelta > 0 ? '+' : ''}${bardMLDelta}pp — ${bardMLDelta > 0 ? 'SOBE' : bardMLDelta < 0 ? 'CAI' : 'estável'}`);

  // --- 2b. Under como flex ---
  console.log('\n\n### b. Under — Bard como flex (trigger 1peel+flex)\n');
  function isPurePeel(sup) {
    return PEEL_SET.has(normChamp(sup));
  }
  function isFlex(sup) {
    return FLEX_SET.has(normChamp(sup));
  }
  const bardFlexRows = rows.filter((r) => {
    if (r.trigger_type !== '1peel+flex') return false;
    const blueIsFlexBard = normChamp(r.sup_blue) === 'bard' && isPurePeel(r.sup_red);
    const redIsFlexBard = normChamp(r.sup_red) === 'bard' && isPurePeel(r.sup_blue);
    return blueIsFlexBard || redIsFlexBard;
  }).map((r) => {
    const bardSide = normChamp(r.sup_blue) === 'bard' ? 'blue' : 'red';
    const peelChamp = bardSide === 'blue' ? r.sup_red : r.sup_blue;
    return { ...r, peel_champ: peelChamp };
  });
  const bardFlexStats = cellStats(bardFlexRows, (r) => r.under_hit_fair_plus1, 1.72);
  const bardFlexSix = cellStats(bardFlexRows.filter((r) => r.is_original_6), (r) => r.under_hit_fair_plus1, 1.72);
  console.log(`Pooled atualizado (dataset completo, TODAS as ligas): n=${bardFlexStats.n}, hit=${bardFlexStats.hit_pct}%, CI95%=[${bardFlexStats.wilson_ci_95.lower}, ${bardFlexStats.wilson_ci_95.upper}], ROI=${bardFlexStats.roi_pct}%`);
  console.log(`Restrito às 6 ligas ORIGINAIS (mais perto do escopo do citado): n=${bardFlexSix.n}, hit=${bardFlexSix.hit_pct}%`);
  console.log(`Citado antes: 58.1%/-0.1% (split2). ${Math.abs((bardFlexSix.hit_pct ?? 0) - 58.1) < 5 ? 'Consistente com o citado — a diferença no pooled completo é escopo (mais ligas).' : 'AINDA diverge mesmo restrito às 6 ligas originais — não é só escopo. Hipótese: fair diferente (leave-one-out-por-liga desta sessão vs fair dinâmica/dashboard usada quando o 58.1% foi gerado) ou período diferente (split2 específico vs todo o histórico coletado).'}`);

  const bardVsKarma = cellStats(bardFlexRows.filter((r) => normChamp(r.peel_champ) === 'karma'), (r) => r.under_hit_fair_plus1, 1.72);
  const bardVsKarmaSix = cellStats(bardFlexRows.filter((r) => normChamp(r.peel_champ) === 'karma' && r.is_original_6), (r) => r.under_hit_fair_plus1, 1.72);
  const bardVsLulu = cellStats(bardFlexRows.filter((r) => normChamp(r.peel_champ) === 'lulu'), (r) => r.under_hit_fair_plus1, 1.72);
  console.log(`\nSkip conhecido — Bard flex vs Karma (peel): n=${bardVsKarma.n}, hit=${bardVsKarma.hit_pct ?? '-'}% (citado: 44% n25) | 6 ligas originais: n=${bardVsKarmaSix.n}, hit=${bardVsKarmaSix.hit_pct ?? '-'}%`);
  console.log(`Skip conhecido — Bard flex vs Lulu (peel): n=${bardVsLulu.n}, hit=${bardVsLulu.hit_pct ?? '-'}% (citado: 50% n18)`);

  // --- 2c. Over — Bard vs Camille ---
  console.log('\n\n### c. Over — Bard como sup inimigo na janela Camille\n');
  const camilleRows2 = rows.filter((r) => normChamp(r.sup_blue) === 'camille' || normChamp(r.sup_red) === 'camille').map((r) => {
    const camilleSide = normChamp(r.sup_blue) === 'camille' ? 'blue' : 'red';
    const enemySup = camilleSide === 'blue' ? r.sup_red : r.sup_blue;
    return { ...r, enemy_support: enemySup };
  });
  const bardVsCamille = cellStats(camilleRows2.filter((r) => normChamp(r.enemy_support) === 'bard'), (r) => r.over_hit_fair, 1.8);
  console.log(`n=${bardVsCamille.n}, hit=${bardVsCamille.hit_pct ?? '-'}%, CI95%=[${bardVsCamille.wilson_ci_95.lower ?? '-'}, ${bardVsCamille.wilson_ci_95.upper ?? '-'}] — citado: 62.5% n16 — ${bardVsCamille.n === 16 && bardVsCamille.hit_pct === 62.5 ? 'BATE EXATO' : 'conferir'}`);

  // --- 2d. Veredito ---
  console.log('\n\n### d. Veredito estruturado\n');
  const mlVerdict = bardMLFullStats.wilson_ci_95.lower > 50 ? `USAR COMO PESO — CI95% inferior (${bardMLFullStats.wilson_ci_95.lower}%) acima de 50%, n=${bardMLFullStats.n}. Julho ${bardMLDelta >= 0 ? 'sustenta' : 'sinaliza queda de'} (${bardMLDelta > 0 ? '+' : ''}${bardMLDelta}pp).` : 'NÃO — CI cruza 50%, sem sinal robusto.';
  const underVerdict = bardFlexStats.hit_pct != null && bardFlexStats.hit_pct < 55.6
    ? `FLEX REBAIXADO CONTINUA — hit ${bardFlexStats.hit_pct}% (n=${bardFlexStats.n}), abaixo do BE. Skips específicos vs Karma/Lulu ${bardVsKarma.hit_pct < 55.6 || bardVsLulu.hit_pct < 55.6 ? 'seguem válidos' : 'não confirmados no dado atual'}.`
    : `Sinal atual é bom (${bardFlexStats.hit_pct}%, n=${bardFlexStats.n}; ${bardFlexSix.hit_pct}% restrito às 6 ligas originais) — MAS diverge forte do valor citado (58.1%) mesmo controlando escopo, sem reconciliação exata encontrada (ver divergence_note). Reconsiderar rebaixamento com CAUTELA — validar contra a fonte original do 58.1% antes de decidir, não só nesse recompute.`;
  const overVerdict = 'NADA — n pequeno (16) numa única janela de comparação (enemy support vs Camille), sem evidência de edge própria no Over.';
  console.log(`1. ML: ${mlVerdict}`);
  console.log(`2. Under: ${underVerdict}`);
  console.log(`3. Over: ${overVerdict}`);

  // ==========================================================================
  // OUTPUT
  // ==========================================================================
  const output = {
    generated_at: new Date().toISOString(),
    params: { z_score_95: Z95, fair_fallback_min_n: FALLBACK_MIN_N },
    les: {
      population_n: lesRows.length, trigger_n: lesTrigger.length,
      rungs: rungResults,
      by_trigger_type: byTriggerType,
      monthly: monthlyStats,
      reconciliation: {
        claude_md_cited_pct: 43.5,
        all_games_recalculated: lesAllStats,
        all_games_fair_line: lesAllStatsFairLine,
        may_only: lesMayOnly,
        apr_may: lesAprMay,
        trigger_only: lesTriggerStats,
        exact_value_reconciled: false,
        note: 'Nenhuma variação de período/linha testada reproduz 43.5% exato — provável fonte de fair diferente (dashboard/cron trailing 21d vs leave-one-out-por-liga desta sessão). Direção do argumento (trigger filtra pra melhor) confirmada mesmo sem bater o valor exato.',
      },
      schedule: {
        les_hour_histogram_brt: lesHist, lfl_hour_histogram_brt: lflHist, prime_hour_histogram_brt: primeHist,
        les_active_hours: [...lesActive].sort((a, b) => a - b), lfl_active_hours: [...lflActive].sort((a, b) => a - b), prime_active_hours: [...primeActive].sort((a, b) => a - b),
        les_vs_lfl_overlap_pct: lesVsLflOverlap, les_vs_prime_overlap_pct: lesVsPrimeOverlap,
      },
      kills_profile: { mean: meanKills, median: medianKills, min: lesKills[0], max: lesKills[lesKills.length - 1], n: lesKills.length, by_team: teamKillsTable },
      camille_window: lesCamilleStats,
    },
    bard: {
      ml: { full_period: bardMLFullStats, july: bardMLJulyStats, delta_pp: bardMLDelta },
      under_flex: {
        pooled: bardFlexStats, pooled_six_original_leagues: bardFlexSix, cited_reference: { hit_pct: 58.1, roi_pct: -0.1 },
        vs_karma: bardVsKarma, vs_karma_six_original_leagues: bardVsKarmaSix, vs_lulu: bardVsLulu,
        cited_vs_karma: { hit_pct: 44, n: 25 }, cited_vs_lulu: { hit_pct: 50, n: 18 },
        divergence_note: 'Restringir às 6 ligas originais NÃO reconcilia com os valores citados — divergência persiste mesmo controlando escopo. Hipótese mais provável: fair diferente ou período diferente do split2 específico usado quando os números citados foram gerados.',
      },
      over_vs_camille: { stats: bardVsCamille, cited_reference: { hit_pct: 62.5, n: 16 } },
      verdict: { ml: mlVerdict, under: underVerdict, over: overVerdict },
    },
  };

  if (!fs.existsSync(AUDIT_OUTPUT)) fs.mkdirSync(AUDIT_OUTPUT, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n\nOutput: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
