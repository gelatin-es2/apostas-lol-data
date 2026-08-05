#!/usr/bin/env node
'use strict';

// Coletor 24/7 de odds Pinnacle (LoL Kills + Moneyline série/mapa) → Supabase.
// Roda no GitHub Actions (baseline a cada 30min + live loop de 60s durante jogos).
// Análise/decisão: knowledge/reports/2026-08-04-analise-captura-pinnacle-24-7.md
// DDL: .claude/scripts/sql/2026-08-04-odds-capture.sql
//
// Modos:
//   --mode=baseline          1 rodada completa (todas as séries listadas) e sai.
//                            Sinaliza dispatch_live=true no GITHUB_OUTPUT se há jogo
//                            em <120min ou live agora.
//   --mode=live              loop de 60s SÓ nas séries da janela (start <45min ou live).
//                            Sai após 30min sem ninguém na janela. Sinaliza
//                            redispatch=true se atingir --max-minutes com janela ativa.
// Flags: --dry-run (não escreve nada), --max-minutes=320, --source=<override>
//
// Regras de escrita (anti-explosão do free tier):
//   odds_timeline  → só leituras cujo content_hash mudou (delta-gating), com
//                    on_conflict ignore-duplicates (idempotente p/ jobs sobrepostos)
//   closing_lines  → upsert da última leitura pré-jogo por (série, mapa); mapas 2+
//                    ganham closing na 1ª leitura live do mapa (âncora first_seen_live_at)
//   capture_runs   → 1 row POR EXECUÇÃO/iteração, sempre — é o heartbeat do watchdog
//
// SEGURANÇA (repo público, logs visíveis): NUNCA logar headers, keys, nem response
// cru do Supabase. Erros logam status + step, só.

const fs = require('fs');
const { loadConfig } = require('./_load-config.cjs');
const core = require('./lib/pinnacle_core.cjs');

// ---------------------------------------------------------------- args/config
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const MODE = args.mode === 'live' ? 'live' : 'baseline';
const DRY_RUN = !!args['dry-run'];
const MAX_MINUTES = Number(args['max-minutes']) || 320;
const SOURCE = args.source || (MODE === 'baseline' ? 'gha-baseline' : 'gha-live');

const LIVE_WINDOW_MIN = 45;        // live loop: séries com start em <45min ou já live
const DISPATCH_WINDOW_MIN = 120;   // baseline dispara o live com 120min de antecedência
const IDLE_EXIT_MIN = 30;          // live loop: sai após 30min sem ninguém na janela
const CLOSING_REFRESH_MIN = 60;    // upsert closing mesmo sem mudança quando falta <60min

let SB = null; // { url, key } — null em dry-run sem creds

// ------------------------------------------------------------- supabase REST
async function sbRequest(method, pathAndQuery, { body, headers = {} } = {}) {
  const res = await fetch(`${SB.url}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SB.key,
      Authorization: `Bearer ${SB.key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Nunca logar o body do erro cru (pode ecoar dados) — só status + tabela.
    throw new Error(`supabase ${method} ${pathAndQuery.split('?')[0]} → HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

// Últimos content_hash por (série, mapa, fase) das últimas 48h — base do delta-gating.
// Paginado em 1000 (max-rows default do Supabase trunca em silêncio acima disso).
async function loadLastHashes() {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const map = new Map();
  const PAGE = 1000;
  for (let offset = 0; offset < 10 * PAGE; offset += PAGE) {
    const rows = await sbRequest('GET',
      `odds_timeline?select=series_id,map_number,phase,content_hash,captured_at` +
      `&captured_at=gte.${since}&order=captured_at.desc&limit=${PAGE}&offset=${offset}`);
    for (const r of rows) {
      const key = `${r.series_id}|${r.map_number}|${r.phase}`;
      if (!map.has(key)) map.set(key, r.content_hash); // 1º visto = mais recente
    }
    if (rows.length < PAGE) break;
  }
  return map;
}

// Pares (série, mapa) que JÁ têm âncora live — pra não re-materializar closing.
async function loadAnchoredPairs() {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const rows = await sbRequest('GET',
    `closing_lines?select=series_id,map_number&first_seen_live_at=not.is.null&captured_at=gte.${since}`);
  return new Set(rows.map((r) => `${r.series_id}|${r.map_number}`));
}

async function insertTimeline(entries) {
  if (!entries.length) return 0;
  const inserted = await sbRequest('POST',
    'odds_timeline?on_conflict=series_id,map_number,phase,market_version,content_hash',
    {
      body: entries,
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    });
  return Array.isArray(inserted) ? inserted.length : 0;
}

async function upsertClosings(rows) {
  if (!rows.length) return 0;
  await sbRequest('POST', 'closing_lines?on_conflict=series_id,map_number', {
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
  return rows.length;
}

async function recordRun(stats) {
  if (DRY_RUN) return;
  try {
    await sbRequest('POST', 'capture_runs', { body: [stats], headers: { Prefer: 'return=minimal' } });
  } catch (err) {
    console.error(`[run-record] falhou: ${err.message}`); // heartbeat perdido ≠ captura perdida
  }
}

function closingFromEntry(e, extra = {}) {
  return {
    series_id: e.series_id,
    map_number: e.map_number,
    league: e.league,
    team_home: e.team_home,
    team_away: e.team_away,
    start_time: e.start_time,
    closing_line: e.main_line,
    over_dec: e.over_dec,
    under_dec: e.under_dec,
    ml_home_us: e.ml_home_us,
    ml_away_us: e.ml_away_us,
    ladder: e.ladder,
    captured_at: e.captured_at,
    minutes_to_start: e.minutes_to_start,
    closing_source: 'pre_start',
    ...extra,
  };
}

// 1ª leitura live de um mapa: materializa a closing daquele mapa (última leitura
// PRÉ-JOGO anterior na timeline) e grava a âncora first_seen_live_at.
// Regras anti-corrupção (review 2026-08-04):
//  - o BANCO é a fonte de verdade de "já ancorado", não o Set em memória (baseline
//    e live rodam simultâneos com snapshots defasados — sem isso, re-anchor
//    sobrescreveria a closing correta com odds live)
//  - a query do prev filtra phase=eq.pre + captured_at anterior: nunca materializa
//    closing a partir de leitura live, mesmo após crash/restart no meio do mapa
//  - anchoredPairs.add() só acontece DEPOIS do upsert persistir (no caller)
async function anchorLiveMap(entry, anchoredPairs) {
  const key = `${entry.series_id}|${entry.map_number}`;
  if (DRY_RUN) { anchoredPairs.add(key); return { dry: true, key }; }

  try {
    const existing = await sbRequest('GET',
      `closing_lines?select=first_seen_live_at&series_id=eq.${entry.series_id}` +
      `&map_number=eq.${entry.map_number}&limit=1`);
    if (existing[0] && existing[0].first_seen_live_at) {
      anchoredPairs.add(key); // já ancorado por outro processo — cacheia e sai
      return null;
    }
  } catch (err) {
    console.error(`[anchor] check falhou (${key}): ${err.message}`);
    return null; // sem certeza, não ancora — re-tenta na próxima iteração
  }

  let prev = null;
  try {
    const rows = await sbRequest('GET',
      `odds_timeline?select=*&series_id=eq.${entry.series_id}&map_number=eq.${entry.map_number}` +
      `&phase=eq.pre&captured_at=lt.${encodeURIComponent(entry.captured_at)}` +
      `&order=captured_at.desc&limit=1`);
    prev = rows[0] || null;
  } catch (err) {
    console.error(`[anchor] query falhou (${key}): ${err.message}`);
    return null;
  }

  const base = prev
    ? closingFromEntry({ ...prev }, {})
    : { // captura começou no meio do mapa: sem closing, mas a âncora fica registrada
        series_id: entry.series_id, map_number: entry.map_number,
        league: entry.league, team_home: entry.team_home, team_away: entry.team_away,
        start_time: entry.start_time, closing_line: null, over_dec: null, under_dec: null,
        ml_home_us: null, ml_away_us: null, ladder: null,
        captured_at: entry.captured_at, minutes_to_start: entry.minutes_to_start,
      };
  return {
    ...base,
    closing_source: entry.map_number === 1 && base.closing_line !== null && (base.minutes_to_start ?? 0) > 0
      ? 'pre_start' : 'pre_map_live_anchor',
    first_seen_live_at: entry.captured_at,
  };
}

// ------------------------------------------------------------------ 1 rodada
// windowOnly=true (modo live): só séries com start <LIVE_WINDOW_MIN ou já live.
async function runOnce({ windowOnly, lastHashes, anchoredPairs }) {
  const t0 = Date.now();
  const nowIso = new Date(t0).toISOString();
  const stats = {
    ran_at: nowIso, source: SOURCE, mode: MODE === 'live' ? 'live-iteration' : 'baseline',
    matchups_seen: 0, live_seen: 0, rows_written: 0, closings_upserted: 0,
    errors: [], duration_ms: 0, notes: null,
  };

  const listRes = await core.fetchJson('/sports/12/matchups?withSpecials=true');
  if (!listRes.ok) {
    stats.errors.push({ step: 'list', error: listRes.error, status: listRes.status });
    stats.duration_ms = Date.now() - t0;
    return { stats, windowActive: null, anyUpcoming: null }; // null = não sabemos (API fora)
  }

  let matchups = core.filterLolKillsMatchups(listRes.data);
  const allMeta = matchups.map(core.matchupMeta);
  const minutesTo = (meta) => meta.startTime
    ? Math.round((new Date(meta.startTime).getTime() - t0) / 60000) : null;

  const windowActive = allMeta.some((meta) => {
    const mts = minutesTo(meta);
    return meta.isLive || (mts !== null && mts <= LIVE_WINDOW_MIN && mts > -360);
  });
  const anyUpcoming = allMeta.some((meta) => {
    const mts = minutesTo(meta);
    return meta.isLive || (mts !== null && mts <= DISPATCH_WINDOW_MIN && mts > -360);
  });

  if (windowOnly) {
    matchups = matchups.filter((m) => {
      const meta = core.matchupMeta(m);
      const mts = minutesTo(meta);
      return meta.isLive || (mts !== null && mts <= LIVE_WINDOW_MIN && mts > -360);
    });
  }
  stats.matchups_seen = matchups.length;
  stats.live_seen = matchups.filter((m) => m.isLive).length;

  const newEntries = [];
  const hashUpdates = [];    // {key, prev} — pra rollback se o insert falhar
  const preClosings = [];    // provisórias (SEM first_seen_live_at)
  const anchorClosings = []; // âncoras (COM first_seen_live_at) — batch separado:
                             // misturar os dois faria o merge NULLar a âncora
                             // (PostgREST trata key ausente em bulk como null)

  for (const m of matchups) {
    const meta = core.matchupMeta(m);
    const marketsRes = await core.fetchJson(`/matchups/${m.id}/markets/related/straight`);
    if (!marketsRes.ok) {
      stats.errors.push({ step: 'markets', matchupId: m.id, error: marketsRes.error, status: marketsRes.status });
      await core.sleep(core.MATCHUP_PAUSE_MS);
      continue;
    }
    const mlIds = core.seriesMlMatchupIds(listRes.data, meta.seriesId);
    const byMap = core.parseRelatedMarkets(marketsRes.data, meta.matchupId, mlIds);
    const phase = meta.isLive ? 'live' : 'pre';
    const entries = core.buildTimelineEntries(m, byMap, nowIso, t0, phase, SOURCE);

    for (const e of entries) {
      const key = `${e.series_id}|${e.map_number}|${e.phase}`;
      const changed = lastHashes.get(key) !== e.content_hash;
      if (changed) {
        hashUpdates.push({ key, prev: lastHashes.get(key) });
        lastHashes.set(key, e.content_hash);
        newEntries.push(e);
      }

      if (e.phase === 'pre' && (e.minutes_to_start ?? -1) > 0) {
        // closing provisória: última pre ganha; refresh perto do jogo mesmo sem mudança
        if (changed || (e.minutes_to_start <= CLOSING_REFRESH_MIN)) {
          preClosings.push(closingFromEntry(e));
        }
      } else if (e.phase === 'live' && e.map_number >= 1 && !anchoredPairs.has(`${e.series_id}|${e.map_number}`)) {
        const anchor = await anchorLiveMap(e, anchoredPairs);
        if (anchor && !anchor.dry) anchorClosings.push(anchor);
      }
    }
    await core.sleep(core.MATCHUP_PAUSE_MS);
  }

  if (DRY_RUN) {
    stats.rows_written = newEntries.length;
    stats.closings_upserted = preClosings.length + anchorClosings.length;
    console.log(`[dry-run] gravaria ${newEntries.length} row(s) timeline, ${stats.closings_upserted} closing(s):`);
    for (const e of newEntries.slice(0, 30)) {
      console.log(`  ${e.phase} ${e.league} | ${e.team_home} vs ${e.team_away} | map${e.map_number} ` +
        `line=${e.main_line} O@${e.over_dec} U@${e.under_dec} ML=${e.ml_home_us}/${e.ml_away_us} v=${e.market_version}`);
    }
  } else {
    try {
      stats.rows_written = await insertTimeline(newEntries);
    } catch (err) {
      stats.errors.push({ step: 'insert_timeline', error: err.message });
      // rollback dos hashes em memória: sem isso, a leitura perdida nunca seria
      // re-tentada neste processo (o delta-gate acharia que já gravou)
      for (const u of hashUpdates) {
        if (u.prev === undefined) lastHashes.delete(u.key);
        else lastHashes.set(u.key, u.prev);
      }
    }
    try {
      // dedup client-side: última closing por (série, mapa) vence dentro da rodada
      const byKey = new Map();
      for (const c of preClosings) byKey.set(`${c.series_id}|${c.map_number}`, c);
      stats.closings_upserted = await upsertClosings([...byKey.values()]);
    } catch (err) {
      stats.errors.push({ step: 'upsert_closings', error: err.message });
    }
    try {
      stats.closings_upserted += await upsertClosings(anchorClosings);
      // âncora persistiu → agora sim marca em memória (antes disso, re-tentar é correto)
      for (const a of anchorClosings) anchoredPairs.add(`${a.series_id}|${a.map_number}`);
    } catch (err) {
      stats.errors.push({ step: 'upsert_anchors', error: err.message });
    }
  }

  stats.duration_ms = Date.now() - t0;
  if (!stats.errors.length) stats.errors = null;
  return { stats, windowActive, anyUpcoming };
}

// ------------------------------------------------------------------- helpers
function ghaOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`[output] ${key}=${value}`);
}

async function healthPing() {
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url) return;
  try { await fetch(url, { method: 'GET' }); } catch { /* alerta é best-effort */ }
}

function logStats(s) {
  console.log(`[${s.mode}] matchups=${s.matchups_seen} live=${s.live_seen} ` +
    `rows=${s.rows_written} closings=${s.closings_upserted} ` +
    `errors=${s.errors ? s.errors.length : 0} dur=${s.duration_ms}ms`);
}

// ---------------------------------------------------------------------- main
async function main() {
  if (!DRY_RUN) {
    const cfg = loadConfig();
    SB = { url: cfg.supabaseUrl.replace(/\/$/, ''), key: cfg.supabaseKey };
  }

  const lastHashes = DRY_RUN ? new Map() : await loadLastHashes();
  const anchoredPairs = DRY_RUN ? new Set() : await loadAnchoredPairs();

  if (MODE === 'baseline') {
    const { stats, anyUpcoming } = await runOnce({ windowOnly: false, lastHashes, anchoredPairs });
    logStats(stats);
    await recordRun(stats);
    await healthPing();
    ghaOutput('dispatch_live', anyUpcoming === true ? 'true' : 'false');
    // API fora do ar em TODA a rodada ainda é exit 0 — o watchdog decide pelo heartbeat
    return;
  }

  // ------- modo live: loop de 60s -------
  const startedAt = Date.now();
  let idleSinceMs = null;
  let iteration = 0;
  let consecutiveFailures = 0;
  let lastWindowActive = null;

  for (;;) {
    iteration += 1;
    const iterStart = Date.now();

    // uma iteração ruim (row malformada, Supabase 500) não pode matar o loop —
    // só desiste após 5 falhas seguidas (aí exit 1 → failure → e-mail)
    try {
      const { stats, windowActive } = await runOnce({ windowOnly: true, lastHashes, anchoredPairs });
      consecutiveFailures = 0;
      lastWindowActive = windowActive;
      logStats(stats);
      await recordRun(stats);
      if (iteration % 10 === 1) await healthPing();

      if (windowActive === true) idleSinceMs = null;
      else if (windowActive === false && idleSinceMs === null) idleSinceMs = Date.now();
      // windowActive === null (API fora): não zera nem inicia idle — espera a próxima
    } catch (err) {
      consecutiveFailures += 1;
      console.error(`[live] iteração ${iteration} falhou (${consecutiveFailures}/5): ${err.message || err}`);
      if (consecutiveFailures >= 5) {
        console.error('[live] 5 falhas consecutivas — abortando.');
        process.exit(1);
      }
    }

    if (idleSinceMs !== null && Date.now() - idleSinceMs > IDLE_EXIT_MIN * 60000) {
      console.log(`[live] ${IDLE_EXIT_MIN}min sem jogo na janela — encerrando.`);
      ghaOutput('redispatch', 'false');
      return;
    }
    if (Date.now() - startedAt > MAX_MINUTES * 60000) {
      const stillActive = lastWindowActive === true;
      console.log(`[live] limite de ${MAX_MINUTES}min atingido — janela ativa: ${stillActive}`);
      ghaOutput('redispatch', stillActive ? 'true' : 'false');
      return;
    }

    const elapsed = Date.now() - iterStart;
    if (elapsed < 60000) await core.sleep(60000 - elapsed);
  }
}

main().catch((err) => {
  console.error('[capture] ERRO FATAL:', err.message || err);
  process.exit(1); // workflow marca failure → e-mail do GitHub
});
