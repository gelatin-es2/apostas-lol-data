// Carrega fair lines Pinnacle manual do arquivo cron-data/YYYY-MM-DD-fair-pinnacle.json.
// Retorna Map indexada por lolesports_match_id (primário) E por team_anchor normalizado (fallback).
//
// Uso:
//   const { loadFairPinnacle } = require('./lib/loadFairPinnacle.cjs');
//   const pinnacle = loadFairPinnacle('2026-05-23');
//   const line = pinnacle.byMatchId.get('115616219464541883');     // → 27.5
//   const line2 = pinnacle.byAnchor.get('we');                     // → { fair_line: 27.5, ... }
//   // lookup robusto (substring/prefix):
//   const line3 = pinnacle.lookupByName('Gen.G Esports', 'DN SOOPers'); // → 27.5

const fs = require('fs');
const path = require('path');

const CRON_DIR = path.resolve(__dirname, '..', 'cron-data');

/** Normaliza nome pra comparação: lowercase, sem espaços, sem pontuação. */
function normName(s) {
  return (s || '').toLowerCase().replace(/[\s.\-_]/g, '');
}

/**
 * Dado um nome de time do calendário e as entradas do JSON, tenta casar via:
 *   1. anchor normalizado === nameNorm (exact)
 *   2. anchor normalizado é substring de nameNorm (prefixo/abreviação)
 *      → só aceita se candidato for ÚNICO (evita "T1" casando com "T1 Academy")
 *
 * @param {string} name - nome do time vindo da API (ex: "Gen.G Esports")
 * @param {Array} entries - array de entradas fair_lines
 * @returns {{ fair_line: number, ... }|null}
 */
function findEntryByName(name, entries) {
  if (!name) return null;
  const nameNorm = normName(name);

  // Exact match primeiro
  for (const e of entries) {
    if (!e.team_anchor) continue;
    if (normName(e.team_anchor) === nameNorm) return e;
  }

  // Substring: anchor é prefixo/sub de nameNorm (ex: "geng" ⊂ "gengesports")
  const candidates = entries.filter(e => {
    if (!e.team_anchor) return false;
    const a = normName(e.team_anchor);
    return a.length > 0 && nameNorm.includes(a);
  });
  // Aceita só quando candidato único (sem ambiguidade)
  if (candidates.length === 1) return candidates[0];

  return null;
}

/**
 * @param {string} date - YYYY-MM-DD
 * @returns {{ byMatchId: Map<string, number>, byAnchor: Map<string, { fair_line: number, liga: string, team_a: string, team_b: string }>, lookupByName: (nameA: string, nameB: string) => number|null, raw: object|null }}
 */
function loadFairPinnacle(date) {
  const file = path.join(CRON_DIR, `${date}-fair-pinnacle.json`);
  const result = {
    byMatchId: new Map(),
    byAnchor: new Map(),
    raw: null,
    lookupByName: () => null,
  };
  if (!fs.existsSync(file)) return result;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return result; }
  result.raw = j;
  const entries = j.fair_lines || [];
  for (const entry of entries) {
    const line = entry.fair_line;
    if (line == null) continue;
    // Índice primário: lolesports_match_id (resolve durante /log-fair)
    if (entry.lolesports_match_id) {
      result.byMatchId.set(String(entry.lolesports_match_id), line);
    }
    // Índice secundário: team_anchor normalizado (lowercase, sem espaços)
    if (entry.team_anchor) {
      const anchor = normName(entry.team_anchor);
      result.byAnchor.set(anchor, {
        fair_line: line,
        liga: entry.liga || null,
        team_a: entry.team_a || null,
        team_b: entry.team_b || null,
        lolesports_match_id: entry.lolesports_match_id || null,
      });
    }
  }

  // lookupByName: fallback robusto quando byMatchId e byAnchor (por código) falham.
  // Testa nameA e nameB contra todos os anchors via exact+substring (único candidato).
  result.lookupByName = (nameA, nameB) => {
    const eA = findEntryByName(nameA, entries);
    if (eA) return eA.fair_line;
    const eB = findEntryByName(nameB, entries);
    if (eB) return eB.fair_line;
    return null;
  };

  return result;
}

module.exports = { loadFairPinnacle };
