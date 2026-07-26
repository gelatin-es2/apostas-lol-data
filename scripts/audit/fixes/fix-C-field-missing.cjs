// scripts/audit/fixes/fix-C-field-missing.cjs
//
// Lote C da auditoria 2026-07-20: backfill match_context.lolesports_game_id em 4
// bets settled (FIELD_MISSING). Fontes:
//   - 2e8053b9: já tinha alt key match_context.map3_game_id (settle manual) — mesmo
//     valor achado pelo matching da auditoria via universo (00-universe.json).
//   - a3f39f6e: já tinha alt key match_context.game_id_map2 — idem.
//   - b0481dab: resolvido via lolesports_match_id + map_number=2 no universo.
//   - 6ae02cd7 (EMEA Masters, fora do universo/6-ligas): resolvido direto via
//     esports-api getEventDetails(match_id) — API confirma games[].id do map 1.
//
// Uso:
//   node fix-C-field-missing.cjs            → dry-run
//   node fix-C-field-missing.cjs --execute  → aplica PATCH

'use strict';
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');

const EXECUTE = process.argv.includes('--execute');

const FIXES = [
  { id: '2e8053b9-8c21-48fa-a02d-ab1b307a720a', gameId: '115615926685761106', source: 'universe match_id_alt (map3_game_id existente)' },
  { id: 'a3f39f6e-4ef8-4c49-9e11-049bce030750', gameId: '116316789792721712', source: 'universe match_id_alt (game_id_map2 existente)' },
  { id: 'b0481dab-6fb4-46e6-a4b3-33619f1f4ccd', gameId: '115564793879469308', source: 'universe match_id + map_number=2' },
  { id: '6ae02cd7-b5e8-442c-acac-c674ba014550', gameId: '116634566264113559', source: 'getEventDetails(match_id=116634566264113558).games[map1].id (EMEA Masters fora do universo 6-ligas)' },
];

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

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  const plan = [];
  for (const fix of FIXES) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${fix.id}&select=id,raw_extraction`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    if (!bet) { console.error(`FATAL: bet ${fix.id} não encontrada`); process.exit(1); }
    const raw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
    const mc = raw.match_context || {};
    const before = mc.lolesports_game_id ?? null;
    mc.lolesports_game_id = fix.gameId;
    raw.match_context = mc;
    plan.push({ id: fix.id, before, after: fix.gameId, source: fix.source, patch: { raw_extraction: raw } });
  }

  console.log(`=== LOTE C — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  for (const p of plan) {
    console.log(`bet ${p.id}`);
    console.log(`  match_context.lolesports_game_id: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`);
    console.log(`  fonte: ${p.source}`);
  }
  console.log(`\nTotal: ${plan.length} rows`);

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum PATCH aplicado. Rode com --execute para aplicar.');
    return;
  }

  console.log('\nAplicando PATCHes...');
  for (const p of plan) {
    await supaRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${p.id}`, p.patch);
    console.log(`  PATCH OK: ${p.id}`);
  }

  console.log('\nRevalidando...');
  for (const p of plan) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${p.id}&select=id,raw_extraction`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    console.log(`  ${p.id}: lolesports_game_id=${bet.raw_extraction?.match_context?.lolesports_game_id}`);
  }
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
