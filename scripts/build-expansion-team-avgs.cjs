// scripts/build-expansion-team-avgs.cjs
//
// Gera médias de kills por time para as ligas de expansão (Prime League, LCK
// Challengers, EMEA Masters e demais ligas cobertas pelo universo coletado em
// 2026-07-21 pro projeto Camille) — usado pelo briefing (daily_briefing.cjs)
// como FALLBACK da coluna Fórmula quando o time não está em
// cron-data/team_avg_kills.json (esse arquivo só cobre LCK/LPL/LEC/CBLOL/LFL/LCS
// + internacionais, gerado por .claude/scripts/rebuild_dashboard_stats_cron.cjs).
//
// Por que essa fonte e não o WIP rebuild_emea_dashboard_stats.cjs (sessão antiga,
// não commitado): esse WIP (a) não cobre LCK Challengers — só ecossistema EMEA —
// deixando KCL sem fórmula mesmo depois de rodado; (b) depende de rede (schedule +
// livestats ao vivo pras 13 ligas EMEA desde abril, nunca testado, lento e frágil);
// (c) o output dele é um "dashboard_stats" completo (hit-rate por trigger/liga/time/
// champ), formato diferente do simples {teams:{nome:{avg_kills,n_games}}} que
// calcFormulaFair() já sabe consumir — exigiria reescrever o consumidor.
// audit-output/00-universe-allregions.json já tem os 3 jogos completos (2.966
// finished), offline, determinístico, e no MESMO formato de time_blue/time_red que
// team_avg_kills.json usa — dá pra reaproveitar a fórmula 1:1 sem tocar no WIP alheio.
//
// Fórmula (idêntica à canônica de rebuild_dashboard_stats_cron.cjs:280-315, SEM
// leave-one-out — igual ao próprio team_avg_kills.json, que é uma média simples
// reaproveitada pra qualquer jogo futuro, não um backtest):
//   avg_kills(time) = média de total_kills (soma kills_blue+kills_red) de todos os
//     jogos finished em que o time apareceu (blue OU red).
//   Se n_games < MIN_SAMPLE_TEAM (5): usa a média de total_kills de TODOS os jogos
//     finished da mesma liga (league_avg_total) — mesmo critério do método principal.
//   fair = round((avgA + avgB) / 2 pro .5 mais próximo), FAIR_ADJUSTMENT=0.
//
// Uso: node scripts/build-expansion-team-avgs.cjs
// Output: cron-data/expansion_team_avg_kills.json
// Re-rodável: sem efeito colateral, sem write no Supabase, sem chamada de rede.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UNIVERSE_FILE = path.join(ROOT, 'audit-output', '00-universe-allregions.json');
const OUT_FILE = path.join(ROOT, 'cron-data', 'expansion_team_avg_kills.json');
const ALIASES_FILE = path.join(ROOT, 'lib', 'team-aliases.json');

const MIN_SAMPLE_TEAM = 5; // mesmo threshold do método principal (rebuild_dashboard_stats_cron.cjs)

// Resolve nome de time vindo da API (longo/raw) → canonical curto do banco, quando
// existir alias. Igual daily_briefing.cjs/rebuild_dashboard_stats_cron.cjs — pra
// bater com os nomes que calcFormulaFair() já recebe (pós-resolveCanonical).
function loadAliasMap() {
  try {
    const j = JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8'));
    return j.aliases || {};
  } catch { return {}; }
}
function resolveCanonical(name, aliasMap) {
  if (!name) return name;
  return aliasMap[name] || name;
}

function main() {
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const aliasMap = loadAliasMap();

  // Só jogos finished com total_kills numérico (defensivo — na prática 100% dos
  // finished já vêm com total_kills preenchido, 0 suspects).
  const finished = universe.filter(
    (g) => g.game_state === 'finished' && typeof g.total_kills === 'number'
  );

  const teamKills = new Map();   // canonical name → [total_kills, ...]
  const teamLeague = new Map();  // canonical name → liga (última vista, times não trocam de liga no split)
  const leagueKills = new Map(); // liga → [total_kills, ...] (um valor por JOGO, não por lado)

  for (const g of finished) {
    const blueName = resolveCanonical(g.team_blue, aliasMap);
    const redName  = resolveCanonical(g.team_red, aliasMap);
    if (!blueName || !redName) continue;

    if (!teamKills.has(blueName)) teamKills.set(blueName, []);
    if (!teamKills.has(redName))  teamKills.set(redName, []);
    teamKills.get(blueName).push(g.total_kills);
    teamKills.get(redName).push(g.total_kills);
    teamLeague.set(blueName, g.league);
    teamLeague.set(redName, g.league);

    if (!leagueKills.has(g.league)) leagueKills.set(g.league, []);
    leagueKills.get(g.league).push(g.total_kills);
  }

  const leagueAvgTotal = {};
  for (const [lg, arr] of leagueKills) {
    leagueAvgTotal[lg] = {
      avg_kills: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
      n_games: arr.length,
    };
  }

  const teams = {};
  let fallbackCount = 0;
  for (const [name, arr] of teamKills) {
    const lg = teamLeague.get(name);
    const nGames = arr.length;
    const ownAvg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const useOwn = nGames >= MIN_SAMPLE_TEAM;
    const avgKills = useOwn ? ownAvg : (leagueAvgTotal[lg]?.avg_kills ?? ownAvg);
    if (!useOwn) fallbackCount++;
    teams[name] = {
      avg_kills: +avgKills.toFixed(2),
      n_games: nGames,
      league: lg,
      source: useOwn ? 'team_avg' : 'league_avg_fallback',
    };
  }

  const out = {
    generated_at: new Date().toISOString(),
    source_file: 'audit-output/00-universe-allregions.json',
    filter: 'game_state === "finished"',
    formula: '(avgA+avgB)/2 round to nearest .5; team avg = mean(total_kills) all finished games; n<' + MIN_SAMPLE_TEAM + ' -> league avg (mean total_kills/game, same league)',
    fair_adjustment: 0,
    min_sample_team: MIN_SAMPLE_TEAM,
    total_games_used: finished.length,
    teams_covered: Object.keys(teams).length,
    teams_using_league_fallback: fallbackCount,
    teams,
    league_avg_total: leagueAvgTotal,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.error(`Wrote: ${OUT_FILE}`);
  console.error(`  games=${finished.length} teams=${Object.keys(teams).length} (${fallbackCount} via league fallback)`);
  console.error(`  leagues: ${Object.keys(leagueAvgTotal).sort().join(', ')}`);
}

main();
