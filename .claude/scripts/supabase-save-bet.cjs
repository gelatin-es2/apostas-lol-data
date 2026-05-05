// Salva uma bet no Supabase (POST em /rest/v1/bets).
// Uso: echo '<json>' | node supabase-save-bet.cjs
//   ou: node supabase-save-bet.cjs <path-to-json-file>
// Output: JSON da row criada (incluindo id gerado pelo Supabase)
//
// Campos esperados no JSON de input (todos opcionais exceto bookmaker, team_a/b, market, pick, odd, stake):
//   bookmaker, league, team_a, team_b, market, pick, odd, stake,
//   bet_datetime, is_map_bet, map_number, status (default 'pending'),
//   pandascore_match_id, screenshot_path, raw_extraction (objeto), notes

const fs = require('fs');
const https = require('https');
const { loadConfig } = require('./_load-config');

const REQUIRED = ['bookmaker', 'team_a', 'team_b', 'market', 'pick', 'odd', 'stake'];

function postJson(supabaseUrl, supabaseKey, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const data = JSON.stringify(body);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'Content-Length': Buffer.byteLength(data),
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
    req.write(data);
    req.end();
  });
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // Lê input: stdin ou arquivo
  let inputRaw;
  const fileArg = process.argv[2];
  if (fileArg && fileArg !== '-') {
    inputRaw = fs.readFileSync(fileArg, 'utf8');
  } else {
    inputRaw = fs.readFileSync(0, 'utf8'); // stdin
  }

  let bet;
  try { bet = JSON.parse(inputRaw); }
  catch (e) { console.error(`Input não é JSON válido: ${e.message}`); process.exit(1); }

  // Validação dos campos obrigatórios
  const missing = REQUIRED.filter(k => bet[k] === undefined || bet[k] === null || bet[k] === '');
  if (missing.length > 0) {
    console.error(`Campos obrigatórios faltando: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Defaults
  if (!bet.status) bet.status = 'pending';
  if (typeof bet.is_map_bet !== 'boolean') bet.is_map_bet = false;

  // Coerção numérica
  bet.odd = Number(bet.odd);
  bet.stake = Number(bet.stake);
  if (bet.map_number !== undefined && bet.map_number !== null) bet.map_number = parseInt(bet.map_number, 10);

  if (isNaN(bet.odd) || isNaN(bet.stake)) {
    console.error('odd e stake devem ser numéricos');
    process.exit(1);
  }

  try {
    const result = await postJson(supabaseUrl, supabaseKey, '/rest/v1/bets', [bet]);
    const row = Array.isArray(result) ? result[0] : result;
    console.log(JSON.stringify({ ok: true, id: row.id, row }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();
