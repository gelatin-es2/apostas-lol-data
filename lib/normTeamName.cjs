// Portado de dashboard/index.html (linha 1705) para uso em Node.js.
// normTeamName: normaliza nome de time para agrupamento (case insensitive + sem pontuação).
// normalizeLeague: canoniza nome de liga para string curta (LCK, LPL, etc.).
// IMPORTAR aqui; HTML ainda tem cópia local — não alterar o HTML.

'use strict';

// normTeamName: prefere mixed-case sobre all-upper sobre all-lower.
// Cache por processo (escopo módulo) — stateful, aceita múltiplas passadas.
const teamNormCache = {};
const teamScoreCache = {};

function normTeamName(name) {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hasLower = /[a-z]/.test(name);
  const hasUpper = /[A-Z]/.test(name);
  // Prefere mixed-case (score 3) > all-lower (score 2) > all-upper (score 1)
  const score = (hasLower && hasUpper) ? 3 : (hasLower ? 2 : 1);
  if (!teamNormCache[key] || teamScoreCache[key] < score) {
    teamNormCache[key] = name;
    teamScoreCache[key] = score;
  }
  return teamNormCache[key];
}

// Portado de dashboard/index.html (linha 885).
function normalizeLeague(league) {
  if (!league) return null;
  const knownCodes = ['LCK','LPL','LEC','CBLOL','LCS','MSI','Worlds','LFL','LIT','EUM'];
  if (knownCodes.includes(league)) return league;
  const u = league.toUpperCase();
  if (/EWC|ESPORTS WORLD CUP/.test(u)) return 'EWC';
  if (/CBLOL|BRASIL/.test(u)) return 'CBLOL';
  if (/\bLCK\b/.test(u)) return 'LCK';
  if (/\bLPL\b/.test(u)) return 'LPL';
  if (/\bLEC\b/.test(u)) return 'LEC';
  if (/\bLCS\b/.test(u)) return 'LCS';
  if (/MSI/.test(u)) return 'MSI';
  if (/WORLDS|CHAMPIONSHIP/.test(u)) return 'Worlds';
  if (/\bLFL\b|LIGUE FRAN/.test(u)) return 'LFL';
  if (/\bLIT\b|ITALIAN/.test(u)) return 'LIT';
  if (/EMEA MASTERS|\bEUM\b/.test(u)) return 'EUM';
  return league;
}

module.exports = { normTeamName, normalizeLeague };
