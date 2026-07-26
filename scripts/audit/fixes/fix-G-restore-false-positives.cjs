// scripts/audit/fixes/fix-G-restore-false-positives.cjs
//
// CORREÇÃO DE ERRO — Lote G (dedup) deletou 3 bets que NÃO eram duplicatas de
// verdade: dedup-bets-audit.cjs/dedup-bets-execute.cjs usam chave
// (pick+bookmaker+stake+bet_datetime), sem game_id/teams. 3 bets SIMULATED antigas
// (inseridas antes do esquema de offset anti-colisão) tinham bet_datetime flat
// "YYYY-MM-DDT12:00:00Z" (sem minuto/segundo variável por jogo) — 2 jogos
// DIFERENTES no mesmo dia com a mesma fair line colidem na mesma chave.
// Verificado manualmente via cron-data/2026-07-21-backup-pre-audit-fixes.json:
// dos 7 grupos, 4 tinham o MESMO game_id nos 2 itens (dup real, delete correto),
// 3 tinham game_id DIFERENTE (delete errado, restaurar):
//   - 379e7fa2-d076-4eab-a96e-57d83dbf3fd4 (LCK Dplus vs T1, game 115548128962840649)
//   - 83f3e13c-1069-4b17-822c-24317b0ba65d (LPL IG vs Weibo, game 115615926685695525)
//   - 7f011bec-b506-4182-96bb-07c359f29c8d (LES Barça vs UCAM, game 116295697481054868)
//
// Restaura os 3 rows EXATOS (mesmo id, mesmos campos) do backup pré-fix.
//
// Uso:
//   node fix-G-restore-false-positives.cjs            → dry-run
//   node fix-G-restore-false-positives.cjs --execute  → aplica INSERT

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');

const EXECUTE = process.argv.includes('--execute');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKUP_FILE = path.join(ROOT, 'cron-data', '2026-07-21-backup-pre-audit-fixes.json');

const RESTORE_IDS = [
  '379e7fa2-d076-4eab-a96e-57d83dbf3fd4',
  '83f3e13c-1069-4b17-822c-24317b0ba65d',
  '7f011bec-b506-4182-96bb-07c359f29c8d',
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
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  const rows = RESTORE_IDS.map((id) => {
    const row = backup.bets.find((b) => b.id === id);
    if (!row) throw new Error(`id ${id} não encontrado no backup`);
    return row;
  });

  console.log(`=== RESTORE (correção de erro no Lote G) — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===\n`);
  for (const r of rows) {
    console.log(`  ${r.id}: ${r.league} ${r.team_a} vs ${r.team_b} map${r.map_number} — bookmaker=${r.bookmaker} pick=${r.pick} game_id=${r.raw_extraction?.match_context?.lolesports_game_id}`);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN — nenhum INSERT aplicado. Rode com --execute para restaurar.');
    return;
  }

  console.log('\nRestaurando (INSERT com id original)...');
  const res = await supaRequest(supabaseUrl, supabaseKey, 'POST', '/rest/v1/bets', rows);
  console.log(`  ${res.length} rows restauradas`);

  console.log('\nRevalidando...');
  const check = await supaRequest(supabaseUrl, supabaseKey, 'GET', `/rest/v1/bets?id=in.(${RESTORE_IDS.join(',')})&select=id,league,team_a,team_b,status,profit`);
  for (const c of check) console.log(`  ${c.id}: ${c.league} ${c.team_a} vs ${c.team_b} status=${c.status} profit=${c.profit}`);
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
