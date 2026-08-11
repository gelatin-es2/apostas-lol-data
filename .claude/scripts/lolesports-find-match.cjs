// Busca match no schedule lolesports por teams + data.
//
// Uso: node lolesports-find-match.cjs <team_a> <team_b> [date_YYYY-MM-DD|today|tomorrow|yesterday]
// Output stdout: JSON único linha — CONTRATO v1 (ver abaixo)
//
// ─── CONTRATO v1 (2026-08-11, Fase 2 do runbook) ────────────────────────────
// {
//   "schema_version": 1,
//   "found": true|false,
//   "ambiguous": bool,              // true = 2+ candidatos na data. BLOQUEIA write.
//   "selection_reason": "live" | "starting_soon" | "exact_date_completed"
//                     | "exact_date_other_state" | "not_found" | "error",
//   "picked": {                     // null quando found=false
//     "match_id": "...",            // id do match no lolesports
//     "league_short": "LCK",
//     "league_id": "...",
//     "start_time": "2026-08-11T08:00:00Z",  // SEMPRE start_time. NUNCA startTime.
//     "state": "unstarted" | "inProgress" | "completed" | "unknown",  // enum único
//     "state_raw": "...",           // só presente quando state="unknown"
//     "teams": [{ "code": "T1", "name": "T1" }, ...],
//     "selection_source": "lolesports_schedule",
//     "selection_confidence": "high" | "medium" | "low",
//     "delta_min": -12.3            // minutos entre agora e start_time (start - now)
//   },
//   "all_candidates": [ { match_id, league, start_time, state, teams, delta_min } ],
//   "query": { "teamA": "...", "teamB": "...", "targetDate": "YYYY-MM-DD" },
//   "reason": "..."                 // só quando found=false
// }
//
// COMPATIBILIDADE: os campos legados no top-level (found, ambiguous, match_id,
// league_short, league_id, start_time, state, teams, selected_reason, all_candidates)
// são mantidos como ESPELHO de `picked` porque `backfill-match-id.cjs` (fora do
// escopo da Fase 2) consome o output por subprocess. Consumo canônico novo = `picked`.
// Não adicionar consumidor novo lendo o espelho legado.
//
// REGRAS DE LINKAGEM (bug histórico de 2026-05-07):
// 1. Match por DATA EXATA do dia (não janela ±1d).
// 2. Match estrito de codes (T1, FNC, KT, DK); nome só se code não bate.
//    Prefix fallback exige >= 4 chars (evita "WE" bater em "WBG").
// 3. Prioriza matches LIVE / UNSTARTED nos próximos 60 min (momento do draft).
// 4. SEMPRE retorna all_candidates pra auditoria.
// 5. 2+ candidatos no mesmo dia → ambiguous: true → consumidor NÃO pode salvar
//    sem escolha explícita do usuário (o save rejeita sem ambiguity_resolution).
//
// JANELA TEMPORAL DO PIPELINE (única, canônica): bet_datetime deve cair em
// [start_time - 24h, start_time + 12h]. Quem APLICA é o supabase-save-bet.cjs.
// Este script só reporta start_time/delta_min — não filtra por janela.

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
  // +3 ligas 2026-07-21 (método Under aprovado): Prime League, LCK Challengers
  // ('KCL' — evita colisão com regex \bLCK\b em normalizeLeague), EMEA Masters
  // ('EUM' — código canônico já esperado por lib/normTeamName.cjs)
  'Prime League': '105266091639104326',
  KCL: '98767991335774713',
  EUM: '100695891328981122',
  // 2026-07-25: LCP (Pacific, tier 1) — teste Under 2peel stake 50% + janela Camille.
  // Viabilidade: knowledge/reports/2026-07-25-lcp-viabilidade.md
  LCP: '113476371197627891',
  // 2026-08-05: NACL promovida do banco de reservas. Decisão Elvis: 1u normal.
  // Análise de entrada: knowledge/reports/2026-08-05-nacl-entrada-set.md
  NACL: '109511549831443335',
  // 2026-08-06: TCL — NÃO é liga operada pelo método. Cadastrada só pra permitir
  // registro/settle de bets discricionárias.
  TCL: '98767991343597634',
};
// Nota: EWC não está aqui (não é torneio Riot). Bets de EWC/qualifier usam
// match_id_exception no payload do save (ver supabase-save-bet.cjs).

function fetchJsonHttps(url) {
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
// Prefix fallback só se q tem >= 4 chars (evita "WE" bater em "WBG").
function strictTeamMatch(q, list) {
  const nq = norm(q);
  for (const item of list) {
    const ni = norm(item);
    if (ni === nq) return true;
  }
  // Fallback prefix real (fix 2026-05-21): se query >= 4 chars, aceita quando query
  // é PREFIXO do item normalizado (ex "Falke" → "Falkeesports").
  if (nq.length >= 4) {
    for (const item of list) {
      const ni = norm(item);
      if (ni.startsWith(nq) || nq.startsWith(ni)) return true;
    }
  }
  return false;
}

function teamsMatchEvent(eventTeams, queryA, queryB) {
  if (!eventTeams || eventTeams.length !== 2) return false;
  const codes = eventTeams.map(t => t.code).filter(Boolean);
  const names = eventTeams.map(t => t.name).filter(Boolean);
  // Cada query deve bater em ALGUM lado (code ou name) — mas NÃO o mesmo lado.
  const matchA0 = strictTeamMatch(queryA, [codes[0], names[0]]);
  const matchA1 = strictTeamMatch(queryA, [codes[1], names[1]]);
  const matchB0 = strictTeamMatch(queryB, [codes[0], names[0]]);
  const matchB1 = strictTeamMatch(queryB, [codes[1], names[1]]);
  return (matchA0 && matchB1) || (matchA1 && matchB0);
}

function parseDateArg(arg, nowMs) {
  const base = nowMs != null ? nowMs : Date.now();
  if (!arg || arg === 'today') return new Date(base).toISOString().slice(0, 10);
  if (arg === 'tomorrow') return new Date(base + 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (arg === 'yesterday') return new Date(base - 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`Data inválida: ${arg}. Use YYYY-MM-DD, today, tomorrow ou yesterday.`);
}

const KNOWN_STATES = ['unstarted', 'inProgress', 'completed'];

// Enum único de estado do contrato v1. Estado fora do enum vira "unknown"
// e o valor cru fica em state_raw pra auditoria.
function stateEnum(raw) {
  return KNOWN_STATES.includes(raw) ? raw : 'unknown';
}

function selectionConfidence(reason, ambiguous) {
  if (ambiguous) return 'low';
  if (reason === 'live' || reason === 'starting_soon') return 'high';
  if (reason === 'exact_date_completed') return 'medium';
  return 'low'; // exact_date_other_state e desconhecidos
}

function buildNotFound(reason, query) {
  return {
    schema_version: 1,
    found: false,
    ambiguous: false,
    selection_reason: 'not_found',
    picked: null,
    all_candidates: [],
    reason,
    query,
  };
}

// Núcleo puro/testável: recebe fetch injetável e clock injetável.
async function runFindMatch({ teamA, teamB, dateArg, nowMs = Date.now(), fetchJson = fetchJsonHttps }) {
  const targetDate = parseDateArg(dateArg, nowMs);
  const query = { teamA, teamB, targetDate };

  const candidates = [];
  for (const [shortName, leagueId] of Object.entries(LEAGUE_IDS)) {
    let pageToken = null;
    let oldestSeen = '9999-12-31';
    // Pagina pra trás até passar do targetDate (-1 dia de margem)
    const stopBefore = new Date(new Date(targetDate).getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
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
    return buildNotFound(
      `Nenhum match (${teamA} vs ${teamB}) na data EXATA ${targetDate} nas ligas operadas. EWC qualifier não é coberto pelo lolesports — usar match_id_exception no save.`,
      query,
    );
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

  const top = candidates[0];
  const ambiguous = candidates.length > 1;
  const reason = top.state === 'inProgress' ? 'live'
               : top.state === 'unstarted' && top._delta_min >= -10 && top._delta_min <= 60 ? 'starting_soon'
               : top.state === 'completed' ? 'exact_date_completed'
               : 'exact_date_other_state';

  const picked = {
    match_id: top.match_id,
    league_short: top.league_short,
    league_id: top.league_id,
    start_time: top.start_time,
    state: stateEnum(top.state),
    teams: top.teams,
    selection_source: 'lolesports_schedule',
    selection_confidence: selectionConfidence(reason, ambiguous),
    delta_min: top._delta_min,
  };
  if (picked.state === 'unknown') picked.state_raw = top.state;

  return {
    schema_version: 1,
    found: true,
    ambiguous,
    selection_reason: reason,
    picked,
    all_candidates: candidates.map(c => ({
      match_id: c.match_id, league: c.league_short, start_time: c.start_time,
      state: c.state, teams: c.teams.map(t => t.code).join(' vs '),
      delta_min: c._delta_min,
    })),
    query,
    // ── espelho legado (compat backfill-match-id.cjs; NÃO usar em código novo) ──
    selected_reason: reason,
    match_id: top.match_id,
    league_short: top.league_short,
    league_id: top.league_id,
    start_time: top.start_time,
    state: top.state,
    teams: top.teams,
  };
}

module.exports = { runFindMatch, parseDateArg, strictTeamMatch, teamsMatchEvent, stateEnum, LEAGUE_IDS };

if (require.main === module) {
  (async () => {
    const [teamA, teamB, dateArg] = process.argv.slice(2);
    if (!teamA || !teamB) {
      console.error('Uso: node lolesports-find-match.cjs <team_a> <team_b> [date_YYYY-MM-DD]');
      process.exit(1);
    }
    const out = await runFindMatch({ teamA, teamB, dateArg });
    console.log(JSON.stringify(out));
  })().catch(e => {
    console.log(JSON.stringify({
      schema_version: 1,
      found: false,
      ambiguous: false,
      selection_reason: 'error',
      picked: null,
      all_candidates: [],
      reason: `ERRO: ${e.message}`,
    }));
    process.exit(1);
  });
}
