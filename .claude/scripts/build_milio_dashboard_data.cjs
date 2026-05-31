// Gera cron-data/milio_dashboard_data.json — TODOS os jogos do Split 2 onde o
// suporte Milio apareceu (qualquer lado), a partir dos results.json.
//
// Fonte: cron-data/YYYY-MM-DD-results.json (gerados por analyze_yesterday no cron).
// Base COMPLETA: todos os mapas que Milio jogou, com ou sem bet (n=105+),
// diferente da aba antiga que lia só bets do Supabase (n=66, ladder/filtro).
//
// Roda no cron (.github/workflows/daily-cron.yml) DEPOIS do analyze → auto-atualiza.
//
// Uso: node .claude/scripts/build_milio_dashboard_data.cjs
// Output: cron-data/milio_dashboard_data.json

const fs = require('fs');
const path = require('path');

const CRON = path.resolve(__dirname, '..', '..', 'cron-data');
const OUT = path.join(CRON, 'milio_dashboard_data.json');

// Flags do audit 2026-05-31 (knowledge/audits/milio-audit-2026-05-31.md)
const FLAGS = {
  stack_opp_sup: ['Bard', 'Lulu'],                  // 🟢 under detona (83% / 80%)
  avoid_opp_sup: ['Nautilus', 'Alistar', 'Renata'], // 🔴 engage-tank fura
  avoid_team: ['NIP'],                              // 🔴 joga rápido mesmo com Milio
  weak_sample_league: ['LCS'],                      // ⚠️ n fraco
};

const files = fs.readdirSync(CRON)
  .filter(x => /^\d{4}-\d{2}-\d{2}-results\.json$/.test(x)) // exclui -migration-, -backup-
  .sort();

const games = [];
let firstDay, lastDay;

for (const file of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(CRON, file), 'utf8')); } catch { continue; }
  const day = file.slice(0, 10);
  for (const r of (d.results || [])) {
    const milioBlue = (r.sup_blue || '').toLowerCase().includes('milio');
    const milioRed = (r.sup_red || '').toLowerCase().includes('milio');
    if (!milioBlue && !milioRed) continue;
    if (r.total_kills == null || r.matchup_fair == null) continue;
    if (!firstDay) firstDay = day;
    lastDay = day;
    games.push({
      date: day,
      league: r.league,
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
      fair_pinnacle: r.fair_pinnacle,
      fair_formula: r.fair_formula,
      fair_source: r.fair_source,
      trigger: r.trigger_type, // '2peel' | '1peel+flex' | null
      peel_count: r.peel_count,
    });
  }
}

const hits = games.filter(g => g.total_kills < g.fair).length;

const out = {
  generated_at: new Date().toISOString(),
  source: 'results.json (Split 2 majors LCK/LPL/LEC/CBLOL/LCS — todos os mapas do Milio)',
  range: [firstDay, lastDay],
  milio_count: games.length,
  baseline_under_hit_pct: games.length ? +(100 * hits / games.length).toFixed(1) : 0,
  flags: FLAGS,
  games,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('WROTE', OUT);
console.log('milio_count:', games.length, '| baseline under_hit:', out.baseline_under_hit_pct + '%', '| range:', firstDay, '->', lastDay);
