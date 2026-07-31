// Visualizador AO VIVO de jogos profissionais de LoL, com itens (o AndyDanger parou de
// mostrar) + contexto de aposta integrado ao método Under kills do projeto.
//
// Uso:
//   node scripts/live-viewer.cjs                → sobe em http://localhost:8787
//   node scripts/live-viewer.cjs --port=8790     → porta customizada
//
// Arquitetura (Node built-ins only — fs/path/http/https, ZERO deps npm, convenção do
// projeto — ver CLAUDE.md):
//   - Servidor HTTP local serve UMA página (HTML+CSS+JS inline, sem framework/CDN).
//   - TODAS as chamadas externas (esports-api, feed.lolesports, ddragon) são feitas
//     pelo SERVIDOR, nunca pelo browser. Motivo: esports-api exige header `x-api-key`
//     e o preflight do browser bloqueia CORS custom header nesse endpoint (feed e
//     ddragon têm CORS aberto, mas manter tudo server-side simplifica e evita 2 origens).
//   - Browser só fala com `/api/*` deste próprio servidor (same-origin, sem CORS).
//
// Pegadinhas conhecidas (já mapeadas no projeto — NÃO re-testar, só respeitar):
//   1. `feed.lolesports.com/livestats/v1/details/{gameId}` exige `startingTime` com
//      ATRASO >= 110s (o `/window` aceita 90s). Usamos 180s de margem nos dois pra
//      folga. Errar isso NÃO dá 204 — dá HTTP 400 `BAD_QUERY_PARAMETER`.
//   2. `getEventDetails` (esports-api) serve estado velho (`state`) com frequência —
//      NUNCA usar pra decidir se o jogo tá rolando. Fonte de verdade é o `gameState`
//      do último frame do `/window` (valores observados: 'in_game', 'finished',
//      'paused'). `getEventDetails` só serve pra descobrir teams/games/ids.
//   3. IDs da esports-api (match id, team id, game id) têm 15+ dígitos — JSON.parse
//      nativo perde precisão (Number > Number.MAX_SAFE_INTEGER). Toda resposta da
//      esports-api passa por regex que aspeia esses campos ANTES do parse.
//   4. `/window` não é um histórico completo do jogo — é uma janela recente (perto do
//      `startingTime` pedido). Não dá pra reconstruir "tempo de jogo" exato só com
//      isso; ver LIMITAÇÕES no header da função `buildLiveState`.
//   5. `/window` e `/details` podem vir vazios ("") ou não-JSON quando o jogo ainda tá
//      no pick/ban ou a Riot não publicou frame — sempre tratar como "sem dados ainda",
//      nunca deixar a página quebrar.
//
// Ligas cobertas (LEAGUE_IDS canônicos, mesmos de `.claude/scripts/lolesports-find-match.cjs`):
//   LCK, LPL, LEC, CBLOL, LCS, LFL, LES, Prime League, LCP, EUM, KCL.
//
// Trigger do método (mesma definição de `analyze_yesterday.cjs` / `settle-pending-bets.cjs`):
//   PEEL_PURE = soraka,sona,janna,lulu,yuumi,karma,seraphine,renataglasc,nami,milio
//   FLEX_ENGAGE = bard,rakan,lux,anivia
//   2peel = ambos supports em PEEL_PURE · 1peel+flex = 1 PEEL_PURE + 1 FLEX_ENGAGE
//   Extras pedidos pro viewer: Milio no trigger → badge "2u"; Milio vs engage
//   (rell/nautilus/leona/alistar/thresh) → "SKIP"; Camille sup em qualquer lado →
//   "janela Over 2u" (fora da lógica de peel/flex).

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 8787;
const CRON_DIR = path.resolve(__dirname, '..', 'cron-data');

const LEAGUE_IDS = {
  LCK: '98767991310872058',
  LPL: '98767991314006698',
  LEC: '98767991302996019',
  CBLOL: '98767991332355509',
  LCS: '98767991299243165',
  LFL: '105266103462388553',
  LES: '105266074488398661',
  'Prime League': '105266091639104326',
  LCP: '113476371197627891',
  EUM: '100695891328981122',
  KCL: '98767991335774713',
};

const PEEL_PURE = ['soraka', 'sona', 'janna', 'lulu', 'yuumi', 'karma', 'seraphine', 'renataglasc', 'renata', 'nami', 'milio'];
const FLEX_ENGAGE = ['bard', 'rakan', 'lux', 'anivia'];
const ENGAGE_VS_MILIO = ['rell', 'nautilus', 'leona', 'alistar', 'thresh'];

// ---------- HTTP helpers ----------

// Aspeia campos de id com 15+ dígitos ANTES do parse (perda de precisão do JSON.parse nativo).
const BIGID_RE = /"(id|esportsTeamId|esportsPlayerId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g;
function safeParse(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw.replace(BIGID_RE, '"$1":"$2"'));
  } catch {
    return null;
  }
}

function fetchRaw(url, headers = {}, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
  });
}

async function esportsApi(pathAndQuery) {
  const { body } = await fetchRaw(`https://esports-api.lolesports.com/persisted/gw/${pathAndQuery}`, {
    'x-api-key': KEY,
    'User-Agent': 'Mozilla/5.0',
    Origin: 'https://lolesports.com',
    Referer: 'https://lolesports.com/',
  });
  return safeParse(body);
}

// startingTime arredondado a múltiplo de 10s, com atraso mínimo pra evitar 400.
// details exige >=110s; window aceita 90s. Usamos 180s de margem nos dois (pegadinha #1).
function startingTime(lagMs = 180000) {
  const d = new Date(Date.now() - lagMs);
  d.setSeconds(Math.floor(d.getSeconds() / 10) * 10, 0);
  return d.toISOString().replace(/\.\d+Z/, 'Z');
}

async function livestats(kind, gameId) {
  const { body } = await fetchRaw(`https://feed.lolesports.com/livestats/v1/${kind}/${gameId}?startingTime=${startingTime()}`);
  return safeParse(body);
}

// ---------- ddragon cache (1x por execução do servidor) ----------

let ddragonCache = null;
async function getDdragon() {
  if (ddragonCache) return ddragonCache;
  const { body: verRaw } = await fetchRaw('https://ddragon.leagueoflegends.com/api/versions.json');
  const versions = safeParse(verRaw);
  const version = (versions && versions[0]) || '16.15.1';
  const { body: itemsRaw } = await fetchRaw(`https://ddragon.leagueoflegends.com/cdn/${version}/data/pt_BR/item.json`);
  const itemsJson = safeParse(itemsRaw);
  ddragonCache = { version, items: (itemsJson && itemsJson.data) || {} };
  return ddragonCache;
}

// ---------- fair line (Pinnacle > fórmula) ----------

function normName(s) {
  return (s || '').toLowerCase().replace(/[\s.\-_]/g, '');
}

function loadFairForMatch(dateStr, matchId) {
  // 1) Pinnacle manual — SÓ por match_id (lookup por nome tem bug de substring conhecido).
  const pinFile = path.join(CRON_DIR, `${dateStr}-fair-pinnacle.json`);
  if (fs.existsSync(pinFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
      const entry = (j.fair_lines || []).find((e) => String(e.lolesports_match_id) === String(matchId));
      if (entry && entry.fair_line != null) {
        return { fair_line: entry.fair_line, source: 'Pinnacle', note: entry.source_note || null };
      }
    } catch { /* ignore */ }
  }
  // 2) Fórmula pré-jogo — também por event_id, pega a captura mais recente que tiver o match.
  const preFile = path.join(CRON_DIR, `${dateStr}-fair-pre.json`);
  if (fs.existsSync(preFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(preFile, 'utf8'));
      const captures = j.captures || [];
      for (let i = captures.length - 1; i >= 0; i--) {
        const entry = (captures[i].fair_lines || []).find((e) => String(e.event_id) === String(matchId));
        if (entry && entry.fair_formula != null) {
          return { fair_line: entry.fair_formula, source: 'fórmula', note: null };
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ---------- trigger / badge do método ----------

const norm = (s) => (s ? s.toLowerCase().replace(/\s+/g, '') : '');
const isPurePeel = (c) => c && PEEL_PURE.includes(norm(c));
const isFlexEngage = (c) => c && FLEX_ENGAGE.includes(norm(c));

function detectTrigger(supBlue, supRed) {
  const pures = (isPurePeel(supBlue) ? 1 : 0) + (isPurePeel(supRed) ? 1 : 0);
  const flexes = (isFlexEngage(supBlue) ? 1 : 0) + (isFlexEngage(supRed) ? 1 : 0);
  if (pures === 2) return '2peel';
  if (pures === 1 && flexes >= 1) return '1peel+flex';
  return null;
}

function classifyBadge(supBlue, supRed) {
  const sb = norm(supBlue);
  const sr = norm(supRed);
  if (sb === 'camille' || sr === 'camille') {
    return { label: 'Janela Camille · Over 2u', cls: 'badge-over' };
  }
  const trig = detectTrigger(supBlue, supRed);
  if (!trig) return { label: 'Skip (sem trigger)', cls: 'badge-skip' };
  const hasMilio = sb === 'milio' || sr === 'milio';
  if (hasMilio) {
    const other = sb === 'milio' ? sr : sb;
    if (ENGAGE_VS_MILIO.includes(other)) {
      return { label: `SKIP · Milio vs engage (${other})`, cls: 'badge-skip' };
    }
    return { label: `${trig} · Milio · 2u`, cls: 'badge-2u' };
  }
  return { label: `${trig} · 1u`, cls: 'badge-1u' };
}

// ---------- schedule (sidebar) ----------

let scheduleCache = { ts: 0, games: [] };
const SCHEDULE_TTL_MS = 60000;

async function getTodaySchedule() {
  if (Date.now() - scheduleCache.ts < SCHEDULE_TTL_MS) return scheduleCache.games;
  const today = new Date().toISOString().slice(0, 10);
  const results = await Promise.all(
    Object.entries(LEAGUE_IDS).map(async ([league, leagueId]) => {
      const j = await esportsApi(`getSchedule?hl=en-US&leagueId=${leagueId}`);
      const events = j?.data?.schedule?.events || [];
      return events
        .filter((e) => e.startTime && e.startTime.slice(0, 10) === today && e.match)
        .map((e) => ({
          matchId: e.match.id,
          league,
          state: e.state, // unstarted | inProgress | completed
          startTime: e.startTime,
          teams: (e.match.teams || []).map((t) => ({ code: t.code, name: t.name })),
        }));
    })
  );
  const games = results.flat().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  scheduleCache = { ts: Date.now(), games };
  return games;
}

// ---------- detalhe de um match (teams + mapas) ----------

async function getMatchDetail(matchId) {
  const j = await esportsApi(`getEventDetails?hl=en-US&id=${matchId}`);
  const event = j?.data?.event;
  if (!event || !event.match) return null;
  const teams = (event.match.teams || []).map((t) => ({ id: String(t.id), code: t.code, name: t.name }));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const games = (event.match.games || []).map((g) => ({
    number: g.number,
    id: g.id,
    state: g.state, // unstarted | inProgress | completed (pode estar velho — pegadinha #2)
    sides: (g.teams || []).map((t) => ({ id: String(t.id), side: t.side })),
  }));
  return { matchId, league: event.league?.name || null, teams, teamById, games };
}

// Escolhe o mapa "atual": prioriza inProgress; senão o completed mais recente; senão null.
function pickCurrentMap(games, mapArg) {
  if (mapArg) return games.find((g) => String(g.number) === String(mapArg)) || null;
  const inProgress = games.find((g) => g.state === 'inProgress');
  if (inProgress) return inProgress;
  const completed = games.filter((g) => g.state === 'completed');
  if (completed.length) return completed[completed.length - 1];
  return null;
}

// ---------- estado ao vivo de um mapa (score + jogadores + itens + fair) ----------
//
// LIMITAÇÃO CONHECIDA: `/window` da Riot não devolve o histórico completo do jogo, só
// uma janela recente perto do `startingTime` pedido — não existe endpoint público que dê
// "tempo de jogo decorrido" exato. O campo `gameTime` documentado em código antigo do
// projeto não veio presente nos testes de hoje (frames só trazem `rfc460Timestamp`,
// `gameState`, `blueTeam`, `redTeam`). Por isso "tempo estimado" aqui é APROXIMADO: contamos
// desde a primeira vez que ESTE servidor observou o jogo em `in_game` (rótulo "tempo
// observado", não "tempo de jogo real" — deixamos isso explícito na UI pra não confundir).
const gameFirstSeen = new Map(); // gameId -> Date da 1ª observação in_game neste processo

async function buildLiveState(matchId, mapArg) {
  const detail = await getMatchDetail(matchId);
  if (!detail) return { status: 'error', message: 'não consegui carregar o match (getEventDetails vazio/erro)' };

  const map = pickCurrentMap(detail.games, mapArg);
  if (!map) {
    return {
      status: 'not_started',
      message: 'nenhum mapa começou ainda',
      matchId,
      league: detail.league,
      teams: detail.teams,
      games: detail.games,
    };
  }

  const [win, det] = await Promise.all([livestats('window', map.id), livestats('details', map.id)]);
  if (!win || !win.frames || !win.frames.length || !det || !det.frames || !det.frames.length) {
    return {
      status: 'no_data',
      message: 'sem dados ainda (pick/ban?)',
      matchId,
      league: detail.league,
      teams: detail.teams,
      games: detail.games,
      selectedMap: map.number,
    };
  }

  const meta = win.gameMetadata;
  const lastFrame = win.frames[win.frames.length - 1];
  const lastDetail = det.frames[det.frames.length - 1];

  // gameState do frame é fonte de verdade (pegadinha #2) — NUNCA usar map.state (eventDetails).
  const gameState = lastFrame.gameState || 'unknown';
  if (gameState === 'in_game' && !gameFirstSeen.has(map.id)) gameFirstSeen.set(map.id, new Date());
  const observedSinceMs = gameFirstSeen.has(map.id) ? Date.now() - gameFirstSeen.get(map.id).getTime() : null;

  const blueTeamId = String(meta.blueTeamMetadata.esportsTeamId);
  const redTeamId = String(meta.redTeamMetadata.esportsTeamId);
  const blueTeam = detail.teamById.get(blueTeamId) || { code: 'BLUE', name: 'Time Azul' };
  const redTeam = detail.teamById.get(redTeamId) || { code: 'RED', name: 'Time Vermelho' };

  const detailByPid = new Map(lastDetail.participants.map((p) => [p.participantId, p]));
  const ddragon = await getDdragon();

  function buildSide(teamMeta) {
    return teamMeta.participantMetadata.map((pm) => {
      const d = detailByPid.get(pm.participantId) || {};
      const items = (d.items || [])
        .filter((id) => id && id !== 0)
        .map((id) => {
          const it = ddragon.items[id];
          return { id, name: it ? it.name : `#${id}` };
        });
      return {
        participantId: pm.participantId,
        role: pm.role,
        player: pm.summonerName,
        championId: pm.championId,
        kills: d.kills ?? 0,
        deaths: d.deaths ?? 0,
        assists: d.assists ?? 0,
        cs: d.creepScore ?? 0,
        gold: d.totalGoldEarned ?? 0,
        level: d.level ?? 0,
        items,
      };
    });
  }

  const bluePlayers = buildSide(meta.blueTeamMetadata);
  const redPlayers = buildSide(meta.redTeamMetadata);
  const supBlue = meta.blueTeamMetadata.participantMetadata.find((p) => p.role === 'support')?.championId || null;
  const supRed = meta.redTeamMetadata.participantMetadata.find((p) => p.role === 'support')?.championId || null;
  const badge = classifyBadge(supBlue, supRed);

  const totalKills = (lastFrame.blueTeam?.totalKills ?? 0) + (lastFrame.redTeam?.totalKills ?? 0);
  const dateStr = new Date().toISOString().slice(0, 10);
  const fair = loadFairForMatch(dateStr, matchId);
  let betContext = null;
  if (fair) {
    const underLine = fair.fair_line + 1; // linha 1 acima da fair, ver nota de UI
    const maxAllowed = Math.floor(underLine);
    betContext = {
      fairLine: fair.fair_line,
      fairSource: fair.source,
      fairNote: fair.note,
      underLine,
      maxAllowed,
      killsRemaining: maxAllowed - totalKills, // negativo = já estourou
    };
  }

  return {
    status: 'ok',
    matchId,
    league: detail.league,
    selectedMap: map.number,
    games: detail.games,
    gameState,
    observedSinceMs,
    score: {
      blue: { ...blueTeam, kills: lastFrame.blueTeam?.totalKills ?? 0, gold: lastFrame.blueTeam?.totalGold ?? 0, towers: lastFrame.blueTeam?.towers ?? 0, inhibitors: lastFrame.blueTeam?.inhibitors ?? 0, barons: lastFrame.blueTeam?.barons ?? 0, dragons: lastFrame.blueTeam?.dragons ?? [] },
      red: { ...redTeam, kills: lastFrame.redTeam?.totalKills ?? 0, gold: lastFrame.redTeam?.totalGold ?? 0, towers: lastFrame.redTeam?.towers ?? 0, inhibitors: lastFrame.redTeam?.inhibitors ?? 0, barons: lastFrame.redTeam?.barons ?? 0, dragons: lastFrame.redTeam?.dragons ?? [] },
      totalKills,
      goldDiff: (lastFrame.blueTeam?.totalGold ?? 0) - (lastFrame.redTeam?.totalGold ?? 0),
    },
    players: { blue: bluePlayers, red: redPlayers },
    badge,
    betContext,
    ddragonVersion: ddragon.version,
  };
}

// ---------- HTML/CSS/JS (inline, sem framework) ----------

const PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LoL Live Viewer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0e0f13; color: #e6e6e6; }
  #app { display: flex; height: 100vh; }
  #sidebar { width: 300px; flex-shrink: 0; background: #14161c; border-right: 1px solid #262a33; overflow-y: auto; }
  #sidebar h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8a8f9c; padding: 14px 14px 6px; margin: 0; }
  .game-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #1c1f27; font-size: 13px; }
  .game-item:hover { background: #1a1d25; }
  .game-item.selected { background: #202535; border-left: 3px solid #4f7cff; }
  .game-item .teams { font-weight: 600; }
  .game-item .meta { color: #8a8f9c; font-size: 11px; margin-top: 2px; }
  .state-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .state-inProgress { background: #e5484d; box-shadow: 0 0 6px #e5484d; }
  .state-unstarted { background: #5a5f6b; }
  .state-completed { background: #3a3f4b; }
  #main { flex: 1; overflow-y: auto; padding: 18px 24px; }
  #topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  #topbar .status { font-size: 12px; color: #8a8f9c; }
  #topbar button { background: #202535; color: #e6e6e6; border: 1px solid #333850; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  #scoreboard { background: #14161c; border: 1px solid #262a33; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  #scoreboard .teams-row { display: flex; align-items: center; justify-content: space-between; }
  #scoreboard .team { flex: 1; text-align: center; }
  #scoreboard .team.blue { color: #6fb1ff; }
  #scoreboard .team.red { color: #ff8080; }
  #scoreboard .team-name { font-size: 20px; font-weight: 700; }
  #scoreboard .kills-big { font-size: 56px; font-weight: 800; line-height: 1; margin: 6px 0; }
  #scoreboard .vs { color: #5a5f6b; font-size: 14px; padding: 0 14px; }
  #stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 10px; margin-top: 16px; font-size: 13px; }
  #stats-grid .stat { background: #1a1d25; border-radius: 8px; padding: 8px 10px; }
  #stats-grid .stat .label { color: #8a8f9c; font-size: 11px; }
  #stats-grid .stat .value { font-size: 16px; font-weight: 700; margin-top: 2px; }
  #map-select { margin-left: 10px; background: #1a1d25; color: #e6e6e6; border: 1px solid #333850; border-radius: 6px; padding: 4px 8px; }
  #bet-bar { background: #191307; border: 1px solid #4a3a10; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
  #bet-bar .badge { padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 12px; }
  .badge-2u { background: #1f4d2b; color: #6fe08a; }
  .badge-1u { background: #24344d; color: #7fb0ff; }
  .badge-skip { background: #4d1f1f; color: #ff8f8f; }
  .badge-over { background: #4d3a1f; color: #ffc46f; }
  #players { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .side-col h3 { font-size: 13px; text-transform: uppercase; color: #8a8f9c; }
  .player-row { display: flex; align-items: center; gap: 10px; background: #14161c; border: 1px solid #262a33; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .champ-icon { width: 40px; height: 40px; border-radius: 6px; background: #1a1d25; }
  .player-info { flex: 1; min-width: 0; }
  .player-info .name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .player-info .kda { font-size: 12px; color: #8a8f9c; }
  .items-row { display: flex; gap: 3px; flex-wrap: wrap; max-width: 210px; }
  .item-icon { width: 22px; height: 22px; border-radius: 4px; background: #1a1d25; }
  .empty-state { color: #8a8f9c; text-align: center; padding: 60px 20px; font-size: 14px; }
  a, a:visited { color: #6fb1ff; }
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <h2>Jogos de hoje</h2>
    <div id="game-list"></div>
  </div>
  <div id="main">
    <div id="topbar">
      <div>
        <select id="map-select"></select>
      </div>
      <div class="status">
        <span id="last-update">carregando…</span>
        <button id="pause-btn">Pausar</button>
      </div>
    </div>
    <div id="content"><div class="empty-state">Selecione um jogo na barra lateral.</div></div>
  </div>
</div>
<script>
let selectedMatchId = null;
let selectedMap = null;
let paused = false;
let timer = null;

function stateLabel(s) {
  return s === 'inProgress' ? 'ao vivo' : s === 'unstarted' ? 'não começou' : s === 'completed' ? 'terminado' : s;
}

function renderGameList(games) {
  const el = document.getElementById('game-list');
  el.innerHTML = '';
  games.forEach(g => {
    const div = document.createElement('div');
    div.className = 'game-item' + (g.matchId === selectedMatchId ? ' selected' : '');
    const teamsTxt = g.teams.map(t => t.code || t.name).join(' x ') || '?';
    const time = new Date(g.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<span class="state-dot state-' + g.state + '"></span><span class="teams">' + teamsTxt + '</span>' +
      '<div class="meta">' + g.league + ' · ' + time + ' · ' + stateLabel(g.state) + '</div>';
    div.onclick = () => selectMatch(g.matchId);
    el.appendChild(div);
  });
}

function champIcon(championId) {
  return championId ? 'https://ddragon.leagueoflegends.com/cdn/' + (window.__ddv || '16.15.1') + '/img/champion/' + championId + '.png' : '';
}
function itemIcon(id, ver) {
  return 'https://ddragon.leagueoflegends.com/cdn/' + ver + '/img/item/' + id + '.png';
}

function renderPlayers(container, players, ver) {
  container.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const items = p.items.map(it => '<img class="item-icon" src="' + itemIcon(it.id, ver) + '" title="' + it.name + '" onerror="this.style.visibility=\\'hidden\\'">').join('');
    row.innerHTML =
      '<img class="champ-icon" src="' + champIcon(p.championId) + '" onerror="this.style.visibility=\\'hidden\\'" title="' + (p.championId||'?') + '">' +
      '<div class="player-info">' +
        '<div class="name">' + p.player + '</div>' +
        '<div class="kda">' + p.kills + '/' + p.deaths + '/' + p.assists + ' · ' + p.cs + 'cs · ' + p.gold + 'g · lvl' + p.level + '</div>' +
        '<div class="items-row">' + (items || '<span style="color:#5a5f6b;font-size:11px">sem itens</span>') + '</div>' +
      '</div>';
    container.appendChild(row);
  });
}

function renderContent(data) {
  const content = document.getElementById('content');

  const mapSelect = document.getElementById('map-select');
  mapSelect.innerHTML = '';
  (data.games || []).forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.number;
    opt.textContent = 'Mapa ' + g.number + ' (' + stateLabel(g.state) + ')';
    if (g.number === data.selectedMap) opt.selected = true;
    mapSelect.appendChild(opt);
  });

  if (data.status !== 'ok') {
    content.innerHTML = '<div class="empty-state">' + (data.message || 'sem dados') + '</div>';
    return;
  }
  window.__ddv = data.ddragonVersion;

  const s = data.score;
  const bet = data.betContext;
  let betHtml = '';
  if (bet) {
    const estourou = bet.killsRemaining < 0;
    betHtml = '<div id="bet-bar">' +
      '<span class="badge ' + data.badge.cls + '">' + data.badge.label + '</span>' +
      '<span>kills atuais <b>' + s.totalKills + '</b></span>' +
      '<span>fair <b>' + bet.fairLine + '</b> (' + bet.fairSource + ')' + (bet.fairNote ? ' — ' + bet.fairNote : '') + '</span>' +
      '<span>Under ' + bet.underLine + ' precisa de <b>≤' + bet.maxAllowed + '</b></span>' +
      '<span>' + (estourou ? '<b style="color:#ff8f8f">já estourou (+' + (-bet.killsRemaining) + ')</b>' : 'faltam <b>' + bet.killsRemaining + '</b> kills pra estourar') + '</span>' +
      '</div>';
  } else {
    betHtml = '<div id="bet-bar"><span class="badge ' + data.badge.cls + '">' + data.badge.label + '</span><span style="color:#8a8f9c">sem fair line pra este match hoje</span></div>';
  }

  const dragonsTxt = (arr) => arr && arr.length ? arr.join(', ') : '—';

  content.innerHTML =
    '<div id="scoreboard">' +
      '<div class="teams-row">' +
        '<div class="team blue"><div class="team-name">' + (s.blue.name || s.blue.code) + '</div><div class="kills-big">' + s.blue.kills + '</div></div>' +
        '<div class="vs">' + s.totalKills + ' kills totais<br>' + data.gameState + '</div>' +
        '<div class="team red"><div class="team-name">' + (s.red.name || s.red.code) + '</div><div class="kills-big">' + s.red.kills + '</div></div>' +
      '</div>' +
      '<div id="stats-grid">' +
        '<div class="stat"><div class="label">Ouro azul</div><div class="value">' + s.blue.gold.toLocaleString('pt-BR') + '</div></div>' +
        '<div class="stat"><div class="label">Ouro vermelho</div><div class="value">' + s.red.gold.toLocaleString('pt-BR') + '</div></div>' +
        '<div class="stat"><div class="label">Diferença de ouro</div><div class="value">' + (s.goldDiff>=0?'+':'') + s.goldDiff.toLocaleString('pt-BR') + '</div></div>' +
        '<div class="stat"><div class="label">Torres (azul/verm.)</div><div class="value">' + s.blue.towers + ' / ' + s.red.towers + '</div></div>' +
        '<div class="stat"><div class="label">Inibidores</div><div class="value">' + s.blue.inhibitors + ' / ' + s.red.inhibitors + '</div></div>' +
        '<div class="stat"><div class="label">Barões</div><div class="value">' + s.blue.barons + ' / ' + s.red.barons + '</div></div>' +
        '<div class="stat"><div class="label">Dragões azul</div><div class="value" style="font-size:12px">' + dragonsTxt(s.blue.dragons) + '</div></div>' +
        '<div class="stat"><div class="label">Dragões verm.</div><div class="value" style="font-size:12px">' + dragonsTxt(s.red.dragons) + '</div></div>' +
        '<div class="stat"><div class="label">Tempo observado*</div><div class="value">' + (data.observedSinceMs != null ? Math.floor(data.observedSinceMs/60000) + 'min' : '—') + '</div></div>' +
      '</div>' +
    '</div>' +
    betHtml +
    '<div id="players">' +
      '<div class="side-col"><h3>' + (s.blue.name || 'Azul') + '</h3><div id="blue-players"></div></div>' +
      '<div class="side-col"><h3>' + (s.red.name || 'Vermelho') + '</h3><div id="red-players"></div></div>' +
    '</div>' +
    '<p style="color:#5a5f6b;font-size:11px;margin-top:16px">*tempo observado = desde que este servidor detectou o jogo em andamento, não o tempo de jogo real (API não fornece gameTime).</p>';

  renderPlayers(document.getElementById('blue-players'), data.players.blue, data.ddragonVersion);
  renderPlayers(document.getElementById('red-players'), data.players.red, data.ddragonVersion);
}

async function fetchState() {
  const qs = selectedMatchId ? ('?matchId=' + selectedMatchId + (selectedMap ? '&map=' + selectedMap : '')) : '';
  const res = await fetch('/api/state' + qs);
  const data = await res.json();
  renderGameList(data.games || []);
  if (data.detail) renderContent(data.detail);
  document.getElementById('last-update').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
}

function selectMatch(matchId) {
  selectedMatchId = matchId;
  selectedMap = null;
  fetchState();
}

document.getElementById('map-select').addEventListener('change', (e) => {
  selectedMap = e.target.value;
  fetchState();
});

document.getElementById('pause-btn').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('pause-btn').textContent = paused ? 'Retomar' : 'Pausar';
  if (paused) clearInterval(timer); else timer = setInterval(fetchState, 20000);
});

(async function init() {
  const res = await fetch('/api/state');
  const data = await res.json();
  renderGameList(data.games || []);
  const live = (data.games || []).find(g => g.state === 'inProgress');
  if (live) selectMatch(live.matchId);
  else fetchState();
  timer = setInterval(fetchState, 20000);
})();
</script>
</body>
</html>`;

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/api/state') {
    try {
      const matchId = url.searchParams.get('matchId');
      const mapArg = url.searchParams.get('map');
      const games = await getTodaySchedule();
      const out = { games };
      if (matchId) out.detail = await buildLiveState(matchId, mapArg);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ games: [], detail: { status: 'error', message: String(e.message || e) } }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`LoL live viewer em http://localhost:${PORT}`);
});
