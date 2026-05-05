// Busca match no schedule lolesports por teams + data.
// Uso: node lolesports-find-match.cjs <team_a> <team_b> [date_YYYY-MM-DD]
// Output stdout: JSON único linha { found, match_id, game_id, league_short, league_id, start_time, teams } ou { found: false, reason }
//
// - team_a/b: pode ser código (T1, GEN, FNC) ou nome completo. Match é fuzzy.
// - date: opcional, default = hoje (UTC). Aceita também "tomorrow" / "yesterday".

const https = require('https');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Ligas operadas pelo método (do knowledge/references/lolesports-league-ids.md)
const LEAGUE_IDS = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  MSI: '98767991325878492',
  Worlds: '98767975604431411',
};
// Nota: EWC (Esports World Cup) não está aqui porque não é torneio Riot.
// Ver knowledge/lessons/2026-05-05-ewc-not-in-lolesports-api.md

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'x-api-key': LOLES_KEY,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

const norm = s => s ? s.toLowerCase().replace(/[\s.\-']/g, '') : '';

function teamMatches(eventTeams, queryA, queryB) {
  if (!eventTeams || eventTeams.length !== 2) return false;
  const codes = eventTeams.map(t => norm(t.code));
  const names = eventTeams.map(t => norm(t.name));
  const qA = norm(queryA), qB = norm(queryB);

  const matchOne = (q, list) => list.some(item => item === q || (q.length >= 3 && (item.startsWith(q) || q.startsWith(item))));

  return (matchOne(qA, codes) || matchOne(qA, names))
      && (matchOne(qB, codes) || matchOne(qB, names));
}

function parseDateArg(arg) {
  if (!arg || arg === 'today') return new Date().toISOString().slice(0, 10);
  if (arg === 'tomorrow') return new Date(Date.now() + 24*3600*1000).toISOString().slice(0, 10);
  if (arg === 'yesterday') return new Date(Date.now() - 24*3600*1000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`Data inválida: ${arg}. Use YYYY-MM-DD, today, tomorrow ou yesterday.`);
}

(async () => {
  const [teamA, teamB, dateArg] = process.argv.slice(2);
  if (!teamA || !teamB) {
    console.error('Uso: node lolesports-find-match.cjs <team_a> <team_b> [date_YYYY-MM-DD]');
    process.exit(1);
  }
  const targetDate = parseDateArg(dateArg);

  // Busca em todas as ligas operadas, com janela ±1 dia (caso jogo cruze meia-noite UTC)
  const datesAccepted = new Set([
    targetDate,
    new Date(new Date(targetDate).getTime() - 24*3600*1000).toISOString().slice(0, 10),
    new Date(new Date(targetDate).getTime() + 24*3600*1000).toISOString().slice(0, 10),
  ]);

  const candidates = [];
  for (const [shortName, leagueId] of Object.entries(LEAGUE_IDS)) {
    let schedule;
    try {
      schedule = await fetchJson(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}`);
    } catch (e) {
      // Liga falhou — não é fatal, continua
      continue;
    }
    const events = schedule?.data?.schedule?.events || [];
    for (const ev of events) {
      if (!ev.startTime) continue;
      if (!datesAccepted.has(ev.startTime.slice(0, 10))) continue;
      const teams = ev.match?.teams || [];
      if (!teamMatches(teams, teamA, teamB)) continue;
      candidates.push({
        league_short: shortName,
        league_id: leagueId,
        match_id: ev.match?.id || ev.id,
        start_time: ev.startTime,
        state: ev.state,
        teams: teams.map(t => ({ code: t.code, name: t.name })),
      });
    }
  }

  if (candidates.length === 0) {
    console.log(JSON.stringify({ found: false, reason: `Nenhum match com (${teamA} vs ${teamB}) em ${targetDate} ±1d nas ligas operadas. EWC não é coberto.` }));
    process.exit(0);
  }

  if (candidates.length > 1) {
    // Prefere o mais próximo da targetDate
    candidates.sort((a, b) => Math.abs(new Date(a.start_time) - new Date(targetDate)) - Math.abs(new Date(b.start_time) - new Date(targetDate)));
    console.log(JSON.stringify({ found: true, ambiguous: true, picked: candidates[0], all: candidates }));
    process.exit(0);
  }

  console.log(JSON.stringify({ found: true, ...candidates[0] }));
})().catch(e => {
  console.log(JSON.stringify({ found: false, reason: `ERRO: ${e.message}` }));
  process.exit(1);
});
