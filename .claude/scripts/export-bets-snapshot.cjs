// export-bets-snapshot.cjs — exporta todas as bets do Supabase em JSON pra backup diário.
//
// Output: cron-data/snapshots/bets-YYYY-MM-DD.json
// Formato:
//   { exported_at, total_bets, bets: [ {full bet row}, ... ] }
//
// Comportamento:
//   - Pull via REST paginado (Range 0–999, 1000–1999, etc)
//   - Idempotente: sobrescreve se snapshot do dia já existe
//   - Cria cron-data/snapshots/ se não existir
//
// Uso:
//   node .claude/scripts/export-bets-snapshot.cjs

const fs = require('fs');
const path = require('path');
const https = require('https');

// ROOT aponta pra raiz do repositório (sobe 2 níveis de .claude/scripts/)
const ROOT = path.resolve(__dirname, '../..');

let SUPA_URL = process.env.SUPABASE_URL || 'https://yxhpopkxlupdpqkdaffg.supabase.co';
let SUPA_KEY = process.env.SUPABASE_SECRET_KEY;

// Fallback: tenta _load-config (lê .env local)
if (!SUPA_KEY) {
  try {
    const { loadConfig } = require('./_load-config.cjs');
    const cfg = loadConfig();
    SUPA_URL = SUPA_URL || cfg.supabaseUrl;
    SUPA_KEY = cfg.supabaseKey;
  } catch (e) {
    // sem credenciais — sai limpo
    console.error('ERRO: sem credenciais Supabase — snapshot ignorado');
    process.exit(0);
  }
}

if (!SUPA_KEY) {
  console.error('ERRO: SUPABASE_SECRET_KEY não setado — snapshot ignorado');
  process.exit(0); // exit 0 pra não falhar o cron
}

const TODAY = new Date().toISOString().slice(0, 10);
const PAGE_SIZE = 1000;

function fetchPage(from, to) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPA_URL}/rest/v1/bets?select=*&order=bet_datetime.asc&limit=${PAGE_SIZE}&offset=${from}`);
    const options = {
      host: u.hostname,
      path: u.pathname + u.search,
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        Range: `${from}-${to}`,
        'Range-Unit': 'items',
        Prefer: 'count=none',
      },
    };
    https.get(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllBets() {
  const allBets = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    console.error(`  fetching rows ${from}–${to}...`);
    const page = await fetchPage(from, to);

    if (!Array.isArray(page) || page.length === 0) break;

    allBets.push(...page);
    console.error(`  got ${page.length} rows (total so far: ${allBets.length})`);

    // Se retornou menos que PAGE_SIZE, chegamos no fim
    if (page.length < PAGE_SIZE) break;

    from += PAGE_SIZE;
  }

  return allBets;
}

(async () => {
  console.error(`[export-bets-snapshot] ${TODAY}`);

  const outDir = path.join(ROOT, 'cron-data', 'snapshots');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    console.error(`  criou ${outDir}`);
  }

  const outFile = path.join(outDir, `bets-${TODAY}.json`);

  console.error('  buscando bets no Supabase...');
  const bets = await fetchAllBets();

  const snapshot = {
    exported_at: new Date().toISOString(),
    total_bets: bets.length,
    bets,
  };

  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
  console.error(`  snapshot salvo: ${outFile} (${bets.length} bets, ${Math.round(fs.statSync(outFile).size / 1024)} KB)`);
})().catch(e => {
  console.error('ERRO no snapshot:', e.message);
  process.exit(1);
});
