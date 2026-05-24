// Migração 2026-05-24: Re-canonicalização de 27 times para nome curto
// Aprovado pelo operador (Elvis). Backups individuais em cron-data/.
// Atualiza team_a, team_b e raw_extraction.match_context.team_a/b.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../..');
const { loadConfig } = require(path.join(ROOT, '.claude/scripts/_load-config.cjs'));

const MIGRATIONS = [
  ['Natus Vincere',           'NAVI'],
  ['Team Vitality',           'Vitality'],
  ['WeiboGaming',             'Weibo'],
  ['Team Liquid Alienware',   'TL'],
  ['Hanwha Life Esports',     'Hanwha'],
  ['Gen.G Esports',           'Gen.G'],
  ['EDWARD GAMING',           'EDG'],
  ['Suzhou LNG Esports',      'LNG'],
  ['BNK FEARX',               'FEARX'],
  ['TOP ESPORTS',             'TES'],
  ['BILIBILI GAMING',         'BLG'],
  ['Beijing JDG Esports',     'JDG'],
  ["Xi'an Team WE",           'WE'],
  ['Shenzhen NINJAS IN PYJAMAS', 'NIP'],
  ['NONGSHIM RED FORCE',      'Nongshim'],
  ['kt Rolster',              'KT'],
  ['Dplus KIA',               'Dplus'],
  ['HANJIN BRION',            'BRO'],
  ['KIWOOM DRX',              'KIWOOM'],
  ['Invictus Gaming',         'IG'],
  ["Anyone's Legend",         'AL'],
  ['Ultra Prime',             'UP'],
  ['Vivo Keyd Stars',         'VKS'],
  ['Movistar KOI',            'KOI'],
  ['Movistar KOI Fénix',      'KOI Fénix'],
  ['Karmine Corp',            'Karmine'],
  ['Cloud9 Kia',              'C9'],
];

const cfg = loadConfig();
const { supabaseUrl, supabaseKey } = cfg;

function supabaseRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + endpoint);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      host: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => {
        try {
          const parsed = b ? JSON.parse(b) : null;
          if (r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}: ${b}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Busca todas as rows de um time (team_a ou team_b)
async function fetchRowsForTeam(name) {
  const enc = encodeURIComponent(name);
  const [a, b] = await Promise.all([
    supabaseRequest('GET', `/rest/v1/bets?team_a=eq.${enc}&select=id,team_a,team_b,raw_extraction&limit=2000`),
    supabaseRequest('GET', `/rest/v1/bets?team_b=eq.${enc}&select=id,team_a,team_b,raw_extraction&limit=2000`),
  ]);
  const all = [...(a || []), ...(b || [])];
  // Dedup por id
  const seen = new Set();
  return all.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}

// Atualiza raw_extraction.match_context.team_a/b se bater com oldName → newName
function patchRawExtraction(raw, oldName, newName) {
  if (!raw?.match_context) return raw;
  const mc = raw.match_context;
  let changed = false;
  if (mc.team_a === oldName) { mc.team_a = newName; changed = true; }
  if (mc.team_b === oldName) { mc.team_b = newName; changed = true; }
  return changed ? raw : null;
}

async function main() {
  const outDir = path.join(ROOT, 'cron-data');
  const results = [];

  for (const [oldName, newName] of MIGRATIONS) {
    console.log(`\n[${oldName}] → [${newName}]`);
    const rows = await fetchRowsForTeam(oldName);
    console.log(`  rows found: ${rows.length}`);

    // Backup individual
    const slug = oldName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    const backupFile = path.join(outDir, `2026-05-24-backup-shortname-${slug}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ old: oldName, new: newName, rows }, null, 2));

    if (rows.length === 0) {
      console.log(`  SKIP: nenhuma row encontrada`);
      results.push({ old: oldName, new: newName, rows: 0, backup: backupFile });
      continue;
    }

    // UPDATE team_a
    const teamARows = rows.filter(r => r.team_a === oldName);
    const teamBRows = rows.filter(r => r.team_b === oldName);

    if (teamARows.length > 0) {
      await supabaseRequest('PATCH',
        `/rest/v1/bets?team_a=eq.${encodeURIComponent(oldName)}`,
        { team_a: newName }
      );
      console.log(`  team_a updated: ${teamARows.length} rows`);
    }
    if (teamBRows.length > 0) {
      await supabaseRequest('PATCH',
        `/rest/v1/bets?team_b=eq.${encodeURIComponent(oldName)}`,
        { team_b: newName }
      );
      console.log(`  team_b updated: ${teamBRows.length} rows`);
    }

    // UPDATE raw_extraction.match_context.team_a/b onde bater
    let rawUpdated = 0;
    for (const row of rows) {
      const patched = patchRawExtraction(row.raw_extraction, oldName, newName);
      if (!patched) continue;
      await supabaseRequest('PATCH',
        `/rest/v1/bets?id=eq.${row.id}`,
        { raw_extraction: patched }
      );
      rawUpdated++;
    }
    console.log(`  raw_extraction patched: ${rawUpdated} rows`);

    results.push({ old: oldName, new: newName, rows: rows.length, team_a: teamARows.length, team_b: teamBRows.length, raw_patched: rawUpdated, backup: backupFile });
  }

  // Relatório final
  const reportFile = path.join(outDir, '2026-05-24-migration-report.json');
  fs.writeFileSync(reportFile, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  console.log('\n\n=== RELATÓRIO FINAL ===');
  for (const r of results) {
    console.log(`${r.old.padEnd(30)} → ${r.new.padEnd(12)} rows=${r.rows} team_a=${r.team_a||0} team_b=${r.team_b||0} raw=${r.raw_patched||0}`);
  }
  console.log(`\nReport: ${reportFile}`);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
