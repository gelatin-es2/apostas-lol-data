// Gera cron-data/milio_dashboard_data.json — TODOS os jogos do Split 2 onde o
// suporte Milio apareceu (qualquer lado), em TODAS as ligas operadas.
//
// Fonte HÍBRIDA (cada liga pela melhor fonte disponível):
//   - Majors LCK/LPL/LEC/CBLOL/LCS → results.json (base-mapa: todo mapa jogado,
//     com ou sem bet; gerados por analyze_yesterday no cron).
//   - Tier2 LFL/LES → Supabase bets (única fonte com esses jogos; dedup por
//     game_id, real tem prioridade sobre SIMULATED).
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

// Flags do audit 2026-05-31 (knowledge/audits/milio-audit-2026-05-31.md)
const FLAGS = {
  stack_opp_sup: ['Bard', 'Lulu'],                  // 🟢 under detona (83% / 80%)
  avoid_opp_sup: ['Nautilus', 'Alistar', 'Renata'], // 🔴 engage-tank fura
  avoid_team: ['NIP'],                              // 🔴 joga rápido mesmo com Milio
  weak_sample_league: ['LCS', 'LFL', 'LES'],       // ⚠️ amostra fraca (n<10)
};

const isMilio = s => (s || '').toLowerCase().includes('milio');
const normLeague = s => (s || '').toUpperCase().replace(/[\s_-]/g, '');

// ---------- 1. Majors via results.json (base-mapa completa) ----------
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

// ---------- 2. Tier2 LFL/LES via Supabase bets ----------
function fromSupabase() {
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
        let rows;
        try { rows = JSON.parse(b); } catch (e) { return reject(e); }

        // dedup por game_id: 1 game = 1 entrada, real > SIMULATED
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
            total_kills: tk,
            fair,
            fair_source: mc.fair_line_source ?? null,
            trigger: mc.trigger_type ?? null,
            game_id: gid,
            _sim: !isReal,
            src: 'supabase',
          });
        }
        resolve([...byGame.values()].map(({ _sim, ...g }) => g));
      });
    }).on('error', reject);
  });
}

(async () => {
  const majors = fromResultsJson();
  let tier2 = [];
  try { tier2 = await fromSupabase(); }
  catch (e) { console.error('[WARN] Supabase tier2 falhou (LFL/LES ficam de fora):', e.message); }

  const games = [...majors, ...tier2].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const firstDay = games[0]?.date, lastDay = games[games.length - 1]?.date;
  const hits = games.filter(g => g.total_kills < g.fair).length;

  const byLeague = {};
  for (const g of games) byLeague[g.league] = (byLeague[g.league] || 0) + 1;

  const out = {
    generated_at: new Date().toISOString(),
    source: 'híbrido: results.json (majors, base-mapa) + Supabase (LFL/LES, dedup por game)',
    range: [firstDay, lastDay],
    milio_count: games.length,
    baseline_under_hit_pct: games.length ? +(100 * hits / games.length).toFixed(1) : 0,
    by_league: byLeague,
    flags: FLAGS,
    games,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE', OUT);
  console.log('milio_count:', games.length, '| baseline:', out.baseline_under_hit_pct + '%', '| range:', firstDay, '->', lastDay);
  console.log('por liga:', JSON.stringify(byLeague));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
