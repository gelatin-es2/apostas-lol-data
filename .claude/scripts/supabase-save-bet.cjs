// Salva UMA bet no Supabase pela RPC canonica transacional. Nunca update/delete.
//
// Uso:
//   node supabase-save-bet.cjs <path-to-json-file>            → valida + insere 1 row
//   node supabase-save-bet.cjs --validate-only <path>          → valida e mostra payload; ZERO rede,
//                                                                ZERO leitura de credencial
//   echo '<json>' | node supabase-save-bet.cjs                 → stdin (legado; preferir arquivo
//                                                                gravado em UTF-8 via Node/Write tool)
//
// Output: JSON em stdout.
//   sucesso insert:   { ok: true, id, row }
//   validate-only:    { ok: true, validate_only: true, warnings: [...], would_insert: {...} }
//   erro:             { ok: false, error } (+ exit code)
//
// Exit codes:
//   1 = validação genérica (campo faltando, tipo errado, bookmaker inválido, input ilegível)
//   2 = bet_datetime fora da janela [start_time - 24h, start_time + 12h]
//   3 = ambiguidade não resolvida (match_context.ambiguous=true sem escolha explícita do usuário)
//   4 = violação de contrato (nomes antigos tipo startTime, schema_version ausente/desconhecida,
//       match_id ausente sem match_id_exception válida)
//   5 = fair guard (Fase 3, 2026-08-11): fair do dia operacional ausente/inválida/de outro dia.
//       Só no modo REAL (--validate-only não exige fair). Ver lib/fair-guard.cjs.
//
// ─── CONTRATO v1 do payload (Fase 2 runbook 2026-08-11) ─────────────────────
// Campos obrigatórios: bookmaker, team_a, team_b, market, pick, odd, stake, bet_datetime.
// raw_extraction.match_context (quando o match foi resolvido pelo finder) DEVE ter:
//   { "schema_version": 1, "lolesports_match_id": "...", "start_time": "...Z",
//     "league_short": "...", "league_id": "...", "teams": [...],
//     "selection_reason": "...", "ambiguous": false }
// Se ambiguous=true, write só é aceito com escolha explícita do usuário:
//   "ambiguity_resolution": { "chosen_by": "user", "chosen_match_id": "<igual ao lolesports_match_id>" }
// Se NÃO há lolesports_match_id (única exceção de negócio aprovada: EWC/qualifier),
// o payload precisa carregar exceção auditável:
//   raw_extraction.match_id_exception = { "reason": "<texto>", "case": "ewc_qualifier" }
// O bypass antigo ALLOW_MISSING_MATCH_ID=1 foi REMOVIDO e agora é erro.
//
// Janela temporal canônica do pipeline: bet_datetime ∈ [start_time - 24h, start_time + 12h].

const fs = require('fs');
const https = require('https');
const path = require('path');
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
 * normalizeLeague: converte formatos EWC fora-padrão pro canônico EWC-LCK/LEC/LPL.
 * Causa: bookmakers usam "EWC SK Qualifier", "EWC_SK_QUAL", "Esports World Cup Korea Q" etc.
 */
function normalizeLeague(league) {
  if (!league) return league;
  const l = String(league).trim();
  const m = l.match(/^(?:EWC[-_\s]+|Esports\s*World\s*Cup[-_\s]+)(.+)$/i);
  if (m) {
    const region = m[1].toLowerCase().replace(/[\s_-]/g, '');
    if (/^(sk|korea|korean|lck|kr|skquali|skqual|koreaquali)/i.test(region)) return 'EWC-LCK';
    if (/^(emea|eu|europe|european|lec|emeaquali)/i.test(region)) return 'EWC-LEC';
    if (/^(china|chinese|lpl|cn|chinaquali|lplquali)/i.test(region)) return 'EWC-LPL';
    if (/^(na|americas|lcs|northamerica)/i.test(region)) return 'EWC-LCS';
    if (/^(apac|asiapacific|asiapac)/i.test(region)) return 'EWC-APAC';
    if (/^(sa|southamerica|brazil|cblol|brasil)/i.test(region)) return 'EWC-CBLOL';
    console.error(`[NORM-LEAGUE] EWC variant não-mapeada: "${league}" → mantendo com prefix EWC-`);
    return 'EWC-' + region.toUpperCase();
  }
  return l;
}

/**
 * normalizeTeam: resolve alias → canônico.
 *  1. isolated_real_teams → retorna original (academy/sub-roster, não toca)
 *  2. aliases → canônico
 *  3. desconhecido → original + aviso (audit trail)
 */
function normalizeTeam(name) {
  if (!name || !TEAM_ALIASES) return name;
  if (ISOLATED_TEAMS.has(name)) return name;
  if (TEAM_ALIASES[name]) {
    if (TEAM_ALIASES[name] !== name) {
      console.error(`[NORM] ${name} → ${TEAM_ALIASES[name]}`);
    }
    return TEAM_ALIASES[name];
  }
  console.error(`[AVISO] time não encontrado no alias_map: "${name}". Salvando original. Considere adicionar em lib/team-aliases.json.`);
  return name;
}

const REQUIRED = ['bookmaker', 'team_a', 'team_b', 'market', 'pick', 'odd', 'stake', 'bet_datetime'];

// Lista canônica de bookmakers (lowercase). Qualquer valor fora dessa lista é rejeitado.
// Sincronizar com normalize-bookmakers.cjs quando adicionar nova casa.
const VALID_BOOKMAKERS = [
  'pinnacle', 'estrelabet', 'parimatch', 'betano', 'whale.io', 'clutch', 'girosbet',
  'thunderpick', 'novibet', 'polymarket', 'simulated', 'duel', '1win',
  // 2026-08-16 (CEO): casas usadas apos o bloqueio da EstrelaBet. Ambas rejeitaram
  // bets reais no upload (fail-closed) ate serem cadastradas aqui.
  'esportivabet', 'betesporte',
  // 2026-08-17 (CEO): Shuffle (sportsbook cripto Oddin, usada pos-limitacao Duel).
  // Card SHUFFLE.COM rejeitado no upload por nao estar cadastrado. Canonico = 'shuffle'.
  'shuffle',
  // 2026-08-20: casas liberadas pelo martelo do CEO em 19/08 (Winna e CoinCasino = SAFE).
  // Estavam em uso real e gravando com bookmaker_unverified=true por nao estarem aqui.
  'winna', 'coincasino',
  // 2026-08-22 (CEO): Rakebit — casa da malha Betby, opera em USD. 4 bets reais de 21-22/08
  // entraram como 'unknown' com stake em USD gravada como se fosse BRL (corrigido na mao).
  'rakebit',
  // 2026-08-23 (CEO): BetEspecial (betespecial.bet.br). Bet real de 23/08 (FEARX x NS m2,
  // BRL 800) entrou como 'unknown' porque o print veio com o topo cortado, sem branding —
  // o CEO identificou a casa depois. Slip usa 'Total de Odds' / 'Aposta Total' /
  // 'Retorno Total' / chip 'ABERTO' e prefixo BRL, com bilhete de 18 digitos.
  'betespecial',
];

// Aliases aceitos somente na borda de entrada. O banco recebe sempre o slug canonico.
// Canônico é 'whale.io' (usado por bet-upload-worker-prompt.txt, migrations e
// normalize-bookmakers.cjs) — aliases convergem PARA ele, nunca dele.
const BOOKMAKER_ALIASES = new Map([
  ['whale', 'whale.io'],
  ['whale io', 'whale.io'],
  ['shuffle.com', 'shuffle'],
]);

// Flag de bypass pra casas novas ainda não cadastradas (ex: Whale.io em teste).
// Uso: ALLOW_UNKNOWN_BOOKMAKER=1 node supabase-save-bet.cjs <file>
const ALLOW_UNKNOWN_BOOKMAKER = process.env.ALLOW_UNKNOWN_BOOKMAKER === '1';

// Única exceção de negócio aprovada pra bet sem lolesports_match_id.
const VALID_MATCH_ID_EXCEPTION_CASES = ['ewc_qualifier'];

// Versão máxima de contrato que este save entende.
const SUPPORTED_SCHEMA_VERSION = 1;

// Janela canônica bet_datetime vs start_time (horas).
const WINDOW_BEFORE_H = -24;
const WINDOW_AFTER_H = 12;

class ValidationError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode || 1;
  }
}

function decimalClose(actual, expected, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= tolerance;
}

function validatePolymarketExecution(bet) {
  if (bet.bookmaker !== 'polymarket') return;

  const raw = bet.raw_extraction;
  const totals = raw?.execution_totals;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !totals || typeof totals !== 'object' || Array.isArray(totals)) {
    throw new ValidationError(
      'Polymarket exige raw_extraction.execution_totals auditável com cost_usd, shares, payout_usd, odd_display e odd_exact.', 1);
  }
  if (raw.original_currency !== 'USD') {
    throw new ValidationError('Polymarket exige raw_extraction.original_currency="USD".', 1);
  }

  const costUsd = Number(totals.cost_usd);
  const originalStakeUsd = Number(raw.original_stake_usd);
  const shares = Number(totals.shares);
  const payoutUsd = Number(totals.payout_usd);
  const oddDisplay = Number(totals.odd_display);
  const oddExact = Number(totals.odd_exact);
  const fxUsdBrl = Number(raw.fx_usd_brl);
  const fxSource = typeof raw.fx_source === 'string' ? raw.fx_source.trim() : '';

  if (![costUsd, originalStakeUsd, shares, payoutUsd, oddDisplay, oddExact, fxUsdBrl]
    .every(value => Number.isFinite(value) && value > 0)) {
    throw new ValidationError('Polymarket exige valores USD, shares, odds e câmbio positivos e numéricos.', 1);
  }
  if (!fxSource || !/\b\d{4}-\d{2}-\d{2}(?:T|\b)/.test(fxSource)) {
    throw new ValidationError('Polymarket exige fx_source com fonte e data auditáveis.', 1);
  }
  if (!decimalClose(originalStakeUsd, costUsd, 0.01)) {
    throw new ValidationError('Polymarket original_stake_usd deve ser igual a execution_totals.cost_usd.', 1);
  }
  if (!decimalClose(payoutUsd, shares, 0.01)) {
    throw new ValidationError('Polymarket payout_usd deve ser igual ao total de shares da posição.', 1);
  }
  const expectedOddExact = payoutUsd / costUsd;
  if (!decimalClose(oddExact, expectedOddExact, 0.000001)) {
    throw new ValidationError('Polymarket odd_exact deve ser payout_usd / cost_usd.', 1);
  }
  if (!decimalClose(bet.odd, oddDisplay, 0.001)) {
    throw new ValidationError('Polymarket odd deve preservar execution_totals.odd_display.', 1);
  }
  const expectedStakeBrl = Math.round(costUsd * fxUsdBrl * 100) / 100;
  if (!decimalClose(bet.stake, expectedStakeBrl, 0.01)) {
    throw new ValidationError(
      `Polymarket stake deve ser cost_usd x fx_usd_brl em BRL (esperado R$${expectedStakeBrl.toFixed(2)}).`, 1);
  }
}

function parseWhaleBrl(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = text.match(/^(?:BRL|R\$)\s*([0-9]+(?:[.,][0-9]{1,2})?)$/i);
  const amount = match ? Number(match[1].replace(',', '.')) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError(`Whale exige ${field} legivel no formato BRL.`, 1);
  }
  return amount;
}

function validateWhaleExecution(bet) {
  if (bet.bookmaker !== 'whale.io') return;
  const native = bet.raw_extraction?.bookmaker_native;
  const ticket = String(native?.bet_id ?? '').trim().replace(/^#+\s*/, '');
  if (!ticket) throw new ValidationError('Whale exige ticket numerico legivel.', 1);
  const stakeFromPrint = parseWhaleBrl(native?.raw_stake_text, 'raw_stake_text');
  const winFromPrint = parseWhaleBrl(native?.raw_win_text, 'raw_win_text');
  if (!decimalClose(stakeFromPrint, bet.stake, 0.01)) {
    throw new ValidationError('Whale stake diverge de raw_stake_text.', 1);
  }
  const expectedWin = Math.round(bet.stake * (bet.odd - 1) * 100) / 100;
  if (!decimalClose(winFromPrint, expectedWin, 0.02)) {
    throw new ValidationError(
      `Whale Stake/Win/odd inconsistentes (esperado Win BRL ${expectedWin.toFixed(2)}). Releia o card.`, 1);
  }
}

// ─── Decodificação do input (UTF-8 confiável) ───────────────────────────────
// Aceita: UTF-8 puro, UTF-8 com BOM (BOM removido, com warning).
// Rejeita com explicação: UTF-16 LE/BE (com ou sem BOM) — típico de
// `Set-Content` sem -Encoding no PowerShell 5.1. O gravador correto é a Write
// tool do Claude ou Node fs.writeFileSync (ambos UTF-8 sem BOM).
function decodeInput(buf) {
  const warnings = [];
  if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) {
    throw new ValidationError(
      'Input em UTF-16 (BOM FF FE / FE FF detectado). Provável Set-Content sem -Encoding utf8. ' +
      'Regrave o JSON em UTF-8 sem BOM (Write tool do Claude ou Node fs.writeFileSync).', 1);
  }
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    start = 3;
    warnings.push('BOM UTF-8 removido do input (tolerado; preferir UTF-8 sem BOM).');
  }
  const text = buf.slice(start).toString('utf8');
  // UTF-16 sem BOM: JSON legítimo não tem byte NUL.
  if (text.includes(String.fromCharCode(0))) {
    throw new ValidationError(
      'Input contém bytes NUL — provável UTF-16 sem BOM. Regrave o JSON em UTF-8.', 1);
  }
  return { text, warnings };
}

// ─── Validação + normalização (pura, sem rede) ─────────────────────────────
// Retorna { bet, warnings }. Lança ValidationError em qualquer violação.
function validateAndNormalize(inputRaw, opts = {}) {
  const warnings = opts.warnings ? [...opts.warnings] : [];

  let bet;
  try { bet = JSON.parse(inputRaw); }
  catch (e) { throw new ValidationError(`Input não é JSON válido: ${e.message}`, 1); }

  if (bet === null || typeof bet !== 'object' || Array.isArray(bet)) {
    throw new ValidationError('Payload deve ser UM objeto JSON (não array/escalar). Uma aprovação = exatamente um insert.', 1);
  }
  if (bet.id !== undefined) {
    throw new ValidationError('Payload contém "id". Este script só INSERE bet nova — nunca update. Remova o campo.', 1);
  }

  // Rejeição clara do contrato antigo (nomes camelCase / campos pré-v1).
  const mc = bet.raw_extraction?.match_context;
  const legacyHits = [];
  if (bet.startTime !== undefined) legacyHits.push('startTime (top-level)');
  if (mc && typeof mc === 'object') {
    for (const k of ['startTime', 'selectedReason', 'matchId', 'leagueShort']) {
      if (mc[k] !== undefined) legacyHits.push(`match_context.${k}`);
    }
  }
  if (bet.all !== undefined) legacyHits.push('all (top-level, output antigo do finder)');
  if (legacyHits.length > 0) {
    throw new ValidationError(
      `Payload usa contrato ANTIGO (pré-v1): ${legacyHits.join(', ')}. ` +
      'Use snake_case (start_time) e match_context com schema_version: 1. Nada foi salvo.', 4);
  }

  // Fail-open (2026-08-17): casa vazia/ausente nunca derruba a bet — vira 'unknown'
  // (marcada como bookmaker_unverified logo abaixo). Coerção ANTES do check de obrigatórios.
  if (bet.bookmaker === undefined || bet.bookmaker === null || String(bet.bookmaker).trim() === '') {
    bet.bookmaker = 'unknown';
  }

  // Campos obrigatórios (bet_datetime agora é obrigatório: settle quebra silencioso sem ele)
  const missing = REQUIRED.filter(k => bet[k] === undefined || bet[k] === null || bet[k] === '');
  if (missing.length > 0) {
    throw new ValidationError(`Campos obrigatórios faltando: ${missing.join(', ')}`, 1);
  }

  // Bookmaker — FAIL-OPEN por decisão do CEO (2026-08-17): nunca derrubar uma bet real
  // por causa da casa. Casa legível fora da lista canônica é registrada com o nome lido
  // e marcada `bookmaker_unverified=true` pra revisão; casa vazia vira 'unknown'. O que
  // NÃO se faz (a montante, no worker/agent) é adivinhar entre duas casas CONHECIDAS
  // (ex.: Whale.io vs Pinnacle) — nesse caso usa-se 'unknown', nunca um palpite.
  let bookmakerInput = (bet.bookmaker || '').toLowerCase().trim();
  if (!bookmakerInput) bookmakerInput = 'unknown';
  const bookmakerNorm = BOOKMAKER_ALIASES.get(bookmakerInput) || bookmakerInput;
  if (!VALID_BOOKMAKERS.includes(bookmakerNorm)) {
    warnings.push(`bookmaker "${bet.bookmaker || '(vazio)'}" fora da lista canônica — registrado como NÃO verificado (bookmaker_unverified=true) para revisão.`);
    if (!bet.raw_extraction || typeof bet.raw_extraction !== 'object') bet.raw_extraction = {};
    bet.raw_extraction.bookmaker_unverified = true;
    if (bet.raw_extraction.bookmaker_raw == null) bet.raw_extraction.bookmaker_raw = bet.bookmaker || null;
  }
  bet.bookmaker = bookmakerNorm;

  // ── Contrato do match_context ──
  if (mc !== undefined && mc !== null) {
    if (typeof mc !== 'object' || Array.isArray(mc)) {
      throw new ValidationError('raw_extraction.match_context deve ser objeto.', 4);
    }
    if (mc.schema_version === undefined) {
      throw new ValidationError(
        'match_context sem schema_version. Contrato v1 exige "schema_version": 1 — atualize o orquestrador (agente/command) junto com o finder.', 4);
    }
    if (mc.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      throw new ValidationError(
        `match_context.schema_version=${JSON.stringify(mc.schema_version)} não suportada por este save (suportada: ${SUPPORTED_SCHEMA_VERSION}). ` +
        'Versão futura/desconhecida — atualize o script antes de salvar.', 4);
    }
  }

  // ── match_id obrigatório OU exceção explícita auditável ──
  const matchId = mc?.lolesports_match_id;
  if (process.env.ALLOW_MISSING_MATCH_ID === '1') {
    throw new ValidationError(
      'ALLOW_MISSING_MATCH_ID foi REMOVIDO (Fase 2, 2026-08-11). Para EWC/qualifier, inclua no payload: ' +
      'raw_extraction.match_id_exception = { "reason": "<motivo>", "case": "ewc_qualifier" }.', 4);
  }
  if (!matchId) {
    const exc = bet.raw_extraction?.match_id_exception;
    const excOk = exc && typeof exc === 'object' && !Array.isArray(exc)
      && typeof exc.reason === 'string' && exc.reason.trim().length > 0
      && VALID_MATCH_ID_EXCEPTION_CASES.includes(exc.case);
    if (!excOk) {
      throw new ValidationError(
        'lolesports_match_id ausente em raw_extraction.match_context (obrigatório pro settle). ' +
        `Única exceção aprovada: raw_extraction.match_id_exception = { "reason": "<motivo>", "case": ${VALID_MATCH_ID_EXCEPTION_CASES.map(c => `"${c}"`).join('|')} }. ` +
        'Nada foi salvo.', 4);
    }
    warnings.push(`bet sem lolesports_match_id — exceção auditável aceita (case=${exc.case}). Settle será manual/fallback.`);
  }

  // ── Ambiguidade BLOQUEIA write sem escolha explícita do usuário ──
  if (mc?.ambiguous === true) {
    const res = mc.ambiguity_resolution;
    const resolved = res && typeof res === 'object'
      && res.chosen_by === 'user'
      && res.chosen_match_id != null
      && String(res.chosen_match_id) === String(matchId);
    if (!resolved) {
      throw new ValidationError(
        'match_context.ambiguous=true sem resolução válida. NENHUM write com ambiguidade aberta. ' +
        'Mostre os all_candidates ao usuário; após escolha explícita, inclua ' +
        'match_context.ambiguity_resolution = { "chosen_by": "user", "chosen_match_id": "<id escolhido>" } ' +
        '(chosen_match_id deve ser igual a lolesports_match_id).', 3);
    }
  }

  // Defaults
  if (!bet.status) bet.status = 'pending';
  if (typeof bet.is_map_bet !== 'boolean') bet.is_map_bet = false;
  // is_method_bet ausente → true (decisão do dono, 2026-08-14: "tudo tem método
  // agora" — a coluna continua existindo pro histórico analítico, só o default
  // muda). Antes ficava ausente e a RPC register_canonical_bet fazia
  // coalesce(is_method_bet, false); setando aqui garante true independente do
  // fallback do banco.
  if (typeof bet.is_method_bet !== 'boolean') bet.is_method_bet = true;

  // Map bet exige map_number válido (fixture 11 do runbook)
  if (bet.is_map_bet === true) {
    const mn = bet.map_number;
    const mnInt = Number.isInteger(mn) ? mn : parseInt(mn, 10);
    if (!Number.isInteger(mnInt) || mnInt < 1 || mnInt > 5) {
      throw new ValidationError(
        `is_map_bet=true exige map_number inteiro entre 1 e 5 (recebido: ${JSON.stringify(mn)}). ` +
        'Map bet sem mapa identificado não pode ser salva — confirme o mapa no print.', 1);
    }
    bet.map_number = mnInt;
  } else if (bet.map_number !== undefined && bet.map_number !== null) {
    bet.map_number = parseInt(bet.map_number, 10);
  }

  // Coerção numérica
  bet.odd = Number(bet.odd);
  bet.stake = Number(bet.stake);
  if (!Number.isFinite(bet.odd) || !Number.isFinite(bet.stake)) {
    throw new ValidationError('odd e stake devem ser numéricos', 1);
  }
  if (bet.odd <= 1 || bet.stake <= 0) {
    throw new ValidationError(`odd (${bet.odd}) deve ser > 1 e stake (${bet.stake}) deve ser > 0.`, 1);
  }
  validatePolymarketExecution(bet);
  validateWhaleExecution(bet);

  // bet_datetime parseável
  const betMs = new Date(bet.bet_datetime).getTime();
  if (!Number.isFinite(betMs)) {
    throw new ValidationError(`bet_datetime inválido: ${JSON.stringify(bet.bet_datetime)}. Use ISO 8601 (ex 2026-08-11T18:00:00Z).`, 1);
  }

  // Normaliza nomes de time: alias → canônico
  bet.team_a = normalizeTeam(bet.team_a);
  bet.team_b = normalizeTeam(bet.team_b);
  if (mc) {
    if (mc.team_a) mc.team_a = normalizeTeam(mc.team_a);
    if (mc.team_b) mc.team_b = normalizeTeam(mc.team_b);
  }

  // Normaliza liga EWC fora-padrão (fix 2026-05-26)
  bet.league = normalizeLeague(bet.league);

  // ── Janela temporal canônica (única do pipeline): [-24h, +12h] vs start_time ──
  // Guard 2026-05-20: bet_datetime inconsistente com o match = bet pending eterna.
  const matchStartIso = mc?.start_time;
  if (matchStartIso) {
    const matchMs = new Date(matchStartIso).getTime();
    if (!Number.isFinite(matchMs)) {
      throw new ValidationError(`match_context.start_time inválido: ${JSON.stringify(matchStartIso)}`, 4);
    }
    const diffH = (betMs - matchMs) / 3600000;
    if (diffH < WINDOW_BEFORE_H || diffH > WINDOW_AFTER_H) {
      throw new ValidationError(
        `bet_datetime fora de janela: bet=${bet.bet_datetime} match_start=${matchStartIso} diff=${diffH.toFixed(1)}h. ` +
        `Esperado entre ${WINDOW_BEFORE_H}h e +${WINDOW_AFTER_H}h. Provável erro de data — REVISE antes de salvar.`, 2);
    }
  }

  // Fair Pinnacle (arquivo local, sem rede). Se ainda não logada, fica NULL e settle popula.
  if (bet.fair_pinnacle === undefined && bet.bet_datetime) {
    const betDate = bet.bet_datetime.slice(0, 10);
    const pinnacle = loadFairPinnacle(betDate);
    const pinnacleVal = matchId ? (pinnacle.byMatchId.get(String(matchId)) ?? null) : null;
    bet.fair_pinnacle = pinnacleVal;
    bet.fair_formula = bet.fair_formula ?? null;
    bet.fair_line_source = pinnacleVal != null ? 'pinnacle_manual' : null;
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

  return { bet, warnings };
}

// ─── Rede (só no modo real) ─────────────────────────────────────────────────
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

module.exports = { validateAndNormalize, validatePolymarketExecution, validateWhaleExecution, decodeInput, normalizeLeague, normalizeTeam, ValidationError, VALID_BOOKMAKERS, BOOKMAKER_ALIASES, SUPPORTED_SCHEMA_VERSION };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const VALIDATE_ONLY = args.includes('--validate-only');
    const fileArg = args.find(a => a !== '--validate-only');

    // Lê input como BUFFER (decodificação controlada — nunca confiar em encoding implícito)
    let inputBuf;
    try {
      if (fileArg && fileArg !== '-') inputBuf = fs.readFileSync(fileArg);
      else inputBuf = fs.readFileSync(0); // stdin
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: `Falha lendo input: ${e.message}` }));
      process.exit(1);
    }

    let bet, warnings;
    try {
      const { text, warnings: decodeWarnings } = decodeInput(inputBuf);
      ({ bet, warnings } = validateAndNormalize(text, { warnings: decodeWarnings }));
    } catch (e) {
      const code = e instanceof ValidationError ? e.exitCode : 1;
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exit(code);
    }

    if (VALIDATE_ONLY) {
      // Modo comprovadamente offline: loadConfig (credenciais) NÃO é chamado e
      // nenhuma função de rede é tocada. Testado com net-blocker em tests/.
      console.log(JSON.stringify({ ok: true, validate_only: true, warnings, would_insert: bet }));
      process.exit(0);
    }

    for (const w of warnings) console.error(`[AVISO] ${w}`);

    // ── Fair guard (Fase 3A) — fronteira de segurança ANTES de credencial/rede ──
    // Valida CONTEÚDO do arquivo de fair do dia operacional (America/Sao_Paulo).
    // Inválido/ausente => exit 5, NADA é inserido. Skip do dia com motivo é aceito
    // (bet discricionária em dia sem operação declarada continua possível, com aviso).
    try {
      const { assertFairReady } = require('./lib/fair-guard.cjs');
      const fair = assertFairReady();
      if (fair.skip) {
        console.error(`[AVISO] fair do dia é SKIP (source=${fair.source}) — dia declarado sem operação; registrando mesmo assim (discricionária).`);
      }
    } catch (e) {
      if (e && e.name === 'FairGuardError') {
        console.log(JSON.stringify({ ok: false, error: e.message, fair_guard: e.code }));
        process.exit(5);
      }
      throw e;
    }

    // Credenciais só aqui — modo real. A RPC compartilha o advisory lock/dedup
    // com o upload batch; deploy da migration batch deve anteceder este writer.
    const { loadConfig } = require('./_load-config.cjs');
    const { supabaseUrl, supabaseKey } = loadConfig();
    try {
      const result = await postJson(supabaseUrl, supabaseKey, '/rest/v1/rpc/register_canonical_bet', {
        p_bet: bet,
        p_screenshot_path: bet.screenshot_path || null,
      });
      const payload = Array.isArray(result) ? result[0] : result;
      if (!payload?.bet_id) throw new Error('RPC canonica nao retornou bet_id');
      console.log(JSON.stringify({
        ok: true,
        id: payload.bet_id,
        inserted: payload.inserted === true,
        reused: payload.inserted === false,
        row: payload.inserted === true ? { ...bet, id: payload.bet_id } : null,
      }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    }
  })();
}
