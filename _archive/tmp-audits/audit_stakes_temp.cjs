const { supabaseGet } = require('./lib/supabaseQuery.cjs');

const { loadConfig } = require('../../.claude/scripts/_load-config.cjs');
const { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY } = loadConfig();

async function auditStakes() {
  try {
    const endpoint = '/rest/v1/bets?select=id,stake,status,bookmaker,created_at,odd&limit=5000';
    const bets = await supabaseGet(SUPABASE_URL, SUPABASE_KEY, endpoint);
    
    console.log(`Total de bets: ${bets.length}\n`);

    const stakes = bets.map(b => b.stake).filter(s => s !== null && s !== undefined);
    stakes.sort((a, b) => a - b);
    
    const min = Math.min(...stakes);
    const max = Math.max(...stakes);
    const p10 = stakes[Math.floor(stakes.length * 0.1)];
    const p25 = stakes[Math.floor(stakes.length * 0.25)];
    const p50 = stakes[Math.floor(stakes.length * 0.50)];
    const mean = stakes.reduce((a, b) => a + b, 0) / stakes.length;
    const p75 = stakes[Math.floor(stakes.length * 0.75)];
    const p90 = stakes[Math.floor(stakes.length * 0.90)];
    const p95 = stakes[Math.floor(stakes.length * 0.95)];
    
    console.log('=== DISTRIBUIÇÃO GLOBAL ===');
    console.log(`Min: R$${min.toFixed(2)} | P10: R$${p10.toFixed(2)} | P25: R$${p25.toFixed(2)}`);
    console.log(`Median: R$${p50.toFixed(2)} | Mean: R$${mean.toFixed(2)}`);
    console.log(`P75: R$${p75.toFixed(2)} | P90: R$${p90.toFixed(2)} | P95: R$${p95.toFixed(2)} | Max: R$${max.toFixed(2)}\n`);

    const nullStakes = bets.filter(b => b.stake === null || b.stake === undefined).length;
    const zeroNegative = bets.filter(b => b.stake !== null && b.stake <= 0).length;
    
    console.log('=== STAKES NULL/ZERO/NEGATIVE ===');
    console.log(`Null/undefined: ${nullStakes}`);
    console.log(`<= 0: ${zeroNegative}\n`);

    const over3k = bets.filter(b => b.stake > 3000);
    const under30 = bets.filter(b => b.stake > 0 && b.stake < 30);
    
    console.log('=== OUTLIERS ===');
    console.log(`Stakes > R$3.000: ${over3k.length}`);
    if (over3k.length > 0) {
      const top = over3k.slice(0, 5);
      console.log('Top 5:', top.map(b => `R$${b.stake} (${b.status})`).join(', '));
    }
    console.log(`Stakes < R$30: ${under30.length}\n`);

    const byBookmaker = {};
    bets.forEach(b => {
      if (b.stake > 0) {
        if (!byBookmaker[b.bookmaker]) {
          byBookmaker[b.bookmaker] = { count: 0, total: 0 };
        }
        byBookmaker[b.bookmaker].count++;
        byBookmaker[b.bookmaker].total += b.stake;
      }
    });
    
    console.log('=== POR BOOKMAKER ===');
    Object.entries(byBookmaker).sort((a, b) => b[1].total - a[1].total).forEach(([bm, data]) => {
      const avg = data.total / data.count;
      console.log(`${bm}: ${data.count} bets, Total R$${data.total.toFixed(2)}, Média R$${avg.toFixed(2)}`);
    });

    const byMonth = {};
    bets.forEach(b => {
      if (b.stake > 0 && b.created_at) {
        const month = b.created_at.substring(0, 7);
        if (!byMonth[month]) {
          byMonth[month] = { count: 0, total: 0 };
        }
        byMonth[month].count++;
        byMonth[month].total += b.stake;
      }
    });
    
    console.log('\n=== POR MÊS ===');
    Object.entries(byMonth).sort().forEach(([month, data]) => {
      const avg = data.total / data.count;
      console.log(`${month}: ${data.count} bets, Total R$${data.total.toFixed(2)}, Média R$${avg.toFixed(2)}`);
    });

    const simulated = bets.filter(b => b.status === 'SIMULATED');
    console.log(`\n=== SIMULATED (${simulated.length} bets) ===`);
    const simStakes = simulated.map(s => s.stake).filter(s => s !== null);
    const allThousand = simStakes.every(s => s === 1000);
    console.log(`Todas R$1000? ${allThousand}`);
    if (!allThousand && simStakes.length > 0) {
      const uniq = [...new Set(simStakes)].sort((a,b)=>a-b);
      console.log(`Stakes únicos SIMULATED: ${uniq.join(', ')}`);
    }

    const highExposure = bets.filter(b => b.stake > 2000 && b.odd > 1.85);
    console.log(`\n=== ALTA EXPOSIÇÃO (stake>R$2k + odd>1.85) ===`);
    console.log(`Count: ${highExposure.length}`);
    if (highExposure.length > 0) {
      const samples = highExposure.slice(0, 5);
      samples.forEach(b => {
        console.log(`  R$${b.stake} @ ${b.odd} (${b.status})`);
      });
    }

  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
}

auditStakes();
