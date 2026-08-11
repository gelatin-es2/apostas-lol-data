const { supabaseGet } = require('./lib/supabaseQuery.cjs');

const { loadConfig } = require('./.claude/scripts/_load-config.cjs');
const { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY } = loadConfig();

async function check() {
  try {
    const endpoint = '/rest/v1/bets?select=id,stake,status,bookmaker&limit=5000&order=stake.desc';
    const bets = await supabaseGet(SUPABASE_URL, SUPABASE_KEY, endpoint);
    
    const simulated = bets.filter(b => b.bookmaker === 'SIMULATED');
    console.log(`SIMULATED (bookmaker=SIMULATED): ${simulated.length} bets`);
    if (simulated.length > 0) {
      console.log('First 5:', simulated.slice(0, 5).map(b => `R$${b.stake} (${b.status})`));
    }
    
    const byStatus = {};
    bets.forEach(b => {
      if (!byStatus[b.status]) byStatus[b.status] = 0;
      byStatus[b.status]++;
    });
    
    console.log('\nStatus distribution:');
    Object.entries(byStatus).forEach(([status, count]) => {
      console.log(`  ${status}: ${count}`);
    });

  } catch (err) {
    console.error('Erro:', err.message);
  }
}

check();
