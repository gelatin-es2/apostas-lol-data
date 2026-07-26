// FASE 0 — Blindagem de dados pro método OVER. READ-ONLY.
// Inspeciona method_reports: cobertura split 2, fair/kills/supports populados,
// distribuição de trigger, e se jogos SEM trigger têm os campos necessários.

'use strict';
const { loadConfig } = require('./_load-config.cjs');
const { supabaseGet } = require('../../lib/supabaseQuery.cjs');

const SPLIT2 = '2026-04-01';

(async () => {
  const { supabaseUrl, supabaseKey, source } = loadConfig();
  console.log(`# FASE 0 — inspeção method_reports (creds via ${source})\n`);

  // Puxa tudo do split 2 (paginado se preciso; method_reports ~ centenas de rows)
  const cols = 'match_date,league,game_id,map_number,team_blue,team_red,sup_blue,sup_red,trigger_type,total_kills,fair_line,fair_source,under_hit';
  const rows = await supabaseGet(
    supabaseUrl, supabaseKey,
    `/rest/v1/method_reports?select=${cols}&match_date=gte.${SPLIT2}&order=match_date.asc&limit=5000`
  );
  console.log(`Total rows split 2 (>=${SPLIT2}): ${rows.length}\n`);

  const has = (v) => v !== null && v !== undefined && v !== '';
  const n = rows.length;

  // Cobertura de campos
  const cov = {
    total_kills: rows.filter(r => has(r.total_kills)).length,
    fair_line: rows.filter(r => has(r.fair_line)).length,
    sup_blue: rows.filter(r => has(r.sup_blue)).length,
    sup_red: rows.filter(r => has(r.sup_red)).length,
    trigger_type: rows.filter(r => has(r.trigger_type)).length,
  };
  console.log('## Cobertura de campos (preenchidos / total)');
  for (const [k, v] of Object.entries(cov)) {
    console.log(`  ${k.padEnd(14)}: ${v}/${n}  (${(100*v/n).toFixed(1)}%)`);
  }

  // Distribuição de trigger
  console.log('\n## Distribuição de trigger_type');
  const trig = {};
  for (const r of rows) {
    const t = has(r.trigger_type) ? r.trigger_type : '(vazio/none)';
    trig[t] = (trig[t] || 0) + 1;
  }
  for (const [t, c] of Object.entries(trig).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${String(t).padEnd(18)}: ${c}`);
  }

  // Quantos jogos NÃO acionam Under (universo Over) e têm fair+kills+supports
  const underTriggers = new Set(['2peel', '1peel+flex']);
  const nonUnder = rows.filter(r => !underTriggers.has(r.trigger_type));
  const nonUnderUsable = nonUnder.filter(r => has(r.total_kills) && has(r.fair_line) && (has(r.sup_blue) || has(r.sup_red)));
  console.log(`\n## Universo OVER (exclui 2peel + 1peel+flex)`);
  console.log(`  Jogos non-Under: ${nonUnder.length}`);
  console.log(`  ...com fair+kills+ao menos 1 support: ${nonUnderUsable.length}`);

  // Calibração G3: Over-hit% global (todo split 2 com fair+kills) e no universo non-Under
  const usableAll = rows.filter(r => has(r.total_kills) && has(r.fair_line));
  const overAll = usableAll.filter(r => Number(r.total_kills) > Number(r.fair_line)).length;
  const usableNU = nonUnder.filter(r => has(r.total_kills) && has(r.fair_line));
  const overNU = usableNU.filter(r => Number(r.total_kills) > Number(r.fair_line)).length;
  console.log(`\n## G3 — Calibração da fair (Over-hit = kills > fair)`);
  console.log(`  Global  (n=${usableAll.length}): ${(100*overAll/usableAll.length).toFixed(1)}%  [esperado ~50% se fair não-enviesada]`);
  console.log(`  nonUnder(n=${usableNU.length}): ${(100*overNU/usableNU.length).toFixed(1)}%`);

  // Por liga (split 2)
  console.log('\n## Rows por liga (split 2)');
  const byLg = {};
  for (const r of rows) { const l = r.league || '(null)'; byLg[l] = (byLg[l]||0)+1; }
  for (const [l, c] of Object.entries(byLg).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(l).padEnd(10)}: ${c}`);

  // fair_source distribution
  console.log('\n## fair_source');
  const bySrc = {};
  for (const r of rows) { const s = r.fair_source || '(null)'; bySrc[s]=(bySrc[s]||0)+1; }
  for (const [s,c] of Object.entries(bySrc).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(s).padEnd(34)}: ${c}`);

  // Amostra de 3 rows non-Under pra cross-check manual (G7)
  console.log('\n## Amostra 3 rows non-Under (cross-check G7)');
  for (const r of nonUnderUsable.slice(0, 3)) {
    console.log(`  ${r.match_date} ${r.league} ${r.team_blue} vs ${r.team_red} m${r.map_number} | sup ${r.sup_blue}/${r.sup_red} | kills ${r.total_kills} fair ${r.fair_line} src ${r.fair_source}`);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
