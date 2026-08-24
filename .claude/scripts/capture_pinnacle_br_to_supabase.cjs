#!/usr/bin/env node
'use strict';

// Coletor Pinnacle BR sem cache (endpoint deslogado do pinnacle.bet.br) → Supabase
// (odds_timeline, source='br-sports2'). PARALELO ao coletor `.com` existente
// (capture_pinnacle_to_supabase.cjs) — não substitui nada, não promove fonte.
//
// Fase 1.1 do plano: knowledge/plans/2026-08-23-plano-execucao.md
// Investigação e schema do payload BR: knowledge/reports/2026-08-23-pinnacle-br-vs-internacional.md
// e .claude/scripts/lib/pinnacle_br_core.cjs (cabeçalho do arquivo tem o mapeamento
// campo-a-campo, com o que foi confirmado e o que ficou null por falta de confiança).
//
// Diferença de arquitetura vs capture_pinnacle_to_supabase.cjs: o endpoint BR devolve
// TODOS os matchups (LoL + resto) numa ÚNICA request (sem cache, ~8x mais barato que o
// `.com`, que precisa de 1 request de lista + 1 por matchup). Por isso este script não
// tem modo --mode=live com loop de 60s — 1 execução = 1 leitura completa. Cadência vem
// de fora (Task Scheduler, mesma cadência do LolFairAutoCapture por ora, ver relatório
// de execução pra como agendar/desligar).
//
// Regras de escrita: odds_timeline só grava leitura cujo content_hash mudou
// (delta-gating, mesmo padrão dos outros 2 coletores), on_conflict ignore-duplicates.
// content_hash inclui salt 'br-sports2' de propósito — ver comentário em
// lib/pinnacle_br_core.cjs (contentHashBr) sobre por que isso é necessário aqui.
//
// Flags: --dry-run (não escreve nada, não exige credencial), --source=<override>
//
// SEGURANÇA: nunca logar headers, keys, nem response cru do Supabase.

const { loadConfig } = require('./_load-config.cjs');
const core = require('./lib/pinnacle_br_core.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const DRY_RUN = !!args['dry-run'];
const SOURCE = args.source || 'br-sports2';

let SB = null;

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
    throw new Error(`supabase ${method} ${pathAndQuery.split('?')[0]} → HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

// Últimos content_hash por (série, mapa, fase) SÓ da fonte br-sports2 (filtro
// explícito — content_hash já tem salt próprio, mas filtrar reduz o volume lido e
// deixa a intenção clara).
async function loadLastHashes() {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const map = new Map();
  const PAGE = 1000;
  for (let offset = 0; offset < 10 * PAGE; offset += PAGE) {
    const rows = await sbRequest('GET',
      `odds_timeline?select=series_id,map_number,phase,content_hash,captured_at` +
      `&source=eq.${SOURCE}&captured_at=gte.${since}&order=captured_at.desc&limit=${PAGE}&offset=${offset}`);
    for (const r of rows) {
      const key = `${r.series_id}|${r.map_number}|${r.phase}`;
      if (!map.has(key)) map.set(key, r.content_hash);
    }
    if (rows.length < PAGE) break;
  }
  return map;
}

async function insertTimeline(entries) {
  if (!entries.length) return 0;
  const inserted = await sbRequest('POST',
    'odds_timeline?on_conflict=series_id,map_number,phase,market_version,content_hash',
    { body: entries, headers: { Prefer: 'resolution=ignore-duplicates,return=representation' } });
  return Array.isArray(inserted) ? inserted.length : 0;
}

async function recordRun(stats) {
  if (DRY_RUN) return;
  try {
    await sbRequest('POST', 'capture_runs', { body: [stats], headers: { Prefer: 'return=minimal' } });
  } catch (err) {
    console.error(`[run-record] falhou: ${err.message}`);
  }
}

function has403(errors) {
  return Array.isArray(errors) && errors.some((e) => e.status === 403);
}

async function main() {
  if (!DRY_RUN) {
    const cfg = loadConfig();
    SB = { url: cfg.supabaseUrl.replace(/\/$/, ''), key: cfg.supabaseKey };
  }

  const t0 = Date.now();
  const nowIso = new Date(t0).toISOString();
  const stats = {
    ran_at: nowIso, source: SOURCE, mode: 'baseline',
    matchups_seen: 0, live_seen: 0, rows_written: 0, closings_upserted: 0,
    errors: [], duration_ms: 0, notes: null,
  };

  const lastHashes = DRY_RUN ? new Map() : await loadLastHashes();

  const res = await core.fetchEvents();
  if (!res.ok) {
    stats.errors.push({ step: 'events', error: res.error, status: res.status });
    stats.duration_ms = Date.now() - t0;
    console.error(`[capture-br] ERRO ao buscar /odds/events: ${res.error} (status ${res.status})`);
    await recordRun({ ...stats, errors: stats.errors });
    if (has403(stats.errors)) {
      console.error('[guard] 403 da Pinnacle BR — encerrando imediatamente (nunca insistir)');
      process.exit(3);
    }
    process.exit(0); // API fora do ar não deve travar o Task Scheduler
  }

  const matchups = core.extractLolKillsMatchups(res.data);
  stats.matchups_seen = matchups.length;
  stats.live_seen = matchups.filter((m) => Number.isFinite(m.startTimeMs) && t0 >= m.startTimeMs).length;

  const newEntries = [];
  const hashUpdates = [];
  for (const m of matchups) {
    const entries = core.buildTimelineEntries(m, nowIso, t0);
    for (const e of entries) {
      const key = `${e.series_id}|${e.map_number}|${e.phase}`;
      if (lastHashes.get(key) !== e.content_hash) {
        hashUpdates.push({ key, prev: lastHashes.get(key) });
        lastHashes.set(key, e.content_hash);
        newEntries.push(e);
      }
    }
  }

  if (DRY_RUN) {
    stats.rows_written = newEntries.length;
    console.log(`[dry-run] matchups de Kills LoL vistos: ${matchups.length}`);
    console.log(`[dry-run] gravaria ${newEntries.length} row(s) em odds_timeline (source=${SOURCE}):`);
    for (const e of newEntries.slice(0, 50)) {
      console.log(`  ${e.phase} ${e.league} | ${e.team_home} vs ${e.team_away} | map${e.map_number} ` +
        `line=${e.main_line} O@${e.over_dec} U@${e.under_dec} juice=${e.juice_pct}% ladder=${e.ladder.length} degraus`);
    }
  } else {
    try {
      stats.rows_written = await insertTimeline(newEntries);
    } catch (err) {
      stats.errors.push({ step: 'insert_timeline', error: err.message });
      for (const u of hashUpdates) {
        if (u.prev === undefined) lastHashes.delete(u.key);
        else lastHashes.set(u.key, u.prev);
      }
    }
  }

  stats.duration_ms = Date.now() - t0;
  if (!stats.errors.length) stats.errors = null;

  console.log(`[capture-br] matchups=${stats.matchups_seen} live=${stats.live_seen} ` +
    `rows=${stats.rows_written} errors=${stats.errors ? stats.errors.length : 0} dur=${stats.duration_ms}ms`);

  await recordRun(stats);

  if (has403(stats.errors)) {
    console.error('[guard] 403 da Pinnacle BR — encerrando imediatamente (nunca insistir)');
    process.exit(3);
  }
}

main().catch((err) => {
  console.error('[capture-br] ERRO FATAL:', err.message || err);
  process.exit(1);
});
