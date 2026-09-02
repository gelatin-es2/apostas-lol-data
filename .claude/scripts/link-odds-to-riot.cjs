// Backfill de odds_timeline.riot_game_id / odds_timeline.game_clock_s (colunas
// RESERVADAS na DDL de 04/08 — ver .claude/scripts/sql/2026-08-04-odds-capture.sql).
//
// Casa cada série Pinnacle (odds_timeline, phase='live', map_number>=1) com o match
// da Riot via lolesports-find-match.cjs (mesmo motor usado por backfill-match-id.cjs,
// que já resolve nomes crus contra lib/team-aliases.json), depois com o game_id
// correspondente em game_drafts (match_id + game_number == map_number), e por fim
// estima game_clock_s pelo frame mais próximo de game_frames.
//
// Regra dura do projeto: ambiguidade (2+ candidatos, alias faltando) → SKIP com log
// explícito. Nunca chuta.
//
// Uso:
//   node link-odds-to-riot.cjs --dry-run                 → não escreve, só reporta
//   node link-odds-to-riot.cjs                            → aplica PATCH
//   node link-odds-to-riot.cjs --from=2026-08-05 --to=2026-08-07 --limit=200
//
// Idempotente: alvo é sempre riot_game_id is.null, então re-rodar só processa o que falta.

'use strict';

const https = require('https');
const path = require('path');
const { loadConfig } = require('./_load-config.cjs');
const { supabaseGet } = require('../../lib/supabaseQuery.cjs');
const { runFindMatch } = require('./lolesports-find-match.cjs');
const { normalizeTeam } = require('../../lib/normalizeTeam.cjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const getFlag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const FROM = getFlag('from');
const TO = getFlag('to');
const LIMIT = getFlag('limit') ? parseInt(getFlag('limit'), 10) : null;

function supabasePatch(supabaseUrl, supabaseKey, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'PATCH',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Prefer: 'return=minimal',
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
          resolve(true);
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Paginação genérica via Range header (PostgREST corta em 1000/req por padrão).
async function fetchAllPaginated(supabaseUrl, supabaseKey, endpoint, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await supabaseGet(supabaseUrl, supabaseKey, endpoint, {
      Range: `${offset}-${offset + pageSize - 1}`,
    });
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function isMissingTableError(e) {
  return /404|PGRST205/i.test(e.message);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Tenta a data exata do start_time primeiro; só cai pra ±1 dia se não achar nada
// (cobre diferença de fuso entre a leitura crua da Pinnacle e o schedule lolesports).
function candidateDates(startTimeIso) {
  const base = new Date(startTimeIso);
  return [isoDate(base), isoDate(new Date(base.getTime() - 86400000)), isoDate(new Date(base.getTime() + 86400000))];
}

// Assinatura comparável de nome de time: normaliza pelo alias canônico do projeto
// e depois reduz a letras/dígitos minúsculos, tirando ruído que só existe de um
// lado ("Esports", "Gaming", "Team", "Club", pontuação). "Movistar KOI Fenix" e
// "MovistarKOIFenix" colidem; "NS" e "NS Challengers" NÃO (sufixo real do time).
function teamKey(name) {
  if (!name) return '';
  const canon = normalizeTeam(String(name)) || String(name);
  return canon.toLowerCase()
    .replace(/\b(esports?|gaming|team|club|kul[uü]b[uü]|e-?sports)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function teamsEqual(a, b) {
  const ka = teamKey(a);
  const kb = teamKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // containment só quando o lado curto tem ≥4 chars — evita casar "ns"/"bro"
  // com qualquer nome que os contenha por acaso.
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 4 && long.includes(short);
}

// Índice match_id -> {league, match_start, teams, games} montado a partir de
// game_drafts (o que JÁ está no banco), carregado uma vez.
//
// Por que não usar só o lolesports-find-match: ele consulta getSchedule paginando
// 6 páginas pra trás, e jogo de ~1 semana atrás já saiu dessa janela — medido em
// 13/08, quando NEM um LCK 06/08 presente no nosso banco era encontrado (0/21
// séries resolvidas). O banco é a fonte certa aqui: o backfill já gravou esses
// mapas com times, liga e horário. A API vira só fallback pro que o banco não tem.
async function buildDraftIndex(supabaseUrl, supabaseKey, fromIso, toIso) {
  // match_start OU first_frame_utc dentro da janela: os drafts vindos do seed dos
  // caches locais não têm match_start (a fonte não traz — 4.530 rows assim), mas
  // ganham first_frame_utc quando o backfill reconstrói a série. Sem esse OR o
  // índice via só os 26 drafts com match_start e o linker perdia 82 dos 108 jogos
  // que JÁ têm série no banco (medido 13/08).
  const range = (col) => `and(${col}.gte.${fromIso},${col}.lte.${toIso})`;
  const rows = await fetchAllPaginated(
    supabaseUrl, supabaseKey,
    `/rest/v1/game_drafts?select=game_id,match_id,league,match_start,first_frame_utc,game_number,blue_team,red_team` +
    `&or=(${range('match_start')},${range('first_frame_utc')})`
  );
  const byMatch = new Map();
  for (const r of rows) {
    if (!byMatch.has(r.match_id)) {
      byMatch.set(r.match_id, {
        match_id: r.match_id, league: r.league,
        match_start: r.match_start || r.first_frame_utc,
        teams: new Set(), games: [],
      });
    }
    const m = byMatch.get(r.match_id);
    if (r.blue_team) m.teams.add(r.blue_team);
    if (r.red_team) m.teams.add(r.red_team);
    m.games.push({ game_number: r.game_number, game_id: r.game_id });
  }
  return [...byMatch.values()];
}

// Casa a série da Pinnacle contra o índice do banco: os DOIS times têm que bater
// e o match_start tem que cair em ±36h do start_time da Pinnacle. Mais de um
// candidato = ambíguo → skip com log (regra dura: nunca chutar).
function resolveFromIndex(index, teamHome, teamAway, startTimeIso) {
  const startMs = new Date(startTimeIso).getTime();
  const WINDOW_MS = 36 * 3600 * 1000;
  const hits = index.filter((m) => {
    if (!m.match_start) return false;
    if (Math.abs(new Date(m.match_start).getTime() - startMs) > WINDOW_MS) return false;
    const teams = [...m.teams];
    const homeHit = teams.some((t) => teamsEqual(t, teamHome));
    const awayHit = teams.some((t) => teamsEqual(t, teamAway));
    return homeHit && awayHit;
  });
  if (hits.length === 1) return { found: true, source: 'db', match: hits[0] };
  if (hits.length > 1) return { found: false, ambiguous: true, candidates: hits };
  return { found: false };
}

async function resolveSeriesMatch(teamHome, teamAway, startTimeIso) {
  const dates = candidateDates(startTimeIso);
  let lastNotFound = null;
  for (const d of dates) {
    const res = await runFindMatch({ teamA: teamHome, teamB: teamAway, dateArg: d });
    if (res.found) return { ...res, matchedDate: d };
    lastNotFound = res;
  }
  return lastNotFound || { found: false, reason: 'not_found_any_date', all_candidates: [] };
}

// Frame mais próximo (por diferença absoluta de tempo) → âncora pro clock estimado.
// Erro documentado no manifest do dataset: ±10s (frames em granularidade de minuto).
function nearestFrameClock(frames, capturedAtMs) {
  if (!frames || frames.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const f of frames) {
    const diff = Math.abs(new Date(f.frame_ts).getTime() - capturedAtMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  if (!best) return null;
  const deltaS = (capturedAtMs - new Date(best.frame_ts).getTime()) / 1000;
  return Math.round(best.game_clock_s + deltaS);
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // series_id::text (não só "series_id"): event_id do Betby tem ~19 dígitos, maior que
  // Number.MAX_SAFE_INTEGER — sem o cast, o PostgREST devolve bigint como número JSON
  // puro e o JSON.parse do Node arredonda o valor (medido em 14/08/2026: "...596611"
  // virou "...596600"), colidindo series distintas por acaso de arredondamento. Pinnacle
  // nunca teve esse problema (ids bem menores), mas o cast é inofensivo pra ela também.
  let qs = `select=id,captured_at,series_id::text,league,team_home,team_away,start_time,map_number` +
    `&phase=eq.live&map_number=gte.1&riot_game_id=is.null&order=start_time.asc`;
  if (FROM) qs += `&start_time=gte.${FROM}`;
  if (TO) qs += `&start_time=lte.${TO}T23:59:59`;

  process.stderr.write(`[1/4] Buscando rows alvo em odds_timeline...\n`);
  let targetRows = await fetchAllPaginated(supabaseUrl, supabaseKey, `/rest/v1/odds_timeline?${qs}`);
  if (LIMIT) targetRows = targetRows.slice(0, LIMIT);
  process.stderr.write(`  ${targetRows.length} rows alvo (phase=live, map_number>=1, riot_game_id null)\n`);

  const bySeries = new Map();
  for (const r of targetRows) {
    if (!bySeries.has(r.series_id)) bySeries.set(r.series_id, { meta: r, rows: [] });
    bySeries.get(r.series_id).rows.push(r);
  }
  process.stderr.write(`  ${bySeries.size} séries distintas\n`);

  process.stderr.write(`[2/4] Resolvendo série Pinnacle -> match Riot (game_drafts do banco; API como fallback)...\n`);
  const skip = {
    not_found: [],
    ambiguous: [],
  };

  // Índice a partir do banco, cobrindo a janela das odds alvo ±2 dias.
  let draftIndex = [];
  if (targetRows.length) {
    const startsMs = targetRows.map((r) => new Date(r.start_time).getTime()).filter(Number.isFinite);
    const fromIso = new Date(Math.min(...startsMs) - 2 * 86400000).toISOString();
    const toIso = new Date(Math.max(...startsMs) + 2 * 86400000).toISOString();
    try {
      draftIndex = await buildDraftIndex(supabaseUrl, supabaseKey, fromIso, toIso);
      process.stderr.write(`  índice do banco: ${draftIndex.length} matches com draft entre ${fromIso.slice(0, 10)} e ${toIso.slice(0, 10)}\n`);
    } catch (e) {
      process.stderr.write(`  [AVISO] não deu pra montar índice de game_drafts (${e.message}); caindo só na API.\n`);
    }
  }

  const seriesMatch = new Map(); // series_id -> { match_id, league_short }
  let resolvedFromDb = 0;
  let resolvedFromApi = 0;
  for (const [seriesId, { meta }] of bySeries) {
    // 1º o banco (tem o histórico completo), depois a API (só alcança ~1 semana)
    const fromDb = resolveFromIndex(draftIndex, meta.team_home, meta.team_away, meta.start_time);
    if (fromDb.found) {
      resolvedFromDb++;
      seriesMatch.set(seriesId, { match_id: fromDb.match.match_id, league_short: fromDb.match.league });
      process.stderr.write(`  OK[db]  ${meta.team_home} vs ${meta.team_away} (${meta.league}) -> match_id=${fromDb.match.match_id} [${fromDb.match.league}]\n`);
      continue;
    }
    if (fromDb.ambiguous) {
      skip.ambiguous.push({
        series_id: seriesId, league: meta.league, team_home: meta.team_home, team_away: meta.team_away,
        start_time: meta.start_time,
        candidates: fromDb.candidates.map((c) => `${[...c.teams].join(' x ')} (${c.league}, ${c.match_start})`),
      });
      continue;
    }
    const found = await resolveSeriesMatch(meta.team_home, meta.team_away, meta.start_time);
    if (found.found && !found.ambiguous) resolvedFromApi++;
    if (!found.found) {
      skip.not_found.push({
        series_id: seriesId, league: meta.league, team_home: meta.team_home, team_away: meta.team_away,
        start_time: meta.start_time, reason: found.reason,
      });
      continue;
    }
    if (found.ambiguous) {
      skip.ambiguous.push({
        series_id: seriesId, league: meta.league, team_home: meta.team_home, team_away: meta.team_away,
        start_time: meta.start_time,
        candidates: found.all_candidates?.map((c) => `${c.teams} (${c.league}, ${c.state}, ${c.start_time})`),
      });
      continue;
    }
    seriesMatch.set(seriesId, { match_id: found.picked.match_id, league_short: found.picked.league_short });
    process.stderr.write(`  OK[api] ${meta.team_home} vs ${meta.team_away} (${meta.league}) -> match_id=${found.picked.match_id} [${found.picked.league_short}]\n`);
  }

  process.stderr.write(`[3/4] Resolvendo game_id (game_drafts) e game_clock_s (game_frames)...\n`);
  let gameDraftsAvailable = true;
  let gameFramesAvailable = true;
  const draftsCache = new Map(); // match_id -> [drafts]
  const framesCache = new Map(); // game_id -> [frames]

  async function getDraftsForMatch(matchId) {
    if (!gameDraftsAvailable) return null;
    if (draftsCache.has(matchId)) return draftsCache.get(matchId);
    try {
      const rows = await supabaseGet(
        supabaseUrl, supabaseKey,
        `/rest/v1/game_drafts?select=game_id,game_number,first_frame_utc,status&match_id=eq.${encodeURIComponent(matchId)}`
      );
      draftsCache.set(matchId, rows);
      return rows;
    } catch (e) {
      if (isMissingTableError(e)) {
        gameDraftsAvailable = false;
        process.stderr.write(`  [AVISO] tabela game_drafts não existe ainda (${e.message}). Resolução de game_id/clock pausada.\n`);
        return null;
      }
      throw e;
    }
  }

  async function getFramesForGame(gameId) {
    if (!gameFramesAvailable) return null;
    if (framesCache.has(gameId)) return framesCache.get(gameId);
    try {
      const rows = await supabaseGet(
        supabaseUrl, supabaseKey,
        `/rest/v1/game_frames?select=frame_ts,game_clock_s&game_id=eq.${encodeURIComponent(gameId)}&order=frame_ts.asc`
      );
      framesCache.set(gameId, rows);
      return rows;
    } catch (e) {
      if (isMissingTableError(e)) {
        gameFramesAvailable = false;
        process.stderr.write(`  [AVISO] tabela game_frames não existe ainda (${e.message}). game_clock_s ficará null.\n`);
        return null;
      }
      throw e;
    }
  }

  const patches = []; // { id, riot_game_id, game_clock_s }
  const skipRows = { no_draft_for_map: [], tables_unavailable: [] };
  let clockNullBeforeStart = 0;
  let clockNullNoFrames = 0;

  for (const [seriesId, { rows }] of bySeries) {
    const m = seriesMatch.get(seriesId);
    if (!m) continue; // já contabilizado em skip.not_found / skip.ambiguous

    const drafts = await getDraftsForMatch(m.match_id);
    if (drafts === null) {
      // tabela indisponível — conta como skip mas não é erro nosso
      for (const r of rows) skipRows.tables_unavailable.push({ id: r.id, series_id: seriesId, map_number: r.map_number });
      continue;
    }

    for (const r of rows) {
      const draft = drafts.find((d) => d.game_number === r.map_number);
      if (!draft) {
        skipRows.no_draft_for_map.push({ id: r.id, series_id: seriesId, map_number: r.map_number, match_id: m.match_id });
        continue;
      }

      let gameClockS = null;
      const capturedAtMs = new Date(r.captured_at).getTime();
      if (draft.first_frame_utc && capturedAtMs < new Date(draft.first_frame_utc).getTime()) {
        clockNullBeforeStart++; // captured_at antes do início do mapa — null é esperado, não bug
      } else {
        const frames = await getFramesForGame(draft.game_id);
        if (!frames) {
          clockNullNoFrames++;
        } else {
          gameClockS = nearestFrameClock(frames, capturedAtMs);
          if (gameClockS === null) clockNullNoFrames++;
        }
      }

      patches.push({ id: r.id, riot_game_id: draft.game_id, game_clock_s: gameClockS });
    }
  }

  process.stderr.write(`[4/4] ${DRY_RUN ? 'DRY-RUN — nenhum PATCH' : 'Aplicando PATCHes...'}\n`);
  let patched = 0;
  let patchErrors = 0;
  if (!DRY_RUN) {
    for (const p of patches) {
      try {
        await supabasePatch(supabaseUrl, supabaseKey, `/rest/v1/odds_timeline?id=eq.${p.id}`, {
          riot_game_id: p.riot_game_id,
          game_clock_s: p.game_clock_s,
        });
        patched++;
      } catch (e) {
        patchErrors++;
        process.stderr.write(`  PATCH ERRO id=${p.id}: ${e.message}\n`);
      }
    }
  }

  const coveragePct = targetRows.length > 0 ? ((patches.length / targetRows.length) * 100).toFixed(1) : '0.0';

  const report = {
    mode: DRY_RUN ? 'DRY-RUN' : 'EXECUTE',
    filters: { from: FROM, to: TO, limit: LIMIT },
    target_rows: targetRows.length,
    distinct_series: bySeries.size,
    series_matched_safe: seriesMatch.size,
    series_matched_via: { db: resolvedFromDb, api: resolvedFromApi },
    series_skipped: {
      not_found: skip.not_found.length,
      ambiguous: skip.ambiguous.length,
    },
    rows_would_link: patches.length,
    rows_with_clock: patches.filter((p) => p.game_clock_s !== null).length,
    rows_clock_null_before_start: clockNullBeforeStart,
    rows_clock_null_no_frames: clockNullNoFrames,
    rows_skipped_no_draft_for_map: skipRows.no_draft_for_map.length,
    rows_skipped_tables_unavailable: skipRows.tables_unavailable.length,
    coverage_pct_of_target: coveragePct,
    game_drafts_table_available: gameDraftsAvailable,
    game_frames_table_available: gameFramesAvailable,
    patched: DRY_RUN ? 'n/a (dry-run)' : patched,
    patch_errors: DRY_RUN ? 'n/a (dry-run)' : patchErrors,
    // amostras pra auditoria — nunca todo o array em produção
    sample_not_found: skip.not_found.slice(0, 8),
    sample_ambiguous: skip.ambiguous.slice(0, 8),
    sample_skipped_no_draft: skipRows.no_draft_for_map.slice(0, 5),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch((e) => {
  process.stderr.write(`ERRO FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
