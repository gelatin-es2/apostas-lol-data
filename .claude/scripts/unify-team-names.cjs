// Unifica variantes de nomes de times na tabela bets.
//
// Modos:
//   node unify-team-names.cjs            → dry-run (lista mudanças, não aplica)
//   node unify-team-names.cjs --execute  → aplica UPDATEs, grava backups em cron-data/
//
// Pares: forma canônica = o que o dashboard_stats.json usa (auditado antes de rodar)
// Backup por par: cron-data/2026-05-24-backup-rename-<slug>.json

'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./_load-config.cjs');

const EXECUTE = process.argv.includes('--execute') || process.env.EXECUTE === '1';
const DRY_RUN = !EXECUTE;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CRON_DATA = path.join(REPO_ROOT, 'cron-data');

// ---------------------------------------------------------------------------
// Mapa: canonical → lista de variantes a renomear (NÃO inclui o canônico)
// Canônicos auditados contra dashboard_stats.json em 2026-05-24
// ---------------------------------------------------------------------------
const RENAME_PAIRS = [
  { slug: 'weibogaming',              canonical: 'WeiboGaming',                  variants: ['WBG', 'Weibo Gaming'] },
  { slug: 'bilibili-gaming',          canonical: 'BILIBILI GAMING',              variants: ['BLG', 'Bilibili Gaming'] },
  { slug: 'edward-gaming',            canonical: 'EDWARD GAMING',                variants: ['EDG', 'EDward Gaming'] },
  { slug: 'jdg',                      canonical: 'Beijing JDG Esports',           variants: ['JDG', 'JD Gaming', 'JD Esports', 'Beijing JDG Esports'.replace('Beijing JDG Esports','_skip_')] /* sem variante que é igual ao canônico */, },
  { slug: 'dplus-kia',                canonical: 'Dplus KIA',                    variants: ['DK'] },
  { slug: 'hanwha',                   canonical: 'Hanwha Life Esports',           variants: ['HLE'] },
  { slug: 't1',                       canonical: 'T1',                           variants: ['T1 Esports'] },
  { slug: 'kt-rolster',               canonical: 'kt Rolster',                   variants: ['KT', 'KT Rolster'] },
  { slug: 'nongshim',                 canonical: 'NONGSHIM RED FORCE',           variants: ['NS', 'Nongshim RedForce', 'NONGSHIM REDFORCE'] },
  { slug: 'bnk-fearx',                canonical: 'BNK FEARX',                    variants: ['BFX', 'BNK FearX'] },
  { slug: 'ninjas-shenzhen',          canonical: 'Shenzhen NINJAS IN PYJAMAS',   variants: ['NIP', 'Ninjas in Pyjamas'] },
  { slug: 'top-esports',              canonical: 'TOP ESPORTS',                  variants: ['TES', 'Top Esports'] },
  { slug: 'geng-esports-orphan',      canonical: 'Gen.G Esports',               variants: ['Gen.G'] },
];

// Fix: limpar _skip_ do JDG variants
for (const p of RENAME_PAIRS) {
  p.variants = p.variants.filter(v => !v.includes('_skip_'));
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
function supaRequest(supabaseUrl, supabaseKey, method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...extraHeaders,
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message} | body: ${b.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Busca todas as rows onde team_a OU team_b esteja na lista de variantes
async function fetchRowsForVariants(supabaseUrl, supabaseKey, variants) {
  const allRows = [];
  for (const v of variants) {
    const encoded = encodeURIComponent(v);
    // team_a
    let r = await supaRequest(supabaseUrl, supabaseKey, 'GET',
      `/rest/v1/bets?team_a=eq.${encoded}&select=id,team_a,team_b,raw_extraction`, {});
    if (r.body && r.body.length > 0) allRows.push(...r.body);
    // team_b
    r = await supaRequest(supabaseUrl, supabaseKey, 'GET',
      `/rest/v1/bets?team_b=eq.${encoded}&select=id,team_a,team_b,raw_extraction`, {});
    if (r.body && r.body.length > 0) allRows.push(...r.body);
  }
  // dedup by id
  const seen = new Set();
  return allRows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; });
}

// PATCH de um campo em um row
async function patchRow(supabaseUrl, supabaseKey, id, patchBody) {
  const u = new URL(supabaseUrl + `/rest/v1/bets?id=eq.${id}`);
  const data = JSON.stringify(patchBody);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`PATCH HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
        resolve(null);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Lógica principal
// ---------------------------------------------------------------------------
async function main() {
  const { supabaseUrl, supabaseKey } = loadConfig();
  console.log(`\nModo: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}\n`);

  const summary = [];

  for (const pair of RENAME_PAIRS) {
    const { slug, canonical, variants } = pair;
    if (variants.length === 0) {
      console.log(`[${slug}] sem variantes → skip`);
      continue;
    }
    console.log(`\n--- Pair: ${slug} → canonical="${canonical}" | variants: [${variants.join(', ')}] ---`);

    // 1. Fetch rows com variantes
    const rows = await fetchRowsForVariants(supabaseUrl, supabaseKey, variants);
    console.log(`  Rows encontradas: ${rows.length}`);
    if (rows.length === 0) {
      console.log(`  → nada a fazer`);
      summary.push({ slug, canonical, variants, rows_found: 0, rows_updated: 0 });
      continue;
    }

    // 2. Backup
    const backupPath = path.join(CRON_DATA, `2026-05-24-backup-rename-${slug}.json`);
    if (EXECUTE) {
      fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
      console.log(`  Backup salvo: ${backupPath}`);
    } else {
      console.log(`  [dry-run] backup seria salvo em: ${backupPath}`);
    }

    // 3. Exibe o que vai mudar
    for (const row of rows.slice(0, 5)) {
      console.log(`    row ${row.id}: team_a="${row.team_a}" team_b="${row.team_b}"`);
    }
    if (rows.length > 5) console.log(`    ... e mais ${rows.length - 5} rows`);

    if (DRY_RUN) {
      summary.push({ slug, canonical, variants, rows_found: rows.length, rows_updated: 0 });
      continue;
    }

    // 4. EXECUTE: PATCH cada row
    let updated = 0;
    let errors = 0;
    for (const row of rows) {
      const patch = {};
      if (variants.includes(row.team_a)) patch.team_a = canonical;
      if (variants.includes(row.team_b)) patch.team_b = canonical;

      // Atualiza raw_extraction.match_context.team_a / team_b se presente
      if (row.raw_extraction && row.raw_extraction.match_context) {
        const mc = row.raw_extraction.match_context;
        const updatedMc = { ...mc };
        let mcChanged = false;
        if (mc.team_a && variants.includes(mc.team_a)) { updatedMc.team_a = canonical; mcChanged = true; }
        if (mc.team_b && variants.includes(mc.team_b)) { updatedMc.team_b = canonical; mcChanged = true; }
        if (mcChanged) {
          patch.raw_extraction = { ...row.raw_extraction, match_context: updatedMc };
        }
      }

      if (Object.keys(patch).length === 0) continue;

      try {
        await patchRow(supabaseUrl, supabaseKey, row.id, patch);
        updated++;
      } catch (e) {
        console.error(`    ERRO row ${row.id}: ${e.message}`);
        errors++;
        if (errors >= 3) {
          console.error(`  ABORTAR: ${errors} erros consecutivos. Restaurar via backup: ${backupPath}`);
          process.exit(1);
        }
      }
    }
    console.log(`  Updated: ${updated} / ${rows.length} | Errors: ${errors}`);

    // 5. Verificação pós-UPDATE: contar variantes restantes
    let remaining = 0;
    for (const v of variants) {
      const enc = encodeURIComponent(v);
      const ra = await supaRequest(supabaseUrl, supabaseKey, 'GET',
        `/rest/v1/bets?team_a=eq.${enc}&select=id`, {});
      const rb = await supaRequest(supabaseUrl, supabaseKey, 'GET',
        `/rest/v1/bets?team_b=eq.${enc}&select=id`, {});
      const cnt = (ra.body ? ra.body.length : 0) + (rb.body ? rb.body.length : 0);
      if (cnt > 0) {
        console.log(`  AVISO: variante "${v}" ainda tem ${cnt} rows após UPDATE`);
        remaining += cnt;
      }
    }
    if (remaining === 0) console.log(`  ✓ Verificação pós-UPDATE: 0 variantes antigas restantes`);

    summary.push({ slug, canonical, variants, rows_found: rows.length, rows_updated: updated });
  }

  console.log('\n=== RESUMO ===');
  let totalRows = 0;
  for (const s of summary) {
    console.log(`  ${s.slug}: found=${s.rows_found} updated=${EXECUTE ? s.rows_updated : '(dry-run)'}`);
    totalRows += s.rows_found;
  }
  console.log(`  TOTAL rows encontradas: ${totalRows}`);
  if (EXECUTE) {
    const totalUpdated = summary.reduce((a, s) => a + s.rows_updated, 0);
    console.log(`  TOTAL rows atualizadas: ${totalUpdated}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
