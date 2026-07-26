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

async function audit() {
  const bets = await supabaseGet('/rest/v1/bets?select=*&limit=5000');
  
  // 7. Detailed analysis: green vs red, profit/loss
  const green = bets.filter(b => b.status === 'green');
  const red = bets.filter(b => b.status === 'red');
  
  console.log('=== GREEN BETS (WON) ===');
  console.log(`Count: ${green.length}`);
  const greenProfit = green.reduce((s, b) => s + (b.profit || 0), 0);
  console.log(`Total profit: R$ ${greenProfit.toFixed(2)}`);
  console.log(`Avg profit: R$ ${(greenProfit / green.length).toFixed(2)}`);
  
  console.log('\n=== RED BETS (LOST) ===');
  console.log(`Count: ${red.length}`);
  const redLoss = red.reduce((s, b) => s + (b.profit || 0), 0);
  console.log(`Total loss: R$ ${redLoss.toFixed(2)}`);
  console.log(`Avg loss: R$ ${(redLoss / red.length).toFixed(2)}`);
  
  // 8. Win rate
  const totalSettled = green.length + red.length;
  const winRate = (green.length / totalSettled * 100).toFixed(2);
  console.log(`\nWin rate: ${winRate}% (${green.length}/${totalSettled})`);
  
  // 9. Pending analysis
  const pending = bets.filter(b => b.status === 'pending');
  console.log(`\n=== PENDING: ${pending.length} bets ===`);
  if (pending.length > 0) {
    pending.forEach(b => {
      const matchId = b.raw_extraction?.match_context?.lolesports_match_id || 'N/A';
      console.log(`  ${b.bet_datetime} | ${b.league} | match_id=${matchId} | bookmaker=${b.bookmaker}`);
    });
  }
  
  // 10. Method bet breakdown by status
  console.log(`\n=== METHOD BET BREAKDOWN ===`);
  const methodTrue = bets.filter(b => b.is_method_bet === true);
  const methodFalse = bets.filter(b => b.is_method_bet === false);
  
  const methodByStatus = {};
  methodTrue.forEach(b => {
    methodByStatus[b.status] = (methodByStatus[b.status] || 0) + 1;
  });
  
  console.log('Method bets (is_method_bet=true):');
  Object.entries(methodByStatus).forEach(([s, c]) => {
    console.log(`  ${s}: ${c}`);
  });
  
  const nonMethodByStatus = {};
  methodFalse.forEach(b => {
    nonMethodByStatus[b.status] = (nonMethodByStatus[b.status] || 0) + 1;
  });
  
  console.log('Non-method bets (is_method_bet=false):');
  Object.entries(nonMethodByStatus).forEach(([s, c]) => {
    console.log(`  ${s}: ${c}`);
  });
  
  // 11. Settle source analysis
  console.log(`\n=== SETTLE SOURCE ===`);
  const settleSource = {};
  bets.forEach(b => {
    if (b.status !== 'pending') {
      const source = b.settle_source || 'null';
      settleSource[source] = (settleSource[source] || 0) + 1;
    }
  });
  
  Object.entries(settleSource).forEach(([src, c]) => {
    console.log(`  ${src}: ${c}`);
  });
  
  // 12. Raw extraction: settled_by analysis (to detect auto vs manual)
  console.log(`\n=== SETTLED_BY (auto vs manual) ===`);
  const settledByAuto = bets.filter(b => b.raw_extraction?.settled_by === 'auto').length;
  const settledByManual = bets.filter(b => b.raw_extraction?.settled_by === 'manual').length;
  const settledByNull = bets.filter(b => b.status !== 'pending' && !b.raw_extraction?.settled_by).length;
  
  console.log(`  auto: ${settledByAuto}`);
  console.log(`  manual: ${settledByManual}`);
  console.log(`  null/missing: ${settledByNull}`);
  
  // 13. League distribution by status
  console.log(`\n=== STATUS BY LEAGUE (top 10 leagues) ===`);
  const leagueStatus = {};
  bets.forEach(b => {
    if (!leagueStatus[b.league]) leagueStatus[b.league] = {};
    leagueStatus[b.league][b.status] = (leagueStatus[b.league][b.status] || 0) + 1;
  });
  
  const topLeagues = Object.entries(leagueStatus)
    .map(([lg, statuses]) => ({ league: lg, total: Object.values(statuses).reduce((a,b)=>a+b,0), statuses }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  
  topLeagues.forEach(({ league, total, statuses }) => {
    const green = statuses.green || 0;
    const red = statuses.red || 0;
    const pending = statuses.pending || 0;
    const others = total - green - red - pending;
    console.log(`  ${league.padEnd(12)} : ${total.toString().padStart(3)} (${green}✓ ${red}✗ ${pending}⏳ ${others}other)`);
  });
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
