// scripts/audit/lib/audit-common.cjs
//
// Loader de bets (Supabase, paginado, SEM filtro de data no SQL) + constantes canônicas
// do método + funções duplicadas de settle-pending-bets.cjs (com sync-comment, MESMA
// semântica — padrão do projeto, ver CLAUDE.md "Definição autoritativa do método").
//
// Uso:
//   const {
//     loadAllBets, inScope, isEwc,
//     PEEL_PURE, FLEX_ENGAGE, LEAGUE_IDS, SPLIT2_FROM, SPLIT2_TO,
//     parsePick, detectTrigger, extractGameData, isFrameSuspect,
//   } = require('./lib/audit-common.cjs');

'use strict';

const path = require('path');
const { loadConfig } = require(path.resolve(__dirname, '..', '..', '..', '.claude', 'scripts', '_load-config.cjs'));
const { supabaseGet } = require(path.resolve(__dirname, '..', '..', '..', 'lib', 'supabaseQuery.cjs'));

const SPLIT2_FROM = '2026-04-01';
const SPLIT2_TO = '2026-07-01'; // exclusivo

// === Listas canônicas do método ===
// sync: settle-pending-bets.cjs L102 (PEEL_PURE) e L104 (FLEX_ENGAGE)
// FLEX_ENGAGE expandido 2026-05-23 (+Lux +Anivia) · Alistar REMOVIDO 2026-05-29
// (CEO: -26.8% ROI n=21) — se alguma lista de referência ainda tiver Alistar, é bug
// do código arquivado, não desse método (ver CLAUDE.md "Fora de escopo").
const PEEL_PURE = [
  'soraka', 'sona', 'janna', 'lulu', 'yuumi', 'karma',
  'seraphine', 'renataglasc', 'renata', 'nami', 'milio',
];
const FLEX_ENGAGE = ['bard', 'rakan', 'lux', 'anivia'];

// sync: lolesports-find-match.cjs L36-45 — confirmado consistente com
// rebuild_dashboard_stats_cron.cjs L37-45 pras 6 ligas abaixo (sem divergência).
// Nota: capture_fair_lines.cjs usa um CBLOL leagueId diferente (98767991325878492) —
// bug conhecido documentado no CLAUDE.md do projeto ("Ainda pendentes" #1), fora do
// escopo da fase 0 (não corrigido aqui).
const LEAGUE_IDS = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  LFL: '105266103462388553',
};

// === Bets: loader paginado (sem filtro de data no SQL) ===

const PAGE_SIZE = 1000;

// Busca TODAS as rows de `bets`, paginado via Range header (padrão de
// dedup-bets-audit.cjs). Propositalmente SEM filtro de data na query — o filtro de
// escopo (inScope) roda em JS depois, senão bet_datetime=null escaparia da busca
// silenciosamente em vez de virar finding.
async function loadAllBets() {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const bets = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const page = await supabaseGet(
      supabaseUrl,
      supabaseKey,
      '/rest/v1/bets?select=*&order=created_at.asc',
      { Range: `${offset}-${end}`, Prefer: 'count=exact' }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    bets.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return bets;
}

// bet_datetime dentro de [SPLIT2_FROM, SPLIT2_TO) OU null.
// null ENTRA no escopo de propósito — bet_datetime ausente é finding (HIGH), não deve
// escapar da auditoria silenciosamente.
function inScope(bet) {
  if (!bet.bet_datetime) return true;
  const d = bet.bet_datetime.slice(0, 10);
  return d >= SPLIT2_FROM && d < SPLIT2_TO;
}

// EWC = fora da Riot API (torneio ESL/Saudi), tratado à parte na fase 5 (best-effort).
function isEwc(bet) {
  const league = (bet.league || '').toUpperCase();
  if (league.includes('EWC')) return true;
  const gameId = bet.raw_extraction?.match_context?.lolesports_game_id;
  if (!gameId && league.startsWith('EWC')) return true;
  return false;
}

// === Duplicadas de settle-pending-bets.cjs (sync-comment por função) ===

const norm = (s) => (s ? s.toLowerCase().replace(/\s+/g, '') : '');
const isPurePeel = (sup) => sup && PEEL_PURE.includes(norm(sup));
const isFlexEngage = (sup) => sup && FLEX_ENGAGE.includes(norm(sup));

// sync: settle-pending-bets.cjs L169-175
function detectTrigger(supBlue, supRed) {
  const pures = (isPurePeel(supBlue) ? 1 : 0) + (isPurePeel(supRed) ? 1 : 0);
  const flexes = (isFlexEngage(supBlue) ? 1 : 0) + (isFlexEngage(supRed) ? 1 : 0);
  if (pures === 2) return '2peel';
  if (pures === 1 && flexes >= 1) return '1peel+flex';
  return null;
}

// sync: settle-pending-bets.cjs L179-195 (parsePick)
// Parser do pick: "Menos de 27.5" / "Under 27.5" / "Mais de 27.5" / "Over 27.5" / nome de time.
// Usa o ÚLTIMO número da string (evita capturar "Mapa 4" em "Total. Mapa 4 Menos de 27.5").
function parsePick(pickRaw, market) {
  const lower = (pickRaw || '').toLowerCase();
  const allMatches = Array.from(lower.matchAll(/(\d+(?:[.,]\d+)?)/g));
  const numMatch = allMatches.length ? allMatches[allMatches.length - 1] : null;
  const line = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;

  if (/menos\s*de|under/i.test(pickRaw || '')) return { kind: 'under', line };
  if (/mais\s*de|over/i.test(pickRaw || '')) return { kind: 'over', line };
  if (/money\s*line|vencedor|resultado\s*final/i.test(market || '')) {
    return { kind: 'moneyline', team_pick: pickRaw };
  }
  return { kind: 'unknown' };
}

// sync: settle-pending-bets.cjs L224-313 (extractGameData) + rebuild_dashboard_stats_cron.cjs
// L98-133 (fetchGameMeta) — versão consolidada pra auditoria: assinatura simplificada
// (só windowJson, sem trustCompleted — quem decide "confiar mesmo sem finished" é o
// caller via isFrameSuspect) e winnerSide com fallback pra towers quando inhibitors
// empatam (comportamento do rebuild, mais robusto que o settle puro).
function extractGameData(windowJson) {
  const meta = windowJson?.gameMetadata;
  if (!meta || !Array.isArray(windowJson.frames) || windowJson.frames.length === 0) return null;
  const lastFrame = windowJson.frames[windowJson.frames.length - 1];
  const blueMeta = meta.blueTeamMetadata;
  const redMeta = meta.redTeamMetadata;
  if (!blueMeta || !redMeta) return null;

  const supportOf = (md) => md.participantMetadata?.find((p) => p.role === 'support')?.championId || null;

  const kBlue = lastFrame.blueTeam?.totalKills ?? 0;
  const kRed = lastFrame.redTeam?.totalKills ?? 0;
  const blueInh = lastFrame.blueTeam?.inhibitors || 0;
  const redInh = lastFrame.redTeam?.inhibitors || 0;
  const blueTowers = lastFrame.blueTeam?.towers || 0;
  const redTowers = lastFrame.redTeam?.towers || 0;

  let winnerSide = null;
  if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
  else if (blueTowers !== redTowers) winnerSide = blueTowers > redTowers ? 'blue' : 'red';

  return {
    gameState: lastFrame.gameState,
    gameTimeMs: lastFrame.gameTime ?? null,
    kBlue,
    kRed,
    totalKills: kBlue + kRed,
    supBlue: supportOf(blueMeta),
    supRed: supportOf(redMeta),
    winnerSide,
    blueTeamId: String(blueMeta.esportsTeamId),
    redTeamId: String(redMeta.esportsTeamId),
  };
}

// sync: settle-pending-bets.cjs L216-222 (isFrameSuspect) — aceita tanto um frame cru
// da API (shape { gameState, gameTime, blueTeam, redTeam }) quanto o objeto já
// extraído por extractGameData() (shape { gameState, gameTimeMs, kBlue, kRed, totalKills }).
// Condição: gameState !== 'finished' E (gameTime<600s OU total_kills<5).
// Se não dá pra saber o gameTime (campo ausente), trata como suspeito por padrão —
// auditoria é conservadora, prefere marcar "verificar manual" a assumir dado bom.
function isFrameSuspect(input) {
  if (!input) return true;
  if (input.gameState === 'finished') return false;

  const isRawFrame = !!(input.blueTeam || input.redTeam);
  const gameTimeMs = isRawFrame ? input.gameTime : input.gameTimeMs;
  const totalKills = isRawFrame
    ? (input.blueTeam?.totalKills ?? 0) + (input.redTeam?.totalKills ?? 0)
    : input.totalKills ?? (input.kBlue ?? 0) + (input.kRed ?? 0);

  if (gameTimeMs == null) return true;
  const gameTimeSecs = gameTimeMs / 1000;
  return gameTimeSecs < 600 || totalKills < 5;
}

module.exports = {
  SPLIT2_FROM,
  SPLIT2_TO,
  PEEL_PURE,
  FLEX_ENGAGE,
  LEAGUE_IDS,
  loadAllBets,
  inScope,
  isEwc,
  parsePick,
  detectTrigger,
  extractGameData,
  isFrameSuspect,
};
