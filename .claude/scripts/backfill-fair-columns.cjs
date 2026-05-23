// Backfill das colunas fair_pinnacle, fair_formula, fair_line_source em bets existentes.
//
// Lê todos cron-data/*-results.json, faz PATCH nas bets correspondentes no Supabase.
// Match key: match_id (string) + map_number + pick (under/over) + line
//
// Comportamento:
//   - Só atualiza se a coluna atual é NULL (idempotente — não sobrescreve valor existente)
//   - Bets SIMULATED também são atualizadas (fonte de verdade é o results.json)
//
// Uso:
//   node backfill-fair-columns.cjs --dry-run   → mostra quantas bets seriam atualizadas
//   node backfill-fair-columns.cjs             → executa o PATCH real

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const CRON_DIR = path.resolve(__dirname, '..', '..', 'cron-data');
const DRY_RUN = process.argv.includes('--dry-run');

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
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method, headers,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
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

// Parser do pick — extrai linha numérica e under/over
function parsePick(pickRaw) {
  const lower = (pickRaw || '').toLowerCase();
  const m = lower.match(/(\d+(?:[.,]\d+)?)/);
  const line = m ? parseFloat(m[1].replace(',', '.')) : null;
  const kind = /menos|under/.test(lower) ? 'under' : /mais|over/.test(lower) ? 'over' : null;
  return { kind, line };
}

// Carrega todos os results.json e indexa por lolesports_game_id
function loadResultsIndex() {
  const index = new Map(); // game_id (string) → result row
  if (!fs.existsSync(CRON_DIR)) return index;
  const files = fs.readdirSync(CRON_DIR).filter(f => f.endsWith('-results.json'));
  let totalRows = 0;
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CRON_DIR, file), 'utf8'));
      for (const r of data.results || []) {
        if (!r.game_id) continue;
        index.set(String(r.game_id), r);
        totalRows++;
      }
    } catch { /* pula arquivo corrompido */ }
  }
  process.stderr.write(`[backfill] ${files.length} results.json carregados, ${index.size} games indexados (${totalRows} rows)\n`);
  return index;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // 1. Carrega índice de results.json
  const resultsIndex = loadResultsIndex();

  // 2. Busca todas as bets com pelo menos uma coluna fair NULL
  process.stderr.write('[backfill] Buscando bets com fair_pinnacle IS NULL ou fair_formula IS NULL...\n');
  // Supabase: OR filter via query params
  const nullFairUrl = `/rest/v1/bets?or=(fair_pinnacle.is.null,fair_formula.is.null)&select=id,bet_datetime,pick,map_number,raw_extraction,fair_pinnacle,fair_formula,fair_line_source&limit=5000`;
  let bets;
  try {
    bets = await supaRequest(supabaseUrl, supabaseKey, 'GET', nullFairUrl);
  } catch (e) {
    console.error(`Erro ao buscar bets: ${e.message}`);
    process.exit(1);
  }
  process.stderr.write(`[backfill] ${bets.length} bets com pelo menos uma coluna fair NULL\n`);

  let matched = 0;
  let updated = 0;
  let noMatch = 0;
  let errors = 0;
  const dryRunSamples = [];

  for (const bet of bets) {
    const gameId = bet.raw_extraction?.match_context?.lolesports_game_id;
    if (!gameId) { noMatch++; continue; }

    const resultRow = resultsIndex.get(String(gameId));
    if (!resultRow) { noMatch++; continue; }

    // Determina source igual à lógica do analyze
    const fairPinnacle = resultRow.fair_pinnacle ?? null;
    const fairFormula = resultRow.fair_formula ?? null;
    const fairLineSource = fairPinnacle != null
      ? 'pinnacle_manual'
      : fairFormula != null
        ? 'formula'
        : 'fallback_29.5';

    // Monta patch — só sobrescreve campos que ainda são NULL no banco
    const patch = {};
    if (bet.fair_pinnacle == null && fairPinnacle != null) patch.fair_pinnacle = fairPinnacle;
    if (bet.fair_formula == null && fairFormula != null) patch.fair_formula = fairFormula;
    if (bet.fair_line_source == null) patch.fair_line_source = fairLineSource;

    if (Object.keys(patch).length === 0) continue; // nada a atualizar

    matched++;

    if (DRY_RUN) {
      if (dryRunSamples.length < 5) {
        dryRunSamples.push({
          bet_id: bet.id,
          game_id: gameId,
          patch,
          resultRow: { fair_pinnacle: resultRow.fair_pinnacle, fair_formula: resultRow.fair_formula, fair_source: resultRow.fair_source },
        });
      }
      continue;
    }

    try {
      await supaRequest(supabaseUrl, supabaseKey, 'PATCH', `/rest/v1/bets?id=eq.${bet.id}`, patch);
      updated++;
      if (updated % 50 === 0) process.stderr.write(`  updated ${updated}/${matched}...\n`);
    } catch (e) {
      errors++;
      process.stderr.write(`  [ERROR] bet=${bet.id}: ${e.message}\n`);
    }
  }

  const summary = {
    dry_run: DRY_RUN,
    bets_with_null_fair: bets.length,
    matched_to_results: matched,
    no_match: noMatch,
    updated: DRY_RUN ? 0 : updated,
    errors: DRY_RUN ? 0 : errors,
    would_update: DRY_RUN ? matched : undefined,
    dry_run_samples: DRY_RUN ? dryRunSamples : undefined,
  };
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
