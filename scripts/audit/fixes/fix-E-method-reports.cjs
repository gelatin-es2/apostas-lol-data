// scripts/audit/fixes/fix-E-method-reports.cjs
//
// Lote E da auditoria 2026-07-20: upsert das 274 rows MR_MISSING em method_reports
// (audit-output/03-method-reports.json), a partir do UNIVERSO (00-universe.json) —
// NÃO de cron-data/*-results.json, que tem o bug do Alistar (código arquivado ainda
// trata Alistar como FLEX_ENGAGE).
//
// fair_line: fórmula leave-one-out (réplica de fairFormulaForGame() de
// scripts/analysis/split2-improve.cjs). fair_source = 'audit_backfill_formula'.
// PK lógica (game_id, map_number) — upsert via on_conflict, mesmo padrão de
// .claude/scripts/save_report_to_db.cjs.
//
// Uso:
//   node fix-E-method-reports.cjs            → dry-run
//   node fix-E-method-reports.cjs --execute  → aplica upsert

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');
const { normTeamName } = require('../../../lib/normTeamName.cjs');
const { PEEL_PURE, FLEX_ENGAGE } = require('../lib/audit-common.cjs');

const EXECUTE = process.argv.includes('--execute');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const UNIVERSE_FILE = path.join(ROOT, 'audit-output', '00-universe.json');
const MR_AUDIT_FILE = path.join(ROOT, 'audit-output', '03-method-reports.json');

const norm = (s) => (s ? s.toLowerCase().replace(/\s+/g, '') : '');
const FLEX_SET = new Set(FLEX_ENGAGE.map(norm));

function supaRequest(supabaseUrl, supabaseKey, method, urlPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extraHeaders,
    };
    let data = null;
    if (body !== null) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// === sync: scripts/analysis/split2-improve.cjs L277-316 ===
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
// === fim sync ===

function flexEngagesFor(game) {
  const out = [];
  if (FLEX_SET.has(norm(game.sup_blue))) out.push(game.sup_blue);
  if (FLEX_SET.has(norm(game.sup_red))) out.push(game.sup_red);
  return out;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const mrAudit = JSON.parse(fs.readFileSync(MR_AUDIT_FILE, 'utf8'));
  const missing = mrAudit.findings.filter((f) => f.check === 'MR_MISSING');

  console.log(`=== LOTE E — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  console.log(`MR_MISSING no snapshot da auditoria (2026-07-20): ${missing.length}`);

  const teamHist = buildTeamKillsHistory(universe);
  const leagueAvg = buildLeagueAvgKills(universe);
  const universeByGameId = new Map(universe.map((g) => [String(g.game_id), g]));

  // Re-checa ao vivo quais (game_id, map_number) já existem em method_reports (evita
  // upsert desnecessário sobrescrever algo criado entre ontem e agora — na prática
  // upsert é idempotente, mas contamos separado pra reportar).
  console.log('Re-checando method_reports existentes ao vivo...');
  const existingRows = await supaRequest(supabaseUrl, supabaseKey, 'GET', '/rest/v1/method_reports?select=game_id,map_number&limit=2000');
  const existingKeys = new Set(existingRows.map((r) => `${r.game_id}|${r.map_number}`));

  const plan = [];
  const skipped = [];
  const byLeague = {};
  for (const m of missing) {
    const key = `${m.game_id}|${m.map_number}`;
    if (existingKeys.has(key)) { skipped.push({ ...m, reason: 'já existe (re-check ao vivo)' }); continue; }
    const game = universeByGameId.get(String(m.game_id));
    if (!game) { skipped.push({ ...m, reason: 'game não encontrado no universo' }); continue; }
    if (game.total_kills == null) { skipped.push({ ...m, reason: 'total_kills null' }); continue; }

    const fair = fairFormulaForGame(game, teamHist, leagueAvg);
    const underHit = game.total_kills < fair;
    const row = {
      match_date: (game.date || '').slice(0, 10),
      league: game.league,
      match_id: String(game.match_id),
      game_id: String(game.game_id),
      map_number: game.map_number,
      team_blue: game.team_blue,
      team_red: game.team_red,
      sup_blue: game.sup_blue,
      sup_red: game.sup_red,
      trigger_type: game.trigger_type,
      flex_engages: flexEngagesFor(game),
      total_kills: game.total_kills,
      fair_line: fair,
      fair_source: 'audit_backfill_formula',
      under_hit: underHit,
    };
    byLeague[game.league] = (byLeague[game.league] || 0) + 1;
    plan.push(row);
  }

  console.log(`\nA upsertar: ${plan.length} | pulados: ${skipped.length}`);
  console.log('Por liga:', JSON.stringify(byLeague));
  if (skipped.length) {
    console.log('\nPulados:');
    for (const s of skipped.slice(0, 20)) console.log(`  game_id=${s.game_id} map=${s.map_number}: ${s.reason}`);
    if (skipped.length > 20) console.log(`  ... e mais ${skipped.length - 20}`);
  }
  console.log('\nAmostra (5 primeiras rows):');
  console.log(JSON.stringify(plan.slice(0, 5), null, 2));

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum upsert aplicado. Rode com --execute para aplicar.');
    return;
  }
  if (plan.length === 0) {
    console.log('\nNada a upsertar.');
    return;
  }

  console.log('\nUpsertando em chunks de 50...');
  let upserted = 0;
  const CHUNK = 50;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const chunk = plan.slice(i, i + CHUNK);
    await supaRequest(
      supabaseUrl, supabaseKey, 'POST',
      '/rest/v1/method_reports?on_conflict=game_id,map_number',
      chunk,
      { Prefer: 'resolution=merge-duplicates' }
    );
    upserted += chunk.length;
    console.log(`  upserted ${upserted}/${plan.length}`);
  }

  console.log('\nRevalidando (contagem method_reports pós-upsert)...');
  const after = await supaRequest(supabaseUrl, supabaseKey, 'GET', '/rest/v1/method_reports?select=game_id,map_number&limit=2000');
  console.log(`  method_reports total agora: ${after.length}`);

  // sample re-check de 5 rows específicas
  const sampleKeys = plan.slice(0, 5).map((r) => `game_id=eq.${r.game_id}&map_number=eq.${r.map_number}`);
  for (const q of sampleKeys) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/method_reports?${q}&select=game_id,map_number,trigger_type,fair_line,under_hit`);
    console.log('  sample:', JSON.stringify(rows[0]));
  }
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
