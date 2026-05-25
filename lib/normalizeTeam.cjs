// lib/normalizeTeam.cjs
// Resolve alias → nome canônico de time usando lib/team-aliases.json.
// Extraído de supabase-save-bet.cjs (2026-05-25) pra ser importável por outros scripts.
//
// Regras (em ordem):
//   1. nome em isolated_real_teams → retorna original (academy/sub-roster, não unificar)
//   2. nome em aliases → retorna canônico
//   3. nome desconhecido → retorna original + loga aviso (não bloqueia)

'use strict';

const fs = require('fs');
const path = require('path');

let TEAM_ALIASES = null;
let ISOLATED_TEAMS = new Set();

try {
  const aliasPath = path.resolve(__dirname, 'team-aliases.json');
  const aliasRaw = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
  TEAM_ALIASES = aliasRaw.aliases || {};
  ISOLATED_TEAMS = new Set(aliasRaw.isolated_real_teams?.list || []);
} catch (e) {
  process.stderr.write(`[AVISO] lib/normalizeTeam: team-aliases.json não carregado: ${e.message}. Nomes não serão normalizados.\n`);
}

/**
 * normalizeTeam(name) → string canônico
 * Sem efeito colateral em banco — só resolve string.
 */
function normalizeTeam(name) {
  if (!name || !TEAM_ALIASES) return name;
  // Regra 1: isolated (ex: Vitality.Bee, Karmine Corp Blue) — nunca unificar
  if (ISOLATED_TEAMS.has(name)) return name;
  // Regra 2: alias map
  if (TEAM_ALIASES[name]) return TEAM_ALIASES[name];
  // Regra 3: desconhecido — loga e retorna original
  process.stderr.write(`[AVISO] normalizeTeam: "${name}" não encontrado em team-aliases.json. Retornando original.\n`);
  return name;
}

module.exports = { normalizeTeam };
