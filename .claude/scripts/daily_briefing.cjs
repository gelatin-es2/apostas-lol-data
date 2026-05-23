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
const { loadFairPinnacle } = require(path.join(REPO, 'lib', 'loadFairPinnacle.cjs'));

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
function fetchLiquipediaJsonRaw(urlPath) {
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

// Liquipedia rate-limits aggressively (HTTP 429). Retry 3x com 35s backoff
// pra dar chance do cache liberar. Fix 2026-05-20: antes só falhava silencioso,
// Elvis perdeu jogos do EWC LPL porque assumi "sem jogo" baseado em 429.
async function fetchLiquipediaJson(urlPath) {
  const delays = [0, 35000, 65000];
  let lastErr;
  for (const d of delays) {
    if (d > 0) await new Promise(r => setTimeout(r, d));
    try { return await fetchLiquipediaJsonRaw(urlPath); }
    catch (e) { lastErr = e; if (!/HTTP 429/.test(e.message)) throw e; }
  }
  throw lastErr;
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

// Calcula fair line pro EWC: (avg_total_a + avg_total_b) / 2, round pra .5.
// Fallback hierárquico: avg do time → avg da liga proxy (LCK/LEC/LPL) → 29.5.
function fairForEwcMatch(teamA, teamB, leagueProxy, teamAvgData) {
  if (!teamAvgData) return { line: 29.5, source: 'fallback_no_data' };
  const t = teamAvgData.teams || {};
  const lAvg = teamAvgData.league_avg?.[leagueProxy] ?? null;
  const a = t[teamA]?.avg_kills ?? lAvg;
  const b = t[teamB]?.avg_kills ?? lAvg;
  if (a == null || b == null) return { line: 29.5, source: 'fallback_29.5' };
  // fix 2026-05-17: avg_kills agora é total_kills → fair = (a+b)/2
  const adjusted = (a + b) / 2;
  const line = Math.round(adjusted - 0.5) + 0.5;
  const usedLgFor = [];
  if (t[teamA]?.avg_kills == null) usedLgFor.push('A');
  if (t[teamB]?.avg_kills == null) usedLgFor.push('B');
  return {
    line, source: usedLgFor.length ? `team_avg(${usedLgFor.join('+')}=lg)/2` : 'team_avg(team+team)/2',
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

// Lista global de falhas Liquipedia pra surfacing no output principal
const EWC_FETCH_FAILURES = [];

async function fetchEwcQualifierMatches(qualifier, targetDateUtc, teamAvgData) {
  const urlPath = `/leagueoflegends/api.php?action=parse&page=${encodeURIComponent(qualifier.page)}&format=json&prop=wikitext`;
  let r;
  try { r = await fetchLiquipediaJson(urlPath); }
  catch (e) {
    console.error(`# ${qualifier.key} liquipedia falhou: ${e.message}`);
    EWC_FETCH_FAILURES.push({ key: qualifier.key, error: e.message, page: qualifier.page });
    return [];
  }
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

// Carrega dados auxiliares (dashboard_stats + tier2_eu + fair-pre)
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

// Carrega fair-pre.json do dia pra obter fair_formula calculada pelo cron
function loadFormulaFair(date) {
  const f = path.join(REPO, 'cron-data', `${date}-fair-pre.json`);
  const out = new Map(); // match_id → fair_formula
  if (!fs.existsSync(f)) return out;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return out; }
  for (const capture of (j.captures || [])) {
    for (const fl of (capture.fair_lines || [])) {
      if (fl.event_id && fl.fair_formula != null) {
        out.set(String(fl.event_id), fl.fair_formula);
      }
    }
  }
  return out;
}

// Stats por time vem das bets SIMULATED do banco (fair line + odd 1.72).
// Decisão CEO 2026-05-23: SIMULATED tem n grande e zero viés (todo jogo
// qualificado pelo método vira SIMULATED, independente do que CEO apostou).
// BE com odd 1.72 = 58.1%. Threshold de cor: <50% vermelho, ≥60% verde, resto branco.
async function buildTeamHitMap() {
  const m = new Map();
  let cfg;
  try {
    const { loadConfig } = require(path.join(__dirname, '_load-config.cjs'));
    cfg = loadConfig();
  } catch (e) {
    console.error(`# [SIMULATED] loadConfig falhou: ${e.message} — continuando sem stats por time`);
    return m;
  }
  const url = new URL(cfg.supabaseUrl);
  const raw = await new Promise((resolve) => {
    https.get({
      host: url.hostname,
      path: '/rest/v1/bets?select=team_a,team_b,league,status&bookmaker=eq.SIMULATED&status=in.(green,red)&limit=2000',
      headers: { 'apikey': cfg.supabaseKey, 'Authorization': 'Bearer ' + cfg.supabaseKey },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', e => {
      console.error(`# [SIMULATED] Supabase request falhou: ${e.message}`);
      resolve(null);
    });
  });
  if (!raw || raw.status >= 400) {
    console.error(`# [SIMULATED] Supabase retornou ${raw?.status}`);
    return m;
  }
  let rows;
  try { rows = JSON.parse(raw.body); } catch (e) {
    console.error(`# [SIMULATED] JSON inválido: ${e.message}`);
    return m;
  }
  const acc = {}; // name_lower → { hits, n, lg, displayName }
  for (const r of rows) {
    for (const teamName of [r.team_a, r.team_b]) {
      if (!teamName) continue;
      const k = teamName.toLowerCase();
      if (!acc[k]) acc[k] = { hits: 0, n: 0, lg: r.league, displayName: teamName };
      acc[k].n += 1;
      if (r.status === 'green') acc[k].hits += 1;
    }
  }
  for (const k of Object.keys(acc)) {
    const a = acc[k];
    m.set(k, { hit: +(100 * a.hits / a.n).toFixed(1), n: a.n, lg: a.lg, name: a.displayName });
  }
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

// Lookup tolerante: tenta exact match, depois sem espaços, depois por substring.
// Necessário porque dashboard usa "NONGSHIM RED FORCE" e LoLEsports API usa "Nongshim RedForce".
function lookupTeam(name, map) {
  if (!name) return null;
  const kExact = name.toLowerCase();
  if (map.has(kExact)) return map.get(kExact);
  const kNoSpace = kExact.replace(/\s+/g, '');
  for (const [k, v] of map) {
    if (k.replace(/\s+/g, '') === kNoSpace) return v;
  }
  return null;
}

// Sempre retorna uma flag (verde/vermelho/branco) — decisão CEO 2026-05-23:
// "sempre é pra mandar a bola dos 2 time vermelha branca ou verde".
// Branco = neutro / sem amostra. Verde ≥60% (acima do BE 58.1% com odd 1.72).
// Vermelho <50% com n≥5 (sinal claro). Resto = branco.
function flagTeam(name, teamHitMap) {
  const stats = lookupTeam(name, teamHitMap);
  if (!stats || stats.n < 5) {
    return `⚪ ${name} (s/ amostra)`;
  }
  if (stats.hit < 50) return `🔴 ${name} (${stats.hit}% n=${stats.n})`;
  if (stats.hit >= 60) return `🟢 ${name} (${stats.hit}% n=${stats.n})`;
  return `⚪ ${name} (${stats.hit}% n=${stats.n})`;
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
  const pinnacle = loadFairPinnacle(TARGET);
  const formulaFair = loadFormulaFair(TARGET);
  const teamAvgData = loadTeamAvgKills();
  const teamHits = await buildTeamHitMap(); // SIMULATED-based (CEO 2026-05-23)
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
    const jogo = `${m.team_a_name || m.team_a} vs ${m.team_b_name || m.team_b}`;
    const lg = m.league;

    // Fair line: EWC já vem com fair calculada; outros: Pinnacle manual (se disponível) → fórmula → cron pendente
    let fairStr = '—';
    if (m.ewc_fair) {
      const f = m.ewc_fair;
      const tag = f.source.startsWith('fallback') ? '(fallback)' : '(team_avg/2)';
      fairStr = `**${f.line}** ${tag}`;
    } else {
      const teamAKey = (m.team_a || '').toLowerCase().replace(/\s+/g, '');
      const teamBKey = (m.team_b || '').toLowerCase().replace(/\s+/g, '');
      const pinLine = pinnacle.byMatchId.get(String(m.match_id))
        ?? pinnacle.byAnchor.get(teamAKey)?.fair_line
        ?? pinnacle.byAnchor.get(teamBKey)?.fair_line
        ?? null;
      const frmLine = formulaFair.get(String(m.match_id)) ?? null;
      if (pinLine != null) {
        fairStr = `**${pinLine}** (Pinnacle)`;
        if (frmLine != null) fairStr += ` / ${frmLine} (fórmula)`;
      } else if (frmLine != null) {
        fairStr = `**${frmLine}** (fórmula)`;
      } else {
        fairStr = '_Pinnacle pendente_';
      }
    }

    const flags = [];
    // EWC: marca como Bo5 e usa LCK/LEC/LPL como liga proxy pros stats
    const isEwc = lg.startsWith('EWC-');
    if (isEwc) flags.push('Bo5 EWC qualifier');
    const lgForStats = isEwc ? lg.split('-')[1] : lg;
    const lgFlag = flagLeague(lgForStats, leagueHits);
    if (lgFlag) flags.push(lgFlag);
    // Sempre incluir bolinha dos 2 times (decisão CEO 2026-05-23)
    flags.push(flagTeam(m.team_a_name, teamHits));
    flags.push(flagTeam(m.team_b_name, teamHits));
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

  // Fix 2026-05-20: surface falhas de fetch EWC pra Elvis decidir checar manual.
  // Antes era só console.error (silencioso pro usuário) — bug do EWC LPL não avisado.
  if (EWC_FETCH_FAILURES.length > 0) {
    console.log('\n⚠️  **EWC QUALIFIERS NÃO CARREGARAM** — verificar manual:');
    for (const f of EWC_FETCH_FAILURES) {
      console.log(`  - ${f.key} (${f.error}) → https://lol.fandom.com/wiki/${f.page.replace(/_/g, '_')}`);
    }
    console.log('  Liquipedia rate-limita agressivo. Fonte alternativa: lol.fandom.com (Leaguepedia).');
  }
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
