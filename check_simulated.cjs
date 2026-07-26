const { supabaseGet } = require('./lib/supabaseQuery.cjs');

const SUPABASE_URL = 'https://yxhpopkxlupdpqkdaffg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4aHBvcGt4bHVwZHBxa2RhZmZnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzE0NzQ1NCwiZXhwIjoyMDkyNzIzNDU0fQ.DyjJGDGceLkiM95NIlbY8GtZaG9-0aK7-vx4SfZTyGI';

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
