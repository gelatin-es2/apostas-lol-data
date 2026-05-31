// Gera cron-data/milio_dashboard_data.json — TODOS os jogos do Split 2 onde o
// suporte Milio apareceu (qualquer lado), em TODAS as ligas operadas, com picks
// completos de todas as lanes quando disponíveis.
//
// Fonte HÍBRIDA + ENRIQUECIMENTO:
//   - Majors LCK/LPL/LEC/CBLOL/LCS → results.json (base-mapa: todo mapa jogado).
//     Tem só o support por jogo (analyze_range só extrai support).
//   - Tier2 LFL/LES → Supabase bets (única fonte com esses jogos).
//   - ENRIQUECIMENTO: picks completos (top/jungle/mid/adc/support dos 2 times)
//     vêm do Supabase, cruzados por lolesports_game_id. Jogos que viraram bet
//     ganham picks completos; mapas sem bet ficam só com support.
//
// Roda no cron (.github/workflows/daily-cron.yml) DEPOIS do analyze + tier2.
//
// Uso: node .claude/scripts/build_milio_dashboard_data.cjs
// Output: cron-data/milio_dashboard_data.json

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const CRON = path.resolve(__dirname, '..', '..', 'cron-data');
const OUT = path.join(CRON, 'milio_dashboard_data.json');
const MAJORS = ['LCK', 'LPL', 'LEC', 'CBLOL', 'LCS'];
const TIER2 = ['LFL', 'LES'];
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];

// Flags do audit 2026-05-31 (knowledge/audits/milio-audit-2026-05-31.md)
const FLAGS = {
  stack_opp_sup: ['Bard', 'Lulu'],
  avoid_opp_sup: ['Nautilus', 'Alistar', 'Renata'],
  avoid_team: ['NIP'],
  weak_sample_league: ['LCS', 'LFL', 'LES'],
};

const isMilio = s => (s || '').toLowerCase().includes('milio');
const normLeague = s => (s || '').toUpperCase().replace(/[\s_-]/g, '');
const hasFullPicks = p => p && ROLES.every(r => p[r]);

// ---------- Supabase: bets de Milio (picks completos + tier2) ----------
function fetchSupabase() {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const q = '/rest/v1/bets?select=raw_extraction,league,team_a,team_b,map_number,bookmaker,bet_datetime&status=in.(green,red)&limit=3000';
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl.replace(/\/$/, '') + q);
    https.get({
      host: u.hostname, path: u.pathname + u.search,
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---------- Majors via results.json (base-mapa) ----------
function fromResultsJson() {
  const files = fs.readdirSync(CRON)
    .filter(x => /^\d{4}-\d{2}-\d{2}-results\.json$/.test(x))
    .sort();
  const games = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(CRON, file), 'utf8')); } catch { continue; }
    const day = file.slice(0, 10);
    for (const r of (d.results || [])) {
      if (!MAJORS.includes(normLeague(r.league))) continue;
      const milioBlue = isMilio(r.sup_blue), milioRed = isMilio(r.sup_red);
      if (!milioBlue && !milioRed) continue;
      if (r.total_kills == null || r.matchup_fair == null) continue;
      games.push({
        date: day,
        league: normLeague(r.league),
        map: r.map_number,
        team_blue: r.team_blue,
        team_red: r.team_red,
        milio_side: milioBlue ? 'blue' : 'red',
        milio_team: milioBlue ? r.team_blue : r.team_red,
        opp_team: milioBlue ? r.team_red : r.team_blue,
        opp_sup: milioBlue ? r.sup_red : r.sup_blue,
        sup_blue: r.sup_blue,
        sup_red: r.sup_red,
        blue_picks: { support: r.sup_blue },
        red_picks: { support: r.sup_red },
        total_kills: r.total_kills,
        fair: r.matchup_fair,
        fair_source: r.fair_source,
        trigger: r.trigger_type,
        game_id: r.game_id ? String(r.game_id) : null,
        src: 'results.json',
      });
    }
  }
  return games;
}

// ---------- Tier2 LFL/LES via Supabase (dedup por game_id) ----------
function tier2FromSupabase(rows) {
  const byGame = new Map();
  for (const x of rows) {
    const mc = x.raw_extraction?.match_context || {};
    const lg = normLeague(x.league);
    if (!TIER2.includes(lg)) continue;
    const supB = mc.blue_picks?.support, supR = mc.red_picks?.support;
    if (!isMilio(supB) && !isMilio(supR)) continue;
    const tk = mc.total_kills;
    const fair = mc.fair_line ?? mc.matchup_fair ?? null;
    if (tk == null || fair == null) continue;
    const gid = String(mc.lolesports_game_id || `${mc.lolesports_match_id}|${x.map_number}`);
    const isReal = x.bookmaker !== 'SIMULATED';
    const prev = byGame.get(gid);
    if (prev && !(isReal && prev._sim)) continue;
    const milioBlue = isMilio(supB);
    byGame.set(gid, {
      date: (x.bet_datetime || '').slice(0, 10),
      league: lg,
      map: x.map_number,
      team_blue: x.team_a,
      team_red: x.team_b,
      milio_side: milioBlue ? 'blue' : 'red',
      milio_team: milioBlue ? x.team_a : x.team_b,
      opp_team: milioBlue ? x.team_b : x.team_a,
      opp_sup: milioBlue ? supR : supB,
      sup_blue: supB,
      sup_red: supR,
      blue_picks: mc.blue_picks || { support: supB },
      red_picks: mc.red_picks || { support: supR },
      total_kills: tk,
      fair,
      fair_source: mc.fair_line_source ?? null,
      trigger: mc.trigger_type ?? null,
      game_id: gid,
      _sim: !isReal,
      src: 'supabase',
    });
  }
  return [...byGame.values()].map(({ _sim, ...g }) => g);
}

// ---------- Índice de picks completos do Supabase (por game_id) ----------
function buildPicksIndex(rows) {
  const idx = new Map();
  for (const x of rows) {
    const mc = x.raw_extraction?.match_context || {};
    const gid = mc.lolesports_game_id ? String(mc.lolesports_game_id) : null;
    if (!gid) continue;
    if (hasFullPicks(mc.blue_picks) && hasFullPicks(mc.red_picks)) {
      idx.set(gid, { blue: mc.blue_picks, red: mc.red_picks });
    }
  }
  return idx;
}

(async () => {
  let rows = [];
  try { rows = await fetchSupabase(); }
  catch (e) { console.error('[WARN] Supabase falhou:', e.message); }

  const picksIdx = buildPicksIndex(rows);
  const majors = fromResultsJson();
  const tier2 = tier2FromSupabase(rows);

  // Enriquece picks completos por game_id onde disponível
  let enriched = 0;
  for (const g of majors) {
    if (g.game_id && picksIdx.has(g.game_id)) {
      const p = picksIdx.get(g.game_id);
      g.blue_picks = p.blue; g.red_picks = p.red;
      enriched++;
    }
  }

  const games = [...majors, ...tier2].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const firstDay = games[0]?.date, lastDay = games[games.length - 1]?.date;
  const hits = games.filter(g => g.total_kills < g.fair).length;
  const withFullPicks = games.filter(g => hasFullPicks(g.blue_picks) && hasFullPicks(g.red_picks)).length;

  const byLeague = {};
  for (const g of games) byLeague[g.league] = (byLeague[g.league] || 0) + 1;

  const out = {
    generated_at: new Date().toISOString(),
    source: 'híbrido: results.json (majors) + Supabase (LFL/LES + picks completos por game_id)',
    range: [firstDay, lastDay],
    milio_count: games.length,
    games_with_full_picks: withFullPicks,
    baseline_under_hit_pct: games.length ? +(100 * hits / games.length).toFixed(1) : 0,
    by_league: byLeague,
    flags: FLAGS,
    games,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE', OUT);
  console.log('milio_count:', games.length, '| full_picks:', withFullPicks, '| enriched majors:', enriched);
  console.log('baseline:', out.baseline_under_hit_pct + '%', '| range:', firstDay, '->', lastDay);
  console.log('por liga:', JSON.stringify(byLeague));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
