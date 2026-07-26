const https = require('https');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const SUPABASE_URL = env.match(/SUPABASE_URL=(.+)/)[1];
const SUPABASE_KEY = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1];

function supabaseGet(endpoint) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + endpoint);
    https.get(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      }
    ).on('error', reject);
  });
}

async function audit() {
  console.log('Fetching all bets...');
  
  const bets = await supabaseGet(
    '/rest/v1/bets?select=id,team_a,team_b,league,bet_datetime&limit=5000'
  );
  
  console.log(`Total bets: ${bets.length}`);
  
  const teamStats = {};
  const nullTeamBets = [];
  const sameTeamBets = [];
  
  for (const bet of bets) {
    const { team_a, team_b, league, bet_datetime } = bet;
    
    if (!team_a || !team_b) {
      nullTeamBets.push(bet.id);
      continue;
    }
    
    if (team_a === team_b) {
      sameTeamBets.push(bet.id);
      continue;
    }
    
    for (const team of [team_a, team_b]) {
      if (!teamStats[team]) {
        teamStats[team] = {
          count: 0,
          leagues: new Set(),
          first_date: null,
          last_date: null,
        };
      }
      teamStats[team].count++;
      if (league) teamStats[team].leagues.add(league);
      const dt = new Date(bet_datetime);
      if (!teamStats[team].first_date || dt < teamStats[team].first_date) {
        teamStats[team].first_date = dt;
      }
      if (!teamStats[team].last_date || dt > teamStats[team].last_date) {
        teamStats[team].last_date = dt;
      }
    }
  }
  
  const teamsArray = Object.entries(teamStats).map(([name, stats]) => ({
    name,
    count: stats.count,
    leagues: Array.from(stats.leagues).sort(),
    first_date: stats.first_date?.toISOString().split('T')[0],
    last_date: stats.last_date?.toISOString().split('T')[0],
  }));
  
  teamsArray.sort((a, b) => b.count - a.count);
  
  console.log('\n=== TEAM STATS (top 40) ===');
  teamsArray.slice(0, 40).forEach(t => {
    console.log(`${t.name.padEnd(30)} count=${t.count.toString().padStart(3)} leagues=${t.leagues.join(', ')} first=${t.first_date} last=${t.last_date}`);
  });
  
  console.log(`\n=== NULLS & SAME TEAM ===`);
  console.log(`Bets with team_a OR team_b null: ${nullTeamBets.length}`);
  console.log(`Bets with team_a == team_b: ${sameTeamBets.length}`);
  
  const aliasMap = require('./lib/team-aliases.json');
  const canonicalTeams = new Set(Object.values(aliasMap.aliases));
  const isolated = new Set(aliasMap.isolated_real_teams.list);
  const allAliases = new Set(Object.keys(aliasMap.aliases));
  
  console.log(`\n=== CROSS-CHECK WITH ALIASES ===`);
  
  const unmappedInDB = [];
  const suspiciousTeams = [];
  
  teamsArray.forEach(t => {
    const isCanonical = canonicalTeams.has(t.name);
    const isIsolated = isolated.has(t.name);
    const isAlias = allAliases.has(t.name);
    
    if (!isCanonical && !isIsolated && !isAlias) {
      unmappedInDB.push(t);
    }
    
    if (t.leagues.length > 1 && !['Vitality', 'KOI', 'Karmine'].some(x => t.name.includes(x))) {
      suspiciousTeams.push(t);
    }
  });
  
  console.log(`\nUnmapped teams in DB (${unmappedInDB.length}):`);
  unmappedInDB.forEach(t => {
    console.log(`  ${t.name.padEnd(30)} n=${t.count} leagues=${t.leagues.join(', ')}`);
  });
  
  console.log(`\nMulti-league teams (${suspiciousTeams.length}):`);
  suspiciousTeams.forEach(t => {
    console.log(`  ${t.name.padEnd(30)} n=${t.count} leagues=${t.leagues.join(', ')}`);
  });
  
  console.log(`\n=== ORPHANED CANONICALS ===`);
  const orphaned = Array.from(canonicalTeams).filter(c => !teamStats[c]);
  if (orphaned.length > 0) {
    console.log(`Canonicals in aliases but NOT in DB (${orphaned.length}):`);
    orphaned.slice(0, 10).forEach(c => console.log(`  ${c}`));
  } else {
    console.log('All canonicals in aliases exist in DB. ✓');
  }
  
  console.log(`\n=== LOW-COUNT TEAMS (n<=3, unmapped) ===`);
  const lowCount = teamsArray.filter(t => t.count <= 3 && !canonicalTeams.has(t.name) && !isolated.has(t.name));
  lowCount.forEach(t => {
    console.log(`  ${t.name.padEnd(30)} n=${t.count} league=${t.leagues.join(', ')}`);
  });
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total distinct teams in DB: ${teamsArray.length}`);
  console.log(`Total bets analyzed: ${bets.length}`);
  console.log(`Unmapped teams: ${unmappedInDB.length}`);
  console.log(`Multi-league teams (suspicious): ${suspiciousTeams.length}`);
  console.log(`Canonicals not in DB: ${orphaned.length}`);
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
