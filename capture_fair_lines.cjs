// Captura fair lines pré-jogo das ligas alvo
// Uso: node capture_fair_lines.cjs lck,lpl
//   ou: node capture_fair_lines.cjs lec,cblol
//
// Para cada série agendada hoje, calcula matchup_fair = avg(team_A) + avg(team_B)
// usando histórico Oracle's Elixir (CSV baixado em datasets/).
//
// Output: cron-data/YYYY-MM-DD-fair-pre.json (cumulativo: cada execução mescla)

const fs = require('fs');
const path = require('path');
const https = require('https');

const ORACLE_CSV = process.env.ORACLE_CSV || path.resolve(__dirname, '..', 'year_backtest/datasets/2026_oracle.csv');
const OUT_DIR = path.join(__dirname, 'cron-data');

const LIGAS_ALVO = (process.argv[2] || 'lck,lpl').toLowerCase().split(',');
const TODAY = new Date().toISOString().slice(0, 10);
const MIN_TEAM_MAPS = 10;

// API lolesports unofficial (chave pública conhecida — memória reference_lolesports_api.md)
const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Mapeia liga → leagueId no lolesports
const LEAGUE_IDS = {
  lpl: '98767991314006698',
  lck: '98767991310872058',
  lec: '98767991302996019',
  cblol: '98767991325878492',
  lcs: '98767991299243165',
};

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://lolesports.com',
      'Referer': 'https://lolesports.com/',
      ...headers,
    };
    https.get(url, { headers: browserHeaders }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON err: ${e.message} — ${body.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur); return out;
}

function num(v) { if (v==null||v==='') return null; const n = parseFloat(v); return isNaN(n)?null:n; }

console.error('[1/3] Carregando histórico Oracle pra calcular fair...');
if (!fs.existsSync(ORACLE_CSV)) {
  console.error(`ERRO: CSV não encontrado em ${ORACLE_CSV}`);
  process.exit(1);
}
const lines = fs.readFileSync(ORACLE_CSV, 'utf8').split(/\r?\n/);
const header = parseCSVLine(lines[0]).map(h => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

// Build team profiles (avg kills por mapa, do ano 2026 inteiro)
const teamProfile = new Map();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const c = parseCSVLine(lines[i]);
  if (c.length < header.length - 2) continue;
  if (c[idx.position] !== 'team') continue;
  const team = c[idx.teamname];
  const tk = num(c[idx.teamkills]);
  if (!team || tk == null) continue;
  if (!teamProfile.has(team)) teamProfile.set(team, { kills: [] });
  teamProfile.get(team).kills.push(tk);
}
for (const [, p] of teamProfile) {
  p.n = p.kills.length;
  p.avg = p.kills.reduce((a,b)=>a+b,0) / p.n;
}
console.error(`  ${teamProfile.size} times com perfil de kills`);

// Match flexível: lolesports usa "BRO", oracle usa "HANJIN BRION"
const _norm = s => s ? s.toLowerCase().replace(/\s+/g,'') : '';
function findTeam(name) {
  if (!name) return null;
  if (teamProfile.has(name)) return teamProfile.get(name);
  const target = _norm(name);
  for (const [oracleName, p] of teamProfile) {
    const o = _norm(oracleName);
    if (o.includes(target) || target.includes(o)) return p;
  }
  return null;
}

(async () => {
console.error('[2/3] Buscando schedule no lolesports...');
const fairLines = [];
for (const liga of LIGAS_ALVO) {
  const leagueId = LEAGUE_IDS[liga];
  if (!leagueId) { console.error(`  liga ${liga} sem ID mapeado, pulando`); continue; }
  let schedule;
  try {
    schedule = await fetch(`https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=pt-BR&leagueId=${leagueId}`, {
      'x-api-key': LOLESPORTS_KEY,
    });
  } catch (e) {
    console.error(`  ${liga}: lolesports falhou (${e.message}). Pulando — TODO: fallback liquipedia.`);
    continue;
  }
  const events = schedule?.data?.schedule?.events || [];
  console.error(`  ${liga}: ${events.length} events no schedule`);
  for (const ev of events) {
    if (!ev.startTime) continue;
    const evDate = ev.startTime.slice(0, 10);
    if (evDate !== TODAY) continue;
    if (ev.state === 'completed') continue;
    const teams = ev.match?.teams || [];
    if (teams.length !== 2) continue;
    const t1 = teams[0]?.code || teams[0]?.name;
    const t2 = teams[1]?.code || teams[1]?.name;
    if (!t1 || !t2) continue;

    const p1 = findTeam(t1) || findTeam(teams[0]?.name);
    const p2 = findTeam(t2) || findTeam(teams[1]?.name);
    let avg1 = p1 && p1.n >= MIN_TEAM_MAPS ? p1.avg : null;
    let avg2 = p2 && p2.n >= MIN_TEAM_MAPS ? p2.avg : null;
    const fair = (avg1 != null && avg2 != null) ? Math.round((avg1 + avg2) - 0.5) + 0.5 : null;

    fairLines.push({
      league: liga.toUpperCase(),
      league_id: leagueId,
      event_id: ev.match?.id || ev.id,
      start_time: ev.startTime,
      team_a: t1, team_b: t2,
      team_a_avg: avg1, team_b_avg: avg2,
      fair_per_map: fair,
      fair_team_a_n: p1?.n, fair_team_b_n: p2?.n,
      bo: ev.match?.strategy?.count || null,
    });
  }
}

console.error('[3/3] Salvando JSON...');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${TODAY}-fair-pre.json`);

// Mescla com existente se ja rodou hoje (LCK+LPL de manha + LEC+CBLOL ao meio-dia)
let existing = { date: TODAY, captures: [] };
if (fs.existsSync(outFile)) {
  try { existing = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
}
existing.captures.push({
  captured_at: new Date().toISOString(),
  ligas: LIGAS_ALVO.map(l => l.toUpperCase()),
  fair_lines: fairLines,
});
fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));
console.error(`Wrote: ${outFile}`);
console.error(`Fair lines capturadas: ${fairLines.length}`);
fairLines.forEach(f => console.error(`  ${f.league} ${f.team_a} vs ${f.team_b} → fair=${f.fair_per_map}`));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
