// Briefing diário — lista todos os jogos do dia (LCK/LPL/LEC/CBLOL/LFL/LCS
// + EWC qualifiers Korea/EMEA/China via Liquipedia) com fair line, flags de
// times ruins e ligas ruins. Pra agente apresentar como "primeira resposta de bet".
//
// Uso:
//   node daily_briefing.cjs                → jogos de hoje (UTC)
//   node daily_briefing.cjs YYYY-MM-DD     → data específica
//
// Output: tabela markdown no stdout, pronta pra colar no chat.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..', '..');
const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

// Ligas operadas pelo Elvis (decisão 2026-05-10): LCK, LPL, LEC, CBLOL, LFL, LCS.
// LIT e LES removidas do briefing — Elvis não opera essas.
const LEAGUE_IDS = {
  LCK:   '98767991310872058',
  LPL:   '98767991314006698',
  LEC:   '98767991302996019',
  CBLOL: '98767991332355509',
  LFL:   '105266103462388553',
  LCS:   '98767991299243165',
};

// Dias úteis em ms (offset BRT = UTC -3)
function ymd(d) { return d.toISOString().slice(0,10); }

const argv = process.argv.slice(2);
const TARGET = argv[0] && /^\d{4}-\d{2}-\d{2}$/.test(argv[0]) ? argv[0] : ymd(new Date());

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    https.get({
      host, path: urlPath,
      headers: { 'x-api-key': LOLES, 'User-Agent': 'Mozilla/5.0', Origin: 'https://lolesports.com', Referer: 'https://lolesports.com/' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
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

// Liquipedia API requer gzip + User-Agent identificável (api-terms-of-use)
function fetchLiquipediaJson(urlPath) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'liquipedia.net', path: urlPath,
      headers: {
        'User-Agent': 'apostas-lol-data-briefing/1.0 (contact: elvisbenites1303@gmail.com)',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
          if (err) return reject(err);
          try { resolve(JSON.parse(decoded.toString())); } catch (e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

// EWC 2026 qualifiers — páginas Liquipedia + mapping team_code → nome canônico
// (canônico = nome usado pelo lolesports/teamsMap, pra bater com team_avg_kills.json)
const EWC_QUALIFIERS = [
  { key: 'EWC-LCK', page: 'Esports_World_Cup/2026/Korea', league_proxy: 'LCK', tz_abbr: 'KST', tz_offset_h: 9 },
  { key: 'EWC-LEC', page: 'Esports_World_Cup/2026/EMEA',  league_proxy: 'LEC', tz_abbr: 'CEST', tz_offset_h: 2 },
  { key: 'EWC-LPL', page: 'Esports_World_Cup/2026/China', league_proxy: 'LPL', tz_abbr: 'CST', tz_offset_h: 8 },
];

// Mapping team_code (Liquipedia) → nome canônico (lolesports). Se faltar,
// fallback é uppercase do code. Cobre os principais times dos 3 qualifiers.
const TEAM_CODE_TO_CANONICAL = {
  // LCK
  t1: 'T1', hle: 'Hanwha Life Esports', kt: 'kt Rolster', dk: 'Dplus KIA',
  ns: 'Nongshim RedForce', bro: 'BRION', bfx: 'BNK FEARX', drx: 'DRX',
  soop: 'DN SOOPers', dns: 'DN SOOPers',
  // LEC
  g2: 'G2 Esports', kc: 'Karmine Corp', mkoi: 'Movistar KOI', gx: 'GIANTX',
  nvc: 'Natus Vincere', vit: 'Team Vitality', th: 'Team Heretics',
  fnc: 'Fnatic', shf: 'Shifters', sk: 'SK Gaming',
  sly: 'Solary', gln: 'Galions',
  // LPL
  blg: 'Bilibili Gaming', jdg: 'Beijing JDG Esports', wbg: 'WeiboGaming',
  al: "Anyone's Legend", ig: 'Invictus Gaming', tes: 'TOP ESPORTS',
  nip: 'Shenzhen NINJAS IN PYJAMAS', we: "Xi'an Team WE", omg: 'Oh My God',
  lng: 'LNG Esports', edg: 'EDward Gaming', ttg: 'ThunderTalk Gaming',
  lgd: 'LGD GAMING', up: 'Ultra Prime',
};

// Resolve team code → nome canônico (pra lookup em team_avg_kills.json)
function canonicalTeamName(code) {
  const c = (code || '').toLowerCase().trim();
  if (TEAM_CODE_TO_CANONICAL[c]) return TEAM_CODE_TO_CANONICAL[c];
  return c.toUpperCase(); // fallback
}

function loadTeamAvgKills() {
  const f = path.join(REPO, 'cron-data', 'team_avg_kills.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// Calcula fair line pro EWC: avg(team_a) + avg(team_b) − 1, round pra .5.
// Fallback hierárquico: avg do time → avg da liga proxy (LCK/LEC/LPL) → 29.5.
function fairForEwcMatch(teamA, teamB, leagueProxy, teamAvgData) {
  if (!teamAvgData) return { line: 29.5, source: 'fallback_no_data' };
  const t = teamAvgData.teams || {};
  const lAvg = teamAvgData.league_avg?.[leagueProxy] ?? null;
  const a = t[teamA]?.avg_kills ?? lAvg;
  const b = t[teamB]?.avg_kills ?? lAvg;
  if (a == null || b == null) return { line: 29.5, source: 'fallback_29.5' };
  const adjusted = a + b + (teamAvgData.fair_adjustment ?? -1);
  const line = Math.round(adjusted - 0.5) + 0.5;
  const usedLgFor = [];
  if (t[teamA]?.avg_kills == null) usedLgFor.push('A');
  if (t[teamB]?.avg_kills == null) usedLgFor.push('B');
  return {
    line, source: usedLgFor.length ? `team_avg(${usedLgFor.join('+')}=lg)-1` : 'team_avg(team+team)-1',
    avgA: a, avgB: b,
  };
}

// Parser de Match templates da Liquipedia. Extrai opponent codes + datetime.
// Retorna array de { team_a_code, team_b_code, date_utc, date_local_str, finished }.
function parseLiquipediaMatches(wikitext) {
  const matchBlocks = wikitext.match(/\{\{Match\b[\s\S]*?\n\}\}/g) || [];
  const out = [];
  for (const block of matchBlocks) {
    // skip blocks marcados finished=skip / finished=true (já jogados)
    const opp1 = block.match(/\|\s*opponent1\s*=\s*\{\{TeamOpponent\|([^|}\s]+)/i);
    const opp2 = block.match(/\|\s*opponent2\s*=\s*\{\{TeamOpponent\|([^|}\s]+)/i);
    const dateLine = block.match(/\|\s*date\s*=\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2})\s*\{\{Abbr\/([A-Z]+)\}\}/i);
    if (!opp1 || !opp2 || !dateLine) continue;
    // Detecta se o match já foi jogado: presença de map1...mapN com winner=N
    // (matches futuros geralmente não têm map definido ainda)
    const hasMapResult = /\|\s*map\d+\s*=\s*\{\{Map[\s\S]*?winner=\d/.test(block);
    out.push({
      team_a_code: opp1[1],
      team_b_code: opp2[1],
      date_local_str: dateLine[1],   // ex "2026-05-04 16:00"
      tz_abbr: dateLine[2],
      finished: hasMapResult,
    });
  }
  return out;
}

// Converte "YYYY-MM-DD HH:MM" + tz_offset_h → epoch UTC
function localToUtcEpoch(localStr, tzOffsetH) {
  const m = localStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  // Date.UTC dá epoch UTC tratando os args como UTC
  const localAsUtc = Date.UTC(Y, Mo - 1, D, H, Mi);
  return localAsUtc - tzOffsetH * 3600 * 1000;
}

async function fetchEwcQualifierMatches(qualifier, targetDateUtc, teamAvgData) {
  const urlPath = `/leagueoflegends/api.php?action=parse&page=${encodeURIComponent(qualifier.page)}&format=json&prop=wikitext`;
  let r;
  try { r = await fetchLiquipediaJson(urlPath); }
  catch (e) { console.error(`# ${qualifier.key} liquipedia falhou: ${e.message}`); return []; }
  const wt = r.parse?.wikitext?.['*'] || '';
  const parsed = parseLiquipediaMatches(wt);
  const out = [];
  for (const p of parsed) {
    const utcMs = localToUtcEpoch(p.date_local_str, qualifier.tz_offset_h);
    if (utcMs == null) continue;
    const startTime = new Date(utcMs).toISOString();
    if (startTime.slice(0, 10) !== targetDateUtc) continue;
    const teamAName = canonicalTeamName(p.team_a_code);
    const teamBName = canonicalTeamName(p.team_b_code);
    const fair = fairForEwcMatch(teamAName, teamBName, qualifier.league_proxy, teamAvgData);
    out.push({
      league: qualifier.key,
      match_id: `liquipedia:${qualifier.page}:${p.date_local_str}:${p.team_a_code}vs${p.team_b_code}`,
      start_time: startTime,
      state: p.finished ? 'completed' : 'unstarted',
      team_a: p.team_a_code.toUpperCase(),
      team_b: p.team_b_code.toUpperCase(),
      team_a_name: teamAName,
      team_b_name: teamBName,
      ewc_fair: fair, // { line, source, avgA, avgB }
    });
  }
  return out;
}

// Carrega dados auxiliares (dashboard_stats + polymarket-lines + tier2_eu)
function loadDashboardStats() {
  const f = path.join(REPO, 'cron-data', 'dashboard_stats.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function loadTier2Stats() {
  const f = path.join(REPO, 'cron-data', 'tier2_eu_split2_analysis.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function loadPolymarketLines() {
  const dir = path.join(REPO, 'cron-data');
  const out = new Map(); // match_id_lolesports → entry
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('-polymarket-lines.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const cap of (j.captured || [])) {
      if (cap.match_id_lolesports && cap.games?.length > 0) {
        out.set(String(cap.match_id_lolesports), cap);
      }
    }
  }
  return out;
}

function buildTeamHitMap(dashboard) {
  // teamName → hit% (do backtest 2peel agregado)
  const m = new Map();
  if (!dashboard?.by_trigger?.['2peel']?.teams) return m;
  for (const t of dashboard.by_trigger['2peel'].teams) m.set(t.name.toLowerCase(), { hit: t.hit, n: t.n, lg: t.lg });
  return m;
}
function buildLeagueHitMap(dashboard, tier2) {
  const m = new Map();
  if (dashboard?.by_trigger?.['2peel']?.ligas) {
    for (const l of dashboard.by_trigger['2peel'].ligas) m.set(l.name, { hit: l.hit, n: l.n });
  }
  if (tier2?.by_league) {
    for (const [lg, s] of Object.entries(tier2.by_league)) {
      m.set(lg, { hit: s.method_total.hit, n: s.method_total.n });
    }
  }
  return m;
}

function flagTeam(name, teamHitMap) {
  const e = teamHitMap.get((name || '').toLowerCase());
  if (!e || e.n < 4) return null;
  if (e.hit < 50) return `🔴 ${name} ruim (${e.hit}% n=${e.n})`;
  if (e.hit < 60) return `🟡 ${name} marginal (${e.hit}% n=${e.n})`;
  if (e.hit >= 70) return `🟢 ${name} bom (${e.hit}% n=${e.n})`;
  return null;
}

function flagLeague(lg, leagueHitMap) {
  const e = leagueHitMap.get(lg);
  if (!e) return null;
  if (e.hit < 50) return `🔴 ${lg} liga ruim (${e.hit}% n=${e.n})`;
  if (e.hit < 60) return `🟡 ${lg} liga marginal (${e.hit}% n=${e.n})`;
  if (e.hit >= 70) return `🟢 ${lg} liga forte (${e.hit}% n=${e.n})`;
  return null;
}

(async () => {
  const dashboard = loadDashboardStats();
  const tier2 = loadTier2Stats();
  const pmLines = loadPolymarketLines();
  const teamAvgData = loadTeamAvgKills();
  const teamHits = buildTeamHitMap(dashboard);
  const leagueHits = buildLeagueHitMap(dashboard, tier2);

  const allMatches = [];
  for (const [lg, id] of Object.entries(LEAGUE_IDS)) {
    let r;
    try { r = await fetchJson('esports-api.lolesports.com', `/persisted/gw/getSchedule?hl=en-US&leagueId=${id}`); }
    catch (e) { console.error(`# ${lg} schedule falhou: ${e.message}`); continue; }
    const events = r?.data?.schedule?.events || [];
    for (const ev of events) {
      if (!ev.match?.id || !ev.startTime) continue;
      if (ev.startTime.slice(0,10) !== TARGET) continue;
      allMatches.push({
        league: lg,
        match_id: ev.match.id,
        start_time: ev.startTime,
        state: ev.state,
        team_a: ev.match.teams[0]?.code || ev.match.teams[0]?.name,
        team_b: ev.match.teams[1]?.code || ev.match.teams[1]?.name,
        team_a_name: ev.match.teams[0]?.name,
        team_b_name: ev.match.teams[1]?.name,
      });
    }
  }

  // EWC qualifiers (Korea/EMEA/China) via Liquipedia. Fair line calculada
  // reusando team_avg_kills.json (mesmos times do regular).
  for (const q of EWC_QUALIFIERS) {
    const ewcMatches = await fetchEwcQualifierMatches(q, TARGET, teamAvgData);
    for (const m of ewcMatches) allMatches.push(m);
  }

  allMatches.sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Header
  console.log(`# Jogos de ${TARGET} — briefing método 2peel\n`);
  if (allMatches.length === 0) {
    console.log('Sem jogos das ligas operadas (LCK/LPL/LEC/CBLOL/LFL/LCS) hoje.');
    return;
  }

  // Tabela principal
  console.log('| Liga | Hora BRT | Jogo | Fair line | Flags |');
  console.log('|---|---|---|---|---|');
  for (const m of allMatches) {
    const dt = new Date(m.start_time);
    const brt = new Date(dt.getTime() - 3*3600*1000);
    const hh = String(brt.getUTCHours()).padStart(2,'0');
    const mm = String(brt.getUTCMinutes()).padStart(2,'0');
    const horaBrt = `${hh}:${mm}`;
    const jogo = `${m.team_a} vs ${m.team_b}`;
    const lg = m.league;

    // Fair line: EWC já vem com fair calculada; outros: Polymarket → cron
    let fairStr = '—';
    if (m.ewc_fair) {
      const f = m.ewc_fair;
      const tag = f.source.startsWith('fallback') ? '(fallback)' : '(team_avg-1)';
      fairStr = `**${f.line}** ${tag}`;
    } else {
      const pm = pmLines.get(String(m.match_id));
      if (pm && pm.games?.length > 0) {
        const g1 = pm.games.find(g => g.game_number === 1) || pm.games[0];
        fairStr = `**${g1.line}** (PM @${g1.under_odd?.toFixed(2) || '?'})`;
      } else {
        fairStr = '_calc após cron_';
      }
    }

    const flags = [];
    // EWC: marca como Bo5 e usa LCK/LEC/LPL como liga proxy pros stats
    const isEwc = lg.startsWith('EWC-');
    if (isEwc) flags.push('Bo5 EWC qualifier');
    const lgForStats = isEwc ? lg.split('-')[1] : lg;
    const lgFlag = flagLeague(lgForStats, leagueHits);
    if (lgFlag) flags.push(lgFlag);
    const t1Flag = flagTeam(m.team_a_name, teamHits);
    if (t1Flag) flags.push(t1Flag);
    const t2Flag = flagTeam(m.team_b_name, teamHits);
    if (t2Flag) flags.push(t2Flag);
    if (m.state !== 'unstarted') flags.push(`(${m.state})`);

    console.log(`| ${lg} | ${horaBrt} | ${jogo} | ${fairStr} | ${flags.join(' · ') || '—'} |`);
  }

  // Análise resumida
  console.log(`\n**${allMatches.length} jogos no total.** Ligas: ${[...new Set(allMatches.map(m => m.league))].join(', ')}.`);

  // Quick stats das ligas do dia
  const ligasDoDia = [...new Set(allMatches.map(m => m.league))];
  const hint = ligasDoDia
    .map(lg => leagueHits.get(lg))
    .filter(Boolean);
  if (hint.length > 0) {
    console.log('\nPerformance histórica método nas ligas do dia (Split 2):');
    for (const lg of ligasDoDia) {
      const e = leagueHits.get(lg);
      if (e) console.log(`- **${lg}**: ${e.hit}% hit (n=${e.n})`);
    }
  }
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
