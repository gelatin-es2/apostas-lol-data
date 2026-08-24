#!/usr/bin/env node
// diag-guest-vs-logged.cjs — carimba a linha de kills que a API GUEST (deslogada)
// está entregando NESTE SEGUNDO, pra comparar com um print da tela LOGADA.
//
// Motivo (2026-08-23): o Elvis suspeita que a Pinnacle atrasa a odd de quem está
// deslogado. O report 2026-08-23-teste-defasagem-odd-guest-pinnacle.md provou que
// o feed guest chega com até 905s de atraso POR CACHE Cloudflare, e não achou
// evidência de gate por login (86 pares cache × origem, 0 divergências) — mas
// "não achei evidência" != "provei que não existe". Este script fecha a metade
// deslogada do teste; a metade logada é um print da tela dele.
//
// Uso:
//   node .claude/scripts/diag-guest-vs-logged.cjs            # só jogos ao vivo
//   node .claude/scripts/diag-guest-vs-logged.cjs --all      # ao vivo + pré-jogo
//   node .claude/scripts/diag-guest-vs-logged.cjs --watch    # repete a cada 30s
//
// SOMENTE LEITURA: não escreve no banco, não altera nada, mesma API guest que a
// captura de produção já usa (sem login, sem cookie, sem credencial).

const { spawnSync } = require('child_process');
const core = require('./lib/pinnacle_core.cjs');

const ARGS = new Set(process.argv.slice(2));
const SHOW_ALL = ARGS.has('--all');
const WATCH = ARGS.has('--watch');
const WATCH_INTERVAL_MS = 30000;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Lê os headers de cache do endpoint pra mostrar QUANTOS SEGUNDOS de idade tem a
// resposta. É esse número que explica o atraso — não o login.
function cacheHeaders(urlPath) {
  const url = `${core.BASE_URL}${urlPath}`;
  const r = spawnSync('curl.exe', ['-s', '-o', 'NUL', '-D', '-', '--max-time', '15',
    '-H', 'Accept: application/json', '-H', 'Referer: https://www.pinnacle.com/', url],
    { encoding: 'utf8' });
  const h = r.stdout || '';
  const get = (name) => {
    const m = h.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : null;
  };
  return { age: get('Age'), cacheStatus: get('cf-cache-status'), cacheControl: get('Cache-Control') };
}

async function snapshot() {
  const t0 = Date.now();
  const nowIso = new Date(t0).toISOString();

  const listRes = await core.fetchJson('/sports/12/matchups?withSpecials=true');
  if (!listRes.ok) {
    console.error(`ERRO na listagem: ${listRes.error} (HTTP ${listRes.status})`);
    return;
  }

  let matchups = core.filterLolKillsMatchups(listRes.data);
  if (!SHOW_ALL) {
    const live = matchups.filter((m) => core.matchupMeta(m).isLive);
    if (live.length) matchups = live;
    else console.log('(nenhum jogo AO VIVO agora — mostrando pré-jogo; use --all pra ver todos)\n');
  }

  console.log('='.repeat(78));
  console.log(`LINHA GUEST (DESLOGADO) — carimbo local ${stamp()}  |  UTC ${nowIso}`);
  const px = core.proxyInfo();
  console.log(`proxy: ${px.enabled ? `${px.host}:${px.port}` : 'direto (sem proxy)'}`);
  console.log('='.repeat(78));

  if (!matchups.length) {
    console.log('nenhum matchup de kills de LoL na lista agora.');
    return;
  }

  for (const m of matchups) {
    const meta = core.matchupMeta(m);
    const path = `/matchups/${m.id}/markets/related/straight`;
    const marketsRes = await core.fetchJson(path);
    if (!marketsRes.ok) {
      console.log(`  [erro] ${meta.home} vs ${meta.away}: ${marketsRes.error}`);
      await core.sleep(core.MATCHUP_PAUSE_MS);
      continue;
    }

    const mlIds = core.seriesMlMatchupIds(listRes.data, meta.seriesId);
    const killsIds = core.seriesKillsMatchupIds(listRes.data, meta.seriesId, meta.matchupId);
    const byMap = core.parseRelatedMarkets(marketsRes.data, killsIds, mlIds);
    const phase = meta.isLive ? 'live' : 'pre';
    const entries = core.buildTimelineEntries(m, byMap, nowIso, t0, phase, 'diag-guest');
    const cache = cacheHeaders(path);

    console.log('');
    console.log(`${meta.home} vs ${meta.away}  [${meta.league}]  ${meta.isLive ? 'AO VIVO' : 'pré-jogo'}`);
    console.log(`  série ${meta.seriesId} · lido às ${stamp()}`);
    const ageTxt = cache.age === null ? 'n/d' : `${cache.age}s`;
    console.log(`  idade da resposta no cache: ${ageTxt}  (cf-cache-status: ${cache.cacheStatus || 'n/d'}; ${cache.cacheControl || 'sem Cache-Control'})`);

    const withLine = entries.filter((e) => e.main_line !== null && e.main_line !== undefined);
    if (!withLine.length) {
      console.log('  (sem linha de kills publicada agora)');
    } else {
      for (const e of withLine.sort((a, b) => a.map_number - b.map_number)) {
        const mapTxt = e.map_number === 0 ? 'série' : `mapa ${e.map_number}`;
        console.log(`  ${mapTxt.padEnd(8)} linha ${String(e.main_line).padStart(5)}  ` +
          `over ${e.over_dec}  under ${e.under_dec}  (vig ${e.juice_pct}%)  v=${e.market_version}`);
      }
    }
    await core.sleep(core.MATCHUP_PAUSE_MS);
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log('COMO COMPARAR: tire AGORA um print da tela logada no mesmo mercado,');
  console.log('com o relógio do Windows visível. Linha igual = não há gate por login.');
  console.log('Linha diferente = há gate, e aí a conclusão de hoje muda.');
  console.log('-'.repeat(78));
}

(async () => {
  await snapshot();
  if (WATCH) {
    setInterval(() => { snapshot().catch((e) => console.error(e.message)); }, WATCH_INTERVAL_MS);
  }
})().catch((e) => { console.error(e); process.exit(1); });
