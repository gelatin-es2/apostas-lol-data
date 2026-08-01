#!/usr/bin/env node
'use strict';

// Captura AUTOMÁTICA da fair line Pinnacle de LoL (Total Kills) — MODO SOMBRA.
//
// Não substitui nada: a fair Pinnacle manual do Elvis (/log-fair →
// cron-data/YYYY-MM-DD-fair-pinnacle.json) continua sendo a primária. Este script só
// observa o mercado público (guest API, sem conta) e grava em arquivos NOVOS e
// separados. Zero escrita em cron-data/YYYY-MM-DD-fair-pinnacle.json, zero escrita em
// qualquer outro arquivo existente do projeto, zero escrita em Supabase.
//
// Roda a cada 30min (Task Scheduler `LolFairAutoCapture`) — cadência curta porque a
// fair que importa é a MAIS PRÓXIMA do início do jogo (closing line).
//
// Grava:
//   1. cron-data/pinnacle-auto/YYYY-MM-DD-HHmm.json  — snapshot completo da rodada
//   2. cron-data/YYYY-MM-DD-fair-pinnacle-auto.json  — consolidado, 1 entrada por
//      matchup, sempre a ÚLTIMA leitura ANTES do início do jogo (closing line). Depois
//      que o jogo começa, a entrada CONGELA (`frozen: true`) — leituras live seguintes
//      são ignoradas, não sobrescrevem a linha de fechamento.
//
// Uso: node .claude/scripts/capture_pinnacle_kills_auto.cjs

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SNAPSHOTS_DIR = path.join(REPO, 'cron-data', 'pinnacle-auto');
const MATCHUP_PAUSE_MS = 300;

// Guest API pública da Pinnacle (mesma usada pelo site, sem login) — chave pública do
// frontend, exposta em qualquer request do site, não é secret de conta.
const BASE_URL = 'https://guest.api.arcadia.pinnacle.com/0.1';
const API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

// "League of Legends - X" (nome cru da Pinnacle) → código canônico do projeto.
// Ligas que não estiverem aqui ficam com o nome cru (league.name completo) — sem
// quebrar o script quando a Pinnacle listar uma liga nova/inesperada.
const LEAGUE_MAP = {
  'League of Legends - LPL': 'LPL',
  'League of Legends - LCK': 'LCK',
  'League of Legends - LEC': 'LEC',
  'League of Legends - CBLOL': 'CBLOL',
  'League of Legends - LCS': 'LCS',
  'League of Legends - LCP': 'LCP',
  'League of Legends - LFL': 'LFL',
  'League of Legends - LES': 'LES',
  'League of Legends - Prime League': 'Prime',
};

function normalizeLeague(rawName) {
  if (!rawName) return rawName;
  return LEAGUE_MAP[rawName] || rawName;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(urlPath, { timeoutMs = 10000 } = {}) {
  const url = `${BASE_URL}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, url };
    const data = await res.json();
    return { ok: true, status: res.status, data, url };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || String(err), url };
  } finally {
    clearTimeout(timer);
  }
}

function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

function calcJuice(overAmerican, underAmerican) {
  const decOver = americanToDecimal(overAmerican);
  const decUnder = americanToDecimal(underAmerican);
  if (!decOver || !decUnder) return null;
  return 1 / decOver + 1 / decUnder - 1;
}

// Filtra o mercado principal de Total Kills de LoL (exclui specials tipo "Odd/Even").
function filterLolKillsMatchups(matchups) {
  return matchups.filter(
    (m) => m.type === 'matchup' && m.units === 'Kills' && (m.league?.name || '').startsWith('League of Legends - ')
  );
}

// A guest API cria um 2º matchup "Kills" (isLive=true, só period 1) quando o mapa 1 já
// começou, em paralelo ao matchup principal pré-jogo (que cobre period 1/2/3 até o
// cutoff). Sem dedup, contaríamos a mesma série 2x e a versão live tem MENOS mapas.
// Preferência: isLive=false primeiro, depois mais períodos cobertos.
function dedupByParent(matchups) {
  const byParent = new Map();
  const score = (m) => (m.isLive ? 0 : 1000) + (m.periods?.length || 0);
  for (const m of matchups) {
    const key = m.parentId ?? m.id;
    const cur = byParent.get(key);
    if (!cur || score(m) > score(cur)) byParent.set(key, m);
  }
  return [...byParent.values()];
}

// Agrupa os markets crus por period, convertendo odds e calculando juice — mesmo
// parsing usado no monitor de Pinnacle do projeto dota-kills-data (padrão copiado,
// não importado).
function parseMarketsByPeriod(rawMarkets, matchupId) {
  const rows = rawMarkets.filter((m) => m.matchupId === matchupId);
  const periods = {};

  for (const row of rows) {
    const p = String(row.period);
    if (!periods[p]) {
      periods[p] = { cutoffAt: row.cutoffAt, totals: [], teamTotals: [], spreads: [], moneyline: null };
    }
    if (row.cutoffAt) periods[p].cutoffAt = row.cutoffAt;

    if (row.type === 'total') {
      const over = row.prices.find((pr) => pr.designation === 'over');
      const under = row.prices.find((pr) => pr.designation === 'under');
      if (!over || !under) continue;
      periods[p].totals.push({
        points: over.points,
        isAlternate: !!row.isAlternate,
        overPriceUS: over.price,
        underPriceUS: under.price,
        overDec: (() => { const d = americanToDecimal(over.price); return d !== null ? Number(d.toFixed(3)) : null; })(),
        underDec: (() => { const d = americanToDecimal(under.price); return d !== null ? Number(d.toFixed(3)) : null; })(),
        juicePct: (() => { const j = calcJuice(over.price, under.price); return j !== null ? Number((j * 100).toFixed(2)) : null; })(),
      });
    } else if (row.type === 'team_total') {
      const over = row.prices.find((pr) => pr.designation === 'over');
      const under = row.prices.find((pr) => pr.designation === 'under');
      if (!over || !under) continue;
      periods[p].teamTotals.push({
        side: row.side,
        points: over.points,
        isAlternate: !!row.isAlternate,
        overPriceUS: over.price,
        underPriceUS: under.price,
      });
    } else if (row.type === 'spread') {
      const home = row.prices.find((pr) => pr.designation === 'home');
      const away = row.prices.find((pr) => pr.designation === 'away');
      if (!home || !away) continue;
      periods[p].spreads.push({
        isAlternate: !!row.isAlternate,
        homePoints: home.points, awayPoints: away.points,
        homePriceUS: home.price, awayPriceUS: away.price,
      });
    } else if (row.type === 'moneyline') {
      const home = row.prices.find((pr) => pr.designation === 'home');
      const away = row.prices.find((pr) => pr.designation === 'away');
      periods[p].moneyline = { homePriceUS: home ? home.price : null, awayPriceUS: away ? away.price : null };
    }
  }

  for (const p of Object.keys(periods)) {
    periods[p].totals.sort((a, b) => a.points - b.points);
    periods[p].spreads.sort((a, b) => a.homePoints - b.homePoints);
  }
  return periods;
}

function mainTotalLine(periodData) {
  if (!periodData) return null;
  return periodData.totals.find((t) => !t.isAlternate) || null;
}

// Componentes de data/hora no fuso LOCAL da máquina (America/Sao_Paulo == BRT, mesmo
// fuso usado em todo o resto do projeto). new Date(iso) já converte pro fuso local.
function localDateParts(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function writeSnapshot(snapshot, runAt) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const { dateStr, timeStr } = localDateParts(runAt);
  const file = path.join(SNAPSHOTS_DIR, `${dateStr}-${timeStr}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  return file;
}

// Merge inteligente no consolidado do dia (bucket = data BRT do startTime do jogo, não
// a data da rodada — uma rodada perto da meia-noite pode tocar 2 arquivos de dia
// diferente se houver jogos de fuso distinto).
function mergeConsolidated(bucketDate, newGames, runIso) {
  const file = path.join(REPO, 'cron-data', `${bucketDate}-fair-pinnacle-auto.json`);
  let existing = { date: bucketDate, source: 'pinnacle-guest-api-auto', captured_at: runIso, games: [] };
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* arquivo corrompido — recomeça limpo */ }
  }
  const byId = new Map((existing.games || []).map((g) => [String(g.matchup_id), g]));

  for (const g of newGames) {
    const key = String(g.matchup_id);
    const prev = byId.get(key);
    const isPreGame = g.minutes_before_start != null && g.minutes_before_start > 0;

    if (!prev) {
      byId.set(key, {
        ...g,
        first_seen: runIso,
        frozen: !isPreGame,
        captures: isPreGame ? [{ ts: runIso, map1_line: g.map1_main_line }] : [],
      });
      continue;
    }

    if (prev.frozen) continue; // já congelado (jogo em andamento/terminado) — ignora leitura live

    if (isPreGame) {
      // ainda pré-jogo: atualiza pra leitura mais recente (mais perto do início = melhor closing line)
      const captures = Array.isArray(prev.captures) ? prev.captures.slice() : [];
      captures.push({ ts: runIso, map1_line: g.map1_main_line });
      byId.set(key, { ...g, first_seen: prev.first_seen || runIso, frozen: false, captures });
    } else {
      // o jogo passou o startTime nesta rodada: congela com o ÚLTIMO valor pré-jogo (prev),
      // não sobrescreve com a leitura live que acabou de chegar
      byId.set(key, { ...prev, frozen: true });
    }
  }

  const merged = {
    date: bucketDate,
    source: 'pinnacle-guest-api-auto',
    captured_at: runIso,
    games: [...byId.values()].sort((a, b) => new Date(a.startTime) - new Date(b.startTime)),
  };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  return { file, count: merged.games.length };
}

async function main() {
  const runAt = new Date();
  const runIso = runAt.toISOString();

  const snapshot = {
    generated_at: runIso,
    source: `${BASE_URL}/sports/12/matchups`,
    matchups_found: 0,
    matchups: [],
    errors: [],
    note: null,
  };

  console.log(`[capture] ${runIso} — buscando matchups do sport 12 (E Sports)...`);

  const listRes = await fetchJson('/sports/12/matchups?withSpecials=true');
  if (!listRes.ok) {
    snapshot.errors.push({ step: 'list', error: listRes.error, status: listRes.status });
    snapshot.note = 'Falha ao buscar lista de matchups — snapshot vazio gravado, scheduler não deve travar.';
    console.error(`[capture] ERRO ao buscar lista: ${listRes.error} (status ${listRes.status})`);
    console.log(`[capture] snapshot: ${writeSnapshot(snapshot, runAt)}`);
    return;
  }

  const lolKills = dedupByParent(filterLolKillsMatchups(listRes.data));
  snapshot.matchups_found = lolKills.length;

  if (lolKills.length === 0) {
    snapshot.note = 'Zero matchups de Total Kills em LoL nesta rodada — dado de cobertura, não erro.';
    console.log('[capture] 0 matchups LoL Kills encontrados nesta rodada.');
    console.log(`[capture] snapshot: ${writeSnapshot(snapshot, runAt)}`);
    return;
  }

  console.log(`[capture] ${lolKills.length} matchup(s) LoL Kills encontrado(s). Buscando markets...`);

  const gamesByBucket = new Map();

  for (const m of lolKills) {
    const home = m.parent?.participants?.find((p) => p.alignment === 'home')?.name
      || m.participants?.find((p) => p.alignment === 'home')?.name || '?';
    const away = m.parent?.participants?.find((p) => p.alignment === 'away')?.name
      || m.participants?.find((p) => p.alignment === 'away')?.name || '?';
    const startTime = m.parent?.startTime || m.startTime;
    const leagueRaw = m.league?.name || null;
    const league = normalizeLeague(leagueRaw);

    const marketsRes = await fetchJson(`/matchups/${m.id}/markets/related/straight`);
    let periods = {};
    let error = null;
    if (!marketsRes.ok) {
      error = `HTTP ${marketsRes.status}: ${marketsRes.error}`;
      snapshot.errors.push({ step: 'markets', matchupId: m.id, error: marketsRes.error, status: marketsRes.status });
      console.error(`[capture] ERRO markets matchup ${m.id} (${home} vs ${away}): ${error}`);
    } else {
      periods = parseMarketsByPeriod(marketsRes.data, m.id);
    }

    snapshot.matchups.push({
      matchup_id: m.id, parent_id: m.parentId ?? null,
      league_raw: leagueRaw, league, home, away, startTime,
      status: m.status, isLive: !!m.isLive, periods, error,
    });

    const p1 = periods['1'];
    const p2 = periods['2'];
    const main1 = mainTotalLine(p1);
    const main2 = mainTotalLine(p2);
    const ladder1 = p1 ? p1.totals.map((t) => ({ points: t.points, over_dec: t.overDec, under_dec: t.underDec })) : [];

    const startMs = new Date(startTime).getTime();
    const minutesBeforeStart = Number.isFinite(startMs) ? Math.round((startMs - runAt.getTime()) / 60000) : null;

    console.log(
      `[capture] ${league} | ${home} vs ${away} | start=${startTime} | min_before=${minutesBeforeStart} | ` +
      `map1=${main1 ? main1.points : 'n/a'} map2=${main2 ? main2.points : 'n/a'}`
    );

    const gameEntry = {
      league, league_raw: leagueRaw,
      team_a: home, team_b: away, startTime, matchup_id: m.id,
      map1_main_line: main1 ? main1.points : null,
      map1_over_dec: main1 ? main1.overDec : null,
      map1_under_dec: main1 ? main1.underDec : null,
      map2_main_line: main2 ? main2.points : null,
      map2_over_dec: main2 ? main2.overDec : null,
      map2_under_dec: main2 ? main2.underDec : null,
      ladder_map1: ladder1,
      captured_at: runIso,
      minutes_before_start: minutesBeforeStart,
    };

    const { dateStr: bucketDate } = localDateParts(startMs ? new Date(startMs) : runAt);
    if (!gamesByBucket.has(bucketDate)) gamesByBucket.set(bucketDate, []);
    gamesByBucket.get(bucketDate).push(gameEntry);

    await sleep(MATCHUP_PAUSE_MS);
  }

  const snapshotFile = writeSnapshot(snapshot, runAt);
  console.log(`[capture] snapshot gravado: ${snapshotFile} (${snapshot.matchups.length} matchup(s), ${snapshot.errors.length} erro(s))`);

  for (const [bucketDate, games] of gamesByBucket) {
    const { file, count } = mergeConsolidated(bucketDate, games, runIso);
    console.log(`[capture] consolidado atualizado: ${file} (${count} jogo(s) no total, ${games.length} tocado(s) nesta rodada)`);
  }
}

main().catch((err) => {
  // Nunca deixa o Task Scheduler ver exit code != 0 por causa disso — só loga.
  console.error('[capture] ERRO FATAL não tratado:', err);
  process.exit(0);
});
