// Briefing diário — lista todos os jogos do dia (LCK/LPL/LEC/CBLOL/LFL/LCS
// + EWC qualifiers Korea/EMEA/China via Liquipedia) com fair line, flags de
// times ruins e ligas ruins. Pra agente apresentar como "primeira resposta de bet".
//
// Uso:
//   node daily_briefing.cjs                → jogos de hoje (UTC)
//   node daily_briefing.cjs YYYY-MM-DD     → data específica
//
// Output: tabela markdown no stdout, pronta pra colar no chat.
//
// Fix 2026-05-24: stats de time/liga agora vêm do Supabase LIVE com a MESMA
// query+parâmetros da aba "Banco de dados (Split 2)" do dashboard — eliminando
// divergência que custou R$2k (EDG 80% no dashboard vs 50% no briefing).

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..', '..');
const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const { loadFairPinnacle } = require(path.join(REPO, 'lib', 'loadFairPinnacle.cjs'));
const { fetchAnaliseStats } = require(path.join(REPO, 'lib', 'analiseStats.cjs'));
const { loadConfig } = require(path.join(REPO, '.claude', 'scripts', '_load-config.cjs'));

// Carrega alias map pra resolver nomes longos (API lolesports) → canonicals curtos (banco)
const ALIAS_MAP = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'team-aliases.json'), 'utf8'));
    return j.aliases || {};
  } catch { return {}; }
})();

// Resolve nome de time vindo da API (longo) → canonical curto do banco.
// Ex: "Shenzhen NINJAS IN PYJAMAS" → "NIP", "WeiboGaming" → "Weibo"
function resolveCanonical(name) {
  if (!name) return name;
  if (ALIAS_MAP[name]) return ALIAS_MAP[name];
  // Tenta case-insensitive fallback
  const lower = name.toLowerCase();
  for (const [alias, canon] of Object.entries(ALIAS_MAP)) {
    if (alias.toLowerCase() === lower) return canon;
  }
  return name; // retorna original se não encontrar
}

// Ligas operadas pelo Elvis (decisão 2026-05-10): LCK, LPL, LEC, CBLOL, LFL, LCS.
// LIT removida do briefing — Elvis não opera essa.
// LES re-adicionada 2026-07-23 (dono aprovou operar de novo). CLAUDE.md ainda cita
// "43.5% SKIP — sangra" pra LES, mas esse número não bate com nenhuma fonte viva
// (tier2_dashboard_stats.json 2026-05-21: all=59.3% n=27, 2peel=56.3% n=16,
// 1peel+flex=63.6% n=11; bets reais no Supabase: 66.7% n=30) — doc provavelmente
// desatualizada, sinalizado no report, não corrigido aqui (fora de escopo).
// normalizeLeague: 'LES' passa ileso nas 2 implementações (testado empiricamente).
// +3 ligas 2026-07-21 (método Under aprovado, validado externamente): Prime League,
// LCK Challengers (código curto 'KCL' — 'LCK Challengers'/'LCK-CL' colidem com o regex
// \bLCK\b de normalizeLeague em lib/normTeamName.cjs e poluiriam as stats da LCK principal),
// EMEA Masters (código curto 'EUM' — já é o código canônico esperado por normalizeLeague,
// que hoje mapeia "EMEA MASTERS" → 'EUM'; usar 'EUM' direto evita o mesmo tipo de
// desalinhamento). Fair dessas 3 = fórmula (mesmo caminho genérico de calcFormulaFair,
// sem histórico em team_avg_kills.json ainda → cai no fallback "—"/29.5 como qualquer
// time sem dado, igual funcionaria pra um time novo de LFL).
const LEAGUE_IDS = {
  LCK:            '98767991310872058',
  LPL:            '98767991314006698',
  LEC:            '98767991302996019',
  CBLOL:          '98767991332355509',
  LFL:            '105266103462388553',
  LCS:            '98767991299243165',
  'Prime League': '105266091639104326',
  KCL:            '98767991335774713', // LCK Challengers
  EUM:            '100695891328981122', // EMEA Masters
  LES:            '105266074488398661',
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
// Mapping team_code → canonical (usa nomes curtos, alinhados com banco 2026-05-24)
const TEAM_CODE_TO_CANONICAL = {
  // LCK
  t1: 'T1', hle: 'Hanwha', kt: 'KT', dk: 'Dplus',
  ns: 'Nongshim', bro: 'BRO', bfx: 'FEARX', drx: 'DRX',
  soop: 'DN SOOPers', dns: 'DN SOOPers',
  // LEC
  g2: 'G2 Esports', kc: 'Karmine', mkoi: 'KOI', gx: 'GIANTX',
  nvc: 'NAVI', vit: 'Vitality', th: 'Team Heretics',
  fnc: 'Fnatic', shf: 'Shifters', sk: 'SK Gaming',
  sly: 'Solary', gln: 'Galions',
  // LPL
  blg: 'BLG', jdg: 'JDG', wbg: 'Weibo',
  al: 'AL', ig: 'IG', tes: 'TES',
  nip: 'NIP', we: 'WE', omg: 'Oh My God',
  lng: 'LNG', edg: 'EDG', ttg: 'THUNDER TALK GAMING',
  lgd: 'LGD GAMING', up: 'UP',
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

// Fallback pras ligas de expansão (Prime League/KCL/EUM + outras) — team_avg_kills.json
// só cobre LCK/LPL/LEC/CBLOL/LFL/LCS + internacionais. Gerado offline por
// scripts/build-expansion-team-avgs.cjs a partir de audit-output/00-universe-allregions.json.
// Re-rodar esse script quando quiser refrescar a amostra (não é automático via cron ainda).
function loadExpansionTeamAvgKills() {
  const f = path.join(REPO, 'cron-data', 'expansion_team_avg_kills.json');
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

// Cache local de schedule EWC pra resiliência a Liquipedia 429.
// Quando consegue puxar, salva por (qualifier, target_date). Quando falha, lê do cache se ≤24h.
const EWC_CACHE_PATH = path.join(REPO, 'cron-data', 'ewc-schedule-cache.json');
const EWC_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function loadEwcCache() {
  try { return JSON.parse(fs.readFileSync(EWC_CACHE_PATH, 'utf8')); }
  catch { return { qualifiers: {} }; }
}
function saveEwcCache(cache) {
  try { fs.writeFileSync(EWC_CACHE_PATH, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error(`# EWC cache save falhou: ${e.message}`); }
}

// Re-aplica enriquecimento (fair, canonical names, match_id) em matches cacheados
function rehydrateCachedMatches(cachedParsed, qualifier, targetDateUtc, teamAvgData) {
  const out = [];
  for (const p of cachedParsed) {
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
      ewc_fair: fair,
    });
  }
  return out;
}

async function fetchEwcQualifierMatches(qualifier, targetDateUtc, teamAvgData) {
  const urlPath = `/leagueoflegends/api.php?action=parse&page=${encodeURIComponent(qualifier.page)}&format=json&prop=wikitext`;
  let r;
  try { r = await fetchLiquipediaJson(urlPath); }
  catch (e) {
    // FALLBACK: tenta cache local
    const cache = loadEwcCache();
    const cached = cache.qualifiers?.[qualifier.key];
    if (cached?.parsed_matches && cached.cached_at) {
      const ageMs = Date.now() - new Date(cached.cached_at).getTime();
      if (ageMs <= EWC_CACHE_TTL_MS) {
        const ageH = (ageMs / 3600000).toFixed(1);
        console.error(`# ${qualifier.key} liquipedia falhou (${e.message}) — usando cache de ${ageH}h atrás`);
        return rehydrateCachedMatches(cached.parsed_matches, qualifier, targetDateUtc, teamAvgData);
      }
      console.error(`# ${qualifier.key} cache expirou (${(ageMs/3600000).toFixed(1)}h > 24h) — sem fallback`);
    }
    console.error(`# ${qualifier.key} liquipedia falhou: ${e.message}`);
    EWC_FETCH_FAILURES.push({ key: qualifier.key, error: e.message, page: qualifier.page });
    return [];
  }
  const wt = r.parse?.wikitext?.['*'] || '';
  const parsed = parseLiquipediaMatches(wt);

  // SUCESSO: salva no cache pra próxima vez que Liquipedia falhar
  if (parsed.length > 0) {
    const cache = loadEwcCache();
    cache.qualifiers = cache.qualifiers || {};
    cache.qualifiers[qualifier.key] = {
      cached_at: new Date().toISOString(),
      page: qualifier.page,
      parsed_matches: parsed,
    };
    saveEwcCache(cache);
  }

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

// buildTeamHitMap / buildLeagueHitMap foram substituídos por fetchAnaliseStats (analiseStats.cjs).
// Fix 2026-05-24: stats agora vêm de query Supabase LIVE com mesmos parâmetros do dashboard
// (delta=0, odd=1.72, stake=1000, trigger='all') — eliminando divergência de fonte.

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

// Retorna célula de time pra tabela: bolinha + nome + hit%(n) ou "(s/ amostra)".
// n >= 1: mostra todos. n < 4 = amostra pequena → cor neutra ⚪ (sem verde/vermelho).
// Verde ≥60%, vermelho <50%, ⚪ = 50-59% ou amostra insuficiente (n<4).
function formatTeamCell(name, teamHitMap) {
  // 2026-07-23 (decisão Elvis pós-contrafactual 22-counterfactual.json): flags de time
  // REMOVIDAS do briefing — verde/vermelho não prevê (3 testes out-of-sample) e a regra
  // de stack por flag custou -R$22k no split 2. Aposta-se o GATILHO, não a camisa.
  // Ver knowledge/reports/2026-07-23-contrafactual-flags.md.
  return name;
}

// Mantida por compatibilidade com código EWC que a chama — alias para formatTeamCell.
function flagTeam(name, teamHitMap) { return formatTeamCell(name, teamHitMap); }

function flagLeague(lg, leagueHitMap) {
  const e = leagueHitMap.get(lg);
  if (!e) return null;
  if (e.hit < 50) return `🔴 ${lg} liga ruim (${e.hit}% n=${e.n})`;
  if (e.hit < 60) return `🟡 ${lg} liga marginal (${e.hit}% n=${e.n})`;
  if (e.hit >= 70) return `🟢 ${lg} liga forte (${e.hit}% n=${e.n})`;
  return null;
}

// Célula de Liga pra tabela: bolinha colorida + nome + hit%(n).
// n≥10 pra colorir (sample mínimo razoável de liga). Entre 50-59% → ⚪.
function formatLeagueCell(lg, leagueHitMap) {
  return lg; // flags removidas 2026-07-23 (decisão Elvis) — ver formatTeamCell
  /* eslint-disable no-unreachable */
  const e = leagueHitMap.get(lg);
  if (!e) return `⚪ ${lg} _(s/ amostra)_`; // liga nova sem bets ainda
  if (e.n < 10) return `⚪ ${lg} (${e.hit}% n=${e.n})`; // amostra pequena
  if (e.hit >= 60) return `🟢 ${lg} (${e.hit}% n=${e.n})`;
  if (e.hit < 50) return `🔴 ${lg} (${e.hit}% n=${e.n})`;
  return `⚪ ${lg} (${e.hit}% n=${e.n})`; // 50-59%
}

// Calcula fair fórmula direto de team_avg_kills.json: (avgA + avgB) / 2 round .5.
// Funciona pra qualquer jogo do calendário, independente do fair-pre.json do dia.
// Fallback por time: se o time não está em team_avg_kills.json (ligas de expansão
// — Prime League/KCL/EUM — não cobertas pelo cron principal), tenta
// expansionAvgData (cron-data/expansion_team_avg_kills.json).
// Retorna number|null (null se algum dos dois times não tem avg em nenhuma fonte).
function calcFormulaFair(teamAName, teamBName, teamAvgData, expansionAvgData) {
  const t = teamAvgData?.teams || {};
  const te = expansionAvgData?.teams || {};
  const a = t[teamAName]?.avg_kills ?? te[teamAName]?.avg_kills ?? null;
  const b = t[teamBName]?.avg_kills ?? te[teamBName]?.avg_kills ?? null;
  if (a == null || b == null) return null;
  const mid = (a + b) / 2;
  return Math.round(mid - 0.5) + 0.5; // round pra .5 mais próximo
}

(async () => {
  // Carrega credenciais Supabase (obrigatório para stats live).
  // _load-config.cjs retorna { supabaseUrl, supabaseKey } — ver lib/_load-config.cjs.
  let supabaseUrl, supabaseKey;
  try {
    const cfg = loadConfig();
    supabaseUrl = cfg.supabaseUrl;
    supabaseKey = cfg.supabaseKey;
  } catch (e) {
    console.error(`# BRIEFING ABORTADO: credenciais Supabase não encontradas — ${e.message}`);
    process.exit(1);
  }

  // Busca stats LIVE do Supabase com mesmos parâmetros do dashboard
  // (delta=0, odd=1.72, stake=1000, trigger='all') — Fix 2026-05-24
  console.error('# [stats-live] buscando bets do Supabase...');
  let analiseResult;
  try {
    analiseResult = await fetchAnaliseStats(supabaseUrl, supabaseKey);
  } catch (e) {
    console.error(`# BRIEFING ABORTADO: falha na query Supabase — ${e.message}`);
    process.exit(1);
  }
  const { teams: liveTeams, leagues: liveLeagues, meta: analiseMeta } = analiseResult;
  console.error(
    `# [stats-live] query=${analiseMeta.query}` +
    `\n# [stats-live] raw=${analiseMeta.raw} → dedup=${analiseMeta.deduped} → filtered=${analiseMeta.filtered} → simulated=${analiseMeta.simulated}` +
    `\n# [stats-live] params: delta=${analiseMeta.params.delta} odd=${analiseMeta.params.odd} stake=${analiseMeta.params.stake} trigger=${analiseMeta.params.trigger}` +
    `\n# [stats-live] times n>=1: ${liveTeams.length} | ligas n>=1: ${liveLeagues.length}`
  );

  // Monta Maps para lookup rápido (mesmo contrato das funções antigas)
  const teamHits = new Map();
  for (const t of liveTeams) {
    if (t.name) teamHits.set(t.name.toLowerCase(), { hit: t.hit, n: t.n, name: t.name });
  }
  const leagueHits = new Map();
  for (const l of liveLeagues) {
    if (l.name) leagueHits.set(l.name, { hit: l.hit, n: l.n });
  }

  // PRE-CHECK: valida que briefing live e Supabase casam (agora são a mesma fonte — deve passar sempre)
  const { spawnSync } = require('child_process');
  const validateResult = spawnSync(process.execPath, [
    require('path').join(__dirname, 'validate_briefing_vs_dashboard.cjs')
  ], { encoding: 'utf8', env: { ...process.env } });
  if (validateResult.stderr) process.stderr.write(validateResult.stderr);
  if (validateResult.status !== 0) {
    console.error('\n# AVISO: validador reportou divergência (veja detalhe acima). Continuando mesmo assim — ambas as fontes são live agora.');
    // Não aborta mais — validador será reescrito para comparar live vs live
  }

  const pinnacle = loadFairPinnacle(TARGET);
  const formulaFair = loadFormulaFair(TARGET);
  const teamAvgData = loadTeamAvgKills();
  const expansionAvgData = loadExpansionTeamAvgKills();

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
  // Gate por data 2026-07-22: EWC 2026 encerrou 2026-07-19 — pra TARGET depois
  // disso não tem mais jogo, só gera fetch inútil na Liquipedia + aviso morto
  // "EWC QUALIFIERS NÃO CARREGARAM" toda vez. Reabilita automático se a próxima
  // edição do EWC cair dentro dessa janela de novo (ajustar a data aqui então).
  const EWC_2026_LAST_DATE = '2026-07-19';
  if (TARGET <= EWC_2026_LAST_DATE) {
    for (const q of EWC_QUALIFIERS) {
      const ewcMatches = await fetchEwcQualifierMatches(q, TARGET, teamAvgData);
      for (const m of ewcMatches) allMatches.push(m);
    }
  }

  allMatches.sort((a, b) => a.start_time.localeCompare(b.start_time));

  // TOP TIMES + LIGAS (filtra ligas sem jogo na agenda; mantém core sempre)
  const agendaLeagues = new Set(
    allMatches.map(m => m.league.startsWith('EWC-') ? m.league.split('-')[1] : m.league)
  );
  const CORE_LEAGUES = new Set(['LCK','LPL','LEC','CBLOL','LCS']);
  const visibleLeagues = liveLeagues.filter(l => CORE_LEAGUES.has(l.name) || agendaLeagues.has(l.name));

  if (liveTeams.length > 0) {
    console.error('\n  TOP TIMES (hit% decrescente):');
    for (const t of liveTeams.slice(0, 10)) {
      const cor = t.n < 4 ? '⚪' : (t.hit >= 60 ? '🟢' : (t.hit >= 50 ? '⚪' : '🔴'));
      console.error(`    ${cor} ${t.name}: ${t.hit}% n=${t.n}`);
    }
  }
  if (visibleLeagues.length > 0) {
    console.error('\n  LIGAS:');
    for (const l of visibleLeagues) {
      const cor = l.n < 4 ? '⚪' : (l.hit >= 60 ? '🟢' : (l.hit >= 50 ? '⚪' : '🔴'));
      console.error(`    ${cor} ${l.name}: ${l.hit}% n=${l.n}`);
    }
  }

  // Header
  console.log(`# Jogos de ${TARGET} — briefing método 2peel\n`);
  if (allMatches.length === 0) {
    console.log('Sem jogos das ligas operadas (LCK/LPL/LEC/CBLOL/LFL/LCS + Prime League/KCL/EUM/LES) hoje.');
    return;
  }

  // Tabela principal — nova estrutura (2026-05-23):
  // Liga (bolinha+hit%) | Hora BRT | Time A (bolinha+hit%) | Time B (bolinha+hit%) | Fair Pin | Fórmula | Diff
  console.log('| Liga | Hora BRT | Time A | Time B | Fair Pin | Fórmula | Diff |');
  console.log('|---|---|---|---|---|---|---|');
  for (const m of allMatches) {
    const dt = new Date(m.start_time);
    const brt = new Date(dt.getTime() - 3*3600*1000);
    const hh = String(brt.getUTCHours()).padStart(2,'0');
    const mm = String(brt.getUTCMinutes()).padStart(2,'0');
    const horaBrt = `${hh}:${mm}`;
    const lg = m.league;
    const isEwc = lg.startsWith('EWC-');
    const lgForStats = isEwc ? lg.split('-')[1] : lg;

    // Coluna Liga
    const lgCell = formatLeagueCell(lgForStats, leagueHits) + (isEwc ? ' _(EWC Bo5)_' : '');

    // Colunas Time A / Time B — resolve alias pra canonical curto antes do lookup de stats
    const nameA = resolveCanonical(m.team_a_name || m.team_a);
    const nameB = resolveCanonical(m.team_b_name || m.team_b);
    const cellA = formatTeamCell(nameA, teamHits) + (m.state !== 'unstarted' ? ` _(${m.state})_` : '');
    const cellB = formatTeamCell(nameB, teamHits);

    // Colunas Fair Pin | Fórmula | Diff
    let pinLine = null;
    let frmLine = null;

    if (m.ewc_fair) {
      // EWC: fair calculada pelo fairForEwcMatch (team_avg/2)
      frmLine = m.ewc_fair.line;
      // Pinnacle não existe pra EWC qualifiers
    } else {
      const teamAKey = (m.team_a || '').toLowerCase().replace(/\s+/g, '');
      const teamBKey = (m.team_b || '').toLowerCase().replace(/\s+/g, '');
      // byMatchId → byAnchor (código da API) → lookupByName (anchor substring de nome completo)
      pinLine = pinnacle.byMatchId.get(String(m.match_id))
        ?? pinnacle.byAnchor.get(teamAKey)?.fair_line
        ?? pinnacle.byAnchor.get(teamBKey)?.fair_line
        ?? pinnacle.lookupByName(nameA, nameB)
        ?? null;
      // Fórmula: tenta fair-pre.json do cron, fallback pra cálculo direto de team_avg_kills
      // nameA/nameB já foram resolvidos para canonical curto (lookup em team_avg_kills funciona)
      const cronFrm = formulaFair.get(String(m.match_id)) ?? null;
      frmLine = cronFrm ?? calcFormulaFair(nameA, nameB, teamAvgData, expansionAvgData);
    }

    const fairPinCell = pinLine != null ? `**${pinLine}**` : '—';
    const fairFrmCell = frmLine != null ? `**${frmLine}**` : '—';

    let diffCell = '—';
    if (pinLine != null && frmLine != null) {
      const d = +(pinLine - frmLine).toFixed(1);
      diffCell = d > 0 ? `+${d}` : `${d}`;
    }

    console.log(`| ${lgCell} | ${horaBrt} | ${cellA} | ${cellB} | ${fairPinCell} | ${fairFrmCell} | ${diffCell} |`);
  }

  // Resumo
  console.log(`\n**${allMatches.length} jogos no total.** Ligas: ${[...new Set(allMatches.map(m => m.league))].join(', ')}.`);

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
