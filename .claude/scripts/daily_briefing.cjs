// Briefing diário — lista todos os jogos do dia (LCK/LPL/LEC/CBLOL + LFL/LES/LIT)
// com fair line, flags de times ruins e ligas ruins. Pra agente apresentar como
// "primeira resposta de bet".
//
// Uso:
//   node daily_briefing.cjs                → jogos de hoje (UTC)
//   node daily_briefing.cjs YYYY-MM-DD     → data específica
//
// Output: tabela markdown no stdout, pronta pra colar no chat.

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = path.resolve(__dirname, '..', '..');
const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const LEAGUE_IDS = {
  // Tier 1 majors
  LCK:   '98767991310872058',
  LPL:   '98767991314006698',
  LEC:   '98767991302996019',
  CBLOL: '98767991332355509',
  // Tier 2 EU operadas
  LFL:   '105266103462388553',
  LES:   '105266074488398661',
  LIT:   '105266094998946936',
};

// Dias úteis em ms (offset BRT = UTC -3)
function ymd(d) { return d.toISOString().slice(0,10); }

const argv = process.argv.slice(2);
const TARGET = argv[0] && /^\d{4}-\d{2}-\d{2}$/.test(argv[0]) ? argv[0] : ymd(new Date());

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    https.get({
      host, path: urlPath,
      headers: { 'x-api-key': LOLES, 'User-Agent': 'Mozilla/5.0', Origin: 'https://lolesports.com', Referer: 'https://lolesports.com/' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Carrega dados auxiliares (dashboard_stats + polymarket-lines + tier2_eu)
function loadDashboardStats() {
  const f = path.join(REPO, 'cron-data', 'dashboard_stats.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function loadTier2Stats() {
  const f = path.join(REPO, 'cron-data', 'tier2_eu_split2_analysis.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function loadPolymarketLines() {
  const dir = path.join(REPO, 'cron-data');
  const out = new Map(); // match_id_lolesports → entry
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('-polymarket-lines.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const cap of (j.captured || [])) {
      if (cap.match_id_lolesports && cap.games?.length > 0) {
        out.set(String(cap.match_id_lolesports), cap);
      }
    }
  }
  return out;
}

function buildTeamHitMap(dashboard) {
  // teamName → hit% (do backtest 2peel agregado)
  const m = new Map();
  if (!dashboard?.by_trigger?.['2peel']?.teams) return m;
  for (const t of dashboard.by_trigger['2peel'].teams) m.set(t.name.toLowerCase(), { hit: t.hit, n: t.n, lg: t.lg });
  return m;
}
function buildLeagueHitMap(dashboard, tier2) {
  const m = new Map();
  if (dashboard?.by_trigger?.['2peel']?.ligas) {
    for (const l of dashboard.by_trigger['2peel'].ligas) m.set(l.name, { hit: l.hit, n: l.n });
  }
  if (tier2?.by_league) {
    for (const [lg, s] of Object.entries(tier2.by_league)) {
      m.set(lg, { hit: s.method_total.hit, n: s.method_total.n });
    }
  }
  return m;
}

function flagTeam(name, teamHitMap) {
  const e = teamHitMap.get((name || '').toLowerCase());
  if (!e) return null;
  if (e.hit < 50 && e.n >= 4) return `🔴 ${name} ruim (${e.hit}% n=${e.n})`;
  if (e.hit < 60 && e.n >= 4) return `🟡 ${name} marginal (${e.hit}% n=${e.n})`;
  return null;
}

function flagLeague(lg, leagueHitMap) {
  const e = leagueHitMap.get(lg);
  if (!e) return null;
  if (e.hit < 50) return `🔴 ${lg} liga ruim (${e.hit}% n=${e.n})`;
  if (e.hit < 60) return `🟡 ${lg} liga marginal (${e.hit}% n=${e.n})`;
  return null;
}

(async () => {
  const dashboard = loadDashboardStats();
  const tier2 = loadTier2Stats();
  const pmLines = loadPolymarketLines();
  const teamHits = buildTeamHitMap(dashboard);
  const leagueHits = buildLeagueHitMap(dashboard, tier2);

  const allMatches = [];
  for (const [lg, id] of Object.entries(LEAGUE_IDS)) {
    let r;
    try { r = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getSchedule?hl=en-US&leagueId=${id}`); }
    catch (e) { console.error(`# ${lg} schedule falhou: ${e.message}`); continue; }
    const events = r?.data?.schedule?.events || [];
    for (const ev of events) {
      if (!ev.match?.id || !ev.startTime) continue;
      if (ev.startTime.slice(0,10) !== TARGET) continue;
      allMatches.push({
        league: lg,
        match_id: ev.match.id,
        start_time: ev.startTime,
        state: ev.state,
        team_a: ev.match.teams[0]?.code || ev.match.teams[0]?.name,
        team_b: ev.match.teams[1]?.code || ev.match.teams[1]?.name,
        team_a_name: ev.match.teams[0]?.name,
        team_b_name: ev.match.teams[1]?.name,
      });
    }
  }
  allMatches.sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Header
  console.log(`# Jogos de ${TARGET} — briefing método 2peel\n`);
  if (allMatches.length === 0) {
    console.log('Sem jogos das ligas operadas (LCK/LPL/LEC/CBLOL/LFL/LES/LIT) hoje.');
    return;
  }

  // Tabela principal
  console.log('| Liga | Hora BRT | Jogo | Fair line | Flags |');
  console.log('|---|---|---|---|---|');
  for (const m of allMatches) {
    const dt = new Date(m.start_time);
    const brt = new Date(dt.getTime() - 3*3600*1000);
    const hh = String(brt.getUTCHours()).padStart(2,'0');
    const mm = String(brt.getUTCMinutes()).padStart(2,'0');
    const horaBrt = `${hh}:${mm}`;
    const jogo = `${m.team_a} vs ${m.team_b}`;
    const lg = m.league;

    // Fair line: prefere Polymarket, fallback "calc TBD"
    const pm = pmLines.get(String(m.match_id));
    let fairStr = '—';
    if (pm && pm.games?.length > 0) {
      const g1 = pm.games.find(g => g.game_number === 1) || pm.games[0];
      fairStr = `**${g1.line}** (PM @${g1.under_odd?.toFixed(2) || '?'})`;
    } else {
      fairStr = '_calc após cron_';
    }

    const flags = [];
    const lgFlag = flagLeague(lg, leagueHits);
    if (lgFlag) flags.push(lgFlag);
    const t1Flag = flagTeam(m.team_a_name, teamHits);
    if (t1Flag) flags.push(t1Flag);
    const t2Flag = flagTeam(m.team_b_name, teamHits);
    if (t2Flag) flags.push(t2Flag);
    if (m.state !== 'unstarted') flags.push(`(${m.state})`);

    console.log(`| ${lg} | ${horaBrt} | ${jogo} | ${fairStr} | ${flags.join(' · ') || '—'} |`);
  }

  // Análise resumida
  console.log(`\n**${allMatches.length} jogos no total.** Ligas: ${[...new Set(allMatches.map(m => m.league))].join(', ')}.`);

  // Quick stats das ligas do dia
  const ligasDoDia = [...new Set(allMatches.map(m => m.league))];
  const hint = ligasDoDia
    .map(lg => leagueHits.get(lg))
    .filter(Boolean);
  if (hint.length > 0) {
    console.log('\nPerformance histórica método nas ligas do dia (Split 2):');
    for (const lg of ligasDoDia) {
      const e = leagueHits.get(lg);
      if (e) console.log(`- **${lg}**: ${e.hit}% hit (n=${e.n})`);
    }
  }
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
