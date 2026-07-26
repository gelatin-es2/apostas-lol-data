// migrate-orphan-splits-2026-06-28.cjs
// Funde nomes órfãos (códigos curtos não cobertos pelo alias map) no canônico
// majoritário que já existe no banco. Mesma classe de bug do TLAW/TL.
//
// Dry-run por padrão. Use --apply para escrever no banco.
//   node .claude/scripts/migrate-orphan-splits-2026-06-28.cjs            # mostra o que mudaria
//   node .claude/scripts/migrate-orphan-splits-2026-06-28.cjs --apply    # executa

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const { supabaseUrl, supabaseKey } = loadConfig();
const CRON_DATA = path.resolve(__dirname, '../../cron-data');
const APPLY = process.argv.includes('--apply');

// órfão (minoritário) → canônico majoritário já existente
const PAIRS = [
  { alias: 'TLAW',        canonical: 'TL',                  liga: 'LCS'   },
  { alias: 'TT',          canonical: 'THUNDER TALK GAMING', liga: 'LPL'   },
  { alias: 'Keyd Stars',  canonical: 'VKS',                 liga: 'CBLOL' },
];

function httpReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const getRows = filter => httpReq('GET', `/rest/v1/bets?${filter}&limit=10000`, null);
const patchRows = (filter, body) => httpReq('PATCH', `/rest/v1/bets?${filter}`, body);

(async () => {
  console.log(APPLY ? '=== MODO APPLY (escreve no banco) ===' : '=== DRY-RUN (nenhuma escrita) ===');
  for (const { alias, canonical } of PAIRS) {
    const rowsA = await getRows(`select=id,team_a,team_b,status,profit,raw_extraction&team_a=eq.${encodeURIComponent(alias)}`);
    const rowsB = await getRows(`select=id,team_a,team_b,status,profit,raw_extraction&team_b=eq.${encodeURIComponent(alias)}`);
    const total = rowsA.length + rowsB.length;
    console.log(`\n[${alias} → ${canonical}]  ${rowsA.length}×team_a + ${rowsB.length}×team_b = ${total} linhas`);
    for (const r of [...rowsA, ...rowsB]) {
      console.log(`    ${r.id} | ${r.team_a} vs ${r.team_b} | ${r.status} | profit=${r.profit}`);
    }
    if (total === 0) continue;

    if (!APPLY) continue;

    // Backup antes de escrever
    const slug = alias.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const backupPath = path.join(CRON_DATA, `2026-06-28-backup-orphan-${slug}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(
      { alias, canonical, backed_up_at: new Date().toISOString(), rows_team_a: rowsA, rows_team_b: rowsB }, null, 2));
    console.log(`    BACKUP → ${backupPath}`);

    if (rowsA.length) {
      const u = await patchRows(`team_a=eq.${encodeURIComponent(alias)}`, { team_a: canonical });
      console.log(`    UPDATE team_a: ${Array.isArray(u) ? u.length : '?'} rows`);
    }
    if (rowsB.length) {
      const u = await patchRows(`team_b=eq.${encodeURIComponent(alias)}`, { team_b: canonical });
      console.log(`    UPDATE team_b: ${Array.isArray(u) ? u.length : '?'} rows`);
    }
    // raw_extraction.match_context nested
    let rawN = 0;
    for (const row of [...rowsA, ...rowsB]) {
      const mc = row.raw_extraction?.match_context;
      if (!mc) continue;
      let changed = false;
      if (mc.team_a === alias) { mc.team_a = canonical; changed = true; }
      if (mc.team_b === alias) { mc.team_b = canonical; changed = true; }
      if (changed) { await patchRows(`id=eq.${row.id}`, { raw_extraction: row.raw_extraction }); rawN++; }
    }
    if (rawN) console.log(`    UPDATE raw_extraction.match_context: ${rawN} rows`);
  }

  if (APPLY) {
    console.log('\n=== pós-migração: contagem dos órfãos (deve ser 0) ===');
    for (const { alias } of PAIRS) {
      const left = await getRows(`select=id&or=(team_a.eq.${encodeURIComponent(alias)},team_b.eq.${encodeURIComponent(alias)})`);
      console.log(`    "${alias}": ${left.length} restantes`);
    }
  } else {
    console.log('\n(dry-run — rode com --apply para executar)');
  }
})().catch(e => console.log('ERRO:', e.message));
