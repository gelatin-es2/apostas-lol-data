'use strict';

// Core do coletor BR sem cache — endpoint público, deslogado, do sportsbook que roda
// dentro do pinnacle.bet.br (operação licenciada BR, A2FBR/Portaria SPA).
// Investigação: knowledge/reports/2026-08-23-pinnacle-br-vs-internacional.md — mesmo
// livro do `.com` (guest.api.arcadia.pinnacle.com), ids de matchup IDÊNTICOS, preços
// idênticos até a 3ª casa decimal, SEM cache Cloudflare (`cf-cache-status: DYNAMIC`,
// sem `Age`, sem `max-age` — contra os 905s do `.com`).
//
// FORMATO DO PAYLOAD (reverse-engineered em 23/08, sem doc oficial — schema por
// posição de array, não por chave nomeada como o `.com`):
//
//   GET /sports-service/sv/odds/events?sp=12&mk=3&ot=1&btg=1&o=1&l=9&cl=9&v=0&me=0
//       &more=false&c=BR&tm=0&pa=0&pn=-1&_g=1
//   → { l: [...], n: [...], ... }   (l = bucket visto com jogo ao vivo; n = bucket
//       "próximos"/pré-jogo — hipótese por observação empírica, não documentada pela
//       Pinnacle; NÃO usamos essa distinção como fonte de verdade de fase — ver phase()).
//
//   cada bucket (l, n) = [ [sportId, sportName, [ [leagueId, leagueName, [ matchup, ... ]
//       , ... ] ] ] ]
//
//   matchup (array por POSIÇÃO, confirmado por comparação direta campo-a-campo contra
//   o `.com` no MESMO matchupId, no mesmo instante — ver seção "validação" no relatório
//   de execução):
//     [0]  matchupId          — MESMO id do `.com` (confirmado 7/7 no relatório de 23/08)
//     [1]  home (c/ sufixo "(Kills)" quando for o sub-matchup de kills)
//     [2]  away (idem)
//     [3]  código interno (varia por matchup, sem uso identificado — NÃO decodificado)
//     [4]  startTime em epoch ms — igual pro matchup Regular e pro sub-matchup Kills
//     [5]  0/1 — hipótese: flag de "ao vivo". NÃO confirmado contra um jogo de LoL ao
//          vivo real (nenhum rolando durante a investigação de 23/08); confirmado só
//          o lado negativo (0 ⇔ isLive=false no `.com`, testado em 2 matchups). Por
//          isso NÃO é usado como fonte de phase aqui — ver phase().
//     [8]  objeto de períodos: chave = número do período (string), valor = array (ver
//          decodePeriodArray abaixo)
//     [24] home SEM sufixo (nome limpo, usado como team_home)
//     [25] away SEM sufixo
//     [27] rótulo do mercado: "Kills" | "Regular" — equivalente ao `units` do `.com`
//     [28] parentId: 0 quando o próprio matchup É a série (Regular); matchupId da série
//          quando é o sub-matchup de Kills — equivalente ao `parentId` do `.com`
//
//   período (array por posição, dentro do objeto em matchup[8]):
//     [0] ladder de SPREAD de kills — NÃO decodificado com confiança (shape de 11
//         campos por linha, ambíguo em relação a home/away/isAlternate). spread_main
//         gravado como null, documentado.
//     [1] ladder de TOTAL de kills — [pointsStr, pointsNum, overDec, underDec, priceId,
//         mainFlag, limit, flag]. mainFlag: 0 = linha PRINCIPAL (equivalente a
//         isAlternate=false no `.com`), 1 = degrau alternativo da escada. Confirmado por
//         comparação direta: BR 28.5 @ over=2.080/under=1.689 (mainFlag=0) contra `.com`
//         mesmo matchupId/período no mesmo minuto: 28.5 @ over=2.07/under=1.699 —
//         diferença compatível com movimento normal de linha entre as duas leituras
//         (~3min de intervalo), mesmo par over/under, mesma ordem.
//     [2] provável mercado 2-way adicional (moneyline-like) — presente também nos
//         períodos do sub-matchup de Kills, onde moneyline não faz sentido de negócio;
//         NÃO decodificado com confiança. ml_home_us/ml_away_us gravados como null.
//
// O QUE FICA NULL NESTA COLETA (documentado, não inventado):
//   ml_home_us, ml_away_us, spread_main, team_totals — payload BR não decodificado
//   com confiança pra esses mercados no tempo desta tarefa. main_line/over_dec/
//   under_dec/juice_pct/ladder (TOTAL de kills) são o que a operação usa — esses
//   estão confirmados.
//   market_version — BR não expõe um contador de versão equivalente ao `version` do
//   `.com`; gravado como constante 0 (documentado). O delta-gating real é por
//   content_hash (payload completo: linha + ladder), igual ao coletor `.com`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE_URL = 'https://sports2.pinnacle.bet.br/sports-service/sv';
const EVENTS_QUERY = 'sp=12&mk=3&ot=1&btg=1&o=1&l=9&cl=9&v=0&me=0&more=false&c=BR&tm=0&pa=0&pn=-1&_g=1';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];

// Raiz do repo: este arquivo mora em .claude/scripts/lib/ (3 níveis acima).
const REPO = path.resolve(__dirname, '..', '..', '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Proxy SOCKS5 (cópia intencional do padrão de pinnacle_core.cjs — mesmo padrão
// documentado lá: "não importado pra não acoplar os dois scripts"). Sem
// PINNACLE_PROXY_HOST configurado, segue sem proxy (não deve acontecer em produção:
// regra do projeto é TODO request pra Pinnacle sair pelo proxy SOCKS5 do .env). -----
function parseDotEnv(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadProxyConfig() {
  let type = process.env.PINNACLE_PROXY_TYPE;
  let host = process.env.PINNACLE_PROXY_HOST;
  let port = process.env.PINNACLE_PROXY_PORT;
  let user = process.env.PINNACLE_PROXY_USER;
  let pass = process.env.PINNACLE_PROXY_PASS;

  if (!host) {
    const envPath = path.join(REPO, '.env');
    if (fs.existsSync(envPath)) {
      const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
      type = type || env.PINNACLE_PROXY_TYPE;
      host = host || env.PINNACLE_PROXY_HOST;
      port = port || env.PINNACLE_PROXY_PORT;
      user = user || env.PINNACLE_PROXY_USER;
      pass = pass || env.PINNACLE_PROXY_PASS;
    }
  }

  if (!host) return null;
  return { type: type || 'socks5', host, port: port || '1080', user, pass };
}

const PROXY = loadProxyConfig();
let proxyModeLogged = false;
function logProxyModeOnce() {
  if (proxyModeLogged) return;
  proxyModeLogged = true;
  if (PROXY) console.log(`[pinnacle_br_core] saindo via proxy SOCKS5 ${PROXY.host}:${PROXY.port}`);
  else console.log('[pinnacle_br_core] ⚠️ saindo SEM proxy (PINNACLE_PROXY_HOST não configurado)');
}
function proxyInfo() {
  return { enabled: !!PROXY, host: PROXY ? PROXY.host : null, port: PROXY ? PROXY.port : null };
}

async function directRequest(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://sports2.pinnacle.bet.br/pt/',
      },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status, data: await res.json() };
    const out = { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) out.retryAfterMs = Math.min(ra * 1000, 30000);
    return out;
  } catch (err) {
    return { ok: false, status: 0, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// curl.exe --socks5-hostname (DNS resolvido do lado do proxy) — mesmo transporte que
// pinnacle_core.cjs usa pro `.com`. Senha só entra nos args do processo filho.
function curlRequest(url, timeoutMs) {
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));
  const args = [
    '-s', '-D', '-',
    '--max-time', String(timeoutSec),
    '--socks5-hostname', `${PROXY.host}:${PROXY.port}`,
  ];
  if (PROXY.user) args.push('--proxy-user', `${PROXY.user}:${PROXY.pass || ''}`);
  args.push(
    '-H', 'Accept: application/json',
    '-H', 'X-Requested-With: XMLHttpRequest',
    '-H', 'Referer: https://sports2.pinnacle.bet.br/pt/',
    '-w', '\n%{http_code}',
    url
  );

  const result = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  if (result.error) return { ok: false, status: 0, error: result.error.message || String(result.error) };
  if (result.status !== 0) return { ok: false, status: 0, error: `curl exit ${result.status}` };

  const stdout = result.stdout || '';
  const lastNlIdx = stdout.lastIndexOf('\n');
  const head = lastNlIdx === -1 ? '' : stdout.slice(0, lastNlIdx);
  const statusStr = (lastNlIdx === -1 ? stdout : stdout.slice(lastNlIdx + 1)).trim();
  const status = Number(statusStr);

  const sepIdx = head.search(/\r?\n\r?\n/);
  const headerBlock = sepIdx === -1 ? head : head.slice(0, sepIdx);
  const body = sepIdx === -1 ? '' : head.slice(sepIdx).replace(/^\r?\n\r?\n/, '');

  let retryAfterMs;
  const raMatch = headerBlock.match(/^Retry-After:\s*(\d+)/im);
  if (raMatch) {
    const ra = Number(raMatch[1]);
    if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 30000);
  }

  if (!Number.isFinite(status) || status < 100) {
    return { ok: false, status: 0, error: 'curl: status parse falhou', retryAfterMs };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, status, error: `HTTP ${status}`, retryAfterMs };
  }
  try {
    return { ok: true, status, data: JSON.parse(body) };
  } catch (err) {
    return { ok: false, status, error: `JSON parse: ${err.message}` };
  }
}

// Fetch com retry (mesma política de pinnacle_core.cjs): 3 tentativas extras em
// 429/5xx/erro de rede, backoff exponencial honrando Retry-After. 403 e outros 4xx
// não re-tentam — regra do projeto é PARAR em 403, nunca insistir.
async function fetchEvents({ timeoutMs = 15000 } = {}) {
  logProxyModeOnce();
  const url = `${BASE_URL}/odds/events?${EVENTS_QUERY}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const retryAfterMs = lastErr && lastErr.retryAfterMs;
      await sleep(retryAfterMs || RETRY_DELAYS_MS[attempt - 1]);
    }
    const result = PROXY ? curlRequest(url, timeoutMs) : await directRequest(url, timeoutMs);
    if (result.ok) return { ok: true, status: result.status, data: result.data, attempts: attempt + 1 };
    lastErr = { status: result.status, error: result.error };
    if (result.retryAfterMs) lastErr.retryAfterMs = result.retryAfterMs;
    if (!RETRY_STATUS.has(result.status)) break;
  }
  return { ok: false, status: lastErr ? lastErr.status : 0, error: lastErr ? lastErr.error : 'unknown', url };
}

// Percorre os buckets (l, n) e devolve os sub-matchups de Kills de LoL (unidade[27]
// === 'Kills', liga começando com 'League of Legends - '). Ids precisam ser inteiros
// seguros — mesma cautela do `.com` (evita interpolar id corrompido em query PostgREST).
function extractLolKillsMatchups(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const bucketName of ['l', 'n']) {
    const bucket = raw[bucketName];
    if (!Array.isArray(bucket)) continue;
    for (const sport of bucket) {
      const leagues = sport?.[2];
      if (!Array.isArray(leagues)) continue;
      for (const league of leagues) {
        const leagueName = league?.[1];
        if (typeof leagueName !== 'string' || !leagueName.startsWith('League of Legends - ')) continue;
        const matchups = league?.[2];
        if (!Array.isArray(matchups)) continue;
        for (const m of matchups) {
          if (!Array.isArray(m) || m[27] !== 'Kills') continue;
          if (!Number.isSafeInteger(m[0])) continue;
          const seriesId = Number.isSafeInteger(m[28]) && m[28] !== 0 ? m[28] : m[0];
          out.push({
            matchupId: m[0],
            seriesId,
            league: leagueName,
            home: m[24],
            away: m[25],
            startTimeMs: m[4],
            periods: m[8] && typeof m[8] === 'object' ? m[8] : {},
            bucket: bucketName,
          });
        }
      }
    }
  }
  return out;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function juicePctFromDecimals(overDec, underDec) {
  if (!overDec || !underDec) return null;
  return Number(((1 / overDec + 1 / underDec - 1) * 100).toFixed(2));
}

// md5 do payload normalizado — mesma ideia de pinnacle_core.contentHash, mas com
// 'br-sports2' embutido no payload de propósito: o `.com` e o BR leem o MESMO livro
// (relatório 2026-08-23) e frequentemente vão computar o MESMO conteúdo (linha/odds/
// ladder idênticos). Sem esse salt, o índice único
// (series_id, map_number, phase, market_version, content_hash) do odds_timeline faria
// o insert do BR ser IGNORADO como "duplicata" do `.com` sempre que os dois
// concordassem — justamente o caso mais comum — e a comparação futura (item 1.4 do
// plano) ficaria com buraco de dado sem ninguém perceber (ignore-duplicates não avisa).
function contentHashBr(payload) {
  return crypto.createHash('md5').update(JSON.stringify({ ...payload, source: 'br-sports2' })).digest('hex');
}

// Monta as entries prontas pra odds_timeline a partir de 1 matchup de Kills extraído.
// Só emite período com pelo menos 1 linha de total (main ou alternate) — mesmo
// critério de "hasKills" do `.com`.
function buildTimelineEntries(matchup, capturedAtIso, nowMs) {
  const entries = [];
  const startMs = Number.isFinite(matchup.startTimeMs) ? matchup.startTimeMs : NaN;
  const minutesToStart = Number.isFinite(startMs) ? Math.round((startMs - nowMs) / 60000) : null;
  // Fase por tempo (não por flag do payload — ver cabeçalho do arquivo). Mesma
  // semântica "nível de série" do `.com` (limitação documentada e conhecida, não
  // corrigida aqui — Fase 3 do plano trata o phase enganoso separadamente).
  const phase = Number.isFinite(startMs) && nowMs >= startMs ? 'live' : 'pre';

  for (const [periodKey, periodArr] of Object.entries(matchup.periods || {})) {
    const mapNumber = Number(periodKey);
    if (!Number.isInteger(mapNumber) || mapNumber < 1 || mapNumber > 5) continue; // kills não usa period 0
    if (!Array.isArray(periodArr) || !Array.isArray(periodArr[1])) continue;

    const totalRows = periodArr[1]
      .filter((r) => Array.isArray(r) && r.length >= 6)
      .map((r) => ({
        points: toNum(r[1]),
        overDec: toNum(r[2]),
        underDec: toNum(r[3]),
        isAlternate: r[5] !== 0,
      }))
      .filter((r) => r.points !== null && r.overDec !== null && r.underDec !== null);

    if (totalRows.length === 0) continue;

    const mainRow = totalRows.find((r) => !r.isAlternate) || null;
    const sortedRows = totalRows.slice().sort((a, b) => a.points - b.points);
    const ladder = sortedRows.map((r) => ({ p: r.points, o: r.overDec, u: r.underDec }));

    const payloadForHash = {
      line: mainRow ? mainRow.points : null,
      o: mainRow ? mainRow.overDec : null,
      u: mainRow ? mainRow.underDec : null,
      ladder: sortedRows.map((r) => [r.points, r.overDec, r.underDec]),
    };

    entries.push({
      captured_at: capturedAtIso,
      source: 'br-sports2',
      matchup_id: matchup.matchupId,
      series_id: matchup.seriesId,
      league: matchup.league,
      team_home: matchup.home,
      team_away: matchup.away,
      start_time: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      phase,
      map_number: mapNumber,
      minutes_to_start: minutesToStart,
      main_line: mainRow ? mainRow.points : null,
      over_dec: mainRow ? mainRow.overDec : null,
      under_dec: mainRow ? mainRow.underDec : null,
      juice_pct: mainRow ? juicePctFromDecimals(mainRow.overDec, mainRow.underDec) : null,
      ml_home_us: null,   // não decodificado com confiança — ver cabeçalho do arquivo
      ml_away_us: null,
      ladder,
      team_totals: null,  // não decodificado com confiança
      spread_main: null,  // não decodificado com confiança
      market_version: 0,  // BR não expõe contador de versão — constante documentada
      content_hash: contentHashBr(payloadForHash),
    });
  }
  return entries;
}

module.exports = {
  BASE_URL,
  sleep,
  fetchEvents,
  proxyInfo,
  extractLolKillsMatchups,
  buildTimelineEntries,
  contentHashBr,
  juicePctFromDecimals,
};
