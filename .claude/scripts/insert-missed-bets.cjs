// Insere as missed opportunities (jogos do método sem bet do CEO) como bets SIMULATED
// no Supabase, pra alimentar análise estatística no dashboard.
//
// Fonte: dashboard_stats.json.missed_opportunities.list (gerado pelo cron oficial)
// Cada game já tem fair line calculada pela fórmula do projeto.
//
// Schema da bet simulada:
//   bookmaker  = 'SIMULATED'  (filtrado fora do PnL real em compute_real_bets_method e rebuild_dashboard_stats_cron)
//   stake      = 1000
//   odd        = 1.74         (típica que CEO pega quando aposta linha+1)
//   pick       = "Under {fair+1}" (linha 1 acima da fair, igual ao que CEO opera)
//   status     = 'green' se kills<fair+1 senão 'red'  (sem passar por pending)
//   profit     = +740 ou -1000
//   raw_extraction.simulated = true
//   raw_extraction.missed_opportunity = true
//
// Dedup: usa raw_extraction.match_context.lolesports_game_id como chave.
// Antes de inserir, query por (bookmaker=SIMULATED + game_id) — pula se já existe.
//
// Uso:
//   node insert-missed-bets.cjs            → insert real (com prompt de confirmação não, vai direto)
//   node insert-missed-bets.cjs --dry-run  → só conta o que faria

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');

const STATS_PATH = path.join(__dirname, '..', '..', 'cron-data', 'dashboard_stats.json');
const STAKE = 1000;
const ODD = 1.74;
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

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  if (!fs.existsSync(STATS_PATH)) {
    console.error('dashboard_stats.json não encontrado em', STATS_PATH);
    process.exit(1);
  }
  const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  const missed = stats.missed_opportunities?.list || [];
  console.error(`[1/3] ${missed.length} missed opportunities carregadas`);

  // Pré-fetch existing SIMULATED game_ids pra dedup em batch
  console.error('[2/3] Fetching existing SIMULATED bets pra dedup...');
  const existing = await supaRequest(supabaseUrl, supabaseKey, 'GET',
    '/rest/v1/bets?select=id,raw_extraction&bookmaker=eq.SIMULATED&limit=2000');
  const existingGameIds = new Set();
  for (const e of existing || []) {
    const gid = e.raw_extraction?.match_context?.lolesports_game_id;
    if (gid) existingGameIds.add(String(gid));
  }
  console.error(`  ${existingGameIds.size} simuladas já no banco`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const batch = [];

  // Cache Pinnacle por data (evita reler o mesmo arquivo pra cada bet do mesmo dia)
  const pinnacleCache = new Map();
  function getPinnacle(date) {
    if (!pinnacleCache.has(date)) pinnacleCache.set(date, loadFairPinnacle(date));
    return pinnacleCache.get(date);
  }

  for (const m of missed) {
    if (existingGameIds.has(String(m.gameId))) { skipped++; continue; }
    const simulatedLine = m.line + 1;  // CEO opera linha+1
    const won = m.kills < simulatedLine;
    const profit = won ? +(STAKE * (ODD - 1)).toFixed(2) : -STAKE;
    const status = won ? 'green' : 'red';
    const betDatetime = `${m.date}T12:00:00Z`; // mid-day pra estar dentro do guard

    // Determina fair_pinnacle/fair_formula/fair_line_source a partir dos dados do missed opportunity
    const pinMap = getPinnacle(m.date);
    const fairPinnacle = m.matchId ? (pinMap.byMatchId.get(String(m.matchId)) ?? null) : null;
    const fairFormula = m.line != null ? m.line : null; // linha do método já é a formula calculada
    const fairLineSource = fairPinnacle != null
      ? 'pinnacle_manual'
      : fairFormula != null
        ? 'formula'
        : 'fallback_29.5';

    const teamA = m.teams?.[0] || '?';
    const teamB = m.teams?.[1] || '?';
    const bet = {
      bookmaker: 'SIMULATED',
      league: m.league,
      team_a: teamA,
      team_b: teamB,
      market: 'Total Kills',
      pick: `Under ${simulatedLine}`,
      odd: ODD,
      stake: STAKE,
      bet_datetime: betDatetime,
      pandascore_match_id: Number(m.matchId) || null,
      is_map_bet: true,
      map_number: m.map,
      status,
      profit,
      settled_at: new Date().toISOString(),
      settle_source: `SIMULATED — fair line ${m.line} + 1 = ${simulatedLine}, ${m.kills} kills, ${m.trigger}`,
      fair_pinnacle: fairPinnacle,
      fair_formula: fairFormula,
      fair_line_source: fairLineSource,
      raw_extraction: {
        simulated: true,
        missed_opportunity: true,
        match_context: {
          lolesports_match_id: String(m.matchId),
          lolesports_game_id: String(m.gameId),
          start_time: betDatetime,
          league_short: m.league,
          fair_line_calculated: m.line,
          simulated_line: simulatedLine,
          total_kills: m.kills,
          under_hit: won,
          trigger_type: m.trigger,
          teams: [{ name: teamA }, { name: teamB }],
          blue_picks: m.blue_picks,
          red_picks: m.red_picks,
        },
      },
      notes: 'simulated_missed_opportunity_split2',
    };
    batch.push(bet);
  }

  console.error(`[3/3] ${batch.length} pra inserir, ${skipped} duplicatas puladas`);
  if (DRY_RUN) {
    console.log(JSON.stringify({ would_insert: batch.length, skipped, sample: batch.slice(0, 3) }, null, 2));
    return;
  }
  if (batch.length === 0) {
    console.log(JSON.stringify({ inserted: 0, skipped, errors }));
    return;
  }

  // Insert em chunks de 50 pra não estourar limite do Supabase
  const CHUNK = 50;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    try {
      await supaRequest(supabaseUrl, supabaseKey, 'POST', '/rest/v1/bets', chunk);
      inserted += chunk.length;
      console.error(`  inserted ${inserted}/${batch.length}`);
    } catch (e) {
      errors++;
      console.error(`  chunk ${i}-${i + chunk.length} falhou: ${e.message}`);
    }
  }

  console.log(JSON.stringify({ inserted, skipped, errors, stake_total: inserted * STAKE, profit_total: 'check banco' }));
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
