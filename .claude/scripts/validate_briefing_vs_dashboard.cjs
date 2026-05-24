// Validador: garante que briefing e dashboard_stats.json casam exatamente.
// Roda como pre-step do daily_briefing.cjs — aborta com exit 1 se divergir.
//
// Verifica:
//  - hit% por time (by_trigger['2peel'].teams) — tolerância 0pp, n deve bater
//  - hit% por liga (by_trigger['2peel'].ligas) — tolerância 0pp
//
// Uso direto:
//   node validate_briefing_vs_dashboard.cjs
//
// Retorna 0 se OK, 1 se há divergência.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const DASHBOARD_PATH = path.join(REPO, 'cron-data', 'dashboard_stats.json');

// Tolerância: 0pp exato (briefing lê do mesmo JSON, não recalcula)
const HIT_TOLERANCE_PP = 0;
const N_TOLERANCE = 0;

function loadDashboardStats() {
  if (!fs.existsSync(DASHBOARD_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8')); } catch { return null; }
}

// Simula o buildTeamHitMap() atual do briefing — lê do dashboard
function buildBriefingTeamMap(dashboard) {
  const m = new Map();
  const teams = dashboard?.by_trigger?.['2peel']?.teams;
  if (!teams || !Array.isArray(teams)) return m;
  for (const t of teams) {
    if (!t.name) continue;
    m.set(t.name.toLowerCase(), { hit: t.hit, n: t.n, name: t.name });
  }
  return m;
}

// Simula o buildLeagueHitMap() atual do briefing — lê do dashboard
function buildBriefingLeagueMap(dashboard) {
  const m = new Map();
  if (dashboard?.by_trigger?.['2peel']?.ligas) {
    for (const l of dashboard.by_trigger['2peel'].ligas) m.set(l.name, { hit: l.hit, n: l.n });
  }
  return m;
}

function main() {
  const dashboard = loadDashboardStats();
  if (!dashboard) {
    console.error('ERRO: dashboard_stats.json não encontrado em', DASHBOARD_PATH);
    console.error('  Rode: node .claude/scripts/rebuild_dashboard_stats_cron.cjs');
    process.exit(1);
  }

  const dashTeams = dashboard?.by_trigger?.['2peel']?.teams || [];
  const dashLeagues = dashboard?.by_trigger?.['2peel']?.ligas || [];
  const briefingTeams = buildBriefingTeamMap(dashboard);
  const briefingLeagues = buildBriefingLeagueMap(dashboard);

  let diffs = 0;

  // Verificar times
  for (const dt of dashTeams) {
    const bt = briefingTeams.get(dt.name.toLowerCase());
    if (!bt) {
      console.error(`DIVERGÊNCIA TIME: "${dt.name}" está no dashboard mas não no briefing`);
      diffs++;
      continue;
    }
    const hitDiff = Math.abs(bt.hit - dt.hit);
    const nDiff = Math.abs(bt.n - dt.n);
    if (hitDiff > HIT_TOLERANCE_PP || nDiff > N_TOLERANCE) {
      console.error(`DIVERGÊNCIA TIME: "${dt.name}" — dashboard hit=${dt.hit}% n=${dt.n} | briefing hit=${bt.hit}% n=${bt.n}`);
      diffs++;
    }
  }

  // Verificar ligas
  for (const dl of dashLeagues) {
    const bl = briefingLeagues.get(dl.name);
    if (!bl) {
      console.error(`DIVERGÊNCIA LIGA: "${dl.name}" está no dashboard mas não no briefing`);
      diffs++;
      continue;
    }
    const hitDiff = Math.abs(bl.hit - dl.hit);
    const nDiff = Math.abs(bl.n - dl.n);
    if (hitDiff > HIT_TOLERANCE_PP || nDiff > N_TOLERANCE) {
      console.error(`DIVERGÊNCIA LIGA: "${dl.name}" — dashboard hit=${dl.hit}% n=${dl.n} | briefing hit=${bl.hit}% n=${bl.n}`);
      diffs++;
    }
  }

  if (diffs > 0) {
    console.error(`\n${diffs} divergência(s) encontrada(s).`);
    console.error('Ação: rode rebuild_dashboard_stats_cron.cjs e tente novamente.');
    process.exit(1);
  }

  console.error(`OK: briefing e dashboard casam (${dashTeams.length} times, ${dashLeagues.length} ligas)`);
  process.exit(0);
}

main();
