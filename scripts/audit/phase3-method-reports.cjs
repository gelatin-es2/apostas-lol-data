// scripts/audit/phase3-method-reports.cjs
//
// Fase 3: audita a tabela method_reports (nunca auditada antes) — PK lógica
// (game_id, map_number), schema em .claude/scripts/save_report_to_db.cjs.
//
// Uso: node phase3-method-reports.cjs
// Output: audit-output/03-method-reports.json

'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../../.claude/scripts/_load-config.cjs');
const { supabaseGet } = require('../../lib/supabaseQuery.cjs');
const { SPLIT2_FROM, SPLIT2_TO, LEAGUE_IDS } = require('./lib/audit-common.cjs');
const { buildUniverseIndex } = require('./lib/match-bet-to-game.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'audit-output');
const UNIVERSE_FILE = path.join(OUTPUT_DIR, '00-universe.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '03-method-reports.json');

const UNIVERSE_LEAGUES = new Set(Object.keys(LEAGUE_IDS));
const PAGE_SIZE = 1000;

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_FILE)) {
    console.error(`FATAL: ${UNIVERSE_FILE} não existe. Rode fase 0 primeiro.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
}

async function loadAllMethodReports() {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const rows = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const page = await supabaseGet(
      supabaseUrl,
      supabaseKey,
      '/rest/v1/method_reports?select=*&order=match_date.asc',
      { Range: `${offset}-${end}`, Prefer: 'count=exact' }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function baseFinding(check, severity, row, extra) {
  return {
    check,
    severity,
    report_id: row.id,
    match_date: row.match_date,
    league: row.league,
    game_id: row.game_id,
    match_id: row.match_id,
    map_number: row.map_number,
    teams: `${row.team_blue ?? '?'} vs ${row.team_red ?? '?'}`,
    ...extra,
  };
}

(async () => {
  const universe = loadUniverse();
  const universeIndex = buildUniverseIndex(universe);

  const allRows = await loadAllMethodReports();
  const scopedRows = allRows.filter((r) => r.match_date >= SPLIT2_FROM && r.match_date < SPLIT2_TO);

  const findings = [];

  // === MR_KILLS_MISMATCH / MR_UNDER_HIT_WRONG / MR_TRIGGER_MISMATCH / MR_ORPHAN ===
  for (const row of scopedRows) {
    const gameId = row.game_id ? String(row.game_id) : null;
    const game = gameId ? universeIndex.byGameId.get(gameId) : null;

    // MR_UNDER_HIT_WRONG: consistência interna (não depende do universo) — under_hit
    // tem que bater com (total_kills < fair_line) da PRÓPRIA row.
    if (row.total_kills != null && row.fair_line != null) {
      const expectedUnderHit = row.total_kills < row.fair_line;
      if (!!row.under_hit !== expectedUnderHit) {
        findings.push(
          baseFinding('MR_UNDER_HIT_WRONG', 'HIGH', row, {
            field: 'under_hit',
            current: row.under_hit,
            expected: expectedUnderHit,
            evidence: { total_kills: row.total_kills, fair_line: row.fair_line },
          })
        );
      }
    }

    if (!game) {
      const leagueKey = (row.league || '').toUpperCase();
      if (UNIVERSE_LEAGUES.has(leagueKey)) {
        findings.push(
          baseFinding('MR_ORPHAN', 'INFO', row, {
            note: 'game_id não encontrado no universo (liga coberta pela fase 0) — checar manual.',
          })
        );
      } else {
        findings.push(
          baseFinding('MR_ORPHAN', 'INFO', row, {
            out_of_universe: true,
            note: 'Liga fora das 6 operadas na fase 0 — sem cobertura de universo, não é órfã de verdade.',
          })
        );
      }
      continue; // sem game não dá pra checar kills/trigger contra API
    }

    if (game.total_kills != null && row.total_kills !== game.total_kills) {
      findings.push(
        baseFinding('MR_KILLS_MISMATCH', 'HIGH', row, {
          field: 'total_kills',
          current: row.total_kills,
          expected: game.total_kills,
          evidence: { game_suspect: game.suspect, game_fetch_error: !!game.fetch_error },
        })
      );
    }

    const currentTrigger = row.trigger_type ?? null;
    const expectedTrigger = game.trigger_type ?? null;
    if (currentTrigger !== expectedTrigger) {
      findings.push(
        baseFinding('MR_TRIGGER_MISMATCH', 'MEDIUM', row, {
          field: 'trigger_type',
          current: currentTrigger,
          expected: expectedTrigger,
          evidence: {
            sup_blue_row: row.sup_blue,
            sup_red_row: row.sup_red,
            sup_blue_universe: game.sup_blue,
            sup_red_universe: game.sup_red,
            flex_engages_row: row.flex_engages,
            alistar_involved: row.sup_blue === 'Alistar' || row.sup_red === 'Alistar',
          },
        })
      );
    }
  }

  // === MR_PK_DUP: (game_id, map_number) duplicado ===
  const pkGroups = new Map();
  for (const row of scopedRows) {
    const key = `${row.game_id}|${row.map_number}`;
    if (!pkGroups.has(key)) pkGroups.set(key, []);
    pkGroups.get(key).push(row);
  }
  for (const [key, rows] of pkGroups) {
    if (rows.length <= 1) continue;
    findings.push({
      check: 'MR_PK_DUP',
      severity: 'HIGH',
      pk: key,
      game_id: rows[0].game_id,
      map_number: rows[0].map_number,
      league: rows[0].league,
      teams: `${rows[0].team_blue ?? '?'} vs ${rows[0].team_red ?? '?'}`,
      duplicate_count: rows.length,
      report_ids: rows.map((r) => r.id),
    });
  }

  // === MR_MISSING: game do universo com trigger sem row ===
  const rowsByGameId = new Set(scopedRows.map((r) => String(r.game_id)));
  const eligibleTriggerGames = universe.filter((g) => g.trigger_type && !g.suspect && !g.fetch_error);
  const missing = eligibleTriggerGames
    .filter((g) => !rowsByGameId.has(String(g.game_id)))
    .map((g) => ({
      check: 'MR_MISSING',
      severity: 'MEDIUM',
      game_id: g.game_id,
      match_id: g.match_id,
      league: g.league,
      date: g.date,
      map_number: g.map_number,
      teams: `${g.team_blue ?? '?'} vs ${g.team_red ?? '?'}`,
      trigger_type: g.trigger_type,
      total_kills: g.total_kills,
    }));
  findings.push(...missing);

  // === Contagens ===
  const byCheckSeverity = {};
  for (const f of findings) {
    const k = `${f.check}|${f.severity}`;
    byCheckSeverity[k] = (byCheckSeverity[k] || 0) + 1;
  }
  const byLeague = (check) => {
    const out = {};
    for (const f of findings.filter((x) => x.check === check)) out[f.league] = (out[f.league] || 0) + 1;
    return out;
  };

  const output = {
    generated_at: new Date().toISOString(),
    split2_range: { from: SPLIT2_FROM, to: SPLIT2_TO },
    method_reports_total: allRows.length,
    method_reports_scoped: scopedRows.length,
    findings,
    counts: {
      by_check_severity: byCheckSeverity,
      mr_kills_mismatch_by_league: byLeague('MR_KILLS_MISMATCH'),
      mr_trigger_mismatch_by_league: byLeague('MR_TRIGGER_MISMATCH'),
      mr_trigger_mismatch_alistar: findings.filter((f) => f.check === 'MR_TRIGGER_MISMATCH' && f.evidence?.alistar_involved).length,
      mr_missing_by_league: byLeague('MR_MISSING'),
      mr_orphan_by_league: byLeague('MR_ORPHAN'),
      mr_orphan_out_of_universe: findings.filter((f) => f.check === 'MR_ORPHAN' && f.out_of_universe).length,
    },
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('=== FASE 3 — METHOD_REPORTS ===');
  console.log(`method_reports total: ${allRows.length} | no escopo (${SPLIT2_FROM}..${SPLIT2_TO}): ${scopedRows.length}`);
  console.log('');
  console.log('Contagem por check x severidade:');
  for (const k of Object.keys(byCheckSeverity).sort()) {
    console.log(`  ${k.padEnd(28)} ${byCheckSeverity[k]}`);
  }
  console.log('');
  console.log('MR_KILLS_MISMATCH por liga:', JSON.stringify(output.counts.mr_kills_mismatch_by_league));
  console.log('MR_TRIGGER_MISMATCH por liga:', JSON.stringify(output.counts.mr_trigger_mismatch_by_league), `(Alistar envolvido: ${output.counts.mr_trigger_mismatch_alistar})`);
  console.log('MR_MISSING por liga:', JSON.stringify(output.counts.mr_missing_by_league));
  console.log('MR_ORPHAN por liga:', JSON.stringify(output.counts.mr_orphan_by_league), `(fora do universo: ${output.counts.mr_orphan_out_of_universe})`);
  console.log('');
  console.log(`Output: ${OUTPUT_FILE}`);
})().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
