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
  const bets = await supabaseGet('/rest/v1/bets?select=team_a,team_b,league&limit=5000');
  
  const allTeams = new Set();
  bets.forEach(b => {
    if (b.team_a) allTeams.add(b.team_a);
    if (b.team_b) allTeams.add(b.team_b);
  });
  
  const aliasMap = require('./lib/team-aliases.json');
  const canonicalSet = new Set(Object.values(aliasMap.aliases));
  const isolated = new Set(aliasMap.isolated_real_teams.list);
  
  console.log('=== CHECKING FOR NAME VARIATIONS ===\n');
  
  // Look for likely duplicates with different case/punctuation
  const suspiciousGroups = {};
  allTeams.forEach(team => {
    const normalized = team.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!suspiciousGroups[normalized]) {
      suspiciousGroups[normalized] = [];
    }
    suspiciousGroups[normalized].push(team);
  });
  
  const duplicateVariants = Object.values(suspiciousGroups).filter(arr => arr.length > 1);
  
  if (duplicateVariants.length > 0) {
    console.log(`Found ${duplicateVariants.length} groups of similar names:\n`);
    duplicateVariants.forEach(group => {
      console.log(`  Variants: ${group.join(' | ')}`);
      const mapped = group.map(t => {
        const isCanonical = canonicalSet.has(t);
        const isIsolated = isolated.has(t);
        const isAlias = Object.keys(aliasMap.aliases).includes(t);
        let status = '?';
        if (isAlias) status = `alias→${aliasMap.aliases[t]}`;
        else if (isCanonical) status = 'canonical';
        else if (isIsolated) status = 'isolated';
        return `${t}(${status})`;
      });
      console.log(`    Status: ${mapped.join(' | ')}`);
    });
  } else {
    console.log('No suspicious name variants found. ✓');
  }
  
  // Check null team_a or team_b
  console.log('\n=== NULL TEAM CHECK ===');
  const nullTeams = bets.filter(b => !b.team_a || !b.team_b);
  console.log(`Bets with null team_a or team_b: ${nullTeams.length}`);
  if (nullTeams.length > 0) {
    nullTeams.slice(0, 3).forEach(b => {
      console.log(`  team_a=${b.team_a}, team_b=${b.team_b}, league=${b.league}`);
    });
  }
  
  // Validate isolated academies
  console.log('\n=== ISOLATED TEAMS (academies/unique) ===');
  const isolatedList = aliasMap.isolated_real_teams.list;
  const isolatedStats = {};
  
  bets.forEach(b => {
    isolatedList.forEach(iso => {
      if (b.team_a === iso) {
        if (!isolatedStats[iso]) isolatedStats[iso] = { count: 0, leagues: new Set() };
        isolatedStats[iso].count++;
        if (b.league) isolatedStats[iso].leagues.add(b.league);
      }
      if (b.team_b === iso) {
        if (!isolatedStats[iso]) isolatedStats[iso] = { count: 0, leagues: new Set() };
        isolatedStats[iso].count++;
        if (b.league) isolatedStats[iso].leagues.add(b.league);
      }
    });
  });
  
  isolatedList.forEach(iso => {
    const stats = isolatedStats[iso] || { count: 0, leagues: new Set() };
    const leagues = Array.from(stats.leagues).join(', ') || 'none';
    console.log(`  ${iso.padEnd(25)} n=${stats.count.toString().padStart(2)} leagues=${leagues}`);
  });
  
  // Teams that LOOK like they should be aliases
  console.log('\n=== UNMAPPED MAJOR TEAMS ===');
  const unmapped = Array.from(allTeams).filter(t => 
    !canonicalSet.has(t) && 
    !isolated.has(t) && 
    !Object.keys(aliasMap.aliases).includes(t)
  );
  
  const majorUnmapped = unmapped.filter(t => {
    const count = bets.filter(b => b.team_a === t || b.team_b === t).length;
    return count >= 4; // Significant presence
  });
  
  console.log(`\nMajor unmapped (n>=4):`);
  majorUnmapped.forEach(t => {
    const count = bets.filter(b => b.team_a === t || b.team_b === t).length;
    const leagues = new Set();
    bets.forEach(b => {
      if (b.team_a === t || b.team_b === t) leagues.add(b.league);
    });
    console.log(`  ${t.padEnd(30)} n=${count.toString().padStart(2)} leagues=${Array.from(leagues).join(', ')}`);
  });
  
  // Check if Vitality.Bee usage is correct (main LFL, not academy)
  console.log('\n=== VITALITY.BEE USAGE ===');
  const vbBets = bets.filter(b => b.team_a === 'Vitality.Bee' || b.team_b === 'Vitality.Bee');
  console.log(`Total Vitality.Bee bets: ${vbBets.length}`);
  const vbLeagues = new Set();
  vbBets.forEach(b => vbLeagues.add(b.league));
  console.log(`Leagues: ${Array.from(vbLeagues).join(', ')}`);
  if (vbLeagues.has('LFL') && vbLeagues.size === 1) {
    console.log('Status: ✓ Correct (main LFL team only)');
  } else {
    console.log('Status: ⚠ Unexpected league mix');
  }
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
