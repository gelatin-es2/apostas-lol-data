// scripts/audit/fixes/00-backup.cjs
//
// Backup GERAL obrigatório antes de qualquer write dos lotes de fix da auditoria
// 2026-07-20. Exporta TODAS as rows de `bets` e `method_reports` (sem filtro de
// data/escopo) para cron-data/2026-07-21-backup-pre-audit-fixes.json.
//
// Uso: node scripts/audit/fixes/00-backup.cjs

'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../../.claude/scripts/_load-config.cjs');
const { supabaseGet } = require('../../../lib/supabaseQuery.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_FILE = path.join(ROOT, 'cron-data', '2026-07-21-backup-pre-audit-fixes.json');
const PAGE_SIZE = 1000;

async function fetchAll(supabaseUrl, supabaseKey, table, orderCol) {
  const rows = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const page = await supabaseGet(
      supabaseUrl, supabaseKey,
      `/rest/v1/${table}?select=*&order=${orderCol}.asc`,
      { Range: `${offset}-${end}`, Prefer: 'count=exact' }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  console.error('[1/2] Buscando todas as bets...');
  const bets = await fetchAll(supabaseUrl, supabaseKey, 'bets', 'created_at');
  console.error(`  ${bets.length} bets`);

  console.error('[2/2] Buscando todas as method_reports...');
  const methodReports = await fetchAll(supabaseUrl, supabaseKey, 'method_reports', 'match_date');
  console.error(`  ${methodReports.length} method_reports`);

  const output = {
    generated_at: new Date().toISOString(),
    purpose: 'Backup pre-audit-fixes 2026-07-21 (auditoria split2 2026-07-20)',
    bets_count: bets.length,
    method_reports_count: methodReports.length,
    bets,
    method_reports: methodReports,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  console.log(JSON.stringify({ bets_count: bets.length, method_reports_count: methodReports.length, out_file: OUT_FILE }, null, 2));
})().catch((e) => {
  console.error('ERRO FATAL:', e.stack || e.message);
  process.exit(1);
});
