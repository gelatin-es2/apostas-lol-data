// Tag 44 bets EWC sem trigger_type com 'ewc_unclassified'
// Backup → PATCH seguro (jsonb_set via REST) → verificação
//
// Uso: node .claude/scripts/tag-ewc-trigger.cjs [--dry-run]
//
// Cuidado: NUNCA sobrescreve raw_extraction inteiro; usa PATCH com object merge pra
// só alterar match_context.trigger_type dentro do JSONB.

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.resolve(__dirname, '..', '..');
const BACKUP_PATH = path.join(ROOT, 'cron-data', '2026-05-26-backup-ewc-trigger-tag.json');

// ── helpers HTTP ────────────────────────────────────────────────────────────

function supabaseGet(url, key, endpoint) {
  return new Promise((resolve, reject) => {
    const u = new URL(url + endpoint);
    https.get({
      host: u.hostname, path: u.pathname + u.search,
      headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json', 'Prefer': 'count=exact' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GET ${res.statusCode}: ${body.slice(0,300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function supabasePatch(url, key, endpoint, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url + endpoint);
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'PATCH',
      host: u.hostname, path: u.pathname + u.search,
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Prefer: 'return=representation',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`PATCH ${res.statusCode}: ${data.slice(0,300)}`));
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // 1. Busca as bets EWC candidatas: is_method_bet=true, status green/red, trigger_type null
  console.log('Buscando bets EWC sem trigger_type...');
  const rows = await supabaseGet(
    supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=id,bookmaker,league,bet_datetime,raw_extraction,status' +
    '&is_method_bet=eq.true&status=in.(green,red)' +
    '&order=bet_datetime.desc&limit=2000'
  );

  // Filtra: tem match_context populado MAS trigger_type null/undefined
  const candidates = rows.filter(b => {
    const mc = b.raw_extraction?.match_context;
    if (!mc) return false;                              // sem match_context → não é EWC
    const trig = mc.trigger_type;
    return trig === null || trig === undefined || trig === '';
  });

  console.log(`Total bets green/red is_method_bet: ${rows.length}`);
  console.log(`Candidatas (match_context presente, trigger_type null): ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('Nada a fazer. Encerrando.');
    return;
  }

  // 2. Backup ANTES de qualquer modificação
  fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(candidates, null, 2), 'utf8');
  console.log(`Backup salvo: ${BACKUP_PATH} (${candidates.length} rows)`);

  if (DRY_RUN) {
    console.log('DRY RUN — nenhuma alteração enviada ao Supabase.');
    console.log('Exemplo do que seria aplicado a', candidates[0]?.id, ':');
    const mc0 = candidates[0]?.raw_extraction?.match_context || {};
    console.log('  trigger_type antes:', mc0.trigger_type);
    console.log('  trigger_type depois: ewc_unclassified');
    return;
  }

  // 3. PATCH row a row: mantém raw_extraction inteiro, muda só match_context.trigger_type
  let updated = 0;
  let errors  = 0;
  for (const row of candidates) {
    try {
      // Clona deep o raw_extraction e seta o campo
      const re = JSON.parse(JSON.stringify(row.raw_extraction || {}));
      if (!re.match_context) re.match_context = {};
      re.match_context.trigger_type = 'ewc_unclassified';

      await supabasePatch(
        supabaseUrl, supabaseKey,
        `/rest/v1/bets?id=eq.${row.id}`,
        { raw_extraction: re }
      );
      updated++;
      process.stdout.write(`  [${updated}/${candidates.length}] OK ${row.id}\n`);
    } catch (e) {
      errors++;
      console.error(`  ERRO ${row.id}: ${e.message}`);
    }
  }

  console.log(`\nPATCH concluído: ${updated} atualizadas, ${errors} erros.`);

  // 4. Verificação pós-UPDATE: deve retornar 0 bets com trigger_type null
  console.log('\nVerificando pós-UPDATE...');
  const verify = await supabaseGet(
    supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=id&is_method_bet=eq.true&status=in.(green,red)&limit=2000'
  );
  // Filtra no cliente (REST não suporta filter em key JSONB nested facilmente)
  const stillNull = verify.filter(b => {
    const mc = b.raw_extraction?.match_context;
    if (!mc) return false;
    const t = mc?.trigger_type;
    return t === null || t === undefined || t === '';
  });
  // Busca raw_extraction tbm
  const verifyFull = await supabaseGet(
    supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=id,raw_extraction&is_method_bet=eq.true&status=in.(green,red)&limit=2000'
  );
  const stillNullFull = verifyFull.filter(b => {
    const mc = b.raw_extraction?.match_context;
    if (!mc) return false;
    const t = mc?.trigger_type;
    return t === null || t === undefined || t === '';
  });

  if (stillNullFull.length === 0) {
    console.log('OK — 0 bets com is_method_bet=true + status green/red + trigger_type null.');
  } else {
    console.warn(`ATENÇÃO: ainda ${stillNullFull.length} bets com trigger_type null:`);
    for (const b of stillNullFull.slice(0, 10)) console.warn(' ', b.id);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
