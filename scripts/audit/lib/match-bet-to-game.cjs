// scripts/audit/lib/match-bet-to-game.cjs
//
// Liga bet (Supabase) ↔ game do universo (audit-output/00-universe.json). Usado pelas
// fases 1 e 2 — extraído em lib pra não duplicar a lógica de matching entre elas (a
// contagem de cobertura da fase 1 tem que ser EXATAMENTE a mesma que a fase 2 usa pra
// achar o game de cada bet, senão os dois relatórios divergem sem motivo real).
//
// Estratégia em camadas (da mais confiável pra mais "melhor esforço"):
//   1. match_context.lolesports_game_id — chave primária, usada por ~99% das bets.
//   2. Chaves alternativas de game_id no match_context (ex: "map3_game_id",
//      "game_id_map2") — settle manual do CEO usou nome de campo não-canônico em
//      alguns casos (bet settled via print, CDN livestats indisponível). Ainda é
//      match EXATO por id, só não está na chave canônica.
//   3. lolesports_match_id + map_number — o match_id aponta pro confronto, sobra achar
//      QUAL mapa bate com bet.map_number dentro do universo daquele match_id.
//   4. Fallback do plano: nomes normalizados (lib/normTeamName.cjs) + data ±1 dia +
//      map_number — pra bets sem NENHUM id utilizável (raro; só bets settled 100%
//      manual/antigas).
//
// Uso:
//   const { buildUniverseIndex, findGameForBet, strictTeamMatch, resolveMoneylineSide }
//     = require('./lib/match-bet-to-game.cjs');
//   const idx = buildUniverseIndex(universeArray);
//   const { game, tier, ambiguous, candidateCount } = findGameForBet(bet, idx);

'use strict';

const { normTeamName } = require('../../../lib/normTeamName.cjs');

function buildUniverseIndex(universe) {
  const byGameId = new Map();
  const byMatchId = new Map();
  for (const g of universe) {
    byGameId.set(String(g.game_id), g);
    const mid = String(g.match_id);
    if (!byMatchId.has(mid)) byMatchId.set(mid, []);
    byMatchId.get(mid).push(g);
  }
  return { byGameId, byMatchId, all: universe };
}

// sync: lolesports-find-match.cjs L76-96 (norm + strictTeamMatch) — mesma heurística:
// match exato (case/pontuação insensível) OU prefixo real com >=4 chars.
function teamKey(name) {
  return name ? name.toLowerCase().replace(/[\s.\-']/g, '') : '';
}

function strictTeamMatch(q, list) {
  const nq = teamKey(q);
  if (!nq) return false;
  for (const item of list) {
    if (!item) continue;
    if (teamKey(item) === nq) return true;
  }
  if (nq.length >= 4) {
    for (const item of list) {
      if (!item) continue;
      const ni = teamKey(item);
      if (ni.startsWith(nq) || nq.startsWith(ni)) return true;
    }
  }
  return false;
}

// Chaves alternativas de game_id que apareceram em settle manual (fora do path
// canônico match_context.lolesports_game_id). Qualquer chave terminando em "game_id"
// com valor numérico (string de dígitos) é candidata.
function findAltGameIds(matchContext) {
  if (!matchContext || typeof matchContext !== 'object') return [];
  const ids = [];
  for (const [key, val] of Object.entries(matchContext)) {
    if (key === 'lolesports_game_id') continue;
    if (!/game_id/i.test(key)) continue;
    if (typeof val === 'string' && /^\d+$/.test(val)) ids.push(val);
    if (typeof val === 'number' && Number.isInteger(val)) ids.push(String(val));
  }
  return ids;
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / (24 * 3600 * 1000);
}

// Fallback camada 4: normaliza nomes via normTeamName (achata pra chave case/pontuação
// insensível — mesma função usada pelo dashboard pra agrupar variações do mesmo time),
// e casa dentro de uma janela de ±1 dia + map_number igual.
function findByTeamsDateMap(bet, universe) {
  const teamA = normTeamName(bet.team_a) || bet.team_a;
  const teamB = normTeamName(bet.team_b) || bet.team_b;
  if (!teamA || !teamB || !bet.bet_datetime) return { game: null, ambiguous: false, candidateCount: 0 };

  const candidates = universe.filter((g) => {
    if (bet.map_number != null && g.map_number !== bet.map_number) return false;
    if (daysBetween(bet.bet_datetime, g.date) > 1) return false;
    const pool = [g.team_blue, g.team_red, ...(g.teams_match || [])];
    const matchA = strictTeamMatch(teamA, pool);
    const matchB = strictTeamMatch(teamB, pool);
    return matchA && matchB;
  });

  if (candidates.length === 1) return { game: candidates[0], ambiguous: false, candidateCount: 1 };
  if (candidates.length > 1) return { game: null, ambiguous: true, candidateCount: candidates.length };
  return { game: null, ambiguous: false, candidateCount: 0 };
}

function findGameForBet(bet, index) {
  const mc = bet.raw_extraction?.match_context || {};

  // Tier 1: game_id canônico
  const gid = mc.lolesports_game_id;
  if (gid) {
    const game = index.byGameId.get(String(gid));
    if (game) return { game, tier: 'game_id', ambiguous: false, candidateCount: 1 };
  }

  // Tier 2: game_id alternativo (settle manual)
  for (const altId of findAltGameIds(mc)) {
    const game = index.byGameId.get(String(altId));
    if (game) return { game, tier: 'game_id_alt', ambiguous: false, candidateCount: 1 };
  }

  // Tier 3: match_id + map_number
  const matchId = mc.lolesports_match_id;
  if (matchId) {
    const candidates = index.byMatchId.get(String(matchId)) || [];
    if (candidates.length) {
      if (bet.map_number != null) {
        const hit = candidates.find((g) => g.map_number === bet.map_number);
        if (hit) return { game: hit, tier: 'match_id_map', ambiguous: false, candidateCount: 1 };
      } else if (candidates.length === 1) {
        return { game: candidates[0], tier: 'match_id_map', ambiguous: false, candidateCount: 1 };
      } else {
        return { game: null, tier: null, ambiguous: true, candidateCount: candidates.length };
      }
    }
  }

  // Tier 4: nomes normalizados + data ±1d + map_number
  const fb = findByTeamsDateMap(bet, index.all);
  if (fb.game) return { game: fb.game, tier: 'team_date_map', ambiguous: false, candidateCount: 1 };
  return { game: null, tier: null, ambiguous: fb.ambiguous, candidateCount: fb.candidateCount };
}

// Resolve o side (blue/red) do pick de uma bet Money Line. Melhor esforço, em 2 passos:
//   A. Se raw_extraction.compositions tiver side explícito (team_a/team_b com
//      side='blue'|'red'), casa o texto do pick contra os nomes ali (mais confiável —
//      side já veio do próprio settle/registro, não precisa inferir).
//   B. Senão, casa o pick contra bet.team_a/team_b, depois casa o vencedor contra
//      game.team_blue/team_red.
// Retorna null se ambíguo (chamador deve classificar como MANUAL_CHECK).
function resolveMoneylineSide(bet, game) {
  const pick = bet.raw_extraction?.pick || bet.pick;
  const comps = bet.raw_extraction?.compositions;

  if (comps?.team_a?.name && comps?.team_b?.name) {
    const aIsPick = strictTeamMatch(pick, [comps.team_a.name]);
    const bIsPick = strictTeamMatch(pick, [comps.team_b.name]);
    if (aIsPick && !bIsPick && comps.team_a.side && comps.team_a.side !== 'unknown') {
      return comps.team_a.side;
    }
    if (bIsPick && !aIsPick && comps.team_b.side && comps.team_b.side !== 'unknown') {
      return comps.team_b.side;
    }
  }

  if (!game || !game.team_blue || !game.team_red) return null; // suspect/fetch_error: sem side confiável

  const aIsPick = strictTeamMatch(pick, [bet.team_a]);
  const bIsPick = strictTeamMatch(pick, [bet.team_b]);
  let pickedTeamName = null;
  if (aIsPick && !bIsPick) pickedTeamName = bet.team_a;
  else if (bIsPick && !aIsPick) pickedTeamName = bet.team_b;
  else return null; // ambíguo ou não bateu em nenhum

  const isBlue = strictTeamMatch(pickedTeamName, [game.team_blue]);
  const isRed = strictTeamMatch(pickedTeamName, [game.team_red]);
  if (isBlue && !isRed) return 'blue';
  if (isRed && !isBlue) return 'red';
  return null;
}

module.exports = {
  buildUniverseIndex,
  findGameForBet,
  strictTeamMatch,
  resolveMoneylineSide,
};
