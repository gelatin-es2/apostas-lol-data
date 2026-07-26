// scripts/audit/fixes/fix-A-kills-status-profit.cjs
//
// Lote A da auditoria 2026-07-20: corrige kills/status/profit da bet real
// 61507820 e da SIMULATED 2432691d (mesmo jogo, LPL LNG vs LGD GAMING map2,
// game_id 115615926685761093) — API+gol.gg confirmam 32 kills (blue 21/red 11),
// pick "Under 25.5"/"Under 23.5" perde, bet devia ser red não green.
//
// Os 2 PROFIT_MISMATCH de centavos (0f79cb9e, b0481dab) NÃO são tocados aqui —
// documentados como no_change_needed (payout real da casa é a verdade).
//
// Uso:
//   node fix-A-kills-status-profit.cjs            → dry-run (mostra antes/depois)
//   node fix-A-kills-status-profit.cjs --execute   → aplica PATCH

'use strict';
const path = require('path');
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');

const EXECUTE = process.argv.includes('--execute');

const FIXES = [
  {
    id: '61507820-8d22-41d4-9f21-aed990f9b678',
    label: 'bet real estrelabet — LPL LNG vs LGD GAMING map2',
    newStatus: 'red',
    newProfit: -1000,
  },
  {
    id: '2432691d-b598-4605-82cf-279dcef80321',
    label: 'SIMULATED — mesmo jogo',
    newStatus: 'red',
    newProfit: -1000,
  },
];

const SETTLE_SOURCE_NOTE = 'audit-fix-2026-07-21 (livestats+golgg 32 kills)';

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
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${fix.id}&select=*`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    if (!bet) { console.error(`FATAL: bet ${fix.id} não encontrada`); process.exit(1); }

    const raw = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
    const mc = raw.match_context || {};
    const before = {
      total_kills: mc.total_kills,
      kills_blue: mc.kills_blue,
      kills_red: mc.kills_red,
      status: bet.status,
      profit: bet.profit,
      settle_source: bet.settle_source,
    };
    mc.total_kills = 32;
    mc.kills_blue = 21;
    mc.kills_red = 11;
    mc.under_hit = false;
    raw.match_context = mc;

    const patch = {
      raw_extraction: raw,
      status: fix.newStatus,
      profit: fix.newProfit,
      settle_source: SETTLE_SOURCE_NOTE,
    };
    const after = {
      total_kills: mc.total_kills,
      kills_blue: mc.kills_blue,
      kills_red: mc.kills_red,
      status: fix.newStatus,
      profit: fix.newProfit,
      settle_source: SETTLE_SOURCE_NOTE,
    };

    plan.push({ id: fix.id, label: fix.label, before, after, patch });
  }

  console.log(`=== LOTE A — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  for (const p of plan) {
    console.log(`bet ${p.id} (${p.label})`);
    console.log(`  before: ${JSON.stringify(p.before)}`);
    console.log(`  after:  ${JSON.stringify(p.after)}`);
    console.log('');
  }
  console.log(`no_change_needed (fora deste lote, documentado):`);
  console.log(`  0f79cb9e-01a5-4b91-b2f6-0945090be420 — profit 181.30 (payout real da casa, não a fórmula 181.43)`);
  console.log(`  b0481dab-6fb4-46e6-a4b3-33619f1f4ccd — profit 2599.99 (payout real da casa, não a fórmula 2600.01)`);

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
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${p.id}&select=id,status,profit,settle_source,raw_extraction`);
    const bet = Array.isArray(rows) ? rows[0] : rows;
    const mc = bet.raw_extraction?.match_context || {};
    console.log(`  ${p.id}: status=${bet.status} profit=${bet.profit} kills=${mc.total_kills} (${mc.kills_blue}/${mc.kills_red}) settle_source=${bet.settle_source}`);
  }
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
