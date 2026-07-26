// scripts/audit/lib/api-cache.cjs
//
// Fetch da API lolesports com cache em disco (audit-cache/), retry + throttle.
// Jogos `completed` são imutáveis — depois do primeiro fetch, re-rodar a auditoria
// custa ~0 chamadas de rede (tudo sai do cache).
//
// Hosts:
//   esports-api.lolesports.com/persisted/gw/getSchedule?leagueId=X[&pageToken=Y]
//   esports-api.lolesports.com/persisted/gw/getEventDetails?id=X
//   esports-api.lolesports.com/persisted/gw/getTeams
//   feed.lolesports.com/livestats/v1/window/{gameId}?startingTime=ISO
//
// Cache (arquivos em audit-cache/, na raiz do repo):
//   schedule-{leagueId}-p{n}.json  — n = pageIndex explícito passado pelo caller (0-based)
//   event-{matchId}.json
//   window-{gameId}.json           — só grava quando a resposta tem frames válidos
//                                     (ver nota em getWindow)
//   teams.json
//
// Retry: 4 tentativas totais (1 + 3 retries), backoff 1s/3s/9s entre elas.
// HTTP 429: espera fixa de 30s antes de tentar de novo (consome 1 retry).
// Throttle: mínimo 250ms entre CHAMADAS DE REDE (cache hit não conta, é instantâneo).
//
// Falha definitiva (esgotou retries) → lança AuditFetchError. O caller (phase0 etc)
// deve capturar, registrar em audit-output/fetch-errors.json e SEGUIR — nunca abortar
// a auditoria inteira por causa de 1 game/match com problema.
//
// Uso:
//   const { getSchedulePage, getEventDetails, getWindow, getTeams, AuditFetchError,
//           tsRoundedTo10sCapped } = require('./lib/api-cache.cjs');
//
//   const page = await getSchedulePage(leagueId, pageToken, { pageIndex: 0 });
//   const detail = await getEventDetails(matchId);
//   const win = await getWindow(gameId, tsRoundedTo10sCapped(startMs));
//   const teams = await getTeams();
//
// opts.noCache = true força refetch de rede ignorando o que tiver em disco
// (ainda assim regrava o cache no final, se a resposta for válida).

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // scripts/audit/lib -> repo root
const CACHE_DIR = path.join(ROOT, 'audit-cache');

const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const THROTTLE_MS = 250;
const RETRY_BACKOFFS_MS = [1000, 3000, 9000]; // 1s / 3s / 9s — 3 retries além da 1ª tentativa
const RATE_LIMIT_WAIT_MS = 30000; // HTTP 429

// Erro tipado: caller identifica pelo `name` ou `instanceof` e decide o que fazer
// (registrar em fetch-errors.json e continuar, nunca deixar derrubar o processo inteiro).
class AuditFetchError extends Error {
  constructor(message, { url, statusCode = null, attempts, cause = null } = {}) {
    super(message);
    this.name = 'AuditFetchError';
    this.url = url;
    this.statusCode = statusCode;
    this.attempts = attempts;
    this.cause = cause;
  }
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(filename) {
  return path.join(CACHE_DIR, filename);
}

function readCache(filename) {
  const p = cachePath(filename);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // cache corrompido/parcial: trata como miss, refaz o fetch
  }
}

function writeCache(filename, data) {
  ensureCacheDir();
  fs.writeFileSync(cachePath(filename), JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Throttle global do módulo — só se aplica a chamadas de rede de verdade.
let lastCallStart = 0;
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastCallStart;
  const wait = elapsed < THROTTLE_MS ? THROTTLE_MS - elapsed : 0;
  if (wait > 0) await sleep(wait);
  lastCallStart = Date.now();
}

function rawGet(host, urlPath) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host,
          path: urlPath,
          headers: {
            'x-api-key': LOLES_KEY,
            'User-Agent': 'Mozilla/5.0',
            Origin: 'https://lolesports.com',
            Referer: 'https://lolesports.com/',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        }
      )
      .on('error', reject);
  });
}

// Fetch com retry (backoff 1s/3s/9s) + tratamento de 429 (espera fixa 30s).
// Fix de IDs longos (>=15 dígitos): a Riot manda number puro que o JSON.parse do V8
// trunca por perda de precisão — envolve em aspas antes de parsear (mesmo regex de
// settle-pending-bets.cjs L127 e rebuild_dashboard_stats_cron.cjs L52).
async function fetchWithRetry(host, urlPath) {
  const url = `https://${host}${urlPath}`;
  const maxAttempts = RETRY_BACKOFFS_MS.length + 1; // 1 tentativa inicial + 3 retries
  let lastErr = null;
  let lastStatus = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await throttle();
    try {
      const { statusCode, body } = await rawGet(host, urlPath);

      if (statusCode === 429) {
        lastErr = new Error('HTTP 429 (rate limited)');
        lastStatus = 429;
        if (attempt === maxAttempts - 1) break;
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      if (statusCode >= 400) {
        lastErr = new Error(`HTTP ${statusCode}: ${body.slice(0, 200)}`);
        lastStatus = statusCode;
        if (attempt === maxAttempts - 1) break;
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }

      const fixed = body.replace(
        /"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g,
        '"$1":"$2"'
      );
      try {
        return JSON.parse(fixed);
      } catch (e) {
        lastErr = new Error(`JSON parse error: ${e.message}`);
        if (attempt === maxAttempts - 1) break;
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }
    } catch (e) {
      lastErr = e; // erro de rede (ECONNRESET etc)
      if (attempt === maxAttempts - 1) break;
      await sleep(RETRY_BACKOFFS_MS[attempt]);
    }
  }

  throw new AuditFetchError(
    `fetch failed after ${maxAttempts} attempts: ${url} — ${lastErr?.message}`,
    { url, statusCode: lastStatus, attempts: maxAttempts, cause: lastErr }
  );
}

async function getSchedulePage(leagueId, pageToken, opts = {}) {
  const pageIndex = opts.pageIndex != null ? opts.pageIndex : 0;
  const filename = `schedule-${leagueId}-p${pageIndex}.json`;
  if (!opts.noCache) {
    const cached = readCache(filename);
    if (cached) return cached;
  }
  const qs = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const data = await fetchWithRetry(
    'esports-api.lolesports.com',
    `/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}${qs}`
  );
  writeCache(filename, data);
  return data;
}

async function getEventDetails(matchId, opts = {}) {
  const filename = `event-${matchId}.json`;
  if (!opts.noCache) {
    const cached = readCache(filename);
    if (cached) return cached;
  }
  const data = await fetchWithRetry(
    'esports-api.lolesports.com',
    `/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`
  );
  writeCache(filename, data);
  return data;
}

// Nota importante sobre cache do window: diferente dos outros 3 endpoints, aqui SÓ
// gravamos em disco quando a resposta parece válida (tem frames + gameMetadata).
// Motivo: o caller (phase0) tenta vários `startingTimeISO` pro MESMO gameId até achar
// um frame não-vazio (heurística +6h, fallback +2h/+4h/+8h). Se a gente cacheasse a
// PRIMEIRA resposta (possivelmente vazia porque o startingTime testado ainda não tinha
// jogo rodando), as tentativas seguintes com outro startingTime encontrariam o cache
// "ruim" no disco e nunca chegariam a fazer o fetch de verdade — quebrando o retry.
// Resultado prático: se todas as tentativas falharem, nada fica em cache (o próximo
// re-run vai tentar de novo — aceitável, é um subconjunto pequeno de games suspeitos).
async function getWindow(gameId, startingTimeISO, opts = {}) {
  const filename = `window-${gameId}.json`;
  if (!opts.noCache) {
    const cached = readCache(filename);
    if (cached) return cached;
  }
  const data = await fetchWithRetry(
    'feed.lolesports.com',
    `/livestats/v1/window/${gameId}?startingTime=${encodeURIComponent(startingTimeISO)}`
  );
  const looksValid = data && Array.isArray(data.frames) && data.frames.length > 0 && data.gameMetadata;
  if (looksValid) writeCache(filename, data);
  return data;
}

async function getTeams(opts = {}) {
  const filename = 'teams.json';
  if (!opts.noCache) {
    const cached = readCache(filename);
    if (cached) return cached;
  }
  const data = await fetchWithRetry('esports-api.lolesports.com', '/persisted/gw/getTeams?hl=en-US');
  writeCache(filename, data);
  return data;
}

async function getLeagues(opts = {}) {
  const filename = 'leagues.json';
  if (!opts.noCache) {
    const cached = readCache(filename);
    if (cached) return cached;
  }
  const data = await fetchWithRetry('esports-api.lolesports.com', '/persisted/gw/getLeagues?hl=en-US');
  writeCache(filename, data);
  return data;
}

// Mesma heurística de settle-pending-bets.cjs L197-209 (tsRoundedTo10s + fetchGameWindow):
// arredonda pra baixo em múltiplos de 10s, e nunca deixa passar de (agora - 200s) —
// a API não libera frames de janelas muito recentes.
function tsRoundedTo10sCapped(ms) {
  const capped = Math.min(ms, Date.now() - 200 * 1000);
  const t = Math.floor(capped / 10000) * 10000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

module.exports = {
  getSchedulePage,
  getEventDetails,
  getWindow,
  getTeams,
  getLeagues,
  tsRoundedTo10sCapped,
  AuditFetchError,
  CACHE_DIR,
};
