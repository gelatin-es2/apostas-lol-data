#!/usr/bin/env node
'use strict';

// Fase 1.2 do plano (knowledge/plans/2026-08-23-plano-execucao.md): disparo EXTRA da
// captura de fair Pinnacle, ANCORADO no calendário do dia (~30min e ~10min antes de
// cada jogo), pra reduzir a defasagem medida de mediana 30min / média 117min entre a
// fair usada e o apito (knowledge/reports/2026-08-23-teste-defasagem-odd-guest-pinnacle.md,
// seção 7). A task `LolFairAutoCapture` (grade cega de 30min) CONTINUA LIGADA — isso
// aqui é ADICIONAL, não substitui.
//
// O que este script faz, a cada execução (idempotente):
//   1. Lê a agenda oficial (lolesports API, via LEAGUE_IDS de lolesports-find-match.cjs
//      — mesma fonte que o resto do projeto usa) pras próximas ANCHOR_LOOKAHEAD_HOURS.
//   2. Pra cada jogo 'unstarted' com anchors (start-30min / start-10min) ainda no
//      futuro, registra 1 Windows Scheduled Task com esses 2 disparos únicos, rodando
//      EXATAMENTE o mesmo comando que a LolFairAutoCapture já roda hoje
//      (run-capture-pinnacle-auto.cmd → capture_pinnacle_kills_auto.cjs +
//      promote_fair_pinnacle_auto.cjs) — não é uma captura nova, é a MESMA captura,
//      só disparada mais perto do apito.
//   3. Limpa tasks de jogos cujo anchor mais tardio (m10) já passou há mais de
//      STALE_HOURS — mantém o Task Scheduler enxuto.
//
// Este script PRECISA rodar periodicamente (task `LolFairAnchorScheduler`, ver
// install-fair-anchor-scheduler.cmd) pra descobrir jogos novos/reagendados — ele NÃO
// aumenta volume de request da Pinnacle (só chama a lolesports API, que o projeto já
// bate pesado em outros lugares), e cada anchor dispara a MESMA captura de sempre (1
// rodada de baseline), não uma cadência nova.
//
// Uso:
//   node schedule-fair-anchor-capture.cjs                 → agenda pro dia + próx 20h
//   node schedule-fair-anchor-capture.cjs --dry-run        → só mostra o que faria
//   node schedule-fair-anchor-capture.cjs --cleanup-only   → só remove tasks (desliga)
//
// COMO DESLIGAR (reversível):
//   1. Desabilitar/deletar a task `LolFairAnchorScheduler` (para de criar novas).
//   2. node schedule-fair-anchor-capture.cjs --cleanup-only  (remove as já criadas).
//   A `LolFairAutoCapture` (grade de 30min) nunca é tocada por isso.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(REPO, 'cron-data', 'fair-anchor');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const RUN_CMD = path.join(__dirname, 'run-capture-pinnacle-auto.cmd');
const RUN_HIDDEN_VBS = path.join(__dirname, 'run-hidden.vbs');
const TASK_PREFIX = 'LolFairAnchor-';

const ANCHOR_OFFSETS_MIN = [30, 10]; // minutos antes do início — pedido do plano
const ANCHOR_LOOKAHEAD_HOURS = 20;   // até onde olhamos a agenda por rodada
const MIN_LEAD_MIN = 2;              // não agenda anchor a menos de 2min de distância
const STALE_HOURS = 4;               // limpa tasks cujo anchor mais tardio já passou há isso

const { LEAGUE_IDS } = require('./lolesports-find-match.cjs');
const LOLES_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const DRY_RUN = !!args['dry-run'];
const CLEANUP_ONLY = !!args['cleanup-only'];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'x-api-key': LOLES_KEY, 'User-Agent': 'Mozilla/5.0', Origin: 'https://lolesports.com', Referer: 'https://lolesports.com/' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// UTF-16LE com BOM — schtasks /create /xml exige esse encoding (testado manualmente
// em 23/08: UTF-8 puro dá "XML mal construído").
function writeUtf16(filePath, str) {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, 'utf16le')]);
  fs.writeFileSync(filePath, buf);
}

function buildTaskXml(taskName, triggersIso) {
  const triggers = triggersIso.map((iso) =>
    `    <TimeTrigger>\n      <StartBoundary>${iso}</StartBoundary>\n    </TimeTrigger>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\\${taskName}</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Triggers>
${triggers}
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${RUN_HIDDEN_VBS}" "${RUN_CMD}"</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

function schtasks(argsArr) {
  return execFileSync('schtasks.exe', argsArr, { encoding: 'utf8' });
}

function createAnchorTask(matchId, triggersIso, tmpDir) {
  const taskName = `${TASK_PREFIX}${matchId}`;
  const xmlPath = path.join(tmpDir, `${matchId}.xml`);
  writeUtf16(xmlPath, buildTaskXml(taskName, triggersIso));
  schtasks(['/create', '/xml', xmlPath, '/tn', taskName, '/f']);
  return taskName;
}

function deleteTask(taskName) {
  try {
    schtasks(['/delete', '/tn', taskName, '/f']);
    return true;
  } catch (err) {
    return false; // já não existe ou falhou — não trava o resto da rodada
  }
}

async function fetchUpcomingEvents(nowMs, lookaheadMs) {
  const events = [];
  for (const [leagueShort, leagueId] of Object.entries(LEAGUE_IDS)) {
    try {
      const r = await fetchJson(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${leagueId}`);
      const evs = r?.data?.schedule?.events || [];
      for (const ev of evs) {
        if (ev.state !== 'unstarted' || !ev.startTime) continue;
        const startMs = new Date(ev.startTime).getTime();
        if (!Number.isFinite(startMs)) continue;
        if (startMs <= nowMs || startMs > nowMs + lookaheadMs) continue;
        events.push({
          matchId: ev.match?.id || ev.id,
          league: leagueShort,
          startMs,
          teams: (ev.match?.teams || []).map((t) => t.code || t.name).join(' vs '),
        });
      }
    } catch (err) {
      console.error(`[fair-anchor] getSchedule falhou pra ${leagueShort}: ${err.message}`);
    }
  }
  return events;
}

async function main() {
  const nowMs = Date.now();
  const state = loadState();

  if (CLEANUP_ONLY) {
    console.log(`[fair-anchor] --cleanup-only: removendo TODAS as tasks ${TASK_PREFIX}*`);
    let removed = 0;
    for (const matchId of Object.keys(state)) {
      const taskName = `${TASK_PREFIX}${matchId}`;
      if (DRY_RUN) { console.log(`  [dry-run] removeria ${taskName}`); continue; }
      if (deleteTask(taskName)) removed++;
    }
    if (!DRY_RUN) { saveState({}); console.log(`[fair-anchor] ${removed} task(s) removida(s). Estado limpo.`); }
    return;
  }

  const events = await fetchUpcomingEvents(nowMs, ANCHOR_LOOKAHEAD_HOURS * 3600 * 1000);
  console.log(`[fair-anchor] ${events.length} jogo(s) 'unstarted' nas próximas ${ANCHOR_LOOKAHEAD_HOURS}h.`);

  const tmpDir = path.join(STATE_DIR, 'tmp-xml');
  fs.mkdirSync(tmpDir, { recursive: true });

  let created = 0, skipped = 0;
  const newState = { ...state };

  for (const ev of events) {
    const anchorsMs = ANCHOR_OFFSETS_MIN
      .map((min) => ev.startMs - min * 60000)
      .filter((atMs) => atMs > nowMs + MIN_LEAD_MIN * 60000);
    if (anchorsMs.length === 0) { skipped++; continue; } // ambos os anchors já passaram

    const triggersIso = anchorsMs.map((ms) => new Date(ms).toISOString());
    const key = String(ev.matchId);

    if (DRY_RUN) {
      console.log(`  [dry-run] agendaria ${TASK_PREFIX}${key} (${ev.league} ${ev.teams}): ${triggersIso.join(', ')}`);
      created++;
      continue;
    }

    try {
      const taskName = createAnchorTask(key, triggersIso, tmpDir);
      newState[key] = { league: ev.league, teams: ev.teams, startMs: ev.startMs, anchorsMs, taskName, updatedAt: nowMs };
      created++;
      console.log(`  criado/atualizado ${taskName} (${ev.league} ${ev.teams}): ${triggersIso.join(', ')}`);
    } catch (err) {
      console.error(`  [fair-anchor] falhou criar task pro match ${key}: ${err.message}`);
    }
  }

  // Cleanup: remove do Task Scheduler + do estado qualquer entrada cujo anchor mais
  // tardio já passou há mais de STALE_HOURS.
  let cleaned = 0;
  for (const [matchId, entry] of Object.entries(newState)) {
    const lastAnchorMs = Math.max(...(entry.anchorsMs || [0]));
    if (nowMs - lastAnchorMs > STALE_HOURS * 3600 * 1000) {
      if (!DRY_RUN) deleteTask(entry.taskName || `${TASK_PREFIX}${matchId}`);
      delete newState[matchId];
      cleaned++;
    }
  }

  if (!DRY_RUN) {
    saveState(newState);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(`[fair-anchor] resultado: ${created} agendada(s)/atualizada(s), ${skipped} sem anchor futuro, ${cleaned} removida(s) por estar velha(s).`);
}

main().catch((err) => {
  console.error('[fair-anchor] ERRO FATAL:', err.message || err);
  process.exit(1); // não deve travar o Task Scheduler que chama isso
});
