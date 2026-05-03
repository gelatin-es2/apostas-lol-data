// save_report_to_db.cjs — lê cron-data/YYYY-MM-DD-results.json e faz upsert
// dos mapas com trigger (2peel | 1peel+flex) na tabela method_reports do Supabase.
//
// Uso: node save_report_to_db.cjs            → ontem (default p/ cron diário)
//      node save_report_to_db.cjs YYYY-MM-DD → data específica

const fs = require('fs');
const path = require('path');
const https = require('https');

const SUPA_URL = process.env.SUPABASE_URL || 'https://yxhpopkxlupdpqkdaffg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPA_KEY) { console.error('ERRO: SUPABASE_SECRET_KEY não setado'); process.exit(1); }

function ymd(d) { return d.toISOString().slice(0, 10); }
const TARGET = process.argv[2] || ymd(new Date(Date.now() - 24*3600*1000));

const file = path.join(__dirname, 'cron-data', `${TARGET}-results.json`);
if (!fs.existsSync(file)) { console.error(`Sem arquivo: ${file}`); process.exit(1); }

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const triggered = (data.results || []).filter(r => r.trigger_type && r.total_kills != null);

console.log(`${TARGET}: ${triggered.length} mapas com trigger (de ${data.results?.length || 0} total)`);
if (triggered.length === 0) process.exit(0);

const rows = triggered.map(r => ({
  match_date: TARGET,
  league: r.league,
  match_id: String(r.match_id),
  game_id: String(r.game_id),
  map_number: r.map_number,
  team_blue: r.team_blue,
  team_red: r.team_red,
  sup_blue: r.sup_blue,
  sup_red: r.sup_red,
  trigger_type: r.trigger_type,
  flex_engages: r.flex_engages || [],
  total_kills: r.total_kills,
  fair_line: r.matchup_fair,
  fair_source: r.fair_source,
  under_hit: r.under_hit,
}));

function postJson(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPA_URL + urlPath);
    const data = JSON.stringify(body);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${b}`)); else resolve(b); });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  // upsert via on_conflict (game_id, map_number)
  await postJson('/rest/v1/method_reports?on_conflict=game_id,map_number', rows);
  console.log(`OK: ${rows.length} rows upserted em method_reports.`);
  // resumo
  const byTrigger = {};
  for (const r of rows) {
    const k = r.trigger_type;
    if (!byTrigger[k]) byTrigger[k] = { n: 0, hits: 0 };
    byTrigger[k].n++;
    if (r.under_hit) byTrigger[k].hits++;
  }
  for (const [k, v] of Object.entries(byTrigger)) {
    const pct = v.n ? (100*v.hits/v.n).toFixed(1) : '-';
    console.log(`  ${k}: ${v.hits}/${v.n} (${pct}%)`);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
