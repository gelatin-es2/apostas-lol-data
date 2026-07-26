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
  console.log('Total bets:', bets.length);
  
  // 1. Status distribution
  const statuses = {};
  bets.forEach(b => {
    statuses[b.status] = (statuses[b.status] || 0) + 1;
  });
  
  console.log('\n=== STATUS DISTRIBUTION ===');
  Object.entries(statuses).sort((a,b)=>b[1]-a[1]).forEach(([s, c]) => {
    console.log(`  ${s.padEnd(12)} : ${c}`);
  });
  
  // 2. Pending forever (>7 dias)
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7*24*60*60*1000);
  const pendingOld = bets.filter(b => b.status === 'pending' && new Date(b.bet_datetime) < sevenDaysAgo);
  
  console.log(`\n=== PENDING FOREVER (>7 days): ${pendingOld.length} ===`);
  if (pendingOld.length > 0) {
    pendingOld.slice(0,5).forEach(b => {
      console.log(`  ${b.bet_datetime} | ${b.league || 'N/A'} | ${b.bookmaker}`);
    });
    if (pendingOld.length > 5) console.log(`  ... +${pendingOld.length - 5} more`);
  }
  
  // 3. Cashout count and profit
  const cashout = bets.filter(b => b.status === 'cashout');
  console.log(`\n=== CASHOUT: ${cashout.length} bets ===`);
  if (cashout.length > 0) {
    const totalProfit = cashout.reduce((s, b) => s + (b.profit || 0), 0);
    const avgProfit = totalProfit / cashout.length;
    console.log(`  Total profit: ${totalProfit.toFixed(2)}`);
    console.log(`  Avg profit per bet: ${avgProfit.toFixed(2)}`);
    cashout.forEach(b => {
      console.log(`    [${b.bookmaker}] ${b.league}: R$ ${b.profit}`);
    });
  }
  
  // 4. Void/refund
  const voidBets = bets.filter(b => b.status === 'void');
  const refund = bets.filter(b => b.status === 'refund');
  
  console.log(`\n=== VOID: ${voidBets.length} ===`);
  voidBets.forEach(b => {
    const reason = b.raw_extraction?.reason || 'N/A';
    console.log(`  [${b.league}] ${reason}`);
  });
  
  console.log(`\n=== REFUND: ${refund.length} ===`);
  refund.forEach(b => {
    const reason = b.raw_extraction?.reason || 'N/A';
    console.log(`  [${b.league}] ${reason}`);
  });
  
  // 5. Settled but pending (bug)
  const settledPending = bets.filter(b => 
    b.status === 'pending' && 
    b.raw_extraction?.settled_by
  );
  console.log(`\n=== SETTLED BUT PENDING (bug): ${settledPending.length} ===`);
  settledPending.forEach(b => {
    console.log(`  ${b.bet_datetime} | ${b.league} | settled_by=${b.raw_extraction.settled_by}`);
  });
  
  // 6. is_method_bet distribution
  const methodBets = {
    null: 0,
    true: 0,
    false: 0
  };
  bets.forEach(b => {
    if (b.is_method_bet === null || b.is_method_bet === undefined) methodBets.null++;
    else if (b.is_method_bet === true) methodBets.true++;
    else methodBets.false++;
  });
  
  console.log(`\n=== is_method_bet DISTRIBUTION ===`);
  console.log(`  null: ${methodBets.null}`);
  console.log(`  true: ${methodBets.true}`);
  console.log(`  false: ${methodBets.false}`);
}

audit().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
