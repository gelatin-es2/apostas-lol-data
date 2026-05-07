// Busca match no schedule lolesports por teams + data.
//
// Uso: node lolesports-find-match.cjs <team_a> <team_b> [date_YYYY-MM-DD]
// Output stdout: JSON único linha
//
// REGRAS DE LINKAGEM (importantes — bug histórico de 2026-05-07):
//
// 1. Match por DATA EXATA do dia (não janela ±1d). Antes a janela ampla
//    pegava matches antigos com mesmos times — vide DK vs KT 15/04 sendo
//    linkado a bet de 07/05.
// 2. Match estrito de codes: ambos teams devem aparecer EXATAMENTE como
//    código (T1, FNC, KT, DK). Match por nome só se code não disponível.
//    Antes o fuzzy "WE" batia em "BLG/WBG" por substring.
// 3. Se hora_atual fornecida, prioriza matches no estado LIVE / UNSTARTED
//    nos próximos 60 minutos (= momento típico do draft, quando Elvis aposta).
// 4. SEMPRE retorna `all_candidates` na saída pra auditoria.
// 5. Se múltiplos candidatos no mesmo dia: avisa com `ambiguous: true`.
//
// Output schema:
// {
//   found: true|false,
//   ambiguous: bool,
//   match_id, league_short, league_id, start_time, state,
//   teams: [{code, name}, ...],
//   selected_reason: "live_or_starting_soon" | "exact_date" | "fallback_today",
//   all_candidates: [...],
//   reason?: string  // só quando found=false
// }

const https = require('https');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const LEAGUE_IDS = {
  // Tier 1 majors
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  // Internacionais Riot
  MSI: '98767991325878492',
  Worlds: '98767975604431411',
  // Tier 2 EU (operadas pelo Elvis nas ligas da tarde)
  LFL: '105266103462388553',
  LES: '105266074488398661',
  LIT: '105266094998946936',
};
// Nota: EWC não está aqui (não é torneio Riot). Pra EWC qualifiers, daily_briefing.cjs
// usa Liquipedia. Bet-logger pra EWC ainda precisa fallback manual.

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
        try {
          // IDs longos vêm como Number truncado em JSON puro — quote eles antes do parse.
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

const norm = s => s ? s.toLowerCase().replace(/[\s.\-']/g, '') : '';

// Match estrito: q deve bater exato com algum item da list (case-insensitive).
// Substring match só se q tem >= 4 chars E é prefix exato (evita "WE" bater em "WBG").
function strictTeamMatch(q, list) {
  const nq = norm(q);
  for (const item of list) {
    const ni = norm(item);
    if (ni === nq) return true;
  }
  // Fallback: se query >= 4 chars, aceita match exato como prefix (ex "Fnatic" bate "Fnatic")
  if (nq.length >= 4) {
    for (const item of list) {
      const ni = norm(item);
      if (ni === nq) return true;
    }
  }
  return false;
}

function teamsMatchEvent(eventTeams, queryA, queryB) {
  if (!eventTeams || eventTeams.length !== 2) return false;
  const codes = eventTeams.map(t => t.code).filter(Boolean);
  const names = eventTeams.map(t => t.name).filter(Boolean);
  // Cada query deve bater em ALGUM lado (code ou name) — mas NÃO o mesmo lado.
  // Estratégia: tentamos as 2 permutações.
  const matchA0 = strictTeamMatch(queryA, [codes[0], names[0]]);
  const matchA1 = strictTeamMatch(queryA, [codes[1], names[1]]);
  const matchB0 = strictTeamMatch(queryB, [codes[0], names[0]]);
  const matchB1 = strictTeamMatch(queryB, [codes[1], names[1]]);
  return (matchA0 && matchB1) || (matchA1 && matchB0);
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
  const nowMs = Date.now();

  const candidates = [];
  for (const [shortName, leagueId] of Object.entries(LEAGUE_IDS)) {
    let pageToken = null;
    let oldestSeen = '9999-12-31';
    // Pagina pra trás até passar do targetDate (-1 dia de margem)
    const stopBefore = new Date(new Date(targetDate).getTime() - 24*3600*1000).toISOString().slice(0, 10);
    for (let pi = 0; pi < 6; pi++) {
      let r;
      try {
        const url = `https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}` + (pageToken ? `&pageToken=${pageToken}` : '');
        r = await fetchJson(url);
      } catch (e) { break; }
      const events = r?.data?.schedule?.events || [];
      for (const ev of events) {
        if (!ev.startTime) continue;
        const evDate = ev.startTime.slice(0, 10);
        if (evDate < oldestSeen) oldestSeen = evDate;
        // FILTRO PRINCIPAL: data EXATA (não ±1d)
        if (evDate !== targetDate) continue;
        const teams = ev.match?.teams || [];
        if (!teamsMatchEvent(teams, teamA, teamB)) continue;
        candidates.push({
          league_short: shortName,
          league_id: leagueId,
          match_id: ev.match?.id || ev.id,
          start_time: ev.startTime,
          state: ev.state,
          teams: teams.map(t => ({ code: t.code, name: t.name })),
        });
      }
      if (!r?.data?.schedule?.pages?.older) break;
      if (oldestSeen < stopBefore) break;
      pageToken = r.data.schedule.pages.older;
    }
  }

  if (candidates.length === 0) {
    console.log(JSON.stringify({
      found: false,
      reason: `Nenhum match (${teamA} vs ${teamB}) na data EXATA ${targetDate} nas ligas operadas. EWC qualifier não é coberto pelo lolesports — registrar manual.`,
      query: { teamA, teamB, targetDate },
    }));
    process.exit(0);
  }

  // Score: prioriza matches LIVE/UNSTARTED nos próximos 60min
  candidates.forEach(c => {
    const startMs = new Date(c.start_time).getTime();
    const deltaMin = (startMs - nowMs) / 60000;
    if (c.state === 'inProgress') c._priority = 1;                          // melhor: já rolando
    else if (c.state === 'unstarted' && deltaMin >= -10 && deltaMin <= 60) c._priority = 2; // prox 60min
    else if (c.state === 'completed') c._priority = 3;
    else c._priority = 4;
    c._delta_min = +deltaMin.toFixed(1);
  });
  candidates.sort((a, b) => a._priority - b._priority || Math.abs(a._delta_min) - Math.abs(b._delta_min));

  const picked = candidates[0];
  const ambiguous = candidates.length > 1;
  const reason = picked.state === 'inProgress' ? 'live'
               : picked.state === 'unstarted' && picked._delta_min >= -10 && picked._delta_min <= 60 ? 'starting_soon'
               : picked.state === 'completed' ? 'exact_date_completed'
               : 'exact_date_other_state';

  console.log(JSON.stringify({
    found: true,
    ambiguous,
    selected_reason: reason,
    match_id: picked.match_id,
    league_short: picked.league_short,
    league_id: picked.league_id,
    start_time: picked.start_time,
    state: picked.state,
    teams: picked.teams,
    all_candidates: candidates.map(c => ({
      match_id: c.match_id, league: c.league_short, start_time: c.start_time,
      state: c.state, teams: c.teams.map(t => t.code).join(' vs '),
      delta_min: c._delta_min,
    })),
  }));
})().catch(e => {
  console.log(JSON.stringify({ found: false, reason: `ERRO: ${e.message}` }));
  process.exit(1);
});
