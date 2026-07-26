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
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    ).on('error', reject);
  });
}

async function checkBookmakers() {
  console.log('=== BOOKMAKERS FOR UNMAPPED MAJOR TEAMS ===\n');
  
  const unmappedMajor = ['LOUD', 'Fnatic', 'Shifters', 'Team Heretics', 'SK Gaming', 'Ici Japon Corp', 'Joblife'];
  
  for (const team of unmappedMajor) {
    const bets = await supabaseGet(
      `/rest/v1/bets?select=id,bookmaker,team_a,team_b,bet_datetime&or=(team_a.eq.${encodeURIComponent(team)},team_b.eq.${encodeURIComponent(team)})&limit=100`
    );
    
    const bookmakers = new Set();
    bets.forEach(b => bookmakers.add(b.bookmaker));
    
    console.log(`${team}: ${bets.length} bets from ${Array.from(bookmakers).join(', ')}`);
  }
}

checkBookmakers().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
