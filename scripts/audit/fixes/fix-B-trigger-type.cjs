// scripts/audit/fixes/fix-B-trigger-type.cjs
//
// Lote B da auditoria 2026-07-20: corrige match_context.trigger_type de 3 bets
// (TRIGGER_MISMATCH) + trigger_type de 6 rows method_reports (MR_TRIGGER_MISMATCH,
// casos Alistar — código arquivado ainda tratava Alistar como FLEX_ENGAGE).
//
// Uso:
//   node fix-B-trigger-type.cjs            → dry-run
//   node fix-B-trigger-type.cjs --execute  → aplica PATCH

'use strict';
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');

const EXECUTE = process.argv.includes('--execute');

const BET_FIXES = [
  { id: '6740f14f-ebde-4646-ac94-a02831e0af0c', expected: null },
  { id: 'c4eda66d-61bc-4249-93bd-c92f4074dbc8', expected: null },
  { id: 'b0481dab-6fb4-46e6-a4b3-33619f1f4ccd', expected: '2peel' },
];

const MR_FIXES = [
  '10aac6be-14f8-4ab3-8dd0-48317614ca32',
  '3bd3cb34-27ea-4c3d-a575-4b2deaff13f0',
  '464b64fe-ff6a-4b1b-9baf-3e315c0f6713',
  '1b11e706-8542-46ba-a7aa-c14c5d3b449b',
  'ca792f93-c2ee-44a1-97cc-28fa96920282',
  '7fd1506b-3cb0-494f-b410-b74f047e287f',
].map((id) => ({ id, expected: null }));

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

  console.log(`=== LOTE B — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);

  // --- bets ---
  const betPlan = [];
  for (const fix of BET_FIXES) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${fix.id}&select=id,raw_extraction`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    if (!bet) { console.error(`FATAL: bet ${fix.id} não encontrada`); process.exit(1); }
    const raw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
    const mc = raw.match_context || {};
    const before = mc.trigger_type ?? null;
    mc.trigger_type = fix.expected;
    raw.match_context = mc;
    betPlan.push({ id: fix.id, before, after: fix.expected, patch: { raw_extraction: raw } });
  }

  console.log('bets (match_context.trigger_type):');
  for (const p of betPlan) console.log(`  ${p.id}: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`);

  // --- method_reports ---
  console.log('\nmethod_reports (trigger_type):');
  const mrPlan = [];
  for (const fix of MR_FIXES) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/method_reports?id=eq.${fix.id}&select=id,trigger_type`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) { console.error(`FATAL: method_report ${fix.id} não encontrada`); process.exit(1); }
    const before = row.trigger_type ?? null;
    mrPlan.push({ id: fix.id, before, after: fix.expected, patch: { trigger_type: fix.expected } });
    console.log(`  ${fix.id}: ${JSON.stringify(before)} -> ${JSON.stringify(fix.expected)}`);
  }

  console.log(`\nTotal: ${betPlan.length} bets + ${mrPlan.length} method_reports = ${betPlan.length + mrPlan.length} rows`);

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum PATCH aplicado. Rode com --execute para aplicar.');
    return;
  }

  console.log('\nAplicando PATCHes (bets)...');
  for (const p of betPlan) {
    await supaRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${p.id}`, p.patch);
    console.log(`  PATCH OK: ${p.id}`);
  }
  console.log('Aplicando PATCHes (method_reports)...');
  for (const p of mrPlan) {
    await supaRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/method_reports?id=eq.${p.id}`, p.patch);
    console.log(`  PATCH OK: ${p.id}`);
  }

  console.log('\nRevalidando...');
  for (const p of betPlan) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${p.id}&select=id,raw_extraction`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    console.log(`  bet ${p.id}: trigger_type=${JSON.stringify(bet.raw_extraction?.match_context?.trigger_type ?? null)}`);
  }
  for (const p of mrPlan) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/method_reports?id=eq.${p.id}&select=id,trigger_type`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    console.log(`  method_report ${p.id}: trigger_type=${JSON.stringify(row.trigger_type ?? null)}`);
  }
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
