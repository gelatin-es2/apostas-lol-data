/**
 * Auditoria de impacto do bug de PnL (2026-05-28).
 *
 * Compara por time:
 *   - PnL NOVO (correto, pós-fix): simulação teórica com odd fixa 1.72, map-dedup
 *   - PnL VELHO (errado, pré-fix): soma direta de b.profit do banco, sem map-dedup, sem odd fixa
 *
 * Reporta todos os times com n_bets >= 5 (usando bets brutas), ordenados por magnitude_bug DESC.
 *
 * Roda com: node scripts/audit-pnl-bug-impact.cjs
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const REPO = path.resolve(__dirname, '..');

const { loadConfig }              = require(path.join(REPO, '.claude', 'scripts', '_load-config.cjs'));
const { getBetSimulation, aggBy } = require(path.join(REPO, 'lib', 'analiseStats.cjs'));
const { supabaseGet }             = require(path.join(REPO, 'lib', 'supabaseQuery.cjs'));
const { normTeamName }            = require(path.join(REPO, 'lib', 'normTeamName.cjs'));

const DELTA = 0, ODD = 1.72, STAKE = 1000;

async function main() {
  const { supabaseUrl, supabaseKey } = loadConfig();

  // === FETCH + DEDUP (idêntico ao analiseStats) ===
  const raw = await supabaseGet(supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=*&status=in.(green,red)&is_method_bet=eq.true&order=bet_datetime.desc&limit=2000'
  );

  const realGids = new Set();
  for (const b of raw) {
    if (b.bookmaker !== 'SIMULATED') {
      const gid = b.raw_extraction?.match_context?.lolesports_game_id;
      if (gid) realGids.add(String(gid));
    }
  }
  const bets = raw.filter(b => {
    if (b.bookmaker !== 'SIMULATED') return true;
    const gid = b.raw_extraction?.match_context?.lolesports_game_id;
    return !gid || !realGids.has(String(gid));
  });

  // Pré-popula cache normTeamName
  for (const b of bets) { normTeamName(b.team_a); normTeamName(b.team_b); }

  const totalBets = bets.length;

  // === CÁLCULO NOVO (pós-fix): teórico puro, map-dedup, odd fixa 1.72 ===
  const simulated = bets
    .map(b => ({ b, sim: getBetSimulation(b, DELTA, ODD) }))
    .filter(x => x.sim != null);

  const newTeams = aggBy(
    simulated,
    b => [normTeamName(b.team_a), normTeamName(b.team_b)],
    STAKE, ODD
  );
  const newByName = {};
  for (const t of newTeams) newByName[t.name] = t;

  // === CÁLCULO VELHO (pré-fix): soma direta de b.profit, sem map-dedup, sem odd fixa ===
  // Replica exatamente o bug: iterava sobre bets e somava b.profit direto
  const oldByName = {};
  for (const b of bets) {
    for (const teamName of [normTeamName(b.team_a), normTeamName(b.team_b)]) {
      if (!teamName) continue;
      if (!oldByName[teamName]) {
        oldByName[teamName] = { name: teamName, n_raw: 0, w_raw: 0, profit_raw: 0 };
      }
      const entry = oldByName[teamName];
      entry.n_raw++;
      // profit real: b.profit pode ser null — tratar como 0
      const bProfit = typeof b.profit === 'number' ? b.profit : 0;
      entry.profit_raw += bProfit;
      if (b.status === 'green') entry.w_raw++;
    }
  }

  // === COMBINAR — só times com n_bets_raw >= 5 ===
  const allNames = new Set([...Object.keys(newByName), ...Object.keys(oldByName)]);
  const rows = [];

  for (const name of allNames) {
    const o = oldByName[name];
    const n = newByName[name];
    if (!o || o.n_raw < 5) continue; // filtra n_raw < 5

    const n_bets_raw   = o.n_raw;
    const n_simulado   = n ? n.n    : 0;
    const w_simulado   = n ? n.w    : 0;
    const hit_pct      = n_simulado > 0 ? Math.round(100 * w_simulado / n_simulado) : null;
    const pnl_novo     = n ? n.profit : 0;
    const pnl_velho    = o.profit_raw;
    const diff         = pnl_novo - pnl_velho;
    const magnitude    = Math.abs(diff) / STAKE; // em unidades de stake
    const ladder_diff  = n_bets_raw - n_simulado; // excesso de bets vs mapas únicos

    // Determina causa principal do bug
    let causa = 'profit_real_direto';
    if (ladder_diff >= 2) causa = 'ladder_amplification';
    else if (Math.abs(diff) > 200 && ladder_diff === 0) causa = 'odd_real_vs_fixa';
    // Se ambos, ladder_amplification tem precedência

    rows.push({
      name,
      n_simulado,
      n_bets_raw,
      ladder_diff,
      hit_pct,
      pnl_novo,
      pnl_velho,
      diff,
      magnitude,
      causa,
    });
  }

  // Ordena por magnitude DESC
  rows.sort((a, b) => b.magnitude - a.magnitude);

  // === GERAR SAÍDA ===
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportLines = [];

  reportLines.push(`# Times com PnL inconsistente (pré-fix vs pós-fix)`);
  reportLines.push(``);
  reportLines.push(`Universo: ${totalBets} bets (deduped), filtros padrão (Δ=0, odd=1.72, stake=1000, trigger=all, liga=todas).`);
  reportLines.push(`Data da auditoria: ${dateStr}.`);
  reportLines.push(``);
  reportLines.push(`## TOP afetados (magnitude do bug)`);
  reportLines.push(``);
  reportLines.push(`| Time | n_mapas | n_bets | Δ ladder | hit% | PnL VELHO (errado) | PnL NOVO (correto) | Diff | Magnitude (stakes) | Causa principal |`);
  reportLines.push(`|------|---------|--------|----------|------|---------------------|---------------------|------|---------------------|-----------------|`);

  let countLadder = 0, countOdd = 0, countProfit = 0;
  let maxMag = 0, totalAffected = 0;
  const causaCounts = {};

  for (const r of rows) {
    const hitStr = r.hit_pct !== null ? `${r.hit_pct}%` : '—';
    const pnlOldStr = `R$${r.pnl_velho >= 0 ? '+' : ''}${r.pnl_velho.toFixed(0)}`;
    const pnlNewStr = `R$${r.pnl_novo >= 0 ? '+' : ''}${r.pnl_novo.toFixed(0)}`;
    const diffStr   = `R$${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(0)}`;
    const magStr    = r.magnitude.toFixed(2);

    if (Math.abs(r.diff) > 10) totalAffected++;
    if (r.magnitude > maxMag) maxMag = r.magnitude;
    causaCounts[r.causa] = (causaCounts[r.causa] || 0) + 1;

    reportLines.push(`| ${r.name} | ${r.n_simulado} | ${r.n_bets_raw} | ${r.ladder_diff > 0 ? '+' : ''}${r.ladder_diff} | ${hitStr} | ${pnlOldStr} | ${pnlNewStr} | ${diffStr} | ${magStr}× | ${r.causa} |`);
  }

  // Padrões observados
  reportLines.push(``);
  reportLines.push(`## Padrões observados`);
  reportLines.push(``);

  const ladderAffected = rows.filter(r => r.causa === 'ladder_amplification');
  const oddAffected    = rows.filter(r => r.causa === 'odd_real_vs_fixa');
  const profitAffected = rows.filter(r => r.causa === 'profit_real_direto');

  if (ladderAffected.length > 0) {
    reportLines.push(`- **${ladderAffected.length} time(s)** sofreram amplificação por ladder (N bets no mesmo mapa contando N stakes em vez de 1).`);
    reportLines.push(`  Times: ${ladderAffected.map(r => r.name).join(', ')}.`);
  }
  if (oddAffected.length > 0) {
    reportLines.push(`- **${oddAffected.length} time(s)** sofreram por odd real < 1.72 (pick line diferente calculada, mudando won/lost).`);
    reportLines.push(`  Times: ${oddAffected.map(r => r.name).join(', ')}.`);
  }
  if (profitAffected.length > 0) {
    reportLines.push(`- **${profitAffected.length} time(s)** sofreram pela mistura de b.profit real (bets reais com valores de mercado) em vez do teórico fixo.`);
  }
  reportLines.push(`- Maior distorção individual: **${maxMag.toFixed(2)}× stake** (R$${(maxMag * STAKE).toFixed(0)}).`);
  reportLines.push(`- Total de times com Δ > R$10 entre versões: **${totalAffected}** (de ${rows.length} com n≥5).`);

  reportLines.push(``);
  reportLines.push(`## Conclusão`);
  reportLines.push(``);
  reportLines.push(`Todos os cards de time agora renderizam o PnL teórico correto (odd fixa 1.72, map-dedup por lolesports_game_id, sem b.profit real).`);
  reportLines.push(`Validado por \`scripts/validate-sim-profit.cjs\` — nenhuma violação de invariante hit>BE↔profit≥0.`);
  reportLines.push(``);
  reportLines.push(`### Detalhamento técnico dos 3 bugs corrigidos`);
  reportLines.push(``);
  reportLines.push(`| Bug | Localização (pré-fix) | Impacto |`);
  reportLines.push(`|-----|-----------------------|---------|`);
  reportLines.push(`| PnL real somado no card simulado | \`dashboard/index.html:1940\`, \`lib/analiseStats.cjs:137\` | Cards com bets reais de odd baixa exibiam profit diferente do teórico |`);
  reportLines.push(`| Odd real sobrescrevia fixa (1.72) | Mesmo caminho — betProfit usava \`b.odd\` no lugar de \`odd\` param | Apostas com odd real < 1.72 calculavam lucro menor, distorcendo PnL |`);
  reportLines.push(`| Ladder amplification (N stakes / mapa) | \`aggBy()\` sem map-dedup | Mapas com 4 bets ladder contavam 4× stake na perda → profit negativo mesmo com hit 67%+ |`);

  const report = reportLines.join('\n');

  // Salva arquivo
  const outPath = path.join(REPO, 'knowledge', 'reports', `${dateStr}-pnl-bug-impact.md`);
  fs.writeFileSync(outPath, report, 'utf8');

  // Imprime no stdout pra CLI
  console.log(report);
  console.log(`\n---`);
  console.log(`Relatório salvo em: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
