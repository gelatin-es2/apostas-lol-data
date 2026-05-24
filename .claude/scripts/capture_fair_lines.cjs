// Captura fair lines pré-jogo via fórmula: (avgBlueTotal + avgRedTotal) / 2, round .5.
// Fonte de dados históricos: Oracle's Elixir CSV (ano 2026).
//
// Polymarket removido em 2026-05-23. Fair Pinnacle manual via /log-fair (primária).
// Este script gera a fair via fórmula que coexiste com Pinnacle no banco.
//
// Uso:
//   node .claude/scripts/capture_fair_lines.cjs lck,lpl
//   node .claude/scripts/capture_fair_lines.cjs lec,cblol
//
// Output: cron-data/YYYY-MM-DD-fair-pre.json (cumulativo: cada execução mescla)

const fs = require('fs');
const path = require('path');
const https = require('https');

// ROOT aponta pra raiz do repositório (sobe 2 níveis de .claude/scripts/)
const ROOT = path.resolve(__dirname, '../..');

const ORACLE_CSV = process.env.ORACLE_CSV || path.resolve(ROOT, '..', 'year_backtest/datasets/2026_oracle.csv');
const OUT_DIR = path.join(ROOT, 'cron-data');

const LIGAS_ALVO = (process.argv[2] || 'lck,lpl').toLowerCase().split(',');
const TODAY = new Date().toISOString().slice(0, 10);
const MIN_TEAM_MAPS = 10;

const LOLESPORTS_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const LEAGUE_IDS = {
  lpl: '98767991314006698',
  lck: '98767991310872058',
  lec: '98767991302996019',
  cblol: '98767991332355509',
  lcs: '98767991299243165',
};

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

// Carrega histórico Oracle pra calcular fair via fórmula
console.error('[1/3] Carregando histórico Oracle pra calcular fair...');
if (!fs.existsSync(ORACLE_CSV)) {
  // CSV Oracle opcional — sem ele, fair_formula = null (campo presente mas nulo)
  console.error(`  AVISO: CSV Oracle não encontrado em ${ORACLE_CSV} — fair_formula será null`);
}

let teamProfile = new Map();
if (fs.existsSync(ORACLE_CSV)) {
  const lines = fs.readFileSync(ORACLE_CSV, 'utf8').split(/\r?\n/);
  const header = parseCSVLine(lines[0]).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
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
}

const TEAM_CODE_TO_ORACLE = {
  // LCK
  'T1': 'T1', 'GEN': 'Gen.G eSports', 'KT': 'KT Rolster', 'HLE': 'Hanwha Life Esports',
  'DK': 'Dplus KIA', 'BRO': 'HANJIN BRION', 'NS': 'Nongshim RedForce',
  'DRX': 'Kiwoom DRX', 'DNS': 'DN SOOPers', 'BFX': 'BNK FearX',
  // LPL
  'BLG': 'Bilibili Gaming', 'JDG': 'JD Gaming', 'EDG': 'EDward Gaming', 'IG': 'Invictus Gaming',
  'TES': 'Top Esports', 'WBG': 'Weibo Gaming', 'AL': "Anyone's Legend",
  'TT': 'ThunderTalk Gaming', 'LGD': 'LGD Gaming', 'NIP': 'Ninjas in Pyjamas.CN',
  'OMG': 'Oh My God', 'FPX': 'FunPlus Phoenix', 'RNG': 'Royal Never Give Up',
  'RA': 'Rare Atom', 'LNG': 'LNG Esports', 'UP': 'Ultra Prime', 'WE': 'Team WE',
  // LEC
  'G2': 'G2 Esports', 'FNC': 'Fnatic', 'MAD': 'MAD Lions KOI', 'SK': 'SK Gaming',
  'KOI': 'Movistar KOI', 'BDS': 'Team BDS', 'GX': 'GIANTX', 'TH': 'Team Heretics',
  'KC': 'Karmine Corp', 'RGE': 'Rogue', 'VIT': 'Team Vitality', 'NAVI': 'Natus Vincere',
  'SHFT': 'Shifters',
  // LCS
  'C9': 'Cloud9', 'TL': 'Team Liquid', 'FLY': 'FlyQuest', '100T': '100 Thieves',
  'NRG': 'NRG', 'DIG': 'Disguised', 'SR': 'Shopify Rebellion', 'IMT': 'Immortals',
  'EG': 'Evil Geniuses', 'GG': 'Golden Guardians', 'LYON': 'LYON',
  // CBLOL
  'LOUD': 'LOUD', 'PNG': 'paiN Gaming', 'FUR': 'FURIA', 'RED': 'RED Canids',
  'KBM': 'KaBuM! e-Sports', 'VKS': 'Vivo Keyd Stars', 'INTZ': 'INTZ', 'LLL': 'LOUD',
  'ITZ': 'Isurus Estral', 'FLX': 'Fluxo W7M', 'LEV': 'Leviatan Esports',
};

const _norm = s => s ? s.toLowerCase().replace(/[\s.\-']/g, '') : '';
function findTeam(name) {
  if (!name) return null;
  if (teamProfile.has(name)) return teamProfile.get(name);
  const oracleName = TEAM_CODE_TO_ORACLE[name];
  if (oracleName && teamProfile.has(oracleName)) return teamProfile.get(oracleName);
  const target = _norm(name);
  if (target.length < 2) return null;
  for (const [otherName, p] of teamProfile) {
    const o = _norm(otherName);
    if (o === target || (target.length >= 3 && (o.startsWith(target) || target.startsWith(o)))) return p;
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
      console.error(`  ${liga}: lolesports falhou (${e.message}). Pulando.`);
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
      const avg1 = p1 && p1.n >= MIN_TEAM_MAPS ? p1.avg : null;
      const avg2 = p2 && p2.n >= MIN_TEAM_MAPS ? p2.avg : null;
      // Fórmula canônica: (avgBlueTotal + avgRedTotal) / 2, round .5
      // teamProfile.avg = avg de teamkills por jogo (Oracle: kills próprias por time)
      // fair = avg total kills = avg_a + avg_b → não divide por 2 aqui, cada avg já é per-team
      const fairFormula = (avg1 != null && avg2 != null)
        ? Math.round((avg1 + avg2) - 0.5) + 0.5
        : null;

      fairLines.push({
        league: liga.toUpperCase(),
        league_id: leagueId,
        event_id: ev.match?.id || ev.id,
        start_time: ev.startTime,
        team_a: t1, team_b: t2,
        team_a_avg: avg1, team_b_avg: avg2,
        fair_formula: fairFormula,   // fórmula (blueAvg + redAvg), round .5
        fair_pinnacle: null,         // preenchido via /log-fair (manual Elvis)
        fair_source: fairFormula != null ? 'formula' : 'unavailable',
        fair_team_a_n: p1?.n, fair_team_b_n: p2?.n,
        bo: ev.match?.strategy?.count || null,
      });
    }
  }

  console.error('[3/3] Salvando JSON...');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${TODAY}-fair-pre.json`);

  // Mescla com existente se já rodou hoje (LCK+LPL de manhã + LEC+CBLOL ao meio-dia)
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
  fairLines.forEach(f => console.error(
    `  ${f.league} ${f.team_a} vs ${f.team_b} → fair_formula=${f.fair_formula} (a=${f.team_a_avg ? f.team_a_avg.toFixed(1) : '?'} b=${f.team_b_avg ? f.team_b_avg.toFixed(1) : '?'})`
  ));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
