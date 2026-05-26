// Auditoria de aliases: cruza times únicos no banco vs lolesports getTeams API.
// Detecta:
//   - duplicatas ativas (mesmo time fragmentado em 2+ nomes no banco)
//   - bug latente (nome oficial sem alias → vai duplicar se entrar no save)
// Rodar manual após cada feed inesperado ou mensalmente.
const fs = require('fs');
const https = require('https');
const path = require('path');

const LOLES = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const ROOT = path.resolve(__dirname, '../..');

function fetchJsonSafe(host, path_, headers) {
  return new Promise((resolve, reject) => {
    https.get({ host, path: path_, headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        try {
          const fixed = body.replace(/"(id|esportsTeamId|leagueId|tournamentId|esportsGameId|esportsMatchId)":(\d{15,})/g, '"$1":"$2"');
          resolve(JSON.parse(fixed));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function norm(s) { return String(s||'').toLowerCase().replace(/[^a-z0-9]/g, ''); }

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'),'utf8').split(/\r?\n/).filter(l=>l && !l.startsWith('#')).map(l=>{const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1)];}));
const { supabaseGet } = require(path.join(ROOT, 'lib/supabaseQuery.cjs'));
const aliasMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/team-aliases.json'),'utf8')).aliases;
const aliasNorm = new Map();
for (const [k,v] of Object.entries(aliasMap)) aliasNorm.set(norm(k), v);

const LIGA_PAIR = {
  'LCK':'LCK', 'LPL':'LPL', 'LEC':'LEC', 'CBLOL':'CBLOL', 'LCS':'LCS',
  'LFL':'La Ligue Française', 'LES':'LES',
};

(async () => {
  const r = await fetchJsonSafe('esports-api.lolesports.com', '/persisted/gw/getTeams?hl=en-US', { 'x-api-key': LOLES });
  const ligaTeams = {};
  for (const t of r.data.teams) {
    const lg = t.homeLeague?.name || '?';
    (ligaTeams[lg] = ligaTeams[lg] || []).push({name: t.name, code: t.code});
  }

  const data = await supabaseGet(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, '/rest/v1/bets?select=team_a,team_b,league&is_method_bet=eq.true&limit=5000');
  const dbByLeague = {};
  for (const b of data) {
    const lg = b.league || 'UNKNOWN';
    if (!dbByLeague[lg]) dbByLeague[lg] = new Map();
    for (const t of [b.team_a, b.team_b]) {
      if (!t) continue;
      dbByLeague[lg].set(t, (dbByLeague[lg].get(t)||0)+1);
    }
  }

  const aliasesFaltando = [];
  let totalChecked = 0, totalCovered = 0;

  console.log('## Audit team aliases — ' + new Date().toISOString().slice(0,10) + '\n');

  for (const [dbLg, offLg] of Object.entries(LIGA_PAIR)) {
    const dbTeams = [...(dbByLeague[dbLg] || new Map()).entries()].sort((a,b)=>b[1]-a[1]);
    const officials = ligaTeams[offLg] || [];
    if (dbTeams.length === 0) continue;
    console.log(`\n### ${dbLg}  (banco=${dbTeams.length}, oficial=${officials.length})`);

    // Detecta duplicatas ATIVAS (2+ nomes do banco resolvem pro mesmo canônico)
    const dupGroups = new Map();
    for (const [t, n] of dbTeams) {
      const c = aliasNorm.get(norm(t)) || t;
      const k = norm(c);
      if (!dupGroups.has(k)) dupGroups.set(k, []);
      dupGroups.get(k).push({t, n, canon: c});
    }
    for (const [k, list] of dupGroups) if (list.length > 1) {
      console.log(`  🔴 DUPLICATA ATIVA: ${list.map(l=>`"${l.t}"(${l.n}x)`).join(' + ')} → canônico "${list[0].canon}"`);
    }

    // Para cada time do banco: tem oficial correspondente e está coberto?
    for (const [dbT, n] of dbTeams) {
      totalChecked++;
      const dbN = norm(dbT);
      const cands = officials.filter(o => norm(o.code) === dbN || norm(o.name) === dbN || norm(o.name).startsWith(dbN) || dbN.startsWith(norm(o.code)));
      const offName = cands.length === 1 ? cands[0].name : (cands.find(c => norm(c.code) === dbN)?.name) || (cands.find(c => norm(c.name) === dbN)?.name) || null;
      if (!offName) continue; // sem candidato claro, skip
      const offNorm = norm(offName), dbNorm = norm(dbT);
      if (offNorm === dbNorm) { totalCovered++; continue; }
      const aliased = aliasNorm.get(offNorm);
      if (aliased && norm(aliased) === dbNorm) { totalCovered++; continue; }
      console.log(`  ❌ FALTA ALIAS: "${offName}" → "${dbT}"  (${n}x bets)`);
      aliasesFaltando.push({league: dbLg, dbCanon: dbT, official: offName, count: n, line: `    "${offName}": "${dbT}",`});
    }
  }

  console.log('\n---');
  console.log(`Cobertura: ${totalCovered}/${totalChecked} times canônicos do banco com alias cobrindo nome oficial`);
  console.log(`Aliases faltando: ${aliasesFaltando.length}`);
  if (aliasesFaltando.length) {
    console.log('\nLinhas pra adicionar em lib/team-aliases.json:');
    for (const a of aliasesFaltando) console.log(a.line);
  }
  process.exit(aliasesFaltando.length > 0 ? 1 : 0);
})();
