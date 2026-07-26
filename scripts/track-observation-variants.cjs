// scripts/track-observation-variants.cjs
//
// Rastreador SIMULADO das variantes de OBSERVAÇÃO do método (aprovado Elvis 2026-07-25).
// Insere bets bookmaker='SIMULATED' (stake R$100) pra acompanhar hipóteses que ainda
// NÃO são método — seguindo o schema canônico de .claude/scripts/insert-missed-bets.cjs.
//
// Variantes rastreadas (config VARIANTS abaixo, extensível):
//   over_pyke_watch — Pyke SUPPORT em qualquer lado → Over na fair @1.80
//                     (base: 62.1% n=103 período completo + 65% n=20 julho, tabela 21)
//   over_rell_naut  — Rell sup de um lado E Nautilus sup do outro → Over na fair @1.80
//                     (base: 60.6% n=33, knowledge/reports/2026-07-21-metodo-over-v1.md)
//   under_shen_top  — Shen TOP em qualquer lado → Under na fair+1 @1.72
//                     (base: 67.1% n=79 pooled, 27-shen-under; reprovou coerência split 3
//                      → por isso OBSERVAÇÃO, não método)
//
// Decisões de schema (diferenças intencionais vs insert-missed-bets.cjs):
//   is_method_bet = FALSE — observação NÃO pode poluir stats do método Under
//     (analiseStats/validate-sim-profit/dashboard filtram is_method_bet=eq.true).
//   raw_extraction.method_variant = nome da variante (padrão do dashboard/playbook).
//   raw_extraction.observation = true.
//   stake = 100 (não 1000) — decisão Elvis 2026-07-25 pra rastreador de observação.
//   match_context.fair_line_calculated = LINHA DO PICK (não a fair base) — assim
//     qualquer consumidor futuro de getBetSimulation(delta=0) avalia na linha certa.
//     A fair base fica em match_context.fair_base_line (+ line_delta_vs_fair).
//
// Fair — hierarquia OPERACIONAL (não a leave-one-out dos scripts de análise):
//   A) cron-data/YYYY-MM-DD-fair-pinnacle.json (match_id → fair, vale todos os mapas;
//      data = dia BRT do startTime, fallback dia UTC) — lib/loadFairPinnacle.cjs
//   B) fórmula (blueAvg+redAvg)/2 round .5 — mesma calcFormulaFair do daily_briefing:
//      cron-data/team_avg_kills.json > cron-data/expansion_team_avg_kills.json
//   C) nenhuma disponível → SKIP (contado e logado, não inventa fallback)
//
// Descoberta de mapas: schedule (fetch fresco, SEM cache — schedule muda todo dia)
//   → eventDetails → livestats window (ambos via scripts/audit/lib/api-cache.cjs,
//   cache em audit-cache/ — jogos completed são imutáveis). Frames suspeitos
//   (gameState!=finished E (gameTime<600s OU kills<5)) → SKIP com log, NUNCA settla.
//
// Idempotente: dedup por (lolesports_game_id + method_variant) nas bets SIMULATED.
// Mapas futuros nunca entram (só match state=completed + game state=completed).
// Mapas já finalizados entram JÁ SETTLADOS (green/red + profit, sem passar por pending).
//
// Uso:
//   node scripts/track-observation-variants.cjs                  → DRY-RUN (default), backfill 2026-07-21 → ontem
//   node scripts/track-observation-variants.cjs --apply          → insere de verdade
//   node scripts/track-observation-variants.cjs --from=2026-07-21 --to=2026-07-24 --apply
//
// Uso diário (idempotente — re-scan do range inteiro insere só o que for novo):
//   node scripts/track-observation-variants.cjs --apply

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');

const { loadConfig } = require(path.join(ROOT, '.claude', 'scripts', '_load-config.cjs'));
const { supabaseGet } = require(path.join(ROOT, 'lib', 'supabaseQuery.cjs'));
const { loadFairPinnacle } = require(path.join(ROOT, 'lib', 'loadFairPinnacle.cjs'));
const { normalizeLeague } = require(path.join(ROOT, 'lib', 'normTeamName.cjs'));
const {
  getEventDetails,
  getWindow,
  getTeams,
  tsRoundedTo10sCapped,
} = require(path.join(ROOT, 'scripts', 'audit', 'lib', 'api-cache.cjs'));
const { detectTrigger, isFrameSuspect } = require(path.join(ROOT, 'scripts', 'audit', 'lib', 'audit-common.cjs'));

// ============================================================================
// CONFIG
// ============================================================================

const STAKE = 100; // R$100 por observação (decisão Elvis 2026-07-25)

const normChamp = (s) => (s || '').toLowerCase().replace(/[\s'.]/g, '');

// Variantes de observação. detect(ctx) recebe { supBlue, supRed, topBlue, topRed }
// (championIds crus da API — comparar via normChamp). side: 'over'|'under'.
// lineDelta: soma na fair pra formar a linha do pick.
const VARIANTS = {
  over_pyke_watch: {
    side: 'over',
    lineDelta: 0,
    odd: 1.80,
    detect: (c) => normChamp(c.supBlue) === 'pyke' || normChamp(c.supRed) === 'pyke',
    basis: 'Pyke sup Over: 62.1% n=103 completo + 65% n=20 julho (21-champion-over-table)',
  },
  over_rell_naut: {
    side: 'over',
    lineDelta: 0,
    odd: 1.80,
    detect: (c) => {
      const a = normChamp(c.supBlue);
      const b = normChamp(c.supRed);
      return (a === 'rell' && b === 'nautilus') || (a === 'nautilus' && b === 'rell');
    },
    basis: 'Rell+Naut sups Over: 60.6% n=33 (2026-07-21-metodo-over-v1)',
  },
  under_shen_top: {
    side: 'under',
    lineDelta: 1,
    odd: 1.72,
    detect: (c) => normChamp(c.topBlue) === 'shen' || normChamp(c.topRed) === 'shen',
    basis: 'Shen top Under fair+1: 67.1% n=79 pooled, reprovou coerência split3 (27-shen-under)',
  },
};

// Ligas operadas (sync: .claude/scripts/lolesports-find-match.cjs LEAGUE_IDS) + LCP em teste.
// LIT/MSI/Worlds fora (não operadas — memória canônica ligas ativas).
const LEAGUES = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  LFL: '105266103462388553',
  LES: '105266074488398661',
  'Prime League': '105266091639104326',
  KCL: '98767991335774713', // LCK Challengers
  EUM: '100695891328981122', // EMEA Masters
  LCP: '113476371197627891', // teste 2026-07-25
};

const DEFAULT_FROM = '2026-07-21'; // início split 3 (volta das ligas)
const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const SAFETY_PAGE_CAP = 25;
const OFFSET_HOURS_TRY_ORDER = [6, 2, 4, 8]; // sync: phase0-universe.cjs
const BRT_OFFSET_MS = 3 * 3600 * 1000;

// ============================================================================
// ARGS
// ============================================================================

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (p) => {
    const a = argv.find((x) => x.startsWith(p + '='));
    return a ? a.split('=')[1] : null;
  };
  const yesterdayBrt = new Date(Date.now() - BRT_OFFSET_MS - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const from = get('--from') || DEFAULT_FROM;
  const to = get('--to') || yesterdayBrt;
  const apply = argv.includes('--apply');
  for (const d of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error(`--from/--to devem ser YYYY-MM-DD. Recebido: ${d}`);
      process.exit(1);
    }
  }
  return { from, to, dryRun: !apply };
}

// ============================================================================
// FETCH — schedule fresco (sem cache de disco; schedule muda todo dia)
// ============================================================================

function fetchJson(host, urlPath) {
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
          res.on('end', () => {
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            try {
              // IDs longos viram string antes do parse (perda de precisão do V8) —
              // mesmo regex de api-cache.cjs / lolesports-find-match.cjs.
              const fixed = body.replace(
                /"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g,
                '"$1":"$2"'
              );
              resolve(JSON.parse(fixed));
            } catch (e) {
              reject(new Error(`JSON err: ${e.message}`));
            }
          });
        }
      )
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function brtDateOf(isoUtc) {
  return new Date(new Date(isoUtc).getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

// Pagina o schedule (fresco) até oldestSeen < FROM. Retorna events completed no range
// [from, to] (data BRT do startTime).
async function fetchLeagueEvents(leagueName, leagueId, from, to) {
  const events = [];
  let pageToken = null;
  let oldestSeen = '9999-12-31';
  let pageIndex = 0;

  while (pageIndex < SAFETY_PAGE_CAP) {
    const qs = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    let page;
    try {
      page = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}${qs}`);
    } catch (e) {
      console.error(`  [${leagueName}] schedule page ${pageIndex} falhou: ${e.message}`);
      break;
    }
    const sched = page?.data?.schedule;
    for (const ev of sched?.events || []) {
      if (!ev.startTime) continue;
      const dBrt = brtDateOf(ev.startTime);
      if (dBrt < oldestSeen) oldestSeen = dBrt;
      if (ev.state === 'completed' && dBrt >= from && dBrt <= to) events.push(ev);
    }
    const olderToken = sched?.pages?.older;
    pageIndex++;
    if (!olderToken || oldestSeen < from) break;
    pageToken = olderToken;
    await sleep(300);
  }
  return events;
}

// eventDetails via cache (audit-cache/) com guarda anti-stale: se o cache existe mas
// não tem NENHUM game completed (foi cacheado com match em andamento), refetch noCache.
async function getEventDetailsFresh(matchId) {
  const cacheFile = path.join(ROOT, 'audit-cache', `event-${matchId}.json`);
  const hadCache = fs.existsSync(cacheFile);
  let detail = await getEventDetails(matchId);
  const games = detail?.data?.event?.match?.games || [];
  const completed = games.filter((g) => g.state === 'completed');
  if (hadCache && completed.length === 0) {
    detail = await getEventDetails(matchId, { noCache: true });
  }
  return detail;
}

// Window com fallback de offsets — sync: phase0-universe.cjs fetchGameWindow.
const isValidWindow = (w) => !!(w && Array.isArray(w.frames) && w.frames.length > 0 && w.gameMetadata);
const lastFrameOf = (w) => w.frames[w.frames.length - 1];

async function fetchWindowByOffsets(gameId, baseMs) {
  for (const hours of OFFSET_HOURS_TRY_ORDER) {
    const startingTime = tsRoundedTo10sCapped(baseMs + hours * 3600 * 1000);
    let win;
    try {
      win = await getWindow(gameId, startingTime);
    } catch {
      continue;
    }
    if (isValidWindow(win)) return win;
  }
  return null;
}

// Resolve o window FINAL do game. Se o melhor frame achado não é 'finished'
// (feed sem frames congelados pós-fim, ou cache gravado mid-game), caminha pra
// frente com noCache em passos de 10min até achar gameState='finished' ou o feed
// secar. O fetch noCache com frames válidos REGRAVA o cache — cura cache
// envenenado (window cacheado durante jogo ao vivo).
async function resolveFinalWindow(gameId, matchStartISO) {
  const baseMs = new Date(matchStartISO).getTime();
  if (!Number.isFinite(baseMs)) return null;
  const win = await fetchWindowByOffsets(gameId, baseMs);
  if (!win) return null;
  if (lastFrameOf(win).gameState === 'finished') return win;

  let best = win;
  let cursorMs = new Date(lastFrameOf(win).rfc460Timestamp).getTime();
  if (!Number.isFinite(cursorMs)) return best;
  let empties = 0;
  for (let i = 0; i < 24 && empties < 2; i++) {
    cursorMs += 10 * 60 * 1000;
    let w2;
    try {
      w2 = await getWindow(gameId, tsRoundedTo10sCapped(cursorMs), { noCache: true });
    } catch {
      empties++;
      continue;
    }
    if (!isValidWindow(w2)) {
      empties++;
      continue;
    }
    empties = 0;
    best = w2;
    const lf = lastFrameOf(w2);
    if (lf.gameState === 'finished') return w2;
    const lfMs = new Date(lf.rfc460Timestamp).getTime();
    if (Number.isFinite(lfMs) && lfMs > cursorMs) cursorMs = lfMs;
  }
  return best; // pode seguir não-finished → cai no isFrameSuspect e vira skip logado
}

// Extrai kills + picks completos (5 roles por lado) + teamIds do window.
// Picks shape sync: settle-pending-bets.cjs extractGameData (adc = role 'bottom').
function extractFromWindow(win) {
  const meta = win?.gameMetadata;
  if (!meta?.blueTeamMetadata || !meta?.redTeamMetadata || !win.frames?.length) return null;
  const lastFrame = win.frames[win.frames.length - 1];
  const picks = (md) => {
    const p = md.participantMetadata || [];
    const get = (role) => p.find((x) => x.role === role)?.championId || null;
    return { top: get('top'), jungle: get('jungle'), mid: get('mid'), adc: get('bottom'), support: get('support') };
  };
  const kBlue = lastFrame.blueTeam?.totalKills ?? 0;
  const kRed = lastFrame.redTeam?.totalKills ?? 0;
  return {
    gameState: lastFrame.gameState,
    gameTimeMs: lastFrame.gameTime ?? null,
    kBlue,
    kRed,
    totalKills: kBlue + kRed,
    bluePicks: picks(meta.blueTeamMetadata),
    redPicks: picks(meta.redTeamMetadata),
    blueTeamId: String(meta.blueTeamMetadata.esportsTeamId),
    redTeamId: String(meta.redTeamMetadata.esportsTeamId),
  };
}

// ============================================================================
// FAIR — hierarquia operacional
// ============================================================================

function loadJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadAliasMap() {
  const j = loadJsonSafe(path.join(ROOT, 'lib', 'team-aliases.json'));
  return j?.aliases || {};
}

// (blueAvg+redAvg)/2 round .5 — sync: daily_briefing.cjs calcFormulaFair
// (team_avg_kills.json primeiro, expansion_team_avg_kills.json como fallback).
function calcFormulaFair(teamAName, teamBName, teamAvgData, expansionAvgData) {
  const t = teamAvgData?.teams || {};
  const te = expansionAvgData?.teams || {};
  const a = t[teamAName]?.avg_kills ?? te[teamAName]?.avg_kills ?? null;
  const b = t[teamBName]?.avg_kills ?? te[teamBName]?.avg_kills ?? null;
  if (a == null || b == null) return null;
  return Math.round((a + b) / 2 - 0.5) + 0.5;
}

// ============================================================================
// SUPABASE write (mesmo padrão de insert-missed-bets.cjs)
// ============================================================================

function supaRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
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
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try {
          resolve(b ? JSON.parse(b) : null);
        } catch (e) {
          reject(new Error(`JSON err: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ============================================================================
// MAIN
// ============================================================================

(async () => {
  const { from, to, dryRun } = parseArgs();
  const { supabaseUrl, supabaseKey } = loadConfig();
  console.error(`Rastreador de variantes de observação — range ${from} → ${to} (data BRT) | ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.error(`Variantes: ${Object.keys(VARIANTS).join(', ')} | ligas: ${Object.keys(LEAGUES).join(', ')}`);

  // --- dados de apoio ---
  const aliasMap = loadAliasMap();
  const resolveCanonical = (name) => (name ? aliasMap[name] || name : name);
  const teamAvgData = loadJsonSafe(path.join(ROOT, 'cron-data', 'team_avg_kills.json'));
  const expansionAvgData = loadJsonSafe(path.join(ROOT, 'cron-data', 'expansion_team_avg_kills.json'));
  if (!teamAvgData && !expansionAvgData) {
    console.error('AVISO: nenhum team_avg_kills disponível — fórmula indisponível, só Pinnacle.');
  }

  const teamsRaw = await getTeams();
  const teamsMap = new Map();
  for (const t of teamsRaw?.data?.teams || []) teamsMap.set(String(t.id), t.name);
  console.error(`teams map: ${teamsMap.size} times`);

  const pinnacleCache = new Map();
  const getPinnacle = (date) => {
    if (!pinnacleCache.has(date)) pinnacleCache.set(date, loadFairPinnacle(date));
    return pinnacleCache.get(date);
  };

  // --- dedup: SIMULATED existentes por (game_id + method_variant) ---
  console.error('Fetching SIMULATED existentes pra dedup...');
  const existing = await supabaseGet(
    supabaseUrl,
    supabaseKey,
    '/rest/v1/bets?select=id,raw_extraction&bookmaker=eq.SIMULATED&limit=5000'
  );
  const existingKeys = new Set();
  for (const e of existing || []) {
    const gid = e.raw_extraction?.match_context?.lolesports_game_id;
    const mv = e.raw_extraction?.method_variant || '';
    if (gid) existingKeys.add(`${gid}|${mv}`);
  }
  console.error(`  ${existing.length} SIMULATED no banco (${existingKeys.size} chaves game+variante)`);

  // --- varredura ---
  const batch = [];
  const skips = { suspect_frame: 0, no_frames: 0, no_fair: 0, dedup: 0 };
  const noFairDetail = [];

  for (const [leagueName, leagueId] of Object.entries(LEAGUES)) {
    const events = await fetchLeagueEvents(leagueName, leagueId, from, to);
    if (!events.length) {
      console.error(`[${leagueName}] 0 matches completed no range`);
      continue;
    }
    console.error(`[${leagueName}] ${events.length} matches completed no range`);

    for (const ev of events) {
      const matchId = String(ev.match?.id || ev.id);
      const startTime = ev.startTime;
      const dateBrt = brtDateOf(startTime);
      const dateUtc = startTime.slice(0, 10);

      let detail;
      try {
        detail = await getEventDetailsFresh(matchId);
      } catch (e) {
        console.error(`  [SKIP eventDetails] match=${matchId}: ${e.message}`);
        continue;
      }
      const games = (detail?.data?.event?.match?.games || []).filter((g) => g.state === 'completed');

      for (const g of games) {
        const gameId = String(g.id);
        const win = await resolveFinalWindow(gameId, startTime);
        if (!win) {
          skips.no_frames++;
          console.error(`  [SKIP no_frames] ${leagueName} match=${matchId} game=${gameId} map${g.number}`);
          continue;
        }
        const gd = extractFromWindow(win);
        if (!gd) {
          skips.no_frames++;
          console.error(`  [SKIP no_frames] ${leagueName} match=${matchId} game=${gameId} map${g.number} (metadata incompleta)`);
          continue;
        }
        // Detecta variante ANTES do check de frame suspeito: picks vêm do
        // gameMetadata (válido mesmo com frame congelado); só os KILLS são
        // insettláveis num frame suspeito.
        const ctx = {
          supBlue: gd.bluePicks.support,
          supRed: gd.redPicks.support,
          topBlue: gd.bluePicks.top,
          topRed: gd.redPicks.top,
        };
        const fired = Object.entries(VARIANTS).filter(([, v]) => v.detect(ctx));
        if (!fired.length) continue;

        if (isFrameSuspect(gd)) {
          skips.suspect_frame += fired.length;
          console.error(
            `  [SKIP suspect] ${leagueName} game=${gameId} map${g.number} gameState=${gd.gameState} ` +
              `gameTime=${gd.gameTimeMs != null ? Math.round(gd.gameTimeMs / 1000) + 's' : '?'} kills=${gd.totalKills} ` +
              `variantes=[${fired.map(([n]) => n).join(', ')}] — NUNCA settla frame suspeito`
          );
          continue;
        }

        // Nomes: getTeams → canonical curto (mesmo resolveCanonical de build-expansion-team-avgs)
        const blueRaw = teamsMap.get(gd.blueTeamId) || gd.blueTeamId;
        const redRaw = teamsMap.get(gd.redTeamId) || gd.redTeamId;
        const teamA = resolveCanonical(blueRaw);
        const teamB = resolveCanonical(redRaw);

        // Fair hierarquia: A) Pinnacle (dia BRT, fallback dia UTC) B) fórmula C) skip
        // SÓ byMatchId — lookupByName é fuzzy demais (substring 'al'⊂'galions' já
        // vazou linha de LPL pra LFL num dry-run) e o /log-fair resolve match_id na origem.
        let fairPinnacle = null;
        for (const d of dateUtc === dateBrt ? [dateBrt] : [dateBrt, dateUtc]) {
          fairPinnacle = getPinnacle(d).byMatchId.get(matchId) ?? null;
          if (fairPinnacle != null) break;
        }
        const fairFormula = calcFormulaFair(teamA, teamB, teamAvgData, expansionAvgData);
        const fair = fairPinnacle ?? fairFormula;
        const fairLineSource = fairPinnacle != null ? 'pinnacle_manual' : fairFormula != null ? 'formula' : null;

        for (const [variantName, v] of fired) {
          if (existingKeys.has(`${gameId}|${variantName}`)) {
            skips.dedup++;
            continue;
          }
          if (fair == null) {
            skips.no_fair++;
            noFairDetail.push(`${dateBrt} ${leagueName} ${teamA} vs ${teamB} map${g.number} [${variantName}]`);
            console.error(`  [SKIP no_fair] ${dateBrt} ${leagueName} ${teamA} vs ${teamB} map${g.number} [${variantName}]`);
            continue;
          }

          const line = fair + v.lineDelta;
          const isOver = v.side === 'over';
          const won = isOver ? gd.totalKills > line : gd.totalKills < line;
          const profit = won ? +(STAKE * (v.odd - 1)).toFixed(2) : -STAKE;
          const pick = `${isOver ? 'Over' : 'Under'} ${line}`;

          // Offset em segundos derivado do game_id — evita colisão da constraint
          // UNIQUE (pick, bookmaker, stake, bet_datetime, odd) entre mapas/jogos
          // (mesmo padrão de insert-missed-bets.cjs).
          const gidOffset = (parseInt(gameId.slice(-6), 10) || 0) % 3600;
          const betDatetime = new Date(new Date(startTime).getTime() + gidOffset * 1000).toISOString();

          batch.push({
            _log: { date: dateBrt, league: leagueName, variant: variantName },
            row: {
              bookmaker: 'SIMULATED',
              league: normalizeLeague(leagueName),
              team_a: teamA,
              team_b: teamB,
              market: 'Total Kills',
              pick,
              odd: v.odd,
              stake: STAKE,
              bet_datetime: betDatetime,
              pandascore_match_id: Number(matchId) || null,
              is_map_bet: true,
              map_number: g.number,
              is_method_bet: false, // observação — fora das stats do método Under
              status: won ? 'green' : 'red',
              profit,
              settled_at: new Date().toISOString(),
              settle_source:
                `SIMULATED observação ${variantName} — ${pick} @${v.odd}, ${gd.totalKills} kills, ` +
                `fair ${fair} (${fairLineSource})`,
              fair_pinnacle: fairPinnacle,
              fair_formula: fairFormula,
              fair_line_source: fairLineSource,
              raw_extraction: {
                simulated: true,
                observation: true,
                method_variant: variantName,
                variant_basis: v.basis,
                match_context: {
                  lolesports_match_id: matchId,
                  lolesports_game_id: gameId,
                  start_time: startTime,
                  league_short: normalizeLeague(leagueName),
                  // fair_line_calculated = linha do PICK (não a fair base) — ver header
                  fair_line_calculated: line,
                  simulated_line: line,
                  fair_base_line: fair,
                  line_delta_vs_fair: v.lineDelta,
                  total_kills: gd.totalKills,
                  kills_blue: gd.kBlue,
                  kills_red: gd.kRed,
                  [isOver ? 'over_hit' : 'under_hit']: won,
                  trigger_type: variantName,
                  method_trigger: detectTrigger(ctx.supBlue, ctx.supRed),
                  teams: [{ name: teamA }, { name: teamB }],
                  blue_team_id: gd.blueTeamId,
                  red_team_id: gd.redTeamId,
                  blue_picks: gd.bluePicks,
                  red_picks: gd.redPicks,
                },
              },
              notes: `simulated_observation_${variantName}`,
            },
          });
        }
      }
    }
  }

  // --- relatório ---
  const byVariantDay = {};
  const byVariant = {};
  for (const { _log, row } of batch) {
    const kd = `${_log.date}|${_log.variant}`;
    byVariantDay[kd] = (byVariantDay[kd] || 0) + 1;
    if (!byVariant[_log.variant]) byVariant[_log.variant] = { n: 0, green: 0, red: 0, profit: 0 };
    byVariant[_log.variant].n++;
    byVariant[_log.variant][row.status]++;
    byVariant[_log.variant].profit += row.profit;
  }

  console.log(`\n=== ${dryRun ? 'DRY-RUN — o que seria inserido' : 'INSERINDO'} (${batch.length} bets novas) ===\n`);
  console.log('| data (BRT) | liga | variante | match | mapa | pick | kills | fair (fonte) | resultado |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const { _log, row } of batch) {
    const mc = row.raw_extraction.match_context;
    console.log(
      `| ${_log.date} | ${row.league} | ${_log.variant} | ${row.team_a} vs ${row.team_b} | M${row.map_number} | ` +
        `${row.pick} @${row.odd} | ${mc.total_kills} | ${mc.fair_base_line} (${row.fair_line_source}) | ${row.status} |`
    );
  }

  console.log('\n=== Contagem por variante/dia ===');
  for (const k of Object.keys(byVariantDay).sort()) console.log(`  ${k.replace('|', '  ')}: ${byVariantDay[k]}`);

  console.log('\n=== Resumo por variante (novas desta rodada) ===');
  for (const [v, s] of Object.entries(byVariant)) {
    console.log(`  ${v}: n=${s.n} green=${s.green} red=${s.red} hit=${s.n ? ((100 * s.green) / s.n).toFixed(1) : 0}% profit=R$${s.profit.toFixed(2)} (stake ${STAKE})`);
  }

  console.log('\n=== Skips ===');
  console.log(`  dedup (já no banco):                     ${skips.dedup}`);
  console.log(`  frame suspeito (bets de variante perdidas): ${skips.suspect_frame}`);
  console.log(`  sem frames válidos (mapas):              ${skips.no_frames}`);
  console.log(`  sem fair (Pinnacle+fórmula):             ${skips.no_fair}`);
  for (const d of noFairDetail) console.log(`    - ${d}`);

  if (dryRun) {
    console.log('\nDRY-RUN — nada foi escrito. Use --apply pra inserir.');
    return;
  }
  if (!batch.length) {
    console.log('\n0 bets novas — nada a inserir (idempotente).');
    return;
  }

  // Insert em chunks de 50 (mesmo padrão de insert-missed-bets.cjs)
  const rows = batch.map((b) => b.row);
  let inserted = 0;
  let errors = 0;
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      await supaRequest(supabaseUrl, supabaseKey, 'POST', '/rest/v1/bets', chunk);
      inserted += chunk.length;
      console.error(`  inserted ${inserted}/${rows.length}`);
    } catch (e) {
      errors++;
      console.error(`  chunk ${i}-${i + chunk.length} falhou: ${e.message}`);
    }
  }
  console.log(JSON.stringify({ inserted, errors, skips }, null, 2));
})().catch((e) => {
  console.error('ERRO:', e.stack || e.message);
  process.exit(1);
});
