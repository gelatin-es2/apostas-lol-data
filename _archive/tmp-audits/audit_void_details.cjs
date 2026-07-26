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
  
  const voidBets = bets.filter(b => b.status === 'void');
  console.log('=== VOID BET DETAILS ===');
  voidBets.forEach(b => {
    console.log(`ID: ${b.id}`);
    console.log(`League: ${b.league}`);
    console.log(`Bookmaker: ${b.bookmaker}`);
    console.log(`Market: ${b.market}`);
    console.log(`Pick: ${b.pick}`);
    console.log(`Stake: ${b.stake}`);
    console.log(`Bet datetime: ${b.bet_datetime}`);
    console.log(`Raw extraction reason: ${b.raw_extraction?.reason || 'null'}`);
    console.log(`Settle source: ${b.settle_source || 'null'}`);
    console.log(`Notes: ${b.notes || 'null'}`);
    console.log('---');
  });
  
  // Check for potential settled_win_loss without status update
  console.log('\n=== POTENTIAL SETTLE BUG (has settled_win_loss but pending/wrong status) ===');
  const potentialBug = bets.filter(b => {
    const hasSettledWL = b.raw_extraction?.bookmaker_native?.settled_win_loss !== undefined && 
                         b.raw_extraction?.bookmaker_native?.settled_win_loss !== null;
    const wrongStatus = b.status === 'pending' || b.status === 'void' || b.status === 'refund';
    return hasSettledWL && wrongStatus;
  });
  
  console.log(`Count: ${potentialBug.length}`);
  potentialBug.forEach(b => {
    const settled = b.raw_extraction?.bookmaker_native?.settled_win_loss;
    console.log(`  ${b.id} | ${b.status} | settled_win_loss=${settled}`);
  });
  
  // Profit summary
  console.log('\n=== PROFIT SUMMARY (settled only) ===');
  const settled = bets.filter(b => b.status !== 'pending');
  const totalProfit = settled.reduce((s, b) => s + (b.profit || 0), 0);
  const methodBets = settled.filter(b => b.is_method_bet === true);
  const methodProfit = methodBets.reduce((s, b) => s + (b.profit || 0), 0);
  const nonMethodProfit = totalProfit - methodProfit;
  
  console.log(`Total settled: ${settled.length}`);
  console.log(`Total profit (all): R$ ${totalProfit.toFixed(2)}`);
  console.log(`Method bets: ${methodBets.length} | profit: R$ ${methodProfit.toFixed(2)}`);
  console.log(`Non-method bets: ${settled.length - methodBets.length} | profit: R$ ${nonMethodProfit.toFixed(2)}`);
  console.log(`ROI (method): ${(methodProfit / (methodBets.length * 100) * 100).toFixed(2)}% per R$100`);
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
