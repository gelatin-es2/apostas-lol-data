// Builds AO VIVO (itens, KDA, gold, nível) de qualquer jogo profissional.
//
// Uso:
//   node scripts/live-items.cjs UoL            → acha o jogo do time hoje nas ligas operadas
//   node scripts/live-items.cjs 116713163972559132   → match_id direto
//   node scripts/live-items.cjs UoL --map=1     → mapa específico (default: o mais recente com dado)
//
// Fontes (ambas públicas, sem auth):
//   feed.lolesports.com/livestats/v1/details/{gameId}  → items[], KDA, gold, runas, habilidades
//     ⚠️ startingTime precisa ter ≥110s de atraso (o /window aceita 90s; o /details NÃO)
//   ddragon.leagueoflegends.com .../item.json          → id do item → nome pt-BR
//     ícone: ddragon.../cdn/<ver>/img/item/<id>.png

'use strict';
const https = require('https');

const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LEAGUES = {
  LCK: '98767991310872058', LPL: '98767991314006698', LEC: '98767991302996019',
  CBLOL: '98767991332355509', LCS: '98767991299243165', LFL: '105266103462388553',
  LES: '105266074488398661', 'Prime League': '105266091639104326',
  LCP: '113476371197627891', KCL: '98767991335774713', EUM: '100695891328981122',
};

const get = (url, headers = {}) => new Promise((res) => {
  https.get(url, { headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); })
    .on('error', () => res(''));
});
// details exige ≥110s de atraso — usamos 180s de margem
const ts = (lagMs = 180000) => {
  const d = new Date(Date.now() - lagMs);
  d.setSeconds(Math.floor(d.getSeconds() / 10) * 10, 0);
  return d.toISOString().replace(/\.\d+Z/, 'Z');
};

async function findMatch(query) {
  if (/^\d{10,}$/.test(query)) return query;
  const today = new Date().toISOString().slice(0, 10);
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [name, id] of Object.entries(LEAGUES)) {
    const raw = await get(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US&leagueId=${id}`, { 'x-api-key': KEY });
    if (!raw.trim()) continue;
    let evs;
    try { evs = JSON.parse(raw).data.schedule.events; } catch { continue; }
    const matches = (t) => {
      const flat = (t.code + t.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (flat.includes(q)) return true;
      // sigla: "Unicorns of Love Sexy Edition" → uolse (pega "uol")
      const acro = t.name.split(/\s+/).map((w) => w[0]).join('').toLowerCase();
      return acro.startsWith(q) || q.startsWith(acro);
    };
    const hit = evs.find((e) => e.startTime.slice(0, 10) === today && e.match.teams.some(matches));
    if (hit) {
      console.log(`# ${name} — ${hit.match.teams.map((t) => t.code).join(' x ')} (${hit.state}, ${hit.startTime})`);
      return hit.match.id;
    }
  }
  return null;
}

(async () => {
  const args = process.argv.slice(2);
  const query = args.find((a) => !a.startsWith('--'));
  const mapArg = (args.find((a) => a.startsWith('--map=')) || '').split('=')[1];
  if (!query) { console.error('uso: node scripts/live-items.cjs <time|match_id> [--map=N]'); process.exit(1); }

  const matchId = await findMatch(query);
  if (!matchId) { console.error(`nenhum jogo de "${query}" hoje nas ligas operadas`); process.exit(1); }

  const ed = JSON.parse(await get(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${matchId}`, { 'x-api-key': KEY }));
  let games = ed.data.event.match.games.filter((g) => g.state !== 'unstarted');
  if (mapArg) games = games.filter((g) => String(g.number) === String(mapArg));
  if (!games.length) { console.error('nenhum mapa com dado ainda'); process.exit(1); }

  const ver = JSON.parse(await get('https://ddragon.leagueoflegends.com/api/versions.json'))[0];
  const items = JSON.parse(await get(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/pt_BR/item.json`)).data;

  for (const g of games.reverse()) {
    const rawD = await get(`https://feed.lolesports.com/livestats/v1/details/${g.id}?startingTime=${ts()}`);
    const rawW = await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}?startingTime=${ts()}`);
    if (!rawD.trim() || !rawW.trim()) continue;
    let d, w;
    try { d = JSON.parse(rawD); w = JSON.parse(rawW); } catch { continue; }
    if (!d.frames || !w.frames) continue;

    const md = w.gameMetadata;
    const wf = w.frames[w.frames.length - 1];
    const f = d.frames[d.frames.length - 1];
    const meta = {};
    [md.blueTeamMetadata, md.redTeamMetadata].forEach((t) =>
      t.participantMetadata.forEach((p) => (meta[p.participantId] = { c: p.championId, n: p.summonerName })));

    console.log(`\n=== mapa ${g.number} · ${wf.gameState} · ${wf.blueTeam.totalKills}-${wf.redTeam.totalKills} kills ===`);
    for (const p of f.participants) {
      const m = meta[p.participantId] || {};
      const its = (p.items || []).map((i) => (items[i] || {}).name || i).join(' · ');
      console.log(`${(m.n || '?').padEnd(18)} ${(m.c || '?').padEnd(12)} ${p.kills}/${p.deaths}/${p.assists}  ${String(p.totalGoldEarned).padStart(6)}g  lvl${p.level}`);
      console.log(`    ${its || '(sem itens)'}`);
    }
    break;
  }
})();
