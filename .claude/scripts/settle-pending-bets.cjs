// Settle bets pending: busca resultado via lolesports livestats, atualiza bets table.
//
// Uso:
//   node settle-pending-bets.cjs            → tenta settle de TODAS bets pending
//   node settle-pending-bets.cjs <bet_id>   → tenta settle só dessa bet (uuid)
//   node settle-pending-bets.cjs --dry-run  → diagnóstico sem PATCH
//
// Stdout: JSON com summary { checked, settled, skipped, errors, dry_run, results }
//
// ─── Garantias Fase 3 (runbook 2026-08-11) ──────────────────────────────────
//  - FAIR GUARD: antes de qualquer PATCH, lib/fair-guard.cjs valida o arquivo de
//    fair do dia operacional (America/Sao_Paulo). Guard reprovado → NENHUMA
//    mutação; bets viram skipped com reason fair_guard_* e o summary carrega
//    summary.fair_guard (estado degradado visível, nunca sucesso silencioso).
//    --dry-run não exige fair (é diagnóstico sem mutação).
//  - IDEMPOTENTE por ID+estado: bet com status != 'pending' NUNCA é re-settlada
//    (nem via --id); o PATCH é condicional (id=eq.X&status=eq.pending) — se outra
//    execução settlou antes, 0 rows batem e o resultado é skipped, não duplicata.
//  - INJEÇÃO pra teste: _setDeps({ fetchJson, supabaseRequest }) troca os
//    clientes HTTP por fakes; a suite roda 100% offline (net-blocker).
//  - SANITIZAÇÃO: strings vindas de fonte externa (API/banco) são limpas
//    (controle → espaço, tamanho capado) antes de irem pro stdout que o hook
//    injeta no contexto do modelo — dado externo é dado, não instrução.
//  - TIMEOUT INTERNO 12s (< 15s do hook): watchdog imprime summary parcial
//    degradado (degraded:true, exit 3) e loga em .settle-degraded.log; nunca
//    trava o hook nem vira sucesso silencioso.
//
// Pra cada bet pending:
//   1. lê raw_extraction.match_context.lolesports_match_id
//   2. fetcha getEventDetails → identifica o game pelo map_number da bet
//   3. fetcha livestats window → kills, supports, picks, winner
//   4. decide green/red baseado em pick (Under/Over/Money Line)
//   5. PATCH bet com status, profit, settled_at, settle_source, raw_extraction enriquecido

const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadFairPinnacle } = require('../../lib/loadFairPinnacle.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');
const { checkFairReady } = require('./lib/fair-guard.cjs');
const { operationalDateYmd } = require('./lib/operational-date.cjs');
// loadConfig (credencial) é required só dentro de runSettle() — nunca no load do
// módulo, pra suite de testes poder dar require neste arquivo sem tocar credencial.

const CRON_DIR = path.resolve(__dirname, '..', '..', 'cron-data');
const MIN_SAMPLE_SETTLE = 5;
const DEGRADED_LOG = path.join(__dirname, '.settle-degraded.log');
const DEFAULT_TIMEOUT_MS = 12 * 1000; // interno < 15s externo do hook
const HTTP_SOCKET_TIMEOUT_MS = 10 * 1000;

// Carrega avgs de time a partir do results.json do dia, pra calcular fair_formula no settle.
// Lê todos os results.json disponíveis no cron-data pra montar histórico 21d.
function buildTeamAvgsFromResults(targetDate) {
  const cutoff = new Date(targetDate + 'T00:00:00Z');
  cutoff.setDate(cutoff.getDate() - 21);
  const since = cutoff.toISOString().slice(0, 10);

  const teamHist = new Map();
  const leagueHist = new Map();

  const files = fs.existsSync(CRON_DIR)
    ? fs.readdirSync(CRON_DIR).filter(f => f.endsWith('-results.json'))
    : [];

  for (const file of files) {
    const dateStr = file.slice(0, 10);
    if (dateStr < since || dateStr > targetDate) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CRON_DIR, file), 'utf8'));
      for (const r of data.results || []) {
        if (r.total_kills == null) continue;
        for (const team of [r.team_blue, r.team_red]) {
          if (!team) continue;
          if (!teamHist.has(team)) teamHist.set(team, []);
          teamHist.get(team).push(r.total_kills);
        }
        const lg = r.league;
        if (lg) {
          if (!leagueHist.has(lg)) leagueHist.set(lg, []);
          leagueHist.get(lg).push(r.kills_blue ?? 0, r.kills_red ?? 0);
        }
      }
    } catch { /* arquivo corrompido: pula */ }
  }

  const teamAvg = new Map();
  for (const [t, arr] of teamHist) {
    teamAvg.set(t, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  const leagueAvg = new Map();
  for (const [l, arr] of leagueHist) {
    leagueAvg.set(l, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return { teamAvg, teamHist, leagueAvg };
}

// Calcula fair_formula para um bet usando histório de times.
function calcFairFormula(bet, teamHist, leagueAvg) {
  const mc = bet.raw_extraction?.match_context || {};
  const teamA = normalizeTeam(mc.teams?.[0]?.name || bet.team_a);
  const teamB = normalizeTeam(mc.teams?.[1]?.name || bet.team_b);
  const lg = (bet.league || '').toUpperCase().replace(/\s+/g,'');
  const lgKey = ['LCK','LPL','LEC','CBLOL','LFL','LCS'].find(k => lg.includes(k)) || null;

  const aHist = teamHist.get(teamA) || [];
  const bHist = teamHist.get(teamB) || [];
  const lAvgPerSide = leagueAvg.get(lgKey) ?? 14.5;
  const lAvgTotal = lAvgPerSide * 2;

  const aAvg = aHist.length >= MIN_SAMPLE_SETTLE
    ? aHist.reduce((a, b) => a + b, 0) / aHist.length
    : lAvgTotal;
  const bAvg = bHist.length >= MIN_SAMPLE_SETTLE
    ? bHist.reduce((a, b) => a + b, 0) / bHist.length
    : lAvgTotal;

  const raw = aAvg + bAvg;
  const formula = Math.round(raw / 2 - 0.5) + 0.5;
  return +formula.toFixed(1);
}

// Extraído do path de settle original (era código inline) pra ser reaproveitado também
// pelo settle de moneyline de SÉRIE, que não passa mais pelo fluxo de 1 game isolado.
// Essa é a janela onde Pinnacle já foi logado (Elvis roda /log-fair antes do jogo).
function computeFairFields(bet) {
  const betDateStr = (bet.bet_datetime || '').slice(0, 10);
  const pinnacleMap = betDateStr ? loadFairPinnacle(betDateStr) : { byMatchId: new Map() };
  const matchIdStr = bet.raw_extraction?.match_context?.lolesports_match_id;
  const fairPinnacleSettle = matchIdStr
    ? (pinnacleMap.byMatchId.get(String(matchIdStr)) ?? null)
    : null;

  // Fallback de data: dia operacional (America/Sao_Paulo) — Fase 3B, nunca corte UTC manual.
  const { teamHist: tHist, leagueAvg: lAvg } = buildTeamAvgsFromResults(betDateStr || operationalDateYmd());
  const fairFormulaSettle = calcFairFormula(bet, tHist, lAvg);

  const fairLineSourceSettle = fairPinnacleSettle != null
    ? 'pinnacle_manual'
    : fairFormulaSettle != null
      ? 'formula'
      : 'fallback_29.5';

  return { fairPinnacleSettle, fairFormulaSettle, fairLineSourceSettle };
}

const LOLES_KEY = process.env.LOLESPORTS_API_KEY;

// Manter sincronizado com analyze_yesterday.cjs:20-21
const PEEL_PURE = ['soraka','sona','janna','lulu','yuumi','karma','seraphine','renataglasc','renata','nami','milio'];
// FLEX expandido 2026-05-23 (CEO): Lux + Anivia. Alistar REMOVIDO 2026-05-29 (CEO): -26.8% ROI n=21.
const FLEX_ENGAGE = ['bard','rakan','lux','anivia'];

function httpFetchJson(host, pathUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    if (!LOLES_KEY) {
      reject(new Error('LOLESPORTS_API_KEY não configurada'));
      return;
    }
    const req = https.get({
      host, path: pathUrl,
      headers: {
        'x-api-key': LOLES_KEY,
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://lolesports.com',
        'Referer': 'https://lolesports.com/',
        ...headers,
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error(`socket timeout ${HTTP_SOCKET_TIMEOUT_MS}ms: ${host}`));
    });
  });
}

function httpSupabaseRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    let data = null;
    if (body !== null) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method, headers,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error(`socket timeout ${HTTP_SOCKET_TIMEOUT_MS}ms: supabase ${method}`));
    });
    if (data) req.write(data);
    req.end();
  });
}

// ─── Clientes injetáveis (Fase 3C) ──────────────────────────────────────────
// Default = HTTP real. Testes trocam por fakes via _setDeps e NUNCA tocam rede.
let fetchJson = httpFetchJson;
let supabaseRequest = httpSupabaseRequest;
function _setDeps(deps = {}) {
  if (deps.fetchJson) fetchJson = deps.fetchJson;
  if (deps.supabaseRequest) supabaseRequest = deps.supabaseRequest;
}
function _resetDeps() {
  fetchJson = httpFetchJson;
  supabaseRequest = httpSupabaseRequest;
}

// ─── Sanitização de dado externo (Fase 3C) ──────────────────────────────────
// Tudo que veio de fora (API lolesports, banco, mensagens de erro HTTP) passa
// aqui antes de ir pro stdout — o hook injeta esse stdout no contexto do modelo.
// Remove caracteres de controle (inclusive \n/\r/ESC), colapsa espaços e capa o
// tamanho. Dado externo malicioso vira texto inerte e curto.
const SANITIZE_MAX_LEN = 300;
function sanitizeStr(s, maxLen = SANITIZE_MAX_LEN) {
  if (typeof s !== 'string') return s;
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + '…';
  return out;
}
// Sanitiza recursivamente todas as strings de um objeto/array (profundidade capada).
function sanitizeDeep(v, depth = 0) {
  if (depth > 8) return undefined;
  if (typeof v === 'string') return sanitizeStr(v);
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => sanitizeDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) out[sanitizeStr(k, 60)] = sanitizeDeep(v[k], depth + 1);
    return out;
  }
  return v;
}

// Log local de estado degradado (redigido/capado). Nunca lança.
function logDegraded(code, msg) {
  try {
    fs.appendFileSync(DEGRADED_LOG,
      `${new Date().toISOString()} | ${sanitizeStr(String(code), 60)} | ${sanitizeStr(String(msg), 240)}\n`);
  } catch { /* log é best-effort */ }
}

// ─── Validação mínima da row de bet vinda do banco (Fase 3C) ────────────────
// O settle usa stake/odd/status/id em decisão financeira — schema errado não
// pode virar PATCH com NaN nem crash no meio do loop.
function validateBetRow(bet) {
  if (bet === null || typeof bet !== 'object' || Array.isArray(bet)) return 'row não é objeto';
  if (typeof bet.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(bet.id)) return `id inválido: ${JSON.stringify(bet.id)}`;
  if (typeof bet.status !== 'string' || !bet.status) return 'status ausente';
  if (!Number.isFinite(parseFloat(bet.stake))) return `stake não numérica: ${JSON.stringify(bet.stake)}`;
  if (!Number.isFinite(parseFloat(bet.odd))) return `odd não numérica: ${JSON.stringify(bet.odd)}`;
  return null;
}

// Posições em exchange (Polymarket etc.) gravam a odd de tela arredondada na coluna
// `odd`, mas o raw_extraction pode ter a odd exata da execução real (execution_totals.odd_exact).
// Preferir a exata evita profit calculado sobre valor arredondado (bug 2026-08-05, bet 1b862f3d).
function resolveOdd(bet) {
  const exact = bet.raw_extraction?.execution_totals?.odd_exact;
  return typeof exact === 'number' && !Number.isNaN(exact) ? exact : parseFloat(bet.odd);
}

const norm = s => s ? s.toLowerCase().replace(/\s+/g, '') : '';
const isPurePeel = sup => sup && PEEL_PURE.includes(norm(sup));
const isFlexEngage = sup => sup && FLEX_ENGAGE.includes(norm(sup));

function detectTrigger(supBlue, supRed) {
  const pures = (isPurePeel(supBlue) ? 1 : 0) + (isPurePeel(supRed) ? 1 : 0);
  const flexes = (isFlexEngage(supBlue) ? 1 : 0) + (isFlexEngage(supRed) ? 1 : 0);
  if (pures === 2) return '2peel';
  if (pures === 1 && flexes >= 1) return '1peel+flex';
  return null;
}

// Parser do pick: "Menos de 27.5" / "Under 27.5" / "Mais de 27.5" / "Over 27.5" / nome de time
// Fix 2026-05-23: usava o ÚLTIMO número da string (pra evitar capturar "Mapa 4" em "Total.
// Mapa 4 Menos de 27.5") — mas isso quebra na ordem inversa: "Under 29.5 Map 4" extraía "4"
// (o número do mapa) como linha, não 29.5. Mascarado até agora porque kills reais (15-45)
// sempre são > que o número de mapa (1-5), então bets Under com essa linha corrompida
// sempre resolviam pra loss de qualquer forma — mas uma Under-win legítima com linha
// corrompida teria sido marcada red incorretamente.
// Fix 2026-07-30 (auditoria under/over, duplicado de lib/analiseStats.cjs): prioriza o
// padrão decimal N.5 (linha de kills sempre termina em .5), não a posição na string.
function parsePick(pickRaw, market) {
  const raw = pickRaw || '';
  // Player props (kills de JOGADOR, ex "Supa Under 6.5") não são total do mapa —
  // settlar automático compararia total_kills do mapa vs linha individual e marcaria
  // red errado. Guard 2026-07-31 (1ª player prop do banco: 72edd2bd).
  if (/player/i.test(market || '') || /\bkills?\s*\(mapa/i.test(raw)) {
    return { kind: 'player_prop' };
  }
  const decimalMatch = raw.match(/(\d+[.,]5)\b/);
  const afterTerm = !decimalMatch && raw.match(/(?:menos de|under|mais de|over)\s+(\d+(?:[.,]\d+)?)/i);
  const m = decimalMatch || afterTerm;
  const line = m ? parseFloat(m[1].replace(',', '.')) : null;

  // Decide kind pelo TERMO do pick (início, ignorando prefixo "Mapa N"), nunca por
  // substring do nome do mercado (ex "Over 30.5 Total Kills Over/Under" tem "under"
  // no meio mas é Over) — under/menos vence só no empate/fallback.
  const s = raw.replace(/^mapa\s*\d+\s*/i, '').trim();
  if (/^(under|menos de)\b/i.test(s)) return { kind: 'under', line };
  if (/^(over|mais de)\b/i.test(s)) return { kind: 'over', line };
  if (/\b(under|menos de)\b/i.test(s)) return { kind: 'under', line };
  if (/\b(over|mais de)\b/i.test(s)) return { kind: 'over', line };
  // "winner" (EN) faltava: mercados de casa internacional vêm como "Game 1 Winner" /
  // "Game 2 Winner" e caíam em kind:'unknown' → bet travada pra sempre (fix 2026-08-07).
  if (/money\s*line|vencedor|winner|resultado\s*final/i.test(market || '')) {
    return { kind: 'moneyline', team_pick: pickRaw };
  }
  return { kind: 'unknown' };
}

function tsRoundedTo10s(date) {
  const t = Math.floor(date.getTime() / 10000) * 10000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

// ============================================================================
// Escolha de frame + detecção de dado podre do CDN — reescrito 2026-08-08.
//
// MEDIDO na auditoria de 08/08 (e reproduzido ao vivo em 2 jogos reais):
//  1. O feed publica o frame gameState='finished' NO MESMO MILISSEGUNDO do
//     último frame 'in_game' (rfc460Timestamp idêntico). Ex.: Fluxo x VKS m3
//     07/08 → dois frames em 23:22:36.442Z, um in_game e um finished.
//     Qualquer dedup/escolha por timestamp que ignore o gameState apaga o
//     'finished' com o 'in_game' — e o script "não vê" o fim do jogo.
//  2. Os frames do /livestats/v1/window/ NÃO têm campo `gameTime` — só
//     { rfc460Timestamp, gameState, blueTeam, redTeam }. Toda checagem antiga
//     baseada em gameTime lia undefined.
//  3. O CDN, pra um startingTime DEPOIS do fim do feed, às vezes devolve um
//     bloco velho do começo do jogo (Weibo x LNG m1 08/08: pedir qualquer
//     T >= 07:52 devolvia frames de 07:16 com kills 0+0). Era esse o
//     "gameTime=0s kills=0" do suspect_frame antigo. A assinatura é
//     determinística: o frame mais novo da resposta vem ANTERIOR ao
//     startingTime pedido.
//
// ⚠️ Correção do comentário de 07/08 (auditoria 1a-bis): no KT x Gen.G m1 o
// feed morreu com o jogo AINDA VIVO (gold subindo nos últimos frames) — os
// 11 kills eram piso, não placar final. Por isso frame não-'finished' NUNCA
// settla mercado de kills automaticamente.
// ============================================================================

const FEED_HOST = 'feed.lolesports.com';
const SCAN_STEP_MS = 10 * 60 * 1000; // passo grosso da varredura do fim do feed
const MAX_SCAN_PROBES = 40;          // teto duro de requests da varredura

function killsOf(frame) {
  return (frame?.blueTeam?.totalKills ?? 0) + (frame?.redTeam?.totalKills ?? 0);
}

// Frame de settle da janela — preferência EXPLÍCITA por gameState='finished'.
// Existindo frame 'finished', ele vence SEMPRE: nunca é descartado em favor de
// um 'in_game' do mesmo timestamp (colisão medida em 08/08) nem de nenhum outro.
function pickSettleFrame(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].gameState === 'finished') return frames[i];
  }
  return frames[frames.length - 1];
}

// Coerência de kills dentro da janela: o total nunca regride de um frame pro
// seguinte (kill não "des-acontece"). Regressão = CDN misturando snapshots de
// momentos diferentes → janela imprestável pra settle.
function killsRegressed(frames) {
  for (let i = 1; i < frames.length; i++) {
    if (killsOf(frames[i]) < killsOf(frames[i - 1])) return true;
  }
  return false;
}

function newestFrameMs(win) {
  const frames = win?.frames || [];
  if (!frames.length) return NaN;
  return new Date(frames[frames.length - 1].rfc460Timestamp).getTime();
}

function hasFinishedFrame(win) {
  return (win?.frames || []).some(f => f.gameState === 'finished');
}

// Janela stale (dado podre do CDN): pedimos startingTime=T e o frame mais novo
// da resposta veio ANTERIOR a T. Não depende de kills/inibidores/sorte — é o
// próprio CDN dizendo que não tem dado fresco naquele T (medição item 3 acima).
function isWindowStale(win, askedMs) {
  const ms = newestFrameMs(win);
  return !Number.isFinite(ms) || ms < askedMs;
}

async function fetchWindowAt(gameId, askedMs) {
  const startingTime = tsRoundedTo10s(new Date(askedMs));
  const win = await fetchJson(FEED_HOST, `/livestats/v1/window/${gameId}?startingTime=${startingTime}`);
  return { win, askedMs };
}

// startingTime default: matchStart+6h, capado em now-270s.
// O cap PRECISA deixar a janela [T, T+10s] com fim ≥240s de idade (regra do
// endpoint, HTTP 400 senão) — 200s ficava preso a ~210s pra sempre porque o
// cálculo acompanha o relógio (medido 11/08, KHK x G2N m1). 270 = 240 + 10 da
// largura da janela + margem pro arredondamento de 10s.
function defaultAskedMs(matchStart) {
  const startMs = matchStart ? new Date(matchStart).getTime() : NaN;
  const capMs = Date.now() - 270 * 1000;
  const baseMs = Number.isFinite(startMs) && startMs > 0 ? startMs + 6 * 3600 * 1000 : capMs;
  return Math.min(baseMs, capMs);
}

// Busca a MELHOR janela pra settle:
//  1. janela default; se já tem frame 'finished' → pronto (caminho comum);
//  2. janela fresca sem 'finished' → feed ainda publicando (jogo ao vivo ou
//     recém-acabado) → NÃO varre; retry honesto na próxima execução;
//  3. janela stale + eventDetails 'completed' → varre o feed atrás do fim real:
//     o frame 'finished' existe mas o CDN só o serve pedindo um startingTime
//     dentro dos últimos ~10s do feed (medido em 08/08 no Weibo x LNG m1).
// Varredura: âncora no bloco stale (os frames dele estão DENTRO do feed real),
// passos de 10min até a 1ª janela stale/vazia, busca binária na transição
// fresco→stale (grid de 10s do endpoint). ~10-15 requests típicos, teto
// MAX_SCAN_PROBES. Probes da varredura toleram erro/vazio; erro na janela
// default propaga (mesmo comportamento de antes).
async function fetchBestWindow(gameId, matchStart, trustCompleted) {
  const first = await fetchWindowAt(gameId, defaultAskedMs(matchStart));
  if (hasFinishedFrame(first.win)) return { ...first, source: 'default' };
  if (!(first.win?.frames || []).length) return { ...first, source: 'default', empty: true };
  if (!isWindowStale(first.win, first.askedMs)) {
    return { ...first, source: 'default', fresh_no_finished: true };
  }
  if (!trustCompleted) return { ...first, source: 'default', stale: true };

  let probes = 0;
  const probe = async (ms) => {
    probes++;
    try { return await fetchWindowAt(gameId, ms); }
    catch { return { win: null, askedMs: ms }; }
  };

  // âncora: frame mais novo do bloco stale — garantido dentro do feed real
  let okMs = newestFrameMs(first.win);
  if (!Number.isFinite(okMs)) return { ...first, source: 'default', stale: true };
  let okWrap = null;
  let badMs = NaN;

  // passo grosso: avança 10min por vez até a 1ª janela stale/vazia
  let cur = okMs;
  while (probes < MAX_SCAN_PROBES) {
    cur += SCAN_STEP_MS;
    const w = await probe(cur);
    if (hasFinishedFrame(w.win)) return { ...w, source: 'scan', probes };
    if (w.win && !isWindowStale(w.win, cur)) { okMs = cur; okWrap = w; continue; }
    badMs = cur;
    break;
  }
  if (!Number.isFinite(badMs)) return { ...first, source: 'default', stale: true, probes };

  // busca binária na transição fresco→stale (grid 10s do endpoint)
  while (badMs - okMs > 10 * 1000 && probes < MAX_SCAN_PROBES) {
    const mid = Math.floor((okMs + badMs) / 2 / 10000) * 10000;
    if (mid <= okMs || mid >= badMs) break;
    const w = await probe(mid);
    if (hasFinishedFrame(w.win)) return { ...w, source: 'scan', probes };
    if (w.win && !isWindowStale(w.win, mid)) { okMs = mid; okWrap = w; }
    else badMs = mid;
  }

  // janela no último ponto fresco = cauda real do feed (cobre os ~10s finais)
  const tail = (okWrap && okWrap.askedMs === okMs) ? okWrap : await probe(okMs);
  if (hasFinishedFrame(tail.win)) return { ...tail, source: 'scan', probes };
  if (tail.win && (tail.win.frames || []).length) {
    // feed acabou sem publicar 'finished' (ex.: KT x Gen.G 07/08) → settle manual
    return { ...tail, source: 'scan', probes, feed_end_no_finished: true };
  }
  return { ...first, source: 'default', stale: true, probes };
}

function extractGameData(window, trustCompleted, windowInfo) {
  const meta = window?.gameMetadata;
  if (!meta || !window.frames?.length) return null;
  // Preferência explícita por frame 'finished' — ver comentário do pickSettleFrame.
  const lastFrame = pickSettleFrame(window.frames);

  if (lastFrame.gameState !== 'finished') {
    if (!trustCompleted) return { gameState: lastFrame.gameState };
    // eventDetails diz 'completed' mas nem a janela default nem a varredura do
    // feed acharam frame 'finished'. NÃO settla com frame de meio de jogo:
    // os kills seriam PISO, não placar final (KT x Gen.G 07/08 — auditoria
    // 1a-bis: feed morreu com o jogo vivo, gold ainda subindo). Skip honesto,
    // com motivo determinístico (não depende de kills/inibidores/sorte).
    const k = killsOf(lastFrame);
    const ts = lastFrame.rfc460Timestamp;
    const reason = windowInfo?.feed_end_no_finished
      ? `feed terminou sem frame 'finished' (último frame ${lastFrame.gameState} ${ts}, kills=${k}) — settle manual`
      : windowInfo?.fresh_no_finished
        ? `feed ainda publicando (frame ${ts}, kills=${k}) — aguardando frame 'finished', retry`
        : `CDN só serve janela stale (frames até ${ts}, kills=${k}) — sem dado utilizável, retry`;
    return { gameState: lastFrame.gameState, suspect: true, suspect_reason: reason };
  }

  // Frame 'finished' achado. Coerência antes de aceitar (determinística):
  // o total do frame final não pode ser menor que o máximo da janela, e kills
  // não podem regredir entre frames — regressão = CDN misturando snapshots.
  const maxWindowKills = Math.max(...window.frames.map(killsOf));
  if (killsOf(lastFrame) < maxWindowKills || killsRegressed(window.frames)) {
    return {
      gameState: 'finished',
      suspect: true,
      suspect_reason: `kills incoerentes na janela (finished=${killsOf(lastFrame)} vs max=${maxWindowKills}) — snapshots misturados, retry`,
    };
  }

  const picks = (md) => {
    const p = md.participantMetadata;
    const get = role => p.find(x => x.role === role)?.championId || null;
    return {
      top: get('top'), jungle: get('jungle'), mid: get('mid'),
      adc: get('bottom'), support: get('support'),
    };
  };

  const blueMeta = meta.blueTeamMetadata;
  const redMeta = meta.redTeamMetadata;
  const blueInh = lastFrame.blueTeam?.inhibitors || 0;
  const redInh = lastFrame.redTeam?.inhibitors || 0;
  let winnerSide = null;
  if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';

  // Top 5 campos extras (fix 2026-05-22 — CEO request "tem acesso a isso tmb")
  // Extraction defensiva: cada campo cai pra null se não existir
  const gameDurationSecs = lastFrame.gameTime != null ? Math.round(lastFrame.gameTime / 1000) : null;
  const safe = (v) => v != null ? v : null;

  // Procura frame ~15min (900000ms) pra kills_at_15min e gold_diff_at_15min
  let frame15 = null;
  for (const f of window.frames) {
    if (f.gameTime != null && f.gameTime >= 900000) { frame15 = f; break; }
  }
  const kills15 = frame15 ? (frame15.blueTeam?.totalKills ?? 0) + (frame15.redTeam?.totalKills ?? 0) : null;
  const goldDiff15 = frame15 ? ((frame15.blueTeam?.totalGold ?? 0) - (frame15.redTeam?.totalGold ?? 0)) : null;

  // First blood: primeiro frame com kills > 0 (qualquer lado)
  let firstBloodTeam = null;
  for (const f of window.frames) {
    const kB = f.blueTeam?.totalKills ?? 0;
    const kR = f.redTeam?.totalKills ?? 0;
    if (kB > 0 || kR > 0) {
      firstBloodTeam = kB >= kR ? 'blue' : 'red';
      break;
    }
  }

  return {
    gameState: 'finished',
    kBlue: lastFrame.blueTeam?.totalKills ?? 0,
    kRed: lastFrame.redTeam?.totalKills ?? 0,
    totalKills: (lastFrame.blueTeam?.totalKills ?? 0) + (lastFrame.redTeam?.totalKills ?? 0),
    bluePicks: picks(blueMeta),
    redPicks: picks(redMeta),
    winnerSide,
    blueTeamId: blueMeta.esportsTeamId,
    redTeamId: redMeta.esportsTeamId,
    // === Top 5 extras ===
    gameDurationSecs,
    firstBloodTeam,
    killsAt15min: kills15,
    goldDiffAt15min: goldDiff15,
    blueDragons: Array.isArray(lastFrame.blueTeam?.dragons) ? lastFrame.blueTeam.dragons.length : safe(lastFrame.blueTeam?.dragons),
    redDragons: Array.isArray(lastFrame.redTeam?.dragons) ? lastFrame.redTeam.dragons.length : safe(lastFrame.redTeam?.dragons),
    blueBarons: safe(lastFrame.blueTeam?.barons),
    redBarons: safe(lastFrame.redTeam?.barons),
    blueTowers: safe(lastFrame.blueTeam?.towers),
    redTowers: safe(lastFrame.redTeam?.towers),
    blueTotalGold: safe(lastFrame.blueTeam?.totalGold),
    redTotalGold: safe(lastFrame.redTeam?.totalGold),
    blueBans: Array.isArray(blueMeta.bans) ? blueMeta.bans : null,
    redBans: Array.isArray(redMeta.bans) ? redMeta.bans : null,
  };
}

function decideOutcome(bet, gameData, matchTeams) {
  const parsed = parsePick(bet.pick, bet.market);
  const tk = gameData.totalKills;

  if (parsed.kind === 'under' && parsed.line != null) {
    const won = tk < parsed.line;
    return { won, under_hit: won, parsed };
  }
  if (parsed.kind === 'over' && parsed.line != null) {
    const won = tk > parsed.line;
    return { won, under_hit: tk < parsed.line, parsed };
  }
  if (parsed.kind === 'player_prop') {
    // Kills individuais de jogador — settle manual do COO via livestats participants.
    return { skip_reason: 'player_prop_settle_manual', parsed };
  }
  if (parsed.kind === 'moneyline') {
    // Esse branch só é alcançado por ML de MAPA (is_map_bet=true + map_number preenchido) —
    // ML de SÉRIE desvia em settleBet() ANTES de chegar aqui, pra decideSeriesMoneylineOutcome()
    // (resolve pelo placar agregado da série, não pelo vencedor de 1 game isolado).
    //
    // Lado vencedor vem do próprio game (inhibidores do frame final), não do match_context
    // gravado no placement — o lado (blue/red) pode diferir por mapa. gameData.blueTeamId/
    // redTeamId já são o teamId do Riot API PARA ESSE game específico (via participantMetadata),
    // então resolvemos o nome do vencedor batendo esse id contra a lista de times do evento
    // (matchTeams, vinda de getEventDetails), não contra o match_context estático da bet.
    if (!gameData.winnerSide) {
      return { skip_reason: 'moneyline_no_winner_side_inhibitors_tied', parsed };
    }
    const winningTeamId = gameData.winnerSide === 'blue' ? gameData.blueTeamId : gameData.redTeamId;
    const winningTeamMeta = (matchTeams || []).find(t => String(t.id) === String(winningTeamId));
    if (!winningTeamMeta) {
      return { skip_reason: 'moneyline_winning_team_not_found_in_match_teams', parsed };
    }
    const pickNorm = norm(normalizeTeam(parsed.team_pick));
    const winnerNameNorm = norm(normalizeTeam(winningTeamMeta.name));
    const winnerCodeNorm = norm(winningTeamMeta.code);
    const won = pickNorm === winnerNameNorm || pickNorm === winnerCodeNorm;
    return {
      won,
      moneyline_winner_name: winningTeamMeta.name,
      moneyline_winner_code: winningTeamMeta.code,
      parsed,
    };
  }
  return { skip_reason: 'pick_kind_unknown', parsed };
}

// ML de SÉRIE (BO3/BO5 match-level, is_map_bet=false ou map_number=null) — resolve pelo
// placar AGREGADO da série (match.teams[].result.gameWins), nunca pelo vencedor de um game
// isolado. Bug corrigido 2026-08-05: o path antigo pegava "o primeiro game completed" e
// comparava o vencedor DESSE GAME contra o pick — errado pra série, pois um time pode vencer
// o game 1 e perder a série (ex: 1-2). Função pura (sem IO) pra facilitar teste/dry-run.
function decideSeriesMoneylineOutcome(match, parsed) {
  const teams = match?.teams || [];
  if (teams.length < 2) {
    return { skip_reason: 'series_moneyline_missing_teams', parsed };
  }

  const strategyCount = match?.strategy?.count;
  if (!strategyCount) {
    return { skip_reason: 'series_moneyline_missing_strategy_count', parsed };
  }

  // Localiza o time do pick ANTES de decidir o vencedor — se o pick não bate com nenhum
  // dos 2 times do evento, é erro de dado (nome/código incompatível), não "perdeu".
  const pickNorm = norm(normalizeTeam(parsed.team_pick));
  const pickTeam = teams.find(t => {
    const nameNorm = norm(normalizeTeam(t.name));
    const codeNorm = norm(t.code);
    return pickNorm === nameNorm || pickNorm === codeNorm;
  });
  if (!pickTeam) {
    return { skip_reason: 'series_moneyline_pick_team_not_found_in_match_teams', parsed };
  }

  const gameWins = teams.map(t => t?.result?.gameWins);
  if (gameWins.some(w => w == null)) {
    return { skip_reason: 'series_moneyline_missing_gamewins', parsed };
  }

  const scoreStr = teams.map(t => `${t.code}:${t.result.gameWins}`).join(' ');
  const winsNeeded = Math.ceil(strategyCount / 2);
  const leaders = teams.filter(t => t.result.gameWins >= winsNeeded);

  if (leaders.length === 0) {
    return { skip_reason: `series_moneyline_not_finished (${scoreStr}, precisa ${winsNeeded} de ${strategyCount})`, parsed };
  }
  if (leaders.length > 1) {
    // Empate impossível numa série real — indica dado inconsistente da API. Nunca adivinha.
    return { skip_reason: `series_moneyline_gamewins_invalid_multiple_leaders (${scoreStr})`, parsed };
  }

  const winner = leaders[0];
  const won = String(winner.id) === String(pickTeam.id);

  return {
    won,
    series_winner_name: winner.name,
    series_winner_code: winner.code,
    series_score: scoreStr,
    series_wins_needed: winsNeeded,
    parsed,
  };
}

// PATCH idempotente: só atualiza se a row AINDA está pending (id+estado).
// Retorna { done, rows } — rows vazio = outra execução settlou antes (não é erro).
async function patchIfStillPending(ctx, betId, update) {
  const rows = await supabaseRequest(
    ctx.supabaseUrl, ctx.supabaseKey, 'PATCH',
    `/rest/v1/bets?id=eq.${betId}&status=eq.pending`, update);
  const done = Array.isArray(rows) && rows.length > 0;
  return { done, rows };
}

// Settle de ML de SÉRIE — não depende de livestats/window (o placar da série já vem pronto
// em getEventDetails), então não busca game/frame nenhum. Monta o update no mesmo formato
// do path de mapa (status+profit sempre juntos, fair_pinnacle/fair_formula via helper comum).
async function settleSeriesMoneyline(ctx, bet, match) {
  const parsed = parsePick(bet.pick, bet.market);
  const outcome = decideSeriesMoneylineOutcome(match, parsed);
  if (outcome.skip_reason) {
    return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: outcome.skip_reason };
  }

  const stake = parseFloat(bet.stake);
  const odd = resolveOdd(bet);
  const profit = outcome.won ? +(stake * (odd - 1)).toFixed(2) : -stake;
  const status = outcome.won ? 'green' : 'red';

  const newRawExtraction = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
  newRawExtraction.match_context = {
    ...(newRawExtraction.match_context || {}),
    series_score_final: outcome.series_score,
    series_winner_name: outcome.series_winner_name,
    series_winner_code: outcome.series_winner_code,
    series_wins_needed: outcome.series_wins_needed,
    settled_at: new Date().toISOString(),
  };

  const fairFields = ctx.outcomeOnly ? null : computeFairFields(bet);

  const update = {
    status,
    profit,
    settled_at: new Date().toISOString(),
    settle_source: `lolesports api - series winner ${outcome.series_winner_name} (${outcome.series_score})`,
    raw_extraction: newRawExtraction,
    ...(!ctx.outcomeOnly && bet.fair_pinnacle == null && fairFields.fairPinnacleSettle != null ? { fair_pinnacle: fairFields.fairPinnacleSettle } : {}),
    ...(!ctx.outcomeOnly && bet.fair_formula == null && fairFields.fairFormulaSettle != null ? { fair_formula: fairFields.fairFormulaSettle } : {}),
    ...(!ctx.outcomeOnly && bet.fair_line_source == null ? { fair_line_source: fairFields.fairLineSourceSettle } : {}),
  };

  if (ctx.dryRun) {
    return { bet_id: bet.id, status: 'dry_run_would_update', would_update: update, series_score: outcome.series_score };
  }

  try {
    const { done } = await patchIfStillPending(ctx, bet.id, update);
    if (!done) {
      return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: 'concurrent_settle_zero_rows (row já não estava pending — idempotência)' };
    }
    return { bet_id: bet.id, status: 'settled', outcome: status, profit, series_score: outcome.series_score };
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `patch: ${e.message}` };
  }
}

// Fix 1: gameWindowCache compartilhado entre chamadas da mesma execução do script.
// Evita que 2+ bets do mesmo lolesports_game_id façam requests duplicados ao CDN,
// o que poderia resultar em snapshots stale diferentes pra cada bet.
async function settleBet(ctx, bet, gameWindowCache) {
  const matchId = bet.raw_extraction?.match_context?.lolesports_match_id;
  if (!matchId) return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: 'no_match_id_in_raw_extraction' };

  // 1. eventDetails → games
  let detail;
  try {
    detail = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`);
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `eventDetails: ${e.message}` };
  }
  const match = detail?.data?.event?.match;
  const games = Array.isArray(match?.games) ? match.games : [];
  if (games.length === 0) return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: 'no_games_in_match' };

  // ML de SÉRIE (moneyline sem is_map_bet+map_number) desvia ANTES de escolher um game
  // isolado — resolve pelo placar agregado da série (match.teams[].result.gameWins).
  // decideOutcome()/o path abaixo continuam servindo ML de MAPA e over/under/player_prop
  // match-level (que resolvem corretamente pegando 1 game específico).
  const isMapBetWithNumber = !!(bet.is_map_bet && bet.map_number);
  const parsedPick = parsePick(bet.pick, bet.market);
  if (parsedPick.kind === 'moneyline' && !isMapBetWithNumber) {
    return settleSeriesMoneyline(ctx, bet, match);
  }

  // 2. localiza o game pelo map_number (se is_map_bet) ou primeiro completed (se match-level)
  let game;
  if (isMapBetWithNumber) {
    game = games.find(g => g.number === bet.map_number);
  } else {
    game = games.find(g => g.state === 'completed') || games[0];
  }
  if (!game) return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `no_game_for_map_${bet.map_number}` };
  if (game.state !== 'completed') return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `game_state_${game.state}` };

  // 3. window livestats — Fix 1: cache por game_id pra evitar requests duplicados.
  // game.state === 'completed' no eventDetails autoriza a varredura do fim do
  // feed quando o CDN serve janela stale (fetchBestWindow, medição 2026-08-08).
  const matchStart = detail?.data?.event?.startTime || bet.bet_datetime;
  const trustCompleted = game.state === 'completed';
  let wrap;
  const cacheKey = String(game.id);
  if (gameWindowCache.has(cacheKey)) {
    wrap = gameWindowCache.get(cacheKey);
    // log só em dry-run pra não poluir output normal
    if (ctx.dryRun) process.stderr.write(`[cache hit] game_id=${sanitizeStr(cacheKey, 40)} reusado sem novo request\n`);
  } else {
    try {
      wrap = await fetchBestWindow(game.id, matchStart, trustCompleted);
      gameWindowCache.set(cacheKey, wrap); // armazena pra demais bets do mesmo game
    } catch (e) {
      return { bet_id: bet.id, status: 'error', reason: `livestats: ${e.message}` };
    }
  }
  if (ctx.dryRun && wrap.source === 'scan') {
    process.stderr.write(`[scan] game_id=${sanitizeStr(cacheKey, 40)} fim do feed achado com ${wrap.probes} probe(s)\n`);
  }

  const gd = extractGameData(wrap.win, trustCompleted, wrap);
  if (!gd) return { bet_id: bet.id, status: 'error', reason: 'livestats_no_data' };

  // Fix 2+3: frame suspeito (CDN stale) → skip pra retry na próxima execução
  if (gd.suspect) {
    process.stderr.write(sanitizeStr(`[WARN] bet=${bet.id} game=${cacheKey} frame suspeito: ${gd.suspect_reason}`) + '\n');
    return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `suspect_frame: ${gd.suspect_reason}` };
  }

  if (gd.gameState && gd.gameState !== 'finished' && !trustCompleted) {
    return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `game_window_state_${gd.gameState}` };
  }

  // 4. decide outcome
  const outcome = decideOutcome(bet, gd, match?.teams);
  if (outcome.skip_reason) return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: outcome.skip_reason };

  // 5. detecta trigger
  const triggerType = detectTrigger(gd.bluePicks.support, gd.redPicks.support);

  // 6. monta update payload
  const stake = parseFloat(bet.stake);
  const odd = resolveOdd(bet);
  const profit = outcome.won ? +(stake * (odd - 1)).toFixed(2) : -stake;
  const status = outcome.won ? 'green' : 'red';

  // Series score at bet: conta quantos games estavam completed antes desse map
  let seriesScoreAtBet = null;
  if (bet.map_number && bet.map_number > 1) {
    const mapsPlayedBefore = games.filter(g => g.number < bet.map_number && g.state === 'completed').length;
    seriesScoreAtBet = { maps_completed_before: mapsPlayedBefore, current_map: bet.map_number };
  }

  const newRawExtraction = JSON.parse(JSON.stringify(bet.raw_extraction || {}));
  newRawExtraction.match_context = {
    ...(newRawExtraction.match_context || {}),
    lolesports_game_id: String(game.id),
    blue_team_id: String(gd.blueTeamId || ''),
    red_team_id: String(gd.redTeamId || ''),
    blue_picks: gd.bluePicks,
    red_picks: gd.redPicks,
    kills_blue: gd.kBlue,
    kills_red: gd.kRed,
    total_kills: gd.totalKills,
    winner_side: gd.winnerSide,
    trigger_type: triggerType,
    under_hit: outcome.under_hit,
    settled_at: new Date().toISOString(),
    // === Top 5 extras (fix 2026-05-22) ===
    game_duration_secs: gd.gameDurationSecs,
    first_blood_team: gd.firstBloodTeam,
    kills_at_15min: gd.killsAt15min,
    gold_diff_at_15min: gd.goldDiffAt15min,
    blue_dragons: gd.blueDragons,
    red_dragons: gd.redDragons,
    blue_barons: gd.blueBarons,
    red_barons: gd.redBarons,
    blue_towers: gd.blueTowers,
    red_towers: gd.redTowers,
    blue_total_gold: gd.blueTotalGold,
    red_total_gold: gd.redTotalGold,
    blue_bans: gd.blueBans,
    red_bans: gd.redBans,
    series_score_at_bet: seriesScoreAtBet,
  };

  // Calcula fair_pinnacle/fair_formula pra popular as colunas dedicadas no settle.
  const fairFields = ctx.outcomeOnly ? null : computeFairFields(bet);

  // Schema da tabela bets NÃO tem coluna under_hit (essa é da method_reports).
  // under_hit fica em raw_extraction.match_context (JSONB) acima.
  const update = {
    status,
    profit,
    settled_at: new Date().toISOString(),
    settle_source: outcome.moneyline_winner_name
      ? `lolesports api - winner ${outcome.moneyline_winner_name} (${gd.totalKills} kills)`
      : `lolesports api - ${gd.totalKills} kills`,
    raw_extraction: newRawExtraction,
    // Popula colunas de fair só se ainda NULL no banco (bet não sobrescreve valor já presente)
    ...(!ctx.outcomeOnly && bet.fair_pinnacle == null && fairFields.fairPinnacleSettle != null ? { fair_pinnacle: fairFields.fairPinnacleSettle } : {}),
    ...(!ctx.outcomeOnly && bet.fair_formula == null && fairFields.fairFormulaSettle != null ? { fair_formula: fairFields.fairFormulaSettle } : {}),
    ...(!ctx.outcomeOnly && bet.fair_line_source == null ? { fair_line_source: fairFields.fairLineSourceSettle } : {}),
  };

  if (ctx.dryRun) {
    return { bet_id: bet.id, status: 'dry_run_would_update', would_update: update, total_kills: gd.totalKills, trigger: triggerType };
  }

  try {
    const { done } = await patchIfStillPending(ctx, bet.id, update);
    if (!done) {
      return { bet_id: bet.id, league: bet.league, status: 'skipped', reason: 'concurrent_settle_zero_rows (row já não estava pending — idempotência)' };
    }
    return { bet_id: bet.id, status: 'settled', outcome: status, total_kills: gd.totalKills, profit, trigger: triggerType, supports: `${gd.bluePicks.support}/${gd.redPicks.support}` };
  } catch (e) {
    return { bet_id: bet.id, status: 'error', reason: `patch: ${e.message}` };
  }
}

// ─── Orquestração (testável: config e fair injetáveis, clientes via _setDeps) ─
async function runSettle(opts = {}) {
  const dryRun = !!opts.dryRun;
  const outcomeOnly = !!opts.outcomeOnly;
  const specificBetId = opts.specificBetId || null;
  const progress = opts.progress || {};

  let config = opts.config;
  if (!config) {
    // Credencial só aqui, nunca no load do módulo (testes injetam opts.config).
    const { loadConfig } = require('./_load-config.cjs');
    config = loadConfig();
  }
  const ctx = { supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey, dryRun, outcomeOnly };

  const summary = { checked: 0, settled: 0, skipped: 0, errors: 0, dry_run: dryRun, outcome_only: outcomeOnly, results: [] };
  progress.summary = summary;

  // ── Fair guard (Fase 3A) — fronteira de segurança ANTES de qualquer PATCH ──
  // --dry-run é diagnóstico sem mutação → não exige fair.
  let fairGuard = null;
  if (!dryRun && !outcomeOnly) {
    fairGuard = checkFairReady(opts.fairOpts || {});
    summary.fair_guard = fairGuard.ok
      ? { ok: true, skip: !!fairGuard.skip, source: fairGuard.source }
      : { ok: false, code: fairGuard.code, error: fairGuard.error };
    if (!fairGuard.ok) logDegraded(`fair_guard_${fairGuard.code}`, fairGuard.error);
  }

  // 1. busca bets (read-only — permitido mesmo com guard reprovado, pra visibilidade)
  const qs = specificBetId ? `id=eq.${specificBetId}` : 'status=eq.pending';
  let pending;
  try {
    pending = await supabaseRequest(ctx.supabaseUrl, ctx.supabaseKey, 'GET', `/rest/v1/bets?${qs}&select=*`);
  } catch (e) {
    throw new Error(`pending_fetch: ${e.message}`);
  }
  if (!Array.isArray(pending)) {
    throw new Error('pending_fetch: resposta inesperada do banco (não-array) — schema/erro upstream, nenhuma mutação executada');
  }

  if (pending.length === 0) {
    summary.message = specificBetId ? `bet ${specificBetId} não encontrada` : 'nenhuma bet pending';
    return summary;
  }

  summary.checked = pending.length;

  // Fix 1: cache compartilhado por execução — 1 request por game_id, independente
  // de quantas bets apontem pro mesmo lolesports_game_id nessa rodada.
  const gameWindowCache = new Map();

  for (const bet of pending) {
    let result;
    const rowErr = validateBetRow(bet);
    if (rowErr) {
      result = { bet_id: (bet && typeof bet.id === 'string') ? bet.id : null, status: 'error', reason: `bet_row_invalid: ${rowErr}` };
    } else if (bet.status !== 'pending') {
      // IDEMPOTÊNCIA por ID+estado: bet já settlada NUNCA é re-settlada, nem via --id.
      result = { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `already_settled_status_${bet.status} (idempotência: re-rodar não duplica profit)` };
    } else if (fairGuard && !fairGuard.ok) {
      // Guard reprovado: NENHUMA mutação. Estado degradado visível no summary.
      result = { bet_id: bet.id, league: bet.league, status: 'skipped', reason: `fair_guard_${fairGuard.code}` };
    } else {
      result = await settleBet(ctx, bet, gameWindowCache);
    }
    summary.results.push(result);
    if (result.status === 'settled') summary.settled++;
    else if (result.status === 'error') summary.errors++;
    else summary.skipped++;
  }

  return summary;
}

// Watchdog do timeout interno (12s < 15s do hook). unref() pra não segurar o
// processo vivo; dispara mesmo com o event loop preso em IO pendente.
function _startWatchdog(ms, onTimeout) {
  const t = setTimeout(onTimeout, ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = {
  runSettle,
  settleBet,
  settleSeriesMoneyline,
  decideOutcome,
  decideSeriesMoneylineOutcome,
  parsePick,
  detectTrigger,
  extractGameData,
  pickSettleFrame,
  fetchBestWindow,
  validateBetRow,
  resolveOdd,
  sanitizeStr,
  sanitizeDeep,
  computeFairFields,
  _setDeps,
  _resetDeps,
  _startWatchdog,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const outcomeOnly = argv.includes('--outcome-only');
  const specificBetId = argv.find(a => !['--dry-run', '--outcome-only'].includes(a) && /^[a-f0-9-]{36}$/i.test(a)) || null;

  const envTimeout = parseInt(process.env.SETTLE_TIMEOUT_MS, 10);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS;

  const progress = {};
  _startWatchdog(timeoutMs, () => {
    // Estado degradado VISÍVEL: summary parcial + exit 3. Nunca sucesso silencioso.
    logDegraded('internal_timeout', `settle excedeu ${timeoutMs}ms (timeout interno < hook externo)`);
    console.log(JSON.stringify(sanitizeDeep({
      error: `internal_timeout: settle excedeu ${timeoutMs}ms — estado degradado, nenhuma mutação nova após este ponto`,
      degraded: true,
      partial_summary: progress.summary || null,
    })));
    process.exit(3);
  });

  runSettle({ dryRun, outcomeOnly, specificBetId, progress })
    .then(summary => {
      console.log(JSON.stringify(sanitizeDeep(summary), null, 2));
      process.exit(0);
    })
    .catch(e => {
      logDegraded('fatal', e.message);
      console.log(JSON.stringify({ error: sanitizeStr(e.message), degraded: true }));
      process.exit(1);
    });
}
