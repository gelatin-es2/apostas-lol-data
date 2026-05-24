// migrate-team-names-2026-05-24.cjs
// Migração de siglas/aliases → nomes canônicos no banco Supabase.
// Executa: backup individual por par → UPDATE team_a/team_b → pós-validação.
// Uso: node migrate-team-names-2026-05-24.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const { supabaseUrl, supabaseKey } = loadConfig();
const CRON_DATA = path.resolve(__dirname, '../../cron-data');

// ─── Pares a migrar ────────────────────────────────────────────────────────────
// formato: { alias, canonical, liga }
// aliases da tabela aprovada + extras encontrados no snapshot
const MIGRATION_PAIRS = [
  // Aprovados no plano
  { alias: 'AL',           canonical: "Anyone's Legend",           liga: 'LPL'   },
  { alias: 'UP',           canonical: 'Ultra Prime',                liga: 'LPL'   },
  { alias: 'DNS',          canonical: 'DN SOOPers',                 liga: 'LCK'   },
  { alias: 'KRX',          canonical: 'KIWOOM DRX',                 liga: 'LCK'   },
  { alias: 'BRO',          canonical: 'HANJIN BRION',               liga: 'LCK'   },
  { alias: 'GEN',          canonical: 'Gen.G Esports',              liga: 'LCK'   },
  { alias: 'VKS',          canonical: 'Vivo Keyd Stars',            liga: 'CBLOL' },
  { alias: 'LOS',          canonical: 'Los Grandes',                liga: 'CBLOL' },
  { alias: 'FX',           canonical: 'Fluxo',                      liga: 'CBLOL' },
  { alias: 'ES',           canonical: 'Esprit Shonen',              liga: 'LFL'   },
  { alias: 'GL',           canonical: 'Galions',                    liga: 'LFL'   },
  { alias: 'GX',           canonical: 'GIANTX',                     liga: 'LEC'   },
  { alias: 'LEVIATÁN',     canonical: 'Leviatan Esports',           liga: 'CBLOL' },
  { alias: 'EDG',          canonical: 'EDWARD GAMING',              liga: 'LPL'   },
  { alias: 'WBG',          canonical: 'WeiboGaming',                liga: 'LPL'   },
  { alias: 'NIP',          canonical: 'Shenzhen NINJAS IN PYJAMAS', liga: 'LPL'   },
  { alias: 'FUR',          canonical: 'FURIA',                      liga: 'CBLOL' },
  { alias: 'RED',          canonical: 'RED Canids Kalunga',         liga: 'CBLOL' },
  { alias: 'RED Canids',   canonical: 'RED Canids Kalunga',         liga: 'CBLOL' },
  { alias: 'VITB',         canonical: 'Vitality.Bee',               liga: 'LFL'   },
  { alias: 'TLNP',         canonical: 'TLN Pirates',                liga: 'LFL'   },
  { alias: 'SLY',          canonical: 'Solary',                     liga: 'LFL'   },
  { alias: 'KCB',          canonical: 'Karmine Corp Blue',          liga: 'LFL'   },
  // Extras encontrados no snapshot (não na tabela original mas são aliases claros)
  { alias: 'WE',           canonical: "Xi'an Team WE",             liga: 'LPL'   },
  { alias: 'Team WE',      canonical: "Xi'an Team WE",             liga: 'LPL'   },
  { alias: 'LNG',          canonical: 'Suzhou LNG Esports',         liga: 'LPL'   },
  { alias: 'G2',           canonical: 'G2 Esports',                 liga: 'LEC'   },
  { alias: 'KC',           canonical: 'Karmine Corp',               liga: 'LEC'   },
  { alias: 'FLY',          canonical: 'FlyQuest',                   liga: 'LCS'   },
  { alias: 'C9',           canonical: 'Cloud9 Kia',                 liga: 'LCS'   },
  { alias: 'NAVI',         canonical: 'Natus Vincere',              liga: 'LEC'   },
  { alias: 'MKOI',         canonical: 'Movistar KOI',               liga: 'LEC'   },
  { alias: 'KOI',          canonical: 'Movistar KOI',               liga: 'LEC'   },
  { alias: 'OMG',          canonical: 'Oh My God',                  liga: 'LPL'   },
  { alias: 'SEN',          canonical: 'Sentinels',                  liga: 'LCS'   },
  { alias: 'DIG',          canonical: 'Dignitas',                   liga: 'LCS'   },
  { alias: 'IG',           canonical: 'Invictus Gaming',            liga: 'LPL'   },
  { alias: 'GALIONS',      canonical: 'Galions',                    liga: 'LFL'   },
  { alias: 'ThunderTalk Gaming', canonical: 'THUNDER TALK GAMING',  liga: 'LPL'   },
  { alias: 'LGD',          canonical: 'LGD GAMING',                 liga: 'LPL'   },
  { alias: 'LGD Gaming',   canonical: 'LGD GAMING',                 liga: 'LPL'   },
  { alias: 'FALKE',        canonical: 'FALKE ESPORTS',              liga: 'LFL'   },
  { alias: 'Los Grandes',  canonical: 'Los Grandes',                liga: 'CBLOL' }, // já canônico, mas inclui pra backup
];

// ─── HTTP helpers ──────────────────────────────────────────────────────────────
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
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    }, res => {
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

function getRows(filter) {
  return httpReq('GET', `/rest/v1/bets?${filter}&limit=10000`, null);
}

function patchRows(filter, body) {
  return httpReq('PATCH', `/rest/v1/bets?${filter}`, body);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const log = [];

  // ── Etapa 1: Snapshot pré ─────────────────────────────────────────────────
  console.log('\n[1/4] Snapshot pré-migração...');
  const allRows = await getRows('select=id,team_a,team_b');
  const counts = {};
  for (const r of allRows) {
    if (r.team_a) counts[r.team_a] = (counts[r.team_a] || 0) + 1;
    if (r.team_b) counts[r.team_b] = (counts[r.team_b] || 0) + 1;
  }
  const snapshotPath = path.join(CRON_DATA, '2026-05-24-snapshot-teams-pre-migration.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(
    { generated_at: new Date().toISOString(), total_distinct: Object.keys(counts).length,
      teams: Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([name, count]) => ({ name, count })) },
    null, 2
  ));
  console.log(`  Snapshot salvo: ${snapshotPath}`);
  console.log(`  Total distinct team_names: ${Object.keys(counts).length}`);

  // ── Etapa 2 + 3: Backup e migrate por par ─────────────────────────────────
  console.log('\n[2/4] Backup + migrate por par...');
  const results = [];

  for (const pair of MIGRATION_PAIRS) {
    const { alias, canonical } = pair;

    // Pula se alias === canonical (já canônico, não precisa migrar)
    if (alias === canonical) {
      console.log(`  SKIP (já canônico): ${alias}`);
      results.push({ alias, canonical, team_a_migrated: 0, team_b_migrated: 0, skip: true });
      continue;
    }

    // Busca rows onde team_a = alias
    const rowsA = await getRows(`select=id,team_a,team_b,raw_extraction&team_a=eq.${encodeURIComponent(alias)}`);
    // Busca rows onde team_b = alias
    const rowsB = await getRows(`select=id,team_a,team_b,raw_extraction&team_b=eq.${encodeURIComponent(alias)}`);

    const totalRows = rowsA.length + rowsB.length;

    if (totalRows === 0) {
      console.log(`  SKIP (0 rows): ${alias} → ${canonical}`);
      results.push({ alias, canonical, team_a_migrated: 0, team_b_migrated: 0, skip: true });
      continue;
    }

    // Backup
    const backupSlug = alias.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const backupPath = path.join(CRON_DATA, `2026-05-24-backup-alias-${backupSlug}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(
      { alias, canonical, backed_up_at: new Date().toISOString(), rows_team_a: rowsA, rows_team_b: rowsB },
      null, 2
    ));
    console.log(`  BACKUP ${alias}: ${rowsA.length}×team_a + ${rowsB.length}×team_b → ${backupPath}`);

    // UPDATE team_a
    let migratedA = 0;
    if (rowsA.length > 0) {
      const updated = await patchRows(
        `team_a=eq.${encodeURIComponent(alias)}`,
        { team_a: canonical }
      );
      migratedA = Array.isArray(updated) ? updated.length : rowsA.length;
      console.log(`  UPDATE team_a: ${alias} → ${canonical} (${migratedA} rows)`);
    }

    // UPDATE team_b
    let migratedB = 0;
    if (rowsB.length > 0) {
      const updated = await patchRows(
        `team_b=eq.${encodeURIComponent(alias)}`,
        { team_b: canonical }
      );
      migratedB = Array.isArray(updated) ? updated.length : rowsB.length;
      console.log(`  UPDATE team_b: ${alias} → ${canonical} (${migratedB} rows)`);
    }

    // UPDATE raw_extraction.match_context.team_a/team_b (se presente)
    // Supabase REST não suporta update de JSONB parcial via REST diretamente para campos nested,
    // então atualiza manualmente via patch row-by-row para rows que têm match_context com o alias
    let rawUpdated = 0;
    const allAliasRows = [...rowsA, ...rowsB];
    for (const row of allAliasRows) {
      if (!row.raw_extraction?.match_context) continue;
      const mc = row.raw_extraction.match_context;
      let changed = false;
      if (mc.team_a === alias) { mc.team_a = canonical; changed = true; }
      if (mc.team_b === alias) { mc.team_b = canonical; changed = true; }
      if (changed) {
        await patchRows(`id=eq.${row.id}`, { raw_extraction: row.raw_extraction });
        rawUpdated++;
      }
    }
    if (rawUpdated > 0) console.log(`  UPDATE raw_extraction.match_context: ${rawUpdated} rows`);

    results.push({ alias, canonical, team_a_migrated: migratedA, team_b_migrated: migratedB, raw_updated: rawUpdated, backup_path: backupPath });
    log.push(`${alias} → ${canonical}: ${migratedA}×team_a + ${migratedB}×team_b + ${rawUpdated}×raw`);
  }

  // ── Etapa 4: Pós-validação ─────────────────────────────────────────────────
  console.log('\n[3/4] Pós-validação...');
  const aliasesToCheck = MIGRATION_PAIRS
    .filter(p => p.alias !== p.canonical)
    .map(p => p.alias);

  const remaining = {};
  for (const alias of aliasesToCheck) {
    const rowsA = await getRows(`select=id&team_a=eq.${encodeURIComponent(alias)}&limit=5`);
    const rowsB = await getRows(`select=id&team_b=eq.${encodeURIComponent(alias)}&limit=5`);
    const total = rowsA.length + rowsB.length;
    if (total > 0) remaining[alias] = total;
  }

  if (Object.keys(remaining).length === 0) {
    console.log('  ✓ Todos os aliases foram migrados — 0 rows remanescentes');
  } else {
    console.log('  ATENÇÃO: aliases ainda presentes no banco:');
    Object.entries(remaining).forEach(([k,v]) => console.log(`    ${k}: ${v} rows`));
  }

  // Salva log de resultado
  const logPath = path.join(CRON_DATA, '2026-05-24-migration-results.json');
  fs.writeFileSync(logPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    results,
    remaining_after_migration: remaining,
    log,
  }, null, 2));

  console.log(`\n[4/4] Resultados salvos: ${logPath}`);
  console.log('\nSUMÁRIO:');
  log.forEach(l => console.log(' ', l));
  if (Object.keys(remaining).length > 0) {
    console.log('\nALIASES REMANESCENTES (requerem atenção):');
    Object.entries(remaining).forEach(([k,v]) => console.log(` ${k}: ${v}`));
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
