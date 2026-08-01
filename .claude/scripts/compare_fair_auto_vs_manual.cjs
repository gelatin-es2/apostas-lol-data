#!/usr/bin/env node
'use strict';

// Comparativo READ-ONLY entre a fair Pinnacle manual do Elvis (/log-fair →
// cron-data/YYYY-MM-DD-fair-pinnacle.json, PRIMÁRIA) e a captura automática
// (capture_pinnacle_kills_auto.cjs → cron-data/YYYY-MM-DD-fair-pinnacle-auto.json).
//
// Não escreve nada em lugar nenhum — só lê os 2 JSONs e imprime tabela no stdout.
//
// Uso:
//   node .claude/scripts/compare_fair_auto_vs_manual.cjs               → hoje (fuso local)
//   node .claude/scripts/compare_fair_auto_vs_manual.cjs --date 2026-08-01

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CRON_DIR = path.join(REPO, 'cron-data');

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const argv = process.argv.slice(2);
const dateFlagIdx = argv.indexOf('--date');
const DATE = dateFlagIdx >= 0 && argv[dateFlagIdx + 1] ? argv[dateFlagIdx + 1] : todayLocal();

// Aliases de código curto → nome mais completo, só pra ajudar o fuzzy match quando o
// `team_a`/`team_b` do arquivo manual já vem como o código curto (ex: "TES", "JDG") em
// vez do nome por extenso que a Pinnacle usa. Copiado (leitura, não import) de
// capture_fair_lines.cjs:105-129 — não altera o original, é só apoio de matching aqui.
const TEAM_CODE_ALIASES = {
  // LCK
  T1: 'T1', GEN: 'Gen.G', GENG: 'Gen.G', KT: 'KT Rolster', HLE: 'Hanwha Life Esports',
  DK: 'Dplus KIA', BRO: 'HANJIN BRION', NS: 'Nongshim Redforce',
  DRX: 'Kiwoom DRX', DNS: 'DN SOOPers', BFX: 'BNK FearX',
  // LPL
  BLG: 'Bilibili Gaming', JDG: 'JD Gaming', EDG: 'EDward Gaming', IG: 'Invictus Gaming',
  TES: 'Top Esports', WBG: 'Weibo Gaming', AL: "Anyone's Legend",
  TT: 'ThunderTalk Gaming', LGD: 'LGD Gaming', NIP: 'Ninjas in Pyjamas',
  OMG: 'Oh My God', FPX: 'FunPlus Phoenix', RNG: 'Royal Never Give Up',
  RA: 'Rare Atom', LNG: 'LNG Esports', UP: 'Ultra Prime', WE: 'Team WE',
  // LEC
  G2: 'G2 Esports', FNC: 'Fnatic', MAD: 'MAD Lions KOI', SK: 'SK Gaming',
  KOI: 'Movistar KOI', BDS: 'Team BDS', GX: 'GIANTX', TH: 'Team Heretics',
  KC: 'Karmine Corp', RGE: 'Rogue', VIT: 'Team Vitality', NAVI: 'Natus Vincere',
  SHFT: 'Shifters',
  // LCS
  C9: 'Cloud9', TL: 'Team Liquid', FLY: 'FlyQuest', '100T': '100 Thieves',
  NRG: 'NRG', DIG: 'Disguised', SR: 'Shopify Rebellion', IMT: 'Immortals',
  EG: 'Evil Geniuses', GG: 'Golden Guardians', LYON: 'LYON',
  // CBLOL
  LOUD: 'LOUD', PNG: 'paiN Gaming', FUR: 'FURIA', RED: 'RED Canids',
  KBM: 'KaBuM! e-Sports', VKS: 'Vivo Keyd Stars', INTZ: 'INTZ',
  ITZ: 'Isurus Estral', FLX: 'Fluxo W7M', LEV: 'Leviatan Esports',
};

function normName(s) {
  return (s || '').toLowerCase().replace(/[\s.\-'’]/g, '');
}

// true se `a` e `b` "casam": iguais depois de normalizar, ou um é substring
// não-trivial do outro (min 3 chars pra evitar falso-positivo tipo "T1"⊂"T1 Academy").
function namesMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

function resolveAlias(name) {
  if (!name) return null;
  const key = name.toUpperCase().trim();
  return TEAM_CODE_ALIASES[key] || null;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const manualFile = path.join(CRON_DIR, `${DATE}-fair-pinnacle.json`);
const autoFile = path.join(CRON_DIR, `${DATE}-fair-pinnacle-auto.json`);

const manual = loadJson(manualFile);
const auto = loadJson(autoFile);

console.log(`[compare] data: ${DATE}`);
console.log(`[compare] manual: ${manualFile} ${manual ? `(${(manual.fair_lines || []).length} entradas)` : '— NÃO ENCONTRADO'}`);
console.log(`[compare] auto:   ${autoFile} ${auto ? `(${(auto.games || []).length} jogos)` : '— NÃO ENCONTRADO'}`);
console.log('');

if (!manual || !auto) {
  console.log('[compare] faltando 1 dos 2 arquivos — nada pra cruzar.');
  process.exit(0);
}

const manualEntries = manual.fair_lines || [];
const autoGames = auto.games || [];

// Bipartite: casa os 2 times do lado manual com os 2 times do lado auto, em qualquer
// ordem (home/away pode vir trocado entre as 2 fontes).
function findAutoMatch(entry) {
  const league = (entry.liga || '').toUpperCase();
  const sameLeague = autoGames.filter((g) => (g.league || '').toUpperCase() === league);
  const pool = sameLeague.length ? sameLeague : autoGames;

  const candsA = [entry.team_a, entry.team_anchor, resolveAlias(entry.team_anchor), resolveAlias(entry.team_a)].filter(Boolean);
  const candsB = [entry.team_b, resolveAlias(entry.team_b)].filter(Boolean);

  const matches = pool.filter((g) => {
    const aVsAuto1 = candsA.some((c) => namesMatch(c, g.team_a));
    const bVsAuto2 = candsB.some((c) => namesMatch(c, g.team_b));
    const aVsAuto2 = candsA.some((c) => namesMatch(c, g.team_b));
    const bVsAuto1 = candsB.some((c) => namesMatch(c, g.team_a));
    return (aVsAuto1 && bVsAuto2) || (aVsAuto2 && bVsAuto1);
  });

  if (matches.length === 1) return { game: matches[0], ambiguous: false, candidates: matches };
  if (matches.length > 1) return { game: null, ambiguous: true, candidates: matches };
  return { game: null, ambiguous: false, candidates: [] };
}

const rows = [];
let matched = 0, ambiguous = 0, missing = 0;

for (const entry of manualEntries) {
  const { game, ambiguous: isAmbiguous, candidates } = findAutoMatch(entry);
  let status;
  if (game) { status = 'ok'; matched++; }
  else if (isAmbiguous) { status = `ambíguo (${candidates.length} candidatos)`; ambiguous++; }
  else { status = 'sem captura auto'; missing++; }

  rows.push({
    liga: entry.liga || '?',
    jogo: `${entry.team_a} vs ${entry.team_b}`,
    fair_manual: entry.fair_line != null ? entry.fair_line.toFixed(1) : '—',
    map1_auto: game && game.map1_main_line != null ? game.map1_main_line.toFixed(1) : '—',
    map2_auto: game && game.map2_main_line != null ? game.map2_main_line.toFixed(1) : '—',
    diff: game && game.map1_main_line != null && entry.fair_line != null
      ? (game.map1_main_line - entry.fair_line >= 0 ? '+' : '') + (game.map1_main_line - entry.fair_line).toFixed(1)
      : '—',
    minutes_before_start: game && game.minutes_before_start != null ? String(game.minutes_before_start) : '—',
    frozen: game ? (game.frozen ? 'sim' : 'não') : '—',
    status,
  });
}

// Monta tabela texto simples (sem dependência npm).
const cols = [
  { key: 'liga', label: 'Liga', w: 6 },
  { key: 'jogo', label: 'Jogo', w: 34 },
  { key: 'fair_manual', label: 'Fair manual', w: 11 },
  { key: 'map1_auto', label: 'Map1 auto', w: 9 },
  { key: 'map2_auto', label: 'Map2 auto', w: 9 },
  { key: 'diff', label: 'Diff', w: 6 },
  { key: 'minutes_before_start', label: 'Min. antes', w: 10 },
  { key: 'frozen', label: 'Frozen', w: 6 },
  { key: 'status', label: 'Status', w: 20 },
];

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

console.log(cols.map((c) => pad(c.label, c.w)).join(' | '));
console.log(cols.map((c) => '-'.repeat(c.w)).join('-|-'));
for (const r of rows) {
  console.log(cols.map((c) => pad(r[c.key], c.w)).join(' | '));
}

console.log('');
console.log(`[compare] ${matched} casados, ${ambiguous} ambíguos, ${missing} sem captura auto (de ${manualEntries.length} entradas manuais).`);

const autoOnly = autoGames.length - matched - ambiguous; // aproximação: jogos auto que nenhum manual reivindicou
if (autoGames.length && autoOnly > 0) {
  console.log(`[compare] captura auto tem ${autoGames.length} jogos no total (pode incluir jogos fora do que o Elvis registrou manualmente).`);
}
