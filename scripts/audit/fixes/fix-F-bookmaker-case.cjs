// scripts/audit/fixes/fix-F-bookmaker-case.cjs
//
// Lote F da auditoria 2026-07-20: normaliza SÓ os 3 rows de bookmaker case-mismatch
// documentados no relatório §7 (EstrelaBet->estrelabet x1, Pinnacle->pinnacle x2).
//
// NÃO usa .claude/scripts/normalize-bookmakers.cjs --execute — esse script generico
// normaliza QUALQUER bookmaker fora do case canônico, e seu VALID_BOOKMAKERS é todo
// lowercase incluindo 'simulated'. Rodar --execute reescreveria os 426 bets
// bookmaker='SIMULATED' (maiúsculo por design, usado em comparação case-sensitive
// por dezenas de scripts: dedup, analiseStats, split2-improve, insert-missed-bets
// etc.) para 'simulated', quebrando o pipeline inteiro. Achado FORA do escopo da
// auditoria original (que só contava 3 rows) — reportado, não corrigido aqui.
//
// Uso:
//   node fix-F-bookmaker-case.cjs            → dry-run
//   node fix-F-bookmaker-case.cjs --execute  → aplica PATCH nos 3 rows

'use strict';
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');

const EXECUTE = process.argv.includes('--execute');

const FIXES = [
  { id: 'f2cffe96-35c8-4b42-96d9-568c6cded36f', from: 'EstrelaBet', to: 'estrelabet' },
  { id: '0c7c3988-d540-4c31-8874-dd6df333c464', from: 'Pinnacle', to: 'pinnacle' },
  { id: 'd1a95598-1800-454b-9c8e-223be8883834', from: 'Pinnacle', to: 'pinnacle' },
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

  console.log(`=== LOTE F — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  for (const f of FIXES) console.log(`  ${f.id}: bookmaker "${f.from}" -> "${f.to}"`);
  console.log(`\nTotal: ${FIXES.length} rows (SIMULATED intocado — ver comentário no topo do script)`);

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum PATCH aplicado. Rode com --execute para aplicar.');
    return;
  }

  console.log('\nAplicando PATCHes...');
  for (const f of FIXES) {
    await supaRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${f.id}`, { bookmaker: f.to });
    console.log(`  PATCH OK: ${f.id}`);
  }

  console.log('\nRevalidando...');
  for (const f of FIXES) {
    const rows = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=eq.${f.id}&select=id,bookmaker`);
    console.log(`  ${f.id}: bookmaker=${rows[0].bookmaker}`);
  }

  // Confirma que SIMULATED continua intocado
  const sim = await supaRequest(supabaseUrl, supabaseKey, 'GET', '/rest/v1/bets?bookmaker=eq.SIMULATED&select=id&limit=1000');
  console.log(`\nConfirmação: bookmaker=SIMULATED (maiúsculo) ainda tem ${sim.length} rows intactas.`);
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
