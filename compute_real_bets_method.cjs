// Lê bets reais do Supabase, aplica regras do método (2peel puro + 1peel+flex
// com Bardo só contando peel em LEC) e produz agregação salva em JSON.
//
// Output:
//   - cron-data/real_bets_method.json (standalone, pra consumo direto)
//   - injetado em dashboard_stats.json no campo `real_bets_method` (rebuild_dashboard chama)
//
// Uso:
//   node compute_real_bets_method.cjs              → escreve cron-data/real_bets_method.json
//   node compute_real_bets_method.cjs --stdout     → imprime JSON no stdout sem escrever arquivo

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./.claude/scripts/_load-config.cjs');

const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];
const BARD_ONLY_IN = ['LEC']; // regra do método: Bardo só conta peel em LEC

const norm = s => s ? String(s).toLowerCase().replace(/[\s.\-']/g,'') : '';
const STDOUT_ONLY = process.argv.includes('--stdout');

function inferLeague(b) {
  const inf = b?.raw_extraction?.match_context?.league_inferred;
  if (inf) return inf;
  const t = (b.league || '').toUpperCase();
  if (/EWC/.test(t)) return 'EWC';
  if (/CBLOL|BRASIL/.test(t)) return 'CBLOL';
  if (/LCK/.test(t)) return 'LCK';
  if (/LPL/.test(t)) return 'LPL';
  if (/LEC/.test(t)) return 'LEC';
  if (/LCS/.test(t)) return 'LCS';
  return null;
}

// Classifica uma bet conforme as regras do método.
// Retorna '2peel' | '1peel+flex' | null
function classify(bet) {
  const mc = bet.raw_extraction?.match_context || {};
  const sb = norm(mc.blue_picks?.support);
  const sr = norm(mc.red_picks?.support);
  const lg = inferLeague(bet);

  const isFlexValid = (sup) => {
    if (!FLEX_ENGAGE.includes(sup)) return false;
    if (sup === 'bard' && !BARD_ONLY_IN.includes(lg)) return false;
    return true;
  };

  const peelB = PEEL_PURE.includes(sb);
  const peelR = PEEL_PURE.includes(sr);
  const flexB = isFlexValid(sb);
  const flexR = isFlexValid(sr);

  if (peelB && peelR) return '2peel';
  if ((peelB && flexR) || (peelR && flexB)) return '1peel+flex';
  return null;
}

function aggregate(bets) {
  let wins=0, losses=0, stake=0, profit=0;
  for (const b of bets) {
    if (b.status === 'green') wins++;
    else if (b.status === 'red') losses++;
    else continue; // ignora pending/cashout
    stake += parseFloat(b.stake) || 0;
    profit += parseFloat(b.profit) || 0;
  }
  const n = wins + losses;
  return {
    n, wins, losses,
    hit: n > 0 ? +(100 * wins / n).toFixed(1) : 0,
    stake: +stake.toFixed(2),
    profit: +profit.toFixed(2),
    roi: stake > 0 ? +(100 * profit / stake).toFixed(1) : 0,
    breakeven: 54.1,
  };
}

function fetchAllBets(supabaseUrl, supabaseKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${supabaseUrl}/rest/v1/bets?select=*&limit=2000`);
    https.get({ host: u.hostname, path: u.pathname + u.search, headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const all = await fetchAllBets(supabaseUrl, supabaseKey);
  const settled = all.filter(b => b.status === 'green' || b.status === 'red');

  const by_trigger = { '2peel': [], '1peel+flex': [], 'none': [] };
  for (const b of settled) {
    const c = classify(b);
    if (c) by_trigger[c].push(b);
    else by_trigger.none.push(b);
  }

  const both = [...by_trigger['2peel'], ...by_trigger['1peel+flex']];

  // Breakdown 1peel+flex por flex específico (Bard, Rakan, Alistar)
  const flexBreakdown = {};
  for (const b of by_trigger['1peel+flex']) {
    const mc = b.raw_extraction?.match_context || {};
    const sb = norm(mc.blue_picks?.support);
    const sr = norm(mc.red_picks?.support);
    const flexNorm = FLEX_ENGAGE.includes(sb) ? sb : sr;
    const flexCanon = { bard:'Bard', rakan:'Rakan', alistar:'Alistar' }[flexNorm] || flexNorm;
    (flexBreakdown[flexCanon] = flexBreakdown[flexCanon] || []).push(b);
  }
  const flex_breakdown = {};
  for (const [name, arr] of Object.entries(flexBreakdown)) flex_breakdown[name] = aggregate(arr);

  // Por liga (só métodos válidos)
  const byLeague = {};
  for (const b of both) {
    const lg = inferLeague(b) || '?';
    (byLeague[lg] = byLeague[lg] || []).push(b);
  }
  const by_league = {};
  for (const [lg, arr] of Object.entries(byLeague)) by_league[lg] = aggregate(arr);

  const out = {
    generated_at: new Date().toISOString(),
    total_bets_universe: all.length,
    total_settled: settled.length,
    method_rules: {
      peel_pure: PEEL_PURE,
      flex_engage: FLEX_ENGAGE,
      bard_only_in: BARD_ONLY_IN,
      breakeven_pct: 54.1,
    },
    by_trigger: {
      '2peel': aggregate(by_trigger['2peel']),
      '1peel+flex': aggregate(by_trigger['1peel+flex']),
      method_total: aggregate(both),
    },
    flex_breakdown,
    by_league,
  };

  const json = JSON.stringify(out, null, 2);
  if (STDOUT_ONLY) {
    console.log(json);
  } else {
    const outDir = path.join(__dirname, 'cron-data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'real_bets_method.json');
    fs.writeFileSync(file, json);
    console.error(`Wrote: ${file}`);
    console.error(`2peel:   ${out.by_trigger['2peel'].n} bets, ${out.by_trigger['2peel'].hit}% hit, R$${out.by_trigger['2peel'].profit} profit`);
    console.error(`1peel+f: ${out.by_trigger['1peel+flex'].n} bets, ${out.by_trigger['1peel+flex'].hit}% hit, R$${out.by_trigger['1peel+flex'].profit} profit`);
    console.error(`Total:   ${out.by_trigger.method_total.n} bets, ${out.by_trigger.method_total.hit}% hit, R$${out.by_trigger.method_total.profit} profit (ROI ${out.by_trigger.method_total.roi}%)`);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
