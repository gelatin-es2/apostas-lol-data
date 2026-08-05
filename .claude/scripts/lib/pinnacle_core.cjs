'use strict';

// Core compartilhado da captura de odds Pinnacle (guest API) — usado pelo coletor
// 24/7 (capture_pinnacle_to_supabase.cjs). O script legado do PC
// (capture_pinnacle_kills_auto.cjs) fica INTACTO como fallback local.
//
// O que este core faz de diferente do legado:
//  - retry com backoff em 429/503/erro de rede (a API caiu 3x em 04/08)
//  - NÃO deduplica pré×live: os dois viram leituras (phase 'pre'/'live')
//  - captura também MONEYLINE da série (period 0) e por mapa (period N),
//    lendo os markets do matchup PRINCIPAL da série que vêm no mesmo
//    endpoint related/straight (o legado descartava por filtrar matchupId)
//  - calcula market_version (max version dos markets) + content_hash por
//    (série, mapa) — motores do delta-gating no banco

const crypto = require('crypto');

const BASE_URL = 'https://guest.api.arcadia.pinnacle.com/0.1';
// Chave PÚBLICA do frontend da Pinnacle (exposta em qualquer request do site).
const API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

const MATCHUP_PAUSE_MS = 300;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch com retry: 3 tentativas extras em 429/5xx/erro de rede, backoff
// exponencial honrando Retry-After quando presente. 4xx (menos 429) não re-tenta.
async function fetchJson(urlPath, { timeoutMs = 15000 } = {}) {
  const url = `${BASE_URL}${urlPath}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const retryAfterMs = lastErr && lastErr.retryAfterMs;
      await sleep(retryAfterMs || RETRY_DELAYS_MS[attempt - 1]);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'X-API-Key': API_KEY,
          Accept: 'application/json',
          Referer: 'https://www.pinnacle.com/',
        },
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, status: res.status, data, attempts: attempt + 1 };
      }
      lastErr = { status: res.status, error: `HTTP ${res.status}` };
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) lastErr.retryAfterMs = Math.min(ra * 1000, 30000);
      if (!RETRY_STATUS.has(res.status)) break; // 4xx (menos 429): não adianta re-tentar
    } catch (err) {
      lastErr = { status: 0, error: err.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: lastErr ? lastErr.status : 0, error: lastErr ? lastErr.error : 'unknown', url };
}

function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  const d = a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  return Number(d.toFixed(3));
}

function calcJuicePct(overUS, underUS) {
  const dOver = americanToDecimal(overUS);
  const dUnder = americanToDecimal(underUS);
  if (!dOver || !dUnder) return null;
  return Number(((1 / dOver + 1 / dUnder - 1) * 100).toFixed(2));
}

// Matchups de Total Kills de LoL — SEM dedup pré×live (queremos os dois como
// leituras distintas). Exclui specials tipo "Odd/Even" (type !== 'matchup').
// Ids precisam ser inteiros: eles são interpolados em queries PostgREST — matchup
// com id/parentId não-numérico (API corrompida/alterada) é descartado.
function filterLolKillsMatchups(matchups) {
  if (!Array.isArray(matchups)) return [];
  return matchups.filter(
    (m) => m.type === 'matchup' && m.units === 'Kills'
      && (m.league?.name || '').startsWith('League of Legends - ')
      && Number.isSafeInteger(m.id)
      && (m.parentId == null || Number.isSafeInteger(m.parentId))
  );
}

function participantName(m, alignment) {
  return m.parent?.participants?.find((p) => p.alignment === alignment)?.name
    || m.participants?.find((p) => p.alignment === alignment)?.name || '?';
}

function matchupMeta(m) {
  return {
    matchupId: m.id,
    seriesId: m.parentId ?? m.id,
    league: m.league?.name || null,
    home: participantName(m, 'home'),
    away: participantName(m, 'away'),
    startTime: m.parent?.startTime || m.startTime || null,
    isLive: !!m.isLive,
  };
}

// Ids de matchup aceitáveis como fonte de MONEYLINE/spread da série: o matchup
// principal (seriesId) + sub-matchups live dele (quando o jogo está rolando, o ML
// live mora num sub-matchup PRÓPRIO, irmão do sub de Kills — sem isso o ML live
// vem null). Specials ficam de fora (type !== 'matchup').
function seriesMlMatchupIds(allMatchups, seriesId) {
  const ids = new Set([seriesId]);
  for (const x of allMatchups) {
    if (x.parentId === seriesId && x.type === 'matchup' && x.units !== 'Kills') ids.add(x.id);
  }
  return ids;
}

// Parseia o response de /matchups/{id}/markets/related/straight.
// Os rows misturam matchups: o de Kills (totals/team_totals/spreads de kills)
// e o PRINCIPAL da série (moneyline período 0 = série e período N = mapa,
// spread período 0 = handicap de mapas). Separa por matchupId.
function parseRelatedMarkets(rawRows, killsMatchupId, seriesMlIds) {
  const byMap = {}; // map_number → dados agregados

  const ensure = (p) => {
    if (!byMap[p]) {
      byMap[p] = {
        totals: [], teamTotals: [], killsSpreads: [],
        ml: null, seriesSpread: null, maxVersion: 0,
        mlVersion: -1, spreadVersion: -1,
      };
    }
    return byMap[p];
  };

  if (!Array.isArray(rawRows)) return byMap;
  for (const row of rawRows) {
    const period = Number(row.period);
    if (!Number.isFinite(period) || period < 0 || period > 5) continue;
    if (!Array.isArray(row.prices)) continue; // market suspenso/malformado com HTTP 200
    const fromKills = row.matchupId === killsMatchupId;
    const fromSeries = seriesMlIds.has(row.matchupId);
    if (!fromKills && !fromSeries) continue; // outros irmãos (specials) fora

    const slot = ensure(period);
    const rowVersion = Number.isFinite(Number(row.version)) ? Number(row.version) : 0;
    slot.maxVersion = Math.max(slot.maxVersion, rowVersion);

    if (fromKills && row.type === 'total') {
      const over = row.prices.find((pr) => pr.designation === 'over');
      const under = row.prices.find((pr) => pr.designation === 'under');
      if (!over || !under) continue;
      slot.totals.push({
        points: over.points,
        isAlternate: !!row.isAlternate,
        overUS: over.price,
        underUS: under.price,
      });
    } else if (fromKills && row.type === 'team_total') {
      const over = row.prices.find((pr) => pr.designation === 'over');
      const under = row.prices.find((pr) => pr.designation === 'under');
      if (!over || !under) continue;
      slot.teamTotals.push({ side: row.side, points: over.points, o_us: over.price, u_us: under.price });
    } else if (fromKills && row.type === 'spread') {
      const home = row.prices.find((pr) => pr.designation === 'home');
      const away = row.prices.find((pr) => pr.designation === 'away');
      if (!home || !away) continue;
      slot.killsSpreads.push({
        isAlternate: !!row.isAlternate,
        hp: home.points, ap: away.points, h_us: home.price, a_us: away.price,
      });
    } else if (fromSeries && row.type === 'moneyline') {
      // Na transição pre→live, 2 matchups podem servir ML pro mesmo period —
      // tiebreak determinístico pela maior version (senão o valor flapa por
      // ordem de chegada da API e gera rows falsas na timeline).
      if (rowVersion < slot.mlVersion) continue;
      const home = row.prices.find((pr) => pr.designation === 'home');
      const away = row.prices.find((pr) => pr.designation === 'away');
      slot.ml = { h_us: home ? home.price : null, a_us: away ? away.price : null };
      slot.mlVersion = rowVersion;
    } else if (fromSeries && row.type === 'spread' && !row.isAlternate) {
      if (rowVersion < slot.spreadVersion) continue;
      const home = row.prices.find((pr) => pr.designation === 'home');
      const away = row.prices.find((pr) => pr.designation === 'away');
      if (!home || !away) continue;
      slot.seriesSpread = { hp: home.points, ap: away.points, h_us: home.price, a_us: away.price };
      slot.spreadVersion = rowVersion;
    }
  }

  for (const p of Object.keys(byMap)) {
    byMap[p].totals.sort((a, b) => a.points - b.points);
    byMap[p].killsSpreads.sort((a, b) => a.hp - b.hp);
    // teamTotals também: sem sort, a ordem de chegada da API mudaria o content_hash
    // sem mudança real de mercado (inflação de rows falsas na timeline)
    byMap[p].teamTotals.sort((a, b) =>
      String(a.side).localeCompare(String(b.side)) || a.points - b.points);
  }
  return byMap;
}

// md5 de um payload normalizado — leitura idêntica gera o mesmo hash,
// independente de ordem de chegada dos markets.
function contentHash(obj) {
  return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
}

// Monta as entries prontas pra odds_timeline: uma por (série, mapa) com dado.
// map 0 = série (ML + handicap de mapas); map 1..5 = mapa (kills + ML do mapa).
function buildTimelineEntries(m, byMap, capturedAtIso, nowMs, phase, source) {
  const meta = matchupMeta(m);
  const startMs = meta.startTime ? new Date(meta.startTime).getTime() : NaN;
  const minutesToStart = Number.isFinite(startMs) ? Math.round((startMs - nowMs) / 60000) : null;
  const entries = [];

  for (const [pStr, slot] of Object.entries(byMap)) {
    const mapNumber = Number(pStr);
    const mainTotal = slot.totals.find((t) => !t.isAlternate) || null;
    const mainSpread = slot.killsSpreads.find((s) => !s.isAlternate) || null;
    const hasKills = slot.totals.length > 0 || slot.teamTotals.length > 0;
    const hasSeries = !!(slot.ml || slot.seriesSpread);
    if (!hasKills && !hasSeries) continue;
    // map 0 sem ML nem spread não interessa; map N sem kills e sem ML idem
    const ladder = slot.totals.map((t) => ({
      p: t.points, o: americanToDecimal(t.overUS), u: americanToDecimal(t.underUS),
    }));

    const payloadForHash = {
      line: mainTotal ? mainTotal.points : null,
      o: mainTotal ? mainTotal.overUS : null,
      u: mainTotal ? mainTotal.underUS : null,
      ladder: slot.totals.map((t) => [t.points, t.overUS, t.underUS]),
      tt: slot.teamTotals.map((t) => [t.side, t.points, t.o_us, t.u_us]),
      sp: mainSpread ? [mainSpread.hp, mainSpread.ap, mainSpread.h_us, mainSpread.a_us] : null,
      ssp: slot.seriesSpread ? [slot.seriesSpread.hp, slot.seriesSpread.ap, slot.seriesSpread.h_us, slot.seriesSpread.a_us] : null,
      ml: slot.ml ? [slot.ml.h_us, slot.ml.a_us] : null,
    };

    entries.push({
      captured_at: capturedAtIso,
      source,
      matchup_id: meta.matchupId,
      series_id: meta.seriesId,
      league: meta.league,
      team_home: meta.home,
      team_away: meta.away,
      start_time: meta.startTime,
      phase,
      map_number: mapNumber,
      minutes_to_start: minutesToStart,
      main_line: mainTotal ? mainTotal.points : null,
      over_dec: mainTotal ? americanToDecimal(mainTotal.overUS) : null,
      under_dec: mainTotal ? americanToDecimal(mainTotal.underUS) : null,
      juice_pct: mainTotal ? calcJuicePct(mainTotal.overUS, mainTotal.underUS) : null,
      ml_home_us: slot.ml ? slot.ml.h_us : null,
      ml_away_us: slot.ml ? slot.ml.a_us : null,
      ladder: ladder.length ? ladder : null,
      team_totals: slot.teamTotals.length ? slot.teamTotals : null,
      spread_main: mainSpread || slot.seriesSpread || null,
      market_version: slot.maxVersion,
      content_hash: contentHash(payloadForHash),
    });
  }
  return entries;
}

module.exports = {
  BASE_URL,
  MATCHUP_PAUSE_MS,
  sleep,
  fetchJson,
  americanToDecimal,
  calcJuicePct,
  filterLolKillsMatchups,
  matchupMeta,
  seriesMlMatchupIds,
  parseRelatedMarkets,
  buildTimelineEntries,
  contentHash,
};
