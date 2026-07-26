// scripts/audit/fixes/fix-D-insert-missing.cjs
//
// Lote D da auditoria 2026-07-20: insere as 36 bets SIMULATED faltando (MISSING_BET,
// audit-output/01-coverage.json.missing_bets) — jogos com trigger ativo, frame
// confiável, sem NENHUMA bet (real ou SIMULATED) correspondente no banco.
//
// Fair line: fórmula leave-one-out sobre o universo inteiro (00-universe.json),
// MESMA lógica de scripts/analysis/split2-improve.cjs (fairFormulaForGame).
// Schema da bet: mesmo padrão de .claude/scripts/insert-missed-bets.cjs (bookmaker
// SIMULATED, stake 1000, odd 1.83, status green se kills<fair senão red).
//
// Dedup: pula se já existir QUALQUER bet (não só SIMULATED) apontando pro mesmo
// lolesports_game_id — re-checado ao vivo no Supabase (não confia só no
// snapshot da auditoria de ontem).
//
// Uso:
//   node fix-D-insert-missing.cjs            → dry-run
//   node fix-D-insert-missing.cjs --execute  → aplica INSERT

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');
const { normTeamName } = require('../../../lib/normTeamName.cjs');

const EXECUTE = process.argv.includes('--execute');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const UNIVERSE_FILE = path.join(ROOT, 'audit-output', '00-universe.json');
const COVERAGE_FILE = path.join(ROOT, 'audit-output', '01-coverage.json');

const STAKE = 1000;
const ODD = 1.83;
const NOTES = 'simulated_audit_backfill_2026-07-21';

function supaRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
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

// === sync: scripts/analysis/split2-improve.cjs L277-316 — fair fórmula leave-one-out ===
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

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  const missing = coverage.missing_bets;

  console.log(`=== LOTE D — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  console.log(`missing_bets no snapshot da auditoria (2026-07-20): ${missing.length}`);

  const teamHist = buildTeamKillsHistory(universe);
  const leagueAvg = buildLeagueAvgKills(universe);
  const universeByGameId = new Map(universe.map((g) => [String(g.game_id), g]));

  // Re-checa AO VIVO se algum game_id já ganhou bet desde ontem
  console.log('Re-checando dedup ao vivo (bets existentes por lolesports_game_id)...');
  const allBets = await supaRequest(supabaseUrl, supabaseKey, 'GET', '/rest/v1/bets?select=id,raw_extraction&limit=2000');
  const existingGameIds = new Set();
  for (const b of allBets) {
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    if (gid) existingGameIds.add(String(gid));
  }

  const plan = [];
  const skipped = [];
  for (const mb of missing) {
    const gid = String(mb.game_id);
    if (existingGameIds.has(gid)) { skipped.push({ game_id: gid, reason: 'já existe bet pro game_id (re-check ao vivo)' }); continue; }

    const game = universeByGameId.get(gid);
    if (!game) { skipped.push({ game_id: gid, reason: 'game não encontrado no universo (inesperado)' }); continue; }
    if (game.total_kills == null) { skipped.push({ game_id: gid, reason: 'total_kills null no universo' }); continue; }

    const fair = fairFormulaForGame(game, teamHist, leagueAvg);
    const won = game.total_kills < fair;
    const profit = won ? +(STAKE * (ODD - 1)).toFixed(2) : -STAKE;
    const status = won ? 'green' : 'red';

    const dateOnly = (game.date || '').slice(0, 10);
    const gidOffset = (parseInt(gid.slice(-6), 10) || 0) % 3600;
    const ss = String(gidOffset % 60).padStart(2, '0');
    const mm = String(Math.floor(gidOffset / 60)).padStart(2, '0');
    const betDatetime = `${dateOnly}T12:${mm}:${ss}Z`;

    const bet = {
      bookmaker: 'SIMULATED',
      league: game.league,
      team_a: game.team_blue,
      team_b: game.team_red,
      market: 'Total Kills',
      pick: `Under ${fair}`,
      odd: ODD,
      stake: STAKE,
      bet_datetime: betDatetime,
      pandascore_match_id: Number(game.match_id) || null,
      is_map_bet: true,
      map_number: game.map_number,
      status,
      profit,
      settled_at: new Date().toISOString(),
      settle_source: `simulated_audit_backfill_2026-07-21 — fair leave-one-out ${fair}, ${game.total_kills} kills, ${game.trigger_type}`,
      fair_pinnacle: null,
      fair_formula: fair,
      fair_line_source: 'audit_backfill_formula',
      is_method_bet: true,
      raw_extraction: {
        simulated: true,
        audit_backfill: true,
        match_context: {
          teams: [{ name: game.team_blue }, { name: game.team_red }],
          fair_line: fair,
          fair_line_calculated: fair,
          fair_line_source: 'audit_backfill_formula',
          start_time: game.date,
          total_kills: game.total_kills,
          kills_blue: game.kills_blue,
          kills_red: game.kills_red,
          league_short: game.league,
          trigger_type: game.trigger_type,
          sup_blue: game.sup_blue,
          sup_red: game.sup_red,
          under_hit: won,
          simulated_odd: ODD,
          simulated_line: fair,
          simulated_rule: 'audit_backfill_2026-07-21_leave_one_out',
          lolesports_game_id: gid,
          lolesports_match_id: String(game.match_id),
        },
        missing_bet_audit: true,
      },
      notes: NOTES,
    };
    plan.push({ game_id: gid, league: game.league, teams: `${game.team_blue} vs ${game.team_red}`, map: game.map_number, fair, kills: game.total_kills, status, profit, bet });
  }

  console.log(`\nA inserir: ${plan.length} | pulados: ${skipped.length}`);
  for (const p of plan) {
    console.log(`  ${p.league} ${p.teams} map${p.map} — fair=${p.fair} kills=${p.kills} -> ${p.status} (${p.profit})`);
  }
  if (skipped.length) {
    console.log('\nPulados:');
    for (const s of skipped) console.log(`  game_id=${s.game_id}: ${s.reason}`);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum INSERT aplicado. Rode com --execute para aplicar.');
    return;
  }
  if (plan.length === 0) {
    console.log('\nNada a inserir.');
    return;
  }

  console.log('\nInserindo em chunks de 20...');
  const inserted = [];
  const CHUNK = 20;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const chunk = plan.slice(i, i + CHUNK).map((p) => p.bet);
    const res = await supaRequest(supabaseUrl, supabaseKey, 'POST', '/rest/v1/bets', chunk);
    for (const r of res) inserted.push(r.id);
    console.log(`  inserted ${inserted.length}/${plan.length}`);
  }

  console.log('\nRevalidando (re-GET dos ids inseridos)...');
  const idsParam = inserted.map((id) => `"${id}"`).join(',');
  const check = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=in.(${inserted.join(',')})&select=id,status,profit,league,team_a,team_b,map_number`);
  console.log(`  ${check.length}/${inserted.length} confirmadas via re-GET`);
  console.log(`  ids: ${inserted.join(', ')}`);
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
