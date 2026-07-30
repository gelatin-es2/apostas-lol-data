// Portado de dashboard/index.html (linha 1705) para uso em Node.js.
// normTeamName: normaliza nome de time para agrupamento (case insensitive + sem pontuação).
// normalizeLeague: canoniza nome de liga para string curta (LCK, LPL, etc.).
// IMPORTAR aqui; HTML ainda tem cópia local — não alterar o HTML.

'use strict';

const fs = require('fs');
const path = require('path');

// Fix 2026-07-30 (auditoria under/over, item 5): normTeamName só agrupava por
// case/pontuação — "Karmine" e "Karmine Corp" (ou "BLG"/"BILIBILI GAMING",
// "TES"/"TOP ESPORTS", "WE"/"Xi'an Team WE") ficavam fragmentados na leitura
// mesmo já existindo alias em team-aliases.json (esse mapa só era aplicado no
// WRITE, por supabase-save-bet.cjs). Agora resolve o alias ANTES de cachear,
// então toda variante converge pro mesmo canônico (curto) na leitura também.
let aliasMap = null;
function loadAliasMap() {
  if (aliasMap) return aliasMap;
  aliasMap = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'team-aliases.json'), 'utf8'));
    for (const [alias, canon] of Object.entries(raw.aliases || {})) {
      aliasMap[alias.toLowerCase().replace(/[^a-z0-9]/g, '')] = canon;
    }
  } catch (e) {
    aliasMap = {};
  }
  return aliasMap;
}

// normTeamName: resolve alias (team-aliases.json) e depois prefere mixed-case
// sobre all-upper sobre all-lower dentre as variantes vistas do canônico.
// Cache por processo (escopo módulo) — stateful, aceita múltiplas passadas.
const teamNormCache = {};
const teamScoreCache = {};

function normTeamName(name) {
  if (!name) return null;
  const aliases = loadAliasMap();
  const rawKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolved = aliases[rawKey] || name;
  const key = resolved.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hasLower = /[a-z]/.test(resolved);
  const hasUpper = /[A-Z]/.test(resolved);
  // Prefere mixed-case (score 3) > all-lower (score 2) > all-upper (score 1)
  const score = (hasLower && hasUpper) ? 3 : (hasLower ? 2 : 1);
  if (!teamNormCache[key] || teamScoreCache[key] < score) {
    teamNormCache[key] = resolved;
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
