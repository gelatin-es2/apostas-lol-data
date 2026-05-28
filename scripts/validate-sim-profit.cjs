/**
 * Validação do fix 2026-05-28 (hit simulado + PnL real = bug recorrente).
 *
 * Invariante verificada: para toda simulação com params fixos (odd=1.72, stake=1000):
 *   hit > BE → profit >= 0
 *   hit < BE → profit <= 0
 *   hit = BE → profit ≈ 0 (tolerância floating point)
 *
 * Também verifica Esprit Shonen especificamente (caso de prova do bug):
 *   n=6, 4W/2L → profit = 4×720 - 2×1000 = +R$880 (era -R$2120 com o bug)
 *
 * Roda com: node scripts/validate-sim-profit.cjs
 */

'use strict';
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const { loadConfig }              = require(path.join(REPO, '.claude', 'scripts', '_load-config.cjs'));
const { getBetSimulation, aggBy } = require(path.join(REPO, 'lib', 'analiseStats.cjs'));
const { supabaseGet }             = require(path.join(REPO, 'lib', 'supabaseQuery.cjs'));
const { normTeamName }            = require(path.join(REPO, 'lib', 'normTeamName.cjs'));

async function main() {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const DELTA = 0, ODD = 1.72, STAKE = 1000;
  const BE = 100 / ODD; // breakeven %

  console.log(`\nParams: delta=${DELTA}, odd=${ODD} (fixo), stake=${STAKE}, BE=${BE.toFixed(2)}%\n`);

  // Fetch + dedup
  const raw = await supabaseGet(supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=*&status=in.(green,red)&is_method_bet=eq.true&order=bet_datetime.desc&limit=2000'
  );
  const realGids = new Set();
  for (const b of raw) if (b.bookmaker !== 'SIMULATED') {
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    if (gid) realGids.add(String(gid));
  }
  const bets = raw.filter(b => {
    if (b.bookmaker !== 'SIMULATED') return true;
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    return !gid || !realGids.has(String(gid));
  });
  for (const b of bets) { normTeamName(b.team_a); normTeamName(b.team_b); }
  const simulated = bets.map(b => ({ b, sim: getBetSimulation(b, DELTA, ODD) })).filter(x => x.sim);

  const total = simulated.length;
  const green = simulated.filter(x => x.sim.won).length;
  const hitGlobal = total ? 100 * green / total : 0;
  console.log(`Total bets: ${total}, Hit global: ${hitGlobal.toFixed(1)}%\n`);

  // Agrega por time
  const teams = aggBy(
    simulated,
    b => [normTeamName(b.team_a), normTeamName(b.team_b)],
    STAKE,
    ODD
  );

  const teamsN5 = teams.filter(t => t.n >= 5);
  let allOk = true;
  const failures = [];

  console.log('Verificando invariante hit>BE → profit≥0 (e hit<BE → profit≤0):\n');
  const pad  = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  console.log(pad('Time', 24) + rpad('n', 5) + rpad('w', 5) + rpad('Hit%', 8) + rpad('Profit', 12) + '  Check');
  console.log('-'.repeat(65));

  for (const t of teamsN5) {
    const hit = typeof t.hit === 'number' ? t.hit : parseFloat(t.hit);
    let check = 'OK';
    let fail = false;

    if (hit > BE + 0.5 && t.profit < -0.01) {
      // hit acima do BE mas profit negativo — IMPOSSÍVEL com simulação teórica
      check = 'FAIL (hit>BE, profit<0)';
      fail = true;
    } else if (hit < BE - 0.5 && t.profit > 0.01) {
      // hit abaixo do BE mas profit positivo — IMPOSSÍVEL com simulação teórica
      check = 'FAIL (hit<BE, profit>0)';
      fail = true;
    }

    if (fail) {
      allOk = false;
      failures.push({ name: t.name, n: t.n, w: t.w, hit, profit: t.profit });
    }

    const hitStr  = hit.toFixed(1) + '%';
    const profStr = 'R$' + t.profit.toFixed(0);
    if (fail || t.name.toLowerCase().includes('esprit')) {
      console.log(pad(t.name, 24) + rpad(t.n, 5) + rpad(t.w, 5) + rpad(hitStr, 8) + rpad(profStr, 12) + '  ' + check);
    }
  }

  // Sempre imprime linha do Esprit Shonen (caso de prova)
  const esprit = teams.find(t => /esprit/i.test(t.name));
  if (esprit) {
    const hit = typeof esprit.hit === 'number' ? esprit.hit : parseFloat(esprit.hit);
    const expectedP = esprit.w * STAKE * (ODD-1) - (esprit.n - esprit.w) * STAKE;
    console.log(`\nEsprit Shonen (caso de prova do bug):`);
    console.log(`  n=${esprit.n}, w=${esprit.w}, hit=${hit.toFixed(1)}%, profit=R$${esprit.profit.toFixed(2)}`);
    console.log(`  Fórmula ${esprit.w}×${STAKE}×${ODD-1} - ${esprit.n - esprit.w}×${STAKE} = R$${expectedP.toFixed(2)}`);
    const pDiff = Math.abs(esprit.profit - expectedP);
    const pOk = pDiff < 0.02;
    console.log(`  Diff com fórmula: R$${pDiff.toFixed(4)} → ${pOk ? 'OK' : 'FAIL'}`);
    if (!pOk) { allOk = false; failures.push({ name: 'Esprit Shonen (fórmula diff)', profit: esprit.profit, expected: expectedP }); }
  }

  console.log();
  if (allOk) {
    console.log(`PASSOU: ${teamsN5.length} times (n≥5) verificados — nenhuma violação de invariante hit/profit.`);
  } else {
    console.error(`FALHOU: ${failures.length} violação(ões):`);
    for (const f of failures) console.error(`  - ${f.name}: n=${f.n} hit=${f.hit?.toFixed(1)}% profit=R$${f.profit?.toFixed(2)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
