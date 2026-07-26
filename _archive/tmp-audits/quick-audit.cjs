const https = require('https');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const SUPABASE_URL = env.match(/SUPABASE_URL=(.+)/)[1];
const SUPABASE_KEY = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1];

function supabaseGet(endpoint) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + endpoint);
    https.get({
      host: u.hostname,
      path: u.pathname + u.search,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Accept: 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i][j-1]+1, dp[i-1][j]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

async function audit() {
  const bets = await supabaseGet('/rest/v1/bets?select=team_a,team_b,league&limit=5000');
  const allTeams = new Set();
  bets.forEach(b => {
    if (b.team_a) allTeams.add(b.team_a);
    if (b.team_b) allTeams.add(b.team_b);
  });
  
  const aliasMap = require('./lib/team-aliases.json');
  const canonicalSet = new Set(Object.values(aliasMap.aliases));
  const isolated = new Set(aliasMap.isolated_real_teams.list);
  const aliasKeys = Object.keys(aliasMap.aliases);
  
  const teamsArray = Array.from(allTeams);
  
  console.log('\n=== LEVENSHTEIN DISTANCE <3 (Likely Duplicates) ===');
  const suspicious = [];
  for (let i = 0; i < teamsArray.length; i++) {
    for (let j = i + 1; j < teamsArray.length; j++) {
      const dist = levenshtein(teamsArray[i].toLowerCase(), teamsArray[j].toLowerCase());
      if (dist < 3 && dist > 0) {
        suspicious.push({
          a: teamsArray[i],
          b: teamsArray[j],
          dist,
          countA: bets.filter(b => b.team_a === teamsArray[i] || b.team_b === teamsArray[i]).length,
          countB: bets.filter(b => b.team_a === teamsArray[j] || b.team_b === teamsArray[j]).length,
        });
      }
    }
  }
  
  if (suspicious.length === 0) {
    console.log('None found. ✓');
  } else {
    suspicious.sort((a, b) => a.dist - b.dist);
    suspicious.forEach(s => {
      console.log(`  ${s.a} ↔ ${s.b} (dist=${s.dist}, counts: ${s.countA} vs ${s.countB})`);
    });
  }
  
  console.log('\n=== SHORT SIGLAS (<=3 chars) unmapped ===');
  const shortUnmapped = teamsArray.filter(t => 
    t.length <= 3 && 
    !canonicalSet.has(t) && 
    !isolated.has(t) && 
    !aliasKeys.includes(t)
  );
  
  if (shortUnmapped.length === 0) {
    console.log('None found. ✓');
  } else {
    shortUnmapped.forEach(t => {
      const count = bets.filter(b => b.team_a === t || b.team_b === t).length;
      console.log(`  ${t.padEnd(10)} n=${count}`);
    });
  }
  
  console.log('\n=== LIGAS MULTIPLAS: Legitimo vs Suspeito ===');
  
  const multiLeagueTeams = [];
  teamsArray.forEach(team => {
    const leagues = new Set();
    bets.forEach(b => {
      if (b.team_a === team || b.team_b === team) leagues.add(b.league);
    });
    if (leagues.size > 1) {
      multiLeagueTeams.push({ team, leagues: Array.from(leagues) });
    }
  });
  
  const legit = [], suspeito = [];
  multiLeagueTeams.forEach(mt => {
    const hasEWC = mt.leagues.some(l => l.startsWith('EWC-'));
    const mainLeagues = mt.leagues.filter(l => !l.startsWith('EWC-'));
    
    if (hasEWC && mainLeagues.length === 1) {
      legit.push(mt);
    } else {
      suspeito.push(mt);
    }
  });
  
  console.log(`\nLEGIT (main + EWC): ${legit.length}`);
  legit.forEach(mt => {
    console.log(`  ${mt.team.padEnd(25)} ${mt.leagues.join(' + ')}`);
  });
  
  console.log(`\nSUSPEITO (unusual): ${suspeito.length}`);
  suspeito.forEach(mt => {
    console.log(`  ${mt.team.padEnd(25)} ${mt.leagues.join(' + ')}`);
  });
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
