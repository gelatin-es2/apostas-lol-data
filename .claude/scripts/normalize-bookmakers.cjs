// Normaliza campo `bookmaker` de todas as bets para lowercase canônico.
//
// Lista canônica: pinnacle, estrelabet, parimatch, betano, thunderpick, novibet, polymarket, simulated
// Bets cujo bookmaker (após lowercase) NÃO está na lista → alerta, não corrige automático.
//
// Modos:
//   node normalize-bookmakers.cjs            → dry-run (lista mudanças, não aplica)
//   node normalize-bookmakers.cjs --execute  → aplica UPDATEs + alerta fora-da-lista
//   NORMALIZE_EXECUTE=1 node normalize-bookmakers.cjs → idem via env
//
// Output JSON:
//   { summary, to_normalize, out_of_canonical, betano_historical, patch_results }

'use strict';
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const EXECUTE = process.argv.includes('--execute') || process.env.NORMALIZE_EXECUTE === '1';
const DRY_RUN = !EXECUTE;

// Lista canônica (lowercase)
const VALID_BOOKMAKERS = [
  'pinnacle',
  'estrelabet',
  'parimatch',
  'betano',
  'thunderpick',
  'novibet',
  'polymarket',
  'simulated',
];

function supaGetRange(supabaseUrl, supabaseKey, urlPath, rangeStart, rangeEnd) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'count=exact',
        Range: `${rangeStart}-${rangeEnd}`,
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function supaPatch(supabaseUrl, supabaseKey, id, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + `/rest/v1/bets?id=eq.${id}`);
    const data = JSON.stringify(body);
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
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
        resolve(null);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchAllBets(supabaseUrl, supabaseKey) {
  const PAGE = 1000;
  const bets = [];
  let offset = 0;
  while (true) {
    const data = await supaGetRange(
      supabaseUrl, supabaseKey,
      '/rest/v1/bets?select=id,bookmaker,bet_datetime,team_a,team_b,league,status&order=bet_datetime.asc',
      offset, offset + PAGE - 1
    );
    if (!Array.isArray(data) || data.length === 0) break;
    bets.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return bets;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  process.stderr.write('[1/3] Buscando todas as bets...\n');
  const bets = await fetchAllBets(supabaseUrl, supabaseKey);
  process.stderr.write(`  ${bets.length} bets carregadas\n`);

  // Classifica cada bet
  const toNormalize = [];      // bookmaker difere só no case → normaliza
  const outOfCanonical = [];   // bookmaker não é canônico mesmo após lowercase
  const alreadyOk = [];        // já está correto, sem mudança necessária

  for (const bet of bets) {
    const raw = bet.bookmaker || '';
    const lower = raw.toLowerCase().trim();
    if (raw === lower && VALID_BOOKMAKERS.includes(lower)) {
      alreadyOk.push(bet);
    } else if (VALID_BOOKMAKERS.includes(lower)) {
      // Apenas case diferente — normalizar
      toNormalize.push({ ...bet, bookmaker_original: raw, bookmaker_normalized: lower });
    } else {
      // Não canônico (mesmo após lowercase)
      outOfCanonical.push({ ...bet, bookmaker_original: raw, bookmaker_normalized: lower });
    }
  }

  // Filtra as Betano históricas: bets com bookmaker Betano (qualquer case) registradas
  // ANTES de 2026-05-22 (CEO nunca apostou Betano antes dessa data)
  const betanoHistorical = bets.filter(b => {
    const lower = (b.bookmaker || '').toLowerCase().trim();
    if (lower !== 'betano') return false;
    const date = b.bet_datetime ? b.bet_datetime.slice(0, 10) : '9999-99-99';
    return date < '2026-05-22'; // suspeitas de mal-rotulação (CEO: "nunca apostei Betano antes de hoje")
  }).map(b => ({
    id: b.id,
    bookmaker_raw: b.bookmaker,
    bet_datetime: b.bet_datetime,
    team_a: b.team_a,
    team_b: b.team_b,
    league: b.league,
    status: b.status,
    suspicion: 'CEO nunca apostou Betano antes de 2026-05-22 — provável Parimatch mal-rotulada',
  }));

  process.stderr.write(`  já OK: ${alreadyOk.length} | a normalizar: ${toNormalize.length} | fora do canônico: ${outOfCanonical.length}\n`);
  process.stderr.write(`  Betano históricas (suspeitas): ${betanoHistorical.length}\n`);

  let patched = 0;
  const patchErrors = [];

  if (!DRY_RUN && toNormalize.length > 0) {
    process.stderr.write('[2/3] Aplicando UPDATEs de normalização de case...\n');
    for (const b of toNormalize) {
      try {
        await supaPatch(supabaseUrl, supabaseKey, b.id, { bookmaker: b.bookmaker_normalized });
        patched++;
        process.stderr.write(`  PATCH OK: ${b.id.slice(0, 8)} ${b.bookmaker_original} → ${b.bookmaker_normalized}\n`);
      } catch (e) {
        patchErrors.push({ id: b.id, error: e.message });
        process.stderr.write(`  PATCH ERRO: ${b.id.slice(0, 8)} — ${e.message}\n`);
      }
    }
  } else {
    process.stderr.write('[2/3] DRY-RUN — nenhum UPDATE aplicado\n');
  }

  process.stderr.write('[3/3] Gerando output...\n');

  // Agrupa "fora do canônico" por valor único pra CEO entender o escopo
  const outOfCanonicalGrouped = {};
  for (const b of outOfCanonical) {
    const k = b.bookmaker_normalized || b.bookmaker_original;
    if (!outOfCanonicalGrouped[k]) outOfCanonicalGrouped[k] = { bookmaker_raw: b.bookmaker_original, count: 0, ids: [] };
    outOfCanonicalGrouped[k].count++;
    outOfCanonicalGrouped[k].ids.push(b.id);
  }

  // Agrupa "to_normalize" por valor único
  const normalizeGrouped = {};
  for (const b of toNormalize) {
    const k = b.bookmaker_original;
    if (!normalizeGrouped[k]) normalizeGrouped[k] = { original: b.bookmaker_original, normalized: b.bookmaker_normalized, count: 0 };
    normalizeGrouped[k].count++;
  }

  const output = {
    mode: DRY_RUN ? 'DRY-RUN — nenhum UPDATE feito' : 'EXECUTE',
    valid_bookmakers_canonical: VALID_BOOKMAKERS,
    summary: {
      total_bets: bets.length,
      already_ok: alreadyOk.length,
      to_normalize_case: toNormalize.length,
      out_of_canonical: outOfCanonical.length,
      betano_historical_suspicious: betanoHistorical.length,
      patched: DRY_RUN ? 'n/a (dry-run)' : patched,
      patch_errors: DRY_RUN ? 'n/a (dry-run)' : patchErrors.length,
    },
    normalize_by_value: Object.values(normalizeGrouped),
    out_of_canonical_by_value: Object.values(outOfCanonicalGrouped),
    // Lista completa das suspeitas Betano pra CEO revisar
    betano_historical_suspicious: betanoHistorical,
    patch_errors: patchErrors,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
})().catch(e => {
  process.stderr.write(`ERRO FATAL: ${e.message}\n`);
  process.exit(1);
});
