// Salva uma bet no Supabase (POST em /rest/v1/bets).
// Uso: echo '<json>' | node supabase-save-bet.cjs
//   ou: node supabase-save-bet.cjs <path-to-json-file>
// Output: JSON da row criada (incluindo id gerado pelo Supabase)
//
// Campos esperados no JSON de input (todos opcionais exceto bookmaker, team_a/b, market, pick, odd, stake):
//   bookmaker, league, team_a, team_b, market, pick, odd, stake,
//   bet_datetime, is_map_bet, map_number, status (default 'pending'),
//   pandascore_match_id, screenshot_path, raw_extraction (objeto), notes

const fs = require('fs');
const https = require('https');
const path = require('path');
const { loadConfig } = require('./_load-config.cjs');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');

// ─── Normalização de nomes de time ──────────────────────────────────────────
// Carrega alias map de lib/team-aliases.json. Fallback seguro: se falhar,
// salva sem normalizar (não bloqueia o fluxo do save).
let TEAM_ALIASES = null;
let ISOLATED_TEAMS = new Set();
try {
  const aliasPath = path.resolve(__dirname, '../../lib/team-aliases.json');
  const aliasRaw = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
  TEAM_ALIASES = aliasRaw.aliases || {};
  ISOLATED_TEAMS = new Set(aliasRaw.isolated_real_teams?.list || []);
} catch (e) {
  console.error(`[AVISO] team-aliases.json não carregado: ${e.message}. Salvando sem normalizar nomes.`);
}

/**
 * normalizeTeam: resolve alias → canônico.
 * Regras (em ordem):
 *  1. nome está em isolated_real_teams → retorna original (academy/sub-roster, não toca)
 *  2. nome está em aliases → retorna canônico
 *  3. caso contrário → retorna original e loga aviso (audit trail)
 */
function normalizeTeam(name) {
  if (!name || !TEAM_ALIASES) return name;
  // Regra 1: isolated (ex: Karmine Corp Blue, Vitality.Bee) — nunca unificar
  if (ISOLATED_TEAMS.has(name)) return name;
  // Regra 2: alias map
  if (TEAM_ALIASES[name]) {
    if (TEAM_ALIASES[name] !== name) {
      console.error(`[NORM] ${name} → ${TEAM_ALIASES[name]}`);
    }
    return TEAM_ALIASES[name];
  }
  // Regra 3: nome desconhecido — loga pra audit trail, salva original
  console.error(`[AVISO] time não encontrado no alias_map: "${name}". Salvando original. Considere adicionar em lib/team-aliases.json.`);
  return name;
}

const REQUIRED = ['bookmaker', 'team_a', 'team_b', 'market', 'pick', 'odd', 'stake'];

// Lista canônica de bookmakers (lowercase). Qualquer valor fora dessa lista é rejeitado.
// Sincronizar com normalize-bookmakers.cjs quando adicionar nova casa.
const VALID_BOOKMAKERS = [
  'pinnacle', 'estrelabet', 'parimatch', 'betano',
  'thunderpick', 'novibet', 'polymarket', 'simulated',
];

// Flag de bypass pra casos legítimos (ex: teste, casa nova ainda não na lista).
// Uso: ALLOW_UNKNOWN_BOOKMAKER=1 node supabase-save-bet.cjs <file>
const ALLOW_UNKNOWN_BOOKMAKER = process.env.ALLOW_UNKNOWN_BOOKMAKER === '1';

// Flag de bypass pra bets sem lolesports_match_id (ex: EWC, ligas não cobertas).
// Uso: ALLOW_MISSING_MATCH_ID=1 node supabase-save-bet.cjs <file>
const ALLOW_MISSING_MATCH_ID = process.env.ALLOW_MISSING_MATCH_ID === '1';

function postJson(supabaseUrl, supabaseKey, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const data = JSON.stringify(body);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // Lê input: stdin ou arquivo
  let inputRaw;
  const fileArg = process.argv[2];
  if (fileArg && fileArg !== '-') {
    inputRaw = fs.readFileSync(fileArg, 'utf8');
  } else {
    inputRaw = fs.readFileSync(0, 'utf8'); // stdin
  }

  let bet;
  try { bet = JSON.parse(inputRaw); }
  catch (e) { console.error(`Input não é JSON válido: ${e.message}`); process.exit(1); }

  // Validação dos campos obrigatórios
  const missing = REQUIRED.filter(k => bet[k] === undefined || bet[k] === null || bet[k] === '');
  if (missing.length > 0) {
    console.error(`Campos obrigatórios faltando: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validação: bookmaker deve estar na lista canônica (lowercase).
  // Bypass: ALLOW_UNKNOWN_BOOKMAKER=1 (ex: casa nova ainda não cadastrada)
  const bookmakerNorm = (bet.bookmaker || '').toLowerCase().trim();
  if (!VALID_BOOKMAKERS.includes(bookmakerNorm)) {
    if (ALLOW_UNKNOWN_BOOKMAKER) {
      console.error(`[AVISO] bookmaker "${bet.bookmaker}" não está na lista canônica. Prosseguindo (ALLOW_UNKNOWN_BOOKMAKER=1).`);
    } else {
      console.error(`bookmaker "${bet.bookmaker}" não é canônico. Lista válida: ${VALID_BOOKMAKERS.join(', ')}`);
      console.error('Para forçar: ALLOW_UNKNOWN_BOOKMAKER=1 node supabase-save-bet.cjs <file>');
      process.exit(1);
    }
  }
  // Normaliza case antes de salvar (independente de bypass)
  bet.bookmaker = bookmakerNorm;

  // Validação: lolesports_match_id é obrigatório em bets de ligas cobertas pelo lolesports.
  // Bets de EWC/ligas externas são isentas (settle usa fallback por design).
  // Bypass: ALLOW_MISSING_MATCH_ID=1 (ex: EWC, ligas externas ao lolesports)
  const matchId = bet.raw_extraction?.match_context?.lolesports_match_id;
  if (!matchId) {
    if (ALLOW_MISSING_MATCH_ID) {
      console.error(`[AVISO] lolesports_match_id ausente. Prosseguindo (ALLOW_MISSING_MATCH_ID=1). Settle usará fallback por league+teams+date.`);
    } else {
      console.error(`lolesports_match_id ausente em raw_extraction.match_context. Campo obrigatório pra settle correto.`);
      console.error('Para bets de EWC ou ligas externas: ALLOW_MISSING_MATCH_ID=1 node supabase-save-bet.cjs <file>');
      process.exit(1);
    }
  }

  // Defaults
  if (!bet.status) bet.status = 'pending';
  if (typeof bet.is_map_bet !== 'boolean') bet.is_map_bet = false;

  // Tenta popular fair_pinnacle/fair_formula/fair_line_source já na inserção.
  // Se Pinnacle ainda não foi logado (caso comum — bet antes de /log-fair),
  // fica NULL e settle popula depois quando Elvis já rodou /log-fair.
  if (bet.fair_pinnacle === undefined && bet.bet_datetime) {
    const betDate = bet.bet_datetime.slice(0, 10); // YYYY-MM-DD
    const matchId = bet.raw_extraction?.match_context?.lolesports_match_id;
    const pinnacle = loadFairPinnacle(betDate);
    const pinnacleVal = matchId ? (pinnacle.byMatchId.get(String(matchId)) ?? null) : null;
    bet.fair_pinnacle = pinnacleVal;
    // fair_formula só é conhecida pelo analyze — não calcula aqui (requer histórico 21d)
    // settle vai preencher fair_formula quando tiver o results.json disponível
    bet.fair_formula = bet.fair_formula ?? null;
    bet.fair_line_source = pinnacleVal != null ? 'pinnacle_manual' : null;
  }

  // Coerção numérica
  bet.odd = Number(bet.odd);
  bet.stake = Number(bet.stake);
  if (bet.map_number !== undefined && bet.map_number !== null) bet.map_number = parseInt(bet.map_number, 10);

  if (isNaN(bet.odd) || isNaN(bet.stake)) {
    console.error('odd e stake devem ser numéricos');
    process.exit(1);
  }

  // Normaliza nomes de time: alias → canônico (ex: FX → Fluxo, WBG → WeiboGaming)
  // Aplica em team_a, team_b e raw_extraction.match_context.team_a/team_b
  bet.team_a = normalizeTeam(bet.team_a);
  bet.team_b = normalizeTeam(bet.team_b);
  if (bet.raw_extraction?.match_context) {
    const mc = bet.raw_extraction.match_context;
    if (mc.team_a) mc.team_a = normalizeTeam(mc.team_a);
    if (mc.team_b) mc.team_b = normalizeTeam(mc.team_b);
  }

  // Guard 2026-05-20: bet_datetime deve estar consistente com match start_time.
  // Erro recorrente: agente passa "hoje" interpretando data errada e bet fica
  // pending eterna porque settle não encontra na janela bet_datetime+6h.
  // Regra: bet_datetime entre [start_time - 24h, start_time + 12h]. Fora disso = erro humano.
  // (24h cobre bet placed na noite anterior; mais que isso é raro pra Total Kills e
  // quase sempre indica confusão de data — bug KCB 2026-05-20 teve diff -40h.)
  const matchStartIso = bet.raw_extraction?.match_context?.start_time;
  if (bet.bet_datetime && matchStartIso) {
    const betMs = new Date(bet.bet_datetime).getTime();
    const matchMs = new Date(matchStartIso).getTime();
    if (Number.isFinite(betMs) && Number.isFinite(matchMs)) {
      const diffH = (betMs - matchMs) / 3600000;
      if (diffH < -24 || diffH > 12) {
        console.error(`bet_datetime fora de janela: bet=${bet.bet_datetime} match_start=${matchStartIso} diff=${diffH.toFixed(1)}h. Esperado entre -24h e +12h. Provável erro de data — REVISE antes de salvar.`);
        process.exit(2);
      }
    }
  }

  // Auto-settle quando a casa já confirmou resultado no print (Win/Lose visível)
  const nativeWL = bet.raw_extraction?.bookmaker_native?.settled_win_loss;
  if ((bet.status === 'green' || bet.status === 'red') && nativeWL != null && bet.profit == null) {
    bet.profit = bet.status === 'green'
      ? +((bet.stake * (bet.odd - 1)).toFixed(2))
      : -bet.stake;
    bet.settled_at = new Date().toISOString();
    bet.settle_source = 'bookmaker_native_print';
  }

  try {
    const result = await postJson(supabaseUrl, supabaseKey, '/rest/v1/bets', [bet]);
    const row = Array.isArray(result) ? result[0] : result;
    console.log(JSON.stringify({ ok: true, id: row.id, row }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();
