// Quant-query: lê bets do Supabase e produz métricas agregadas (N, hit%, profit, ROI)
// com filtros e breakdowns.
//
// Uso:
//   node quant-query.cjs                                              → tudo settled
//   node quant-query.cjs --trigger 2peel                              → só 2peel
//   node quant-query.cjs --trigger 1peel+flex --by flex_engage        → 1peel+flex por Bard/Rakan/Alistar
//   node quant-query.cjs --league CBLOL --by team                     → CBLOL por time
//   node quant-query.cjs --by league                                  → tudo, quebrado por liga
//   node quant-query.cjs --since 2026-04-25 --until 2026-05-02        → janela de datas
//
// Filtros:
//   --trigger <2peel|1peel+flex|1peel-flex|none|any>      (1peel-flex é alias de 1peel+flex)
//   --league <LCK|LPL|LEC|CBLOL|EWC|all>
//   --bookmaker <EstrelaBet|Pinnacle|Parimatch|Betano>
//   --map_number <n>
//   --since YYYY-MM-DD
//   --until YYYY-MM-DD
//   --status <green|red|all>  (default: settled = green+red)
//   --flex <Bard|Rakan|Alistar>   (mantém só bets onde aquele flex está no draft)
//   --market <under|over|moneyline>
//
// Breakdowns (--by):
//   trigger | league | team | bookmaker | map_number | flex_engage |
//   sup_blue | sup_red | sup_pair | line | odd_bucket | weekday | bet_date | status
//
// Saída: JSON estruturado pra subagent consumir.

const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','nami','milio'];
const FLEX_ENGAGE = ['bard','rakan','alistar'];
const FLEX_CANON = { bard: 'Bard', rakan: 'Rakan', alistar: 'Alistar' };

const BREAK_EVEN = 0.541; // referência (odd 1.85)

const argv = process.argv.slice(2);

function getArg(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}

const filters = {
  trigger: getArg('trigger'),
  league: getArg('league'),
  bookmaker: getArg('bookmaker'),
  map_number: getArg('map_number'),
  since: getArg('since'),
  until: getArg('until'),
  status: getArg('status', 'settled'),
  flex: getArg('flex'),
  market: getArg('market'),
  by: getArg('by'),
  include_pending: argv.includes('--include-pending'),
};

// Normalize trigger filter: 1peel-flex (shell-friendly) → 1peel+flex (canonical)
if (filters.trigger === '1peel-flex') filters.trigger = '1peel+flex';

const norm = s => s ? String(s).toLowerCase().replace(/[\s.\-']/g, '') : '';

function fetchAllBets(supabaseUrl, supabaseKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${supabaseUrl}/rest/v1/bets?select=*&limit=2000`);
    https.get({
      host: u.hostname, path: u.pathname + u.search,
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function inferLeagueShort(bet) {
  // Prefer enriched
  const inferred = bet?.raw_extraction?.match_context?.league_inferred;
  if (inferred) return inferred;
  // Fallback: from bet.league text
  const t = (bet.league || '').toUpperCase();
  if (/EWC|ESPORTS WORLD CUP/.test(t)) return 'EWC';
  if (/CBLOL|BRASIL/.test(t)) return 'CBLOL';
  if (/\bLCK\b/.test(t)) return 'LCK';
  if (/\bLPL\b/.test(t)) return 'LPL';
  if (/\bLEC\b/.test(t)) return 'LEC';
  if (/\bLCS\b/.test(t)) return 'LCS';
  if (/MSI/.test(t)) return 'MSI';
  if (/WORLDS|CHAMPIONSHIP/.test(t)) return 'Worlds';
  return null;
}

function inferMarketKind(bet) {
  const lower = (bet.pick || '').toLowerCase();
  if (/menos\s*de|under/i.test(bet.pick || '')) return 'under';
  if (/mais\s*de|over/i.test(bet.pick || '')) return 'over';
  if (/money\s*line|vencedor|resultado\s*final/i.test(bet.market || '')) return 'moneyline';
  return 'unknown';
}

function parsePickLine(pickRaw) {
  const m = (pickRaw || '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

function passesFilters(bet) {
  const mc = bet.raw_extraction?.match_context || {};
  const trigger = mc.trigger_type || null;

  if (filters.trigger) {
    if (filters.trigger === 'any') {
      if (!trigger) return false;
    } else if (filters.trigger === 'none') {
      if (trigger) return false;
    } else if (trigger !== filters.trigger) {
      return false;
    }
  }

  if (filters.league && filters.league !== 'all') {
    const lg = inferLeagueShort(bet);
    if ((lg || '').toUpperCase() !== filters.league.toUpperCase()) return false;
  }

  if (filters.bookmaker) {
    if (norm(bet.bookmaker) !== norm(filters.bookmaker)) return false;
  }

  if (filters.map_number) {
    if (Number(bet.map_number) !== Number(filters.map_number)) return false;
  }

  if (filters.since) {
    const d = (bet.bet_datetime || '').slice(0, 10);
    if (d && d < filters.since) return false;
  }
  if (filters.until) {
    const d = (bet.bet_datetime || '').slice(0, 10);
    if (d && d > filters.until) return false;
  }

  if (filters.status && filters.status !== 'all' && filters.status !== 'settled') {
    if (bet.status !== filters.status) return false;
  } else if (!filters.include_pending) {
    // default: só settled (green/red)
    if (bet.status !== 'green' && bet.status !== 'red') return false;
  }

  if (filters.flex) {
    const wanted = norm(filters.flex);
    const sb = norm(mc.blue_picks?.support);
    const sr = norm(mc.red_picks?.support);
    if (sb !== wanted && sr !== wanted) return false;
  }

  if (filters.market) {
    if (inferMarketKind(bet) !== filters.market) return false;
  }

  return true;
}

// Devolve array de chaves do bucket pra essa bet (1 ou mais).
// Pra `team`, devolve [team_a, team_b]. Pra `flex_engage`, devolve só os flex presentes.
function bucketKeys(bet, by) {
  const mc = bet.raw_extraction?.match_context || {};
  switch (by) {
    case 'trigger': return [mc.trigger_type || '(none)'];
    case 'league':  return [inferLeagueShort(bet) || '(unknown)'];
    case 'team':    return [bet.team_a, bet.team_b].filter(Boolean);
    case 'bookmaker': return [bet.bookmaker || '(unknown)'];
    case 'map_number': return [String(bet.map_number ?? '(null)')];
    case 'flex_engage': {
      const sb = norm(mc.blue_picks?.support);
      const sr = norm(mc.red_picks?.support);
      const out = [];
      if (FLEX_ENGAGE.includes(sb)) out.push(FLEX_CANON[sb]);
      if (FLEX_ENGAGE.includes(sr) && !out.includes(FLEX_CANON[sr])) out.push(FLEX_CANON[sr]);
      return out.length ? out : ['(no_flex_in_draft)'];
    }
    case 'sup_blue': return [mc.blue_picks?.support || '(unknown)'];
    case 'sup_red':  return [mc.red_picks?.support || '(unknown)'];
    case 'sup_pair': {
      const sb = mc.blue_picks?.support || '?';
      const sr = mc.red_picks?.support || '?';
      const pair = [sb, sr].sort().join(' + ');
      return [pair];
    }
    case 'line': {
      const ln = parsePickLine(bet.pick);
      return [ln != null ? String(ln) : '(no_line)'];
    }
    case 'odd_bucket': {
      const o = parseFloat(bet.odd);
      if (!isFinite(o)) return ['(no_odd)'];
      // buckets de 0.10
      const b = Math.floor(o * 10) / 10;
      return [`${b.toFixed(1)}-${(b + 0.1).toFixed(1)}`];
    }
    case 'weekday': {
      if (!bet.bet_datetime) return ['(no_date)'];
      const wd = new Date(bet.bet_datetime).getUTCDay();
      return [['sun','mon','tue','wed','thu','fri','sat'][wd]];
    }
    case 'bet_date': return [(bet.bet_datetime || '').slice(0, 10) || '(no_date)'];
    case 'status': return [bet.status || '(no_status)'];
    default: return ['(all)'];
  }
}

function emptyMetric() {
  return { n: 0, wins: 0, losses: 0, stake_total: 0, profit: 0 };
}

function accumulate(metric, bet) {
  const stake = parseFloat(bet.stake) || 0;
  const profit = parseFloat(bet.profit) || 0;
  metric.n += 1;
  if (bet.status === 'green') metric.wins += 1;
  else if (bet.status === 'red') metric.losses += 1;
  metric.stake_total += stake;
  metric.profit += profit;
}

function finalize(metric) {
  const settled = metric.wins + metric.losses;
  return {
    n: metric.n,
    wins: metric.wins,
    losses: metric.losses,
    hit_rate: settled > 0 ? +(metric.wins / settled).toFixed(4) : null,
    stake_total: +metric.stake_total.toFixed(2),
    profit: +metric.profit.toFixed(2),
    roi: metric.stake_total > 0 ? +(metric.profit / metric.stake_total).toFixed(4) : null,
    gap_vs_breakeven_pp: settled > 0 ? +((metric.wins / settled - BREAK_EVEN) * 100).toFixed(1) : null,
  };
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const all = await fetchAllBets(supabaseUrl, supabaseKey);

  const universe = {
    total_bets: all.length,
    by_status: {},
  };
  for (const b of all) {
    universe.by_status[b.status || '(null)'] = (universe.by_status[b.status || '(null)'] || 0) + 1;
  }

  const filtered = all.filter(passesFilters);

  // Aggregate global
  const global = emptyMetric();
  for (const b of filtered) accumulate(global, b);

  // Aggregate breakdown
  let breakdown = null;
  if (filters.by) {
    const map = new Map();
    for (const b of filtered) {
      const keys = bucketKeys(b, filters.by);
      for (const k of keys) {
        if (!map.has(k)) map.set(k, emptyMetric());
        accumulate(map.get(k), b);
      }
    }
    breakdown = Array.from(map.entries())
      .map(([key, m]) => ({ key, ...finalize(m) }))
      .sort((a, b) => (b.profit) - (a.profit));
  }

  const out = {
    filters,
    universe,
    matched: filtered.length,
    summary: finalize(global),
    breakdown_field: filters.by || null,
    breakdown,
    break_even_reference_pct: +(BREAK_EVEN * 100).toFixed(1),
  };

  console.log(JSON.stringify(out, null, 2));
})().catch(e => {
  console.log(JSON.stringify({ error: e.message, stack: e.stack }));
  process.exit(1);
});
