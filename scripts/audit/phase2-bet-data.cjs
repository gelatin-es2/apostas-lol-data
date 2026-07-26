// scripts/audit/phase2-bet-data.cjs
//
// Fase 2: recompute por bet (kills, status, profit, campos obrigatórios, trigger,
// fair, bookmaker case, geração de linha SIMULATED) contra o universo (fase 0) e
// contra a MESMA lógica de fair usada pelo settle real (portada com sync-comment de
// .claude/scripts/settle-pending-bets.cjs).
//
// Uso: node phase2-bet-data.cjs
// Output: audit-output/02-bet-data.json

'use strict';

const fs = require('fs');
const path = require('path');

const { loadAllBets, inScope, isEwc, parsePick, SPLIT2_FROM, SPLIT2_TO } = require('./lib/audit-common.cjs');
const { buildUniverseIndex, findGameForBet, resolveMoneylineSide } = require('./lib/match-bet-to-game.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');
const CRON_DIR = path.join(ROOT, 'cron-data');
const UNIVERSE_FILE = path.join(OUTPUT_DIR, '00-universe.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '02-bet-data.json');

const VALID_LEAGUES = new Set(['LCK', 'LPL', 'LEC', 'CBLOL', 'LFL', 'LCS', 'LES', 'EMEA Masters', 'LIT']);

// === sync: .claude/scripts/settle-pending-bets.cjs L25-97 (buildTeamAvgsFromResults +
// calcFairFormula) — MESMA lógica, copiada verbatim (só cache adicionado por cima pra
// não reler os mesmos results.json centenas de vezes). Qualquer mudança lá tem que
// espelhar aqui, senão FAIR_MISMATCH vira ruído de auditoria desatualizada.
const MIN_SAMPLE_SETTLE = 5;

function buildTeamAvgsFromResults(targetDate) {
  const cutoff = new Date(targetDate + 'T00:00:00Z');
  cutoff.setDate(cutoff.getDate() - 21);
  const since = cutoff.toISOString().slice(0, 10);

  const teamHist = new Map();
  const leagueHist = new Map();

  const files = fs.existsSync(CRON_DIR)
    ? fs.readdirSync(CRON_DIR).filter((f) => f.endsWith('-results.json'))
    : [];

  for (const file of files) {
    const dateStr = file.slice(0, 10);
    if (dateStr < since || dateStr > targetDate) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CRON_DIR, file), 'utf8'));
      for (const r of data.results || []) {
        if (r.total_kills == null) continue;
        for (const team of [r.team_blue, r.team_red]) {
          if (!team) continue;
          if (!teamHist.has(team)) teamHist.set(team, []);
          teamHist.get(team).push(r.total_kills);
        }
        const lg = r.league;
        if (lg) {
          if (!leagueHist.has(lg)) leagueHist.set(lg, []);
          leagueHist.get(lg).push(r.kills_blue ?? 0, r.kills_red ?? 0);
        }
      }
    } catch {
      /* arquivo corrompido: pula */
    }
  }

  const teamAvg = new Map();
  for (const [t, arr] of teamHist) {
    teamAvg.set(t, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  const leagueAvg = new Map();
  for (const [l, arr] of leagueHist) {
    leagueAvg.set(l, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return { teamAvg, teamHist, leagueAvg };
}

function calcFairFormula(bet, teamHist, leagueAvg) {
  const mc = bet.raw_extraction?.match_context || {};
  const teamA = normalizeTeam(mc.teams?.[0]?.name || bet.team_a);
  const teamB = normalizeTeam(mc.teams?.[1]?.name || bet.team_b);
  const lg = (bet.league || '').toUpperCase().replace(/\s+/g, '');
  const lgKey = ['LCK', 'LPL', 'LEC', 'CBLOL', 'LFL', 'LCS'].find((k) => lg.includes(k)) || null;

  const aHist = teamHist.get(teamA) || [];
  const bHist = teamHist.get(teamB) || [];
  const lAvgPerSide = leagueAvg.get(lgKey) ?? 14.5;
  const lAvgTotal = lAvgPerSide * 2;

  const aAvg = aHist.length >= MIN_SAMPLE_SETTLE ? aHist.reduce((a, b) => a + b, 0) / aHist.length : lAvgTotal;
  const bAvg = bHist.length >= MIN_SAMPLE_SETTLE ? bHist.reduce((a, b) => a + b, 0) / bHist.length : lAvgTotal;

  const raw = aAvg + bAvg;
  const formula = Math.round(raw / 2 - 0.5) + 0.5;
  return +formula.toFixed(1);
}
// === fim sync ===

// Caches por processo — mesma janela 21d é recalculada centenas de vezes se não cachear.
const teamAvgsCache = new Map();
function getTeamAvgs(targetDate) {
  if (!teamAvgsCache.has(targetDate)) teamAvgsCache.set(targetDate, buildTeamAvgsFromResults(targetDate));
  return teamAvgsCache.get(targetDate);
}
const pinnacleCache = new Map();
function getPinnacle(date) {
  if (!pinnacleCache.has(date)) pinnacleCache.set(date, loadFairPinnacle(date));
  return pinnacleCache.get(date);
}

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_FILE)) {
    console.error(`FATAL: ${UNIVERSE_FILE} não existe. Rode fase 0 primeiro.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
}

function teamsLabel(bet) {
  return `${bet.team_a ?? '?'} vs ${bet.team_b ?? '?'}`;
}

function baseFinding(check, severity, bet, extra) {
  return {
    check,
    severity,
    bet_id: bet.id,
    bookmaker: bet.bookmaker,
    league: bet.league,
    teams: teamsLabel(bet),
    date: bet.bet_datetime,
    ...extra,
  };
}

function evidenceForGame(game) {
  if (!game) return null;
  return {
    game_id: game.game_id,
    match_id: game.match_id,
    url: `https://feed.lolesports.com/livestats/v1/window/${game.game_id}`,
    cache_file: `audit-cache/window-${game.game_id}.json`,
  };
}

// === Checks por bet ===

function checkKillsMismatch(bet, game, findings) {
  const mc = bet.raw_extraction?.match_context || {};
  const ev = evidenceForGame(game);
  if (mc.total_kills != null && game.total_kills != null && mc.total_kills !== game.total_kills) {
    findings.push(
      baseFinding('KILLS_MISMATCH', 'CRITICAL', bet, {
        field: 'match_context.total_kills',
        current: mc.total_kills,
        expected: game.total_kills,
        evidence: ev,
      })
    );
  }
  if (mc.kills_blue != null && game.kills_blue != null && mc.kills_blue !== game.kills_blue) {
    findings.push(
      baseFinding('KILLS_MISMATCH', 'CRITICAL', bet, {
        field: 'match_context.kills_blue',
        current: mc.kills_blue,
        expected: game.kills_blue,
        evidence: ev,
      })
    );
  }
  if (mc.kills_red != null && game.kills_red != null && mc.kills_red !== game.kills_red) {
    findings.push(
      baseFinding('KILLS_MISMATCH', 'CRITICAL', bet, {
        field: 'match_context.kills_red',
        current: mc.kills_red,
        expected: game.kills_red,
        evidence: ev,
      })
    );
  }
}

function checkStatusMismatch(bet, game, findings) {
  if (bet.status === 'cashout' || bet.status === 'void') {
    findings.push(
      baseFinding('STATUS_MISMATCH', 'INFO', bet, {
        field: 'status',
        current: bet.status,
        expected: bet.status,
        evidence: 'manual, legítimo — hedge/cashout não é resolvido pela API',
      })
    );
    return;
  }

  const parsed = parsePick(bet.pick, bet.market);
  const ev = evidenceForGame(game);
  const totalKills = game.total_kills;

  if ((parsed.kind === 'under' || parsed.kind === 'over') && parsed.line != null && totalKills != null) {
    const won = parsed.kind === 'under' ? totalKills < parsed.line : totalKills > parsed.line;
    const expected = won ? 'green' : 'red';
    if (bet.status !== expected) {
      findings.push(
        baseFinding('STATUS_MISMATCH', 'CRITICAL', bet, {
          field: 'status',
          current: bet.status,
          expected,
          evidence: { ...ev, pick: bet.pick, line: parsed.line, total_kills: totalKills },
        })
      );
    }
    return;
  }

  if (parsed.kind === 'moneyline') {
    const side = resolveMoneylineSide(bet, game);
    if (!side || !game.winner_side) {
      findings.push(
        baseFinding('STATUS_MISMATCH', 'INFO', bet, {
          check: 'MANUAL_CHECK',
          field: 'status',
          current: bet.status,
          expected: null,
          evidence: { ...ev, pick: bet.pick, note: 'moneyline: side do pick ambíguo (melhor esforço não resolveu) — conferir manual' },
        })
      );
      return;
    }
    const won = side === game.winner_side;
    const expected = won ? 'green' : 'red';
    if (bet.status !== expected) {
      findings.push(
        baseFinding('STATUS_MISMATCH', 'CRITICAL', bet, {
          field: 'status',
          current: bet.status,
          expected,
          evidence: { ...ev, pick: bet.pick, resolved_side: side, winner_side: game.winner_side },
        })
      );
    }
    return;
  }

  // pick não parseável (kind unknown) e status não é cashout/void — vale checagem manual.
  findings.push(
    baseFinding('STATUS_MISMATCH', 'INFO', bet, {
      check: 'MANUAL_CHECK',
      field: 'pick',
      current: bet.pick,
      expected: null,
      evidence: { market: bet.market, note: 'pick não parseável por parsePick() — conferir manual' },
    })
  );
}

function checkProfitMismatch(bet, findings) {
  if (bet.status === 'cashout' || bet.status === 'void' || bet.status === 'pending') return;
  const stake = parseFloat(bet.stake);
  const odd = parseFloat(bet.odd);
  if (!Number.isFinite(stake) || !Number.isFinite(odd)) return;

  if (bet.status === 'green') {
    const expected = +(stake * (odd - 1)).toFixed(2);
    if (bet.profit == null || Math.abs(bet.profit - expected) > 0.01) {
      findings.push(
        baseFinding('PROFIT_MISMATCH', 'CRITICAL', bet, {
          field: 'profit',
          current: bet.profit,
          expected,
          evidence: { stake, odd, formula: 'stake*(odd-1)' },
        })
      );
    }
  } else if (bet.status === 'red') {
    const expected = -stake;
    if (bet.profit == null || Math.abs(bet.profit - expected) > 0.01) {
      findings.push(
        baseFinding('PROFIT_MISMATCH', 'CRITICAL', bet, {
          field: 'profit',
          current: bet.profit,
          expected,
          evidence: { stake, odd, formula: '-stake' },
        })
      );
    }
  }
}

function checkFieldMissing(bet, findings) {
  if (!bet.bet_datetime) {
    findings.push(baseFinding('FIELD_MISSING', 'HIGH', bet, { field: 'bet_datetime', current: null, expected: 'not null' }));
  }
  if ((bet.status === 'green' || bet.status === 'red') && bet.profit == null) {
    findings.push(baseFinding('FIELD_MISSING', 'HIGH', bet, { field: 'profit', current: null, expected: 'not null (settled bet)' }));
  }
  if (bet.status === 'green' || bet.status === 'red') {
    const mc = bet.raw_extraction?.match_context || {};
    if (!mc.lolesports_match_id) {
      findings.push(
        baseFinding('FIELD_MISSING', 'HIGH', bet, {
          field: 'match_context.lolesports_match_id',
          current: null,
          expected: 'not null (settled bet)',
        })
      );
    }
    if (!mc.lolesports_game_id) {
      findings.push(
        baseFinding('FIELD_MISSING', 'HIGH', bet, {
          field: 'match_context.lolesports_game_id',
          current: null,
          expected: 'not null (settled bet)',
        })
      );
    }
  }
  const leagueOk = bet.league && (VALID_LEAGUES.has(bet.league) || bet.league.toUpperCase().startsWith('EWC'));
  if (!leagueOk) {
    findings.push(
      baseFinding('FIELD_MISSING', 'HIGH', bet, {
        field: 'league',
        current: bet.league,
        expected: `um de ${[...VALID_LEAGUES].join(',')} (ou EWC*)`,
      })
    );
  }
}

function checkTriggerMismatch(bet, game, findings) {
  const mc = bet.raw_extraction?.match_context || {};
  const current = mc.trigger_type ?? null;
  const expected = game.trigger_type ?? null;
  if (current !== expected) {
    findings.push(
      baseFinding('TRIGGER_MISMATCH', 'MEDIUM', bet, {
        field: 'match_context.trigger_type',
        current,
        expected,
        evidence: { ...evidenceForGame(game), sup_blue: game.sup_blue, sup_red: game.sup_red },
      })
    );
  }
}

// Ligas que efetivamente têm histórico em cron-data/*-results.json (checado empírico:
// resultsIndex nunca teve rows league=LFL/LES/LIT — só existe pipeline separado pra
// tier2, `analyze_tier2_eu.cjs`/`rebuild_tier2_dashboard_stats.cjs`, que NUNCA escreve
// em `-results.json`). Pra essas ligas, calcFairFormula() SEMPRE cai no fallback
// (sem team hist, sem league hist) — recompute não é comparável ao que popula o
// fair_formula real dessas bets (vem de outro pipeline). Ver nota em checkFairMismatch.
const FAIR_FORMULA_DATA_COVERAGE = new Set(['LCK', 'LPL', 'LEC', 'CBLOL', 'LCS']);

function checkFairMismatch(bet, findings) {
  const betDateStr = (bet.bet_datetime || '').slice(0, 10);
  if (!betDateStr) return;

  const { teamHist, leagueAvg } = getTeamAvgs(betDateStr);
  const expectedFormula = calcFairFormula(bet, teamHist, leagueAvg);
  const currentFormula = bet.fair_formula;
  const hasDataCoverage = FAIR_FORMULA_DATA_COVERAGE.has(bet.league);
  if (currentFormula == null || Math.abs(currentFormula - expectedFormula) > 0.0001) {
    findings.push(
      baseFinding('FAIR_MISMATCH', 'MEDIUM', bet, {
        field: 'fair_formula',
        current: currentFormula,
        expected: expectedFormula,
        formula_data_coverage: hasDataCoverage,
        note: hasDataCoverage
          ? undefined
          : 'liga sem histórico em cron-data/*-results.json (só 4 majors+LCS têm) — recompute cai em fallback, não é comparável ao valor real (provável fonte: pipeline tier2 separado). Ver fair_mismatch_analysis no topo do output.',
        evidence: { window: '21d antes de ' + betDateStr, source: 'buildTeamAvgsFromResults (cron-data/*-results.json)' },
      })
    );
  }

  const pinMap = getPinnacle(betDateStr);
  if (pinMap.raw != null) {
    const matchId = bet.raw_extraction?.match_context?.lolesports_match_id;
    const expectedPinnacle = matchId ? pinMap.byMatchId.get(String(matchId)) ?? null : null;
    const currentPinnacle = bet.fair_pinnacle ?? null;
    if (expectedPinnacle != null && (currentPinnacle == null || Math.abs(currentPinnacle - expectedPinnacle) > 0.0001)) {
      findings.push(
        baseFinding('FAIR_MISMATCH', 'MEDIUM', bet, {
          field: 'fair_pinnacle',
          current: currentPinnacle,
          expected: expectedPinnacle,
          evidence: { file: `cron-data/${betDateStr}-fair-pinnacle.json` },
        })
      );
    }
  }
}

function checkBookmakerCase(bets) {
  const groups = new Map(); // lowercased -> Map<original,count>
  for (const b of bets) {
    if (!b.bookmaker) continue;
    const key = b.bookmaker.toLowerCase();
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key);
    g.set(b.bookmaker, (g.get(b.bookmaker) || 0) + 1);
  }
  const findings = [];
  for (const [key, variants] of groups) {
    if (variants.size <= 1) continue;
    findings.push({
      check: 'BOOKMAKER_CASE',
      severity: 'LOW',
      normalized: key,
      variants: [...variants.entries()].map(([value, count]) => ({ value, count })),
      total: [...variants.values()].reduce((a, b) => a + b, 0),
    });
  }
  return findings;
}

function checkSimLineGeneration(bet) {
  const parsed = parsePick(bet.pick, bet.market);
  const fair = bet.fair_formula;
  let generation = 'no_fair_formula';
  if (parsed.line != null && fair != null) {
    if (Math.abs(parsed.line - fair) < 0.0001) generation = 'exact';
    else if (Math.abs(parsed.line - (fair + 1)) < 0.0001) generation = 'fair+1';
    else if (Math.abs(parsed.line - (fair - 2)) < 0.0001) generation = 'fair-2';
    else generation = 'outro';
  }
  return {
    check: 'SIM_LINE_GENERATION',
    severity: 'INFO',
    bet_id: bet.id,
    league: bet.league,
    teams: teamsLabel(bet),
    date: bet.bet_datetime,
    pick_line: parsed.line,
    fair_formula: fair,
    generation,
  };
}

(async () => {
  const universe = loadUniverse();
  const universeIndex = buildUniverseIndex(universe);

  const allBets = await loadAllBets();
  const scopedBets = allBets.filter((b) => inScope(b) && !isEwc(b));

  const findings = [];
  const manualCheck = [];
  const simLineList = [];

  for (const bet of scopedBets) {
    const m = findGameForBet(bet, universeIndex);
    const game = m.game;
    const gameUsable = game && !game.suspect && !game.fetch_error;

    if (gameUsable) {
      checkKillsMismatch(bet, game, findings);
      checkStatusMismatch(bet, game, findings);
      checkTriggerMismatch(bet, game, findings);
    } else {
      let reason;
      if (!game) reason = m.ambiguous ? 'universe_ambiguous_candidates' : 'no_universe_match';
      else if (game.fetch_error) reason = 'fetch_error';
      else reason = 'suspect_frame';

      manualCheck.push({
        check: 'MANUAL_CHECK',
        severity: 'INFO',
        bet_id: bet.id,
        bookmaker: bet.bookmaker,
        league: bet.league,
        teams: teamsLabel(bet),
        date: bet.bet_datetime,
        status: bet.status,
        reason,
        game_id: game ? game.game_id : null,
        fetch_error_detail: game?.fetch_error || null,
        note:
          reason === 'no_universe_match'
            ? 'Nenhum jogo do universo casou (fora das 6 ligas cobertas, ou realmente órfã — ver fase 1) — checar manual no gol.gg/Leaguepedia se necessário.'
            : reason === 'universe_ambiguous_candidates'
              ? `${m.candidateCount} candidatos ambíguos no universo (nomes/data/map_number não desempataram).`
              : 'Frame livestats não confiável (gameState≠finished + gameTime<600s ou kills<5, ou fetch falhou) — conferir kills/status manual no gol.gg antes de confiar no recompute.',
      });
      // Ainda assim tentamos checar STATUS_MISMATCH quando o pick é cashout/void
      // (não depende de dado de jogo) — evita perder o INFO "manual, legítimo".
      if (bet.status === 'cashout' || bet.status === 'void') {
        checkStatusMismatch(bet, game || {}, findings);
      }
    }

    checkProfitMismatch(bet, findings);
    checkFieldMissing(bet, findings);
    checkFairMismatch(bet, findings);

    if (bet.bookmaker === 'SIMULATED') {
      simLineList.push(checkSimLineGeneration(bet));
    }
  }

  const bookmakerCase = checkBookmakerCase(scopedBets);

  // === Contagens ===
  const byCheckSeverity = {};
  for (const f of findings) {
    const k = `${f.check}|${f.severity}`;
    byCheckSeverity[k] = (byCheckSeverity[k] || 0) + 1;
  }
  const simGenCounts = {};
  for (const s of simLineList) simGenCounts[s.generation] = (simGenCounts[s.generation] || 0) + 1;

  // Diagnóstico FAIR_MISMATCH — ver comentário em checkFairMismatch(). Duas causas
  // sistêmicas identificadas por investigação manual (validação #3 do plano), NENHUMA
  // é bug de bet:
  //   1. Ligas tier2 (LFL/LES/LIT) nunca tiveram histórico em cron-data/*-results.json
  //      (só pipeline separado, results.json cobre só LCK/LPL/LEC/CBLOL/LCS) — recompute
  //      cai sempre no fallback 29.5, incomparável ao valor real (fonte: pipeline tier2).
  //   2. cron-data/*-results.json NÃO é imutável na prática: commit eb7514a
  //      ("regen 2026-05-20/21/22 results") reescreveu janelas históricas depois que
  //      bets daquele período já tinham sido settled — settle-then usou um snapshot
  //      diferente do que existe hoje. Explica os ~1 linha de diferença nos majors com
  //      current != null.
  const fairFormulaFindings = findings.filter((f) => f.check === 'FAIR_MISMATCH' && f.field === 'fair_formula');
  const fairMismatchAnalysis = {
    total: fairFormulaFindings.length,
    current_null_missing_backfill: fairFormulaFindings.filter((f) => f.current == null).length,
    tier2_no_data_source_in_settle: fairFormulaFindings.filter((f) => f.current != null && f.formula_data_coverage === false).length,
    majors_value_diverges: fairFormulaFindings.filter((f) => f.current != null && f.formula_data_coverage === true).length,
    root_cause:
      'Divergência em massa (>30%) investigada por amostragem (validação #3): NÃO é bug das bets. ' +
      '(a) LFL/LES/LIT nunca aparecem em cron-data/*-results.json (só as 5 ligas LCK/LPL/LEC/CBLOL/LCS têm histórico ali) — ' +
      'calcFairFormula() cai sempre no fallback pra essas ligas, incomparável ao valor real gravado (que vem de outro pipeline, tier2). ' +
      '(b) cron-data/*-results.json não é imutável na prática — commit eb7514a reescreveu dias já usados por settle antes dele; ' +
      'o snapshot histórico mudou depois do settle original, então o recompute de hoje diverge por ~1 linha do valor travado então. ' +
      'Tratar como limitação da auditoria (fonte histórica mutável), não como erro de dado da bet.',
  };

  const output = {
    generated_at: new Date().toISOString(),
    split2_range: { from: SPLIT2_FROM, to: SPLIT2_TO },
    scoped_bets_total: scopedBets.length,
    fair_mismatch_analysis: fairMismatchAnalysis,
    findings,
    manual_check: manualCheck,
    sim_line_generation: { counts: simGenCounts, total: simLineList.length, list: simLineList },
    bookmaker_case: bookmakerCase,
    counts: {
      by_check_severity: byCheckSeverity,
      manual_check_total: manualCheck.length,
      manual_check_by_reason: manualCheck.reduce((acc, m) => {
        acc[m.reason] = (acc[m.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('=== FASE 2 — DADOS POR BET ===');
  console.log(`Bets no escopo (non-EWC): ${scopedBets.length}`);
  console.log('');
  console.log('Contagem por check x severidade:');
  const sortedKeys = Object.keys(byCheckSeverity).sort();
  for (const k of sortedKeys) {
    console.log(`  ${k.padEnd(30)} ${byCheckSeverity[k]}`);
  }
  console.log('');
  console.log(`FAIR_MISMATCH (fair_formula) diagnóstico — ${fairMismatchAnalysis.total} total:`);
  console.log(`  coluna null (nunca backfilled): ${fairMismatchAnalysis.current_null_missing_backfill}`);
  console.log(`  tier2 sem fonte de dado no settle (LFL/LES/LIT — incomparável): ${fairMismatchAnalysis.tier2_no_data_source_in_settle}`);
  console.log(`  majors com valor divergente (~1 linha, results.json mutável): ${fairMismatchAnalysis.majors_value_diverges}`);
  console.log('  → NÃO tratar como bug de bet em massa. Ver fair_mismatch_analysis.root_cause no JSON.');
  console.log('');
  console.log(`MANUAL_CHECK (INFO): ${manualCheck.length}`);
  console.log('  por motivo:', JSON.stringify(output.counts.manual_check_by_reason));
  console.log(`SIM_LINE_GENERATION: ${simLineList.length} SIMULATED bets`);
  console.log('  por geração:', JSON.stringify(simGenCounts));
  console.log(`BOOKMAKER_CASE (LOW): ${bookmakerCase.length} pares colidindo`);
  for (const b of bookmakerCase) {
    console.log(`  ${b.normalized}: ${JSON.stringify(b.variants)}`);
  }
  console.log('');
  console.log(`Output: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
