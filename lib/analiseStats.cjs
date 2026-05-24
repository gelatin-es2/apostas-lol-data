// Replica EXATAMENTE a lógica da aba "Banco de dados (Split 2)" do dashboard.
// Fonte: dashboard/index.html linhas 1719-1910.
//
// Parâmetros default idênticos ao HTML:
//   delta=0, odd=1.72, stake=1000, trigger='all', league='all', champion='all'
//
// Uso:
//   const { fetchAnaliseStats } = require('./analiseStats.cjs');
//   const { teams, leagues } = await fetchAnaliseStats(supabaseUrl, supabaseKey);
//   // teams: [{ name, hit, n, w, profit }], leagues: [{ name, hit, n, w, profit }]

'use strict';

const { supabaseGet } = require('./supabaseQuery.cjs');
const { normTeamName, normalizeLeague } = require('./normTeamName.cjs');

// Parâmetros default — espelham os defaults do HTML (linhas 1781-1786)
const DEFAULT_DELTA   = 0;
const DEFAULT_ODD     = 1.72;
const DEFAULT_STAKE   = 1000;
const DEFAULT_TRIGGER = 'all';
const DEFAULT_LEAGUE  = 'all';
const DEFAULT_CHAMP   = 'all';

/**
 * Busca bets do Supabase e aplica dedup defensiva idêntica ao dashboard.
 * Retorna array de bets prontos para simulação.
 */
async function fetchAndDedup(supabaseUrl, supabaseKey) {
  // Query base — idêntica às linhas 1721-1727 do dashboard
  const endpoint =
    '/rest/v1/bets' +
    '?select=*' +
    '&status=in.(green,red)' +
    '&is_method_bet=eq.true' +
    '&order=bet_datetime.desc' +
    '&limit=2000';

  const data = await supabaseGet(supabaseUrl, supabaseKey, endpoint);

  // DEDUP DEFENSIVA (linhas 1730-1742): se um gameId tem bet real, remove SIMULATED do mesmo game.
  const realGids = new Set();
  for (const b of data) {
    if (b.bookmaker !== 'SIMULATED') {
      const gid = b.raw_extraction?.match_context?.lolesports_game_id;
      if (gid) realGids.add(String(gid));
    }
  }
  const deduped = data.filter((b) => {
    if (b.bookmaker !== 'SIMULATED') return true;
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    return !gid || !realGids.has(String(gid));
  });

  return { raw: data.length, deduped: deduped.length, bets: deduped };
}

/**
 * Recomputa won/lost por bet com base em (fair + delta) e total_kills.
 * Replica getBetSimulation() do dashboard (linhas 1809-1832).
 *
 * @param {object} b     — row da tabela bets
 * @param {number} delta — ajuste sobre fair line (default 0)
 * @param {number} odd   — odd conservadora para decidir se real é fair+1 (default 1.72)
 * @returns {{ won: boolean, simLine: number, kills: number } | null}
 */
function getBetSimulation(b, delta, odd) {
  const mc = b.raw_extraction?.match_context || {};
  let baseLine = null;

  if (b.bookmaker === 'SIMULATED') {
    baseLine = mc.fair_line_calculated ?? null;
    if (baseLine == null) {
      // Fallback: extrai linha do pick (ex "Under 25.5")
      const match = (b.pick || '').match(/(\d+(?:[.,]\d+)?)/);
      if (match) baseLine = parseFloat(match[1].replace(',', '.'));
      // NÃO subtrair 1 aqui — SIMULATED salva a linha direta, sem delta de fair+1
    }
  } else {
    // Reais: extrai linha do pick (ex "Under 28.5 kills")
    const match = (b.pick || '').match(/(\d+(?:[.,]\d+)?)/);
    if (match) baseLine = parseFloat(match[1].replace(',', '.'));
    // Se odd < 1.72 → pickLine = fair+1 → volta pra fair subtraindo 1
    const realOdd = parseFloat(b.odd);
    if (!isNaN(realOdd) && realOdd < odd) baseLine = baseLine != null ? baseLine - 1 : null;
  }

  if (baseLine == null) return null;

  const simLine = baseLine + delta;
  const kills = mc.total_kills;
  if (kills == null) return null;

  const isOver = /over|mais de/i.test(b.pick || '');
  const won = isOver ? kills > simLine : kills < simLine;
  return { won, simLine, kills };
}

/**
 * Agrega bets simuladas por uma chave (time ou liga).
 * Replica aggBy() do dashboard (linhas 1873-1889).
 * n >= 1 pra aparecer na lista. n < 4 = amostra pequena (hit retorna com flag small_sample).
 *
 * @param {Array} simulated  — [{ b, sim }]
 * @param {Function} keyFn   — b => string[] (pode retornar múltiplas chaves por bet)
 * @param {number} stake
 * @param {number} odd
 * @returns {Array<{name, n, w, profit, hit, small_sample}>} sorted por hit desc
 */
function aggBy(simulated, keyFn, stake, odd) {
  const m = {};
  for (const { b, sim } of simulated) {
    const keys = keyFn(b);
    for (const k of keys) {
      if (!k) continue;
      if (!m[k]) m[k] = { name: k, n: 0, w: 0, profit: 0 };
      m[k].n++;
      if (sim.won) {
        m[k].w++;
        m[k].profit += stake * (odd - 1);
      } else {
        m[k].profit -= stake;
      }
    }
  }
  return Object.values(m)
    .filter((x) => x.n >= 1)
    .map((x) => ({ ...x, hit: Math.round((100 * x.w) / x.n), small_sample: x.n < 4 }))
    .sort((a, b) => b.hit - a.hit);
}

/**
 * Função principal: busca bets, simula, agrega por time e liga.
 * Parâmetros default = defaults do dashboard HTML.
 *
 * @param {string} supabaseUrl
 * @param {string} supabaseKey
 * @param {object} [opts]
 * @param {number} [opts.delta=0]
 * @param {number} [opts.odd=1.72]
 * @param {number} [opts.stake=1000]
 * @param {string} [opts.trigger='all']
 * @param {string} [opts.league='all']
 * @param {string} [opts.champion='all']
 * @returns {Promise<{teams: Array, leagues: Array, meta: object}>}
 */
async function fetchAnaliseStats(supabaseUrl, supabaseKey, opts = {}) {
  const delta   = opts.delta   != null ? opts.delta   : DEFAULT_DELTA;
  const odd     = opts.odd     != null ? opts.odd     : DEFAULT_ODD;
  const stake   = opts.stake   != null ? opts.stake   : DEFAULT_STAKE;
  const trigger = opts.trigger != null ? opts.trigger : DEFAULT_TRIGGER;
  const league  = opts.league  != null ? opts.league  : DEFAULT_LEAGUE;
  const champ   = opts.champ   != null ? opts.champ   : DEFAULT_CHAMP;

  const { raw, deduped, bets: rawBets } = await fetchAndDedup(supabaseUrl, supabaseKey);

  // Pré-popula cache de normTeamName com todos os times antes de filtrar
  for (const b of rawBets) { normTeamName(b.team_a); normTeamName(b.team_b); }

  // Aplica filtros (trigger / liga / champion) — replica linhas 1788-1804
  const bets = rawBets.filter((b) => {
    if (trigger !== 'all' && b.raw_extraction?.match_context?.trigger_type !== trigger) return false;
    if (league !== 'all' && normalizeLeague(b.league) !== league) return false;
    if (champ !== 'all') {
      const mc = b.raw_extraction?.match_context || {};
      let found = false;
      for (const side of ['blue_picks', 'red_picks']) {
        const p = mc[side] || {};
        for (const role of ['top', 'jungle', 'mid', 'adc', 'support']) {
          if (p[role] === champ) { found = true; break; }
        }
        if (found) break;
      }
      if (!found) return false;
    }
    return true;
  });

  // Simula cada bet
  const simulated = bets
    .map((b) => ({ b, sim: getBetSimulation(b, delta, odd) }))
    .filter((x) => x.sim != null);

  // Agrega por time (cada bet conta pros 2 times)
  const teams = aggBy(
    simulated,
    (b) => [normTeamName(b.team_a), normTeamName(b.team_b)],
    stake,
    odd
  );

  // Agrega por liga
  const leagues = aggBy(
    simulated,
    (b) => [normalizeLeague(b.league)],
    stake,
    odd
  );

  const meta = {
    raw,
    deduped,
    filtered: bets.length,
    simulated: simulated.length,
    params: { delta, odd, stake, trigger, league, champ },
    query: `/rest/v1/bets?select=*&status=in.(green,red)&is_method_bet=eq.true&order=bet_datetime.desc&limit=2000`,
  };

  return { teams, leagues, meta };
}

module.exports = { fetchAnaliseStats, getBetSimulation, aggBy };
