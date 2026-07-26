// scripts/audit/split3-fetch.cjs — AUDITORIA 2026-07-26 (100% READ-ONLY)
// Puxa TODAS as bets com bet_datetime >= 2026-07-21 (split 3) + bets com bet_datetime null
// e salva snapshot em audit-output/30-split3-bets.json pra análise offline.
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require(path.resolve(__dirname, '..', '..', '.claude', 'scripts', '_load-config.cjs'));
const { supabaseGet } = require(path.resolve(__dirname, '..', '..', 'lib', 'supabaseQuery.cjs'));

const OUT = path.resolve(__dirname, '..', '..', 'audit-output', '30-split3-bets.json');

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const page = await supabaseGet(
      supabaseUrl, supabaseKey,
      '/rest/v1/bets?select=*&order=created_at.asc',
      { Range: `${offset}-${offset + PAGE - 1}` }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  const split3 = all.filter(b => {
    if (!b.bet_datetime) return true; // finding em potencial
    return b.bet_datetime.slice(0, 10) >= '2026-07-21';
  });

  const summary = {
    fetched_at: new Date().toISOString(),
    total_bets_banco: all.length,
    split3_count: split3.filter(b => b.bet_datetime).length,
    null_bet_datetime_count: all.filter(b => !b.bet_datetime).length,
    by_status: {},
    by_day: {},
  };
  for (const b of split3) {
    summary.by_status[b.status] = (summary.by_status[b.status] || 0) + 1;
    const d = b.bet_datetime ? b.bet_datetime.slice(0, 10) : 'NULL';
    summary.by_day[d] = (summary.by_day[d] || 0) + 1;
  }

  fs.writeFileSync(OUT, JSON.stringify({ summary, bets: split3 }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('OK →', OUT);
})().catch(e => { console.error(e.message); process.exit(1); });
