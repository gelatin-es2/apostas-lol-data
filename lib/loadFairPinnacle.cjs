// Carrega fair lines Pinnacle manual do arquivo cron-data/YYYY-MM-DD-fair-pinnacle.json.
// Retorna Map indexada por lolesports_match_id (primário) E por team_anchor normalizado (fallback).
//
// Uso:
//   const { loadFairPinnacle } = require('./lib/loadFairPinnacle.cjs');
//   const pinnacle = loadFairPinnacle('2026-05-23');
//   const line = pinnacle.byMatchId.get('115616219464541883');     // → 27.5
//   const line2 = pinnacle.byAnchor.get('we');                     // → { fair_line: 27.5, ... }

const fs = require('fs');
const path = require('path');

const CRON_DIR = path.resolve(__dirname, '..', 'cron-data');

/**
 * @param {string} date - YYYY-MM-DD
 * @returns {{ byMatchId: Map<string, number>, byAnchor: Map<string, { fair_line: number, liga: string, team_a: string, team_b: string }>, raw: object|null }}
 */
function loadFairPinnacle(date) {
  const file = path.join(CRON_DIR, `${date}-fair-pinnacle.json`);
  const result = {
    byMatchId: new Map(),
    byAnchor: new Map(),
    raw: null,
  };
  if (!fs.existsSync(file)) return result;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return result; }
  result.raw = j;
  for (const entry of (j.fair_lines || [])) {
    const line = entry.fair_line;
    if (line == null) continue;
    // Índice primário: lolesports_match_id (resolve durante /log-fair)
    if (entry.lolesports_match_id) {
      result.byMatchId.set(String(entry.lolesports_match_id), line);
    }
    // Índice secundário: team_anchor normalizado (lowercase, sem espaços)
    if (entry.team_anchor) {
      const anchor = entry.team_anchor.toLowerCase().replace(/\s+/g, '');
      result.byAnchor.set(anchor, {
        fair_line: line,
        liga: entry.liga || null,
        team_a: entry.team_a || null,
        team_b: entry.team_b || null,
        lolesports_match_id: entry.lolesports_match_id || null,
      });
    }
  }
  return result;
}

module.exports = { loadFairPinnacle };
