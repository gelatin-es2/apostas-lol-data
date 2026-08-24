'use strict';

// Teste do fix 2026-08-23: tiebreak por `version` na linha PRINCIPAL de Total Kills
// (`parseRelatedMarkets`, lib/pinnacle_core.cjs). Bug real medido em
// knowledge/reports/2026-08-23-pinnacle-br-vs-internacional.md (seção 3.5): em série
// ao vivo, 3 sub-matchups concorrentes publicam totals "principais" (isAlternate=false)
// conflitantes ao mesmo tempo, pro mesmo (série, mapa) — sem tiebreak, o main line
// gravado dependia de ordem de chegada/pontos, instável.
//
// Já existia tiebreak por version pra moneyline/spread (mlVersion/spreadVersion);
// este teste cobre a extensão do mesmo critério pro `total`.
//
// 100% offline — sem rede, sem Supabase, só testa a função pura.
// Uso: node .claude/scripts/tests/pinnacle-core-total-tiebreak.test.cjs

const path = require('path');
const core = require(path.join(__dirname, '..', 'lib', 'pinnacle_core.cjs'));

const results = [];
let failures = 0;

function test(name, fn) {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL  ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(`assert falhou: ${msg}`); }
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}

// Fabrica uma row de 'total' crua, no formato do endpoint /markets/related/straight.
function totalRow({ matchupId, period, points, overUS, underUS, version, isAlternate = false }) {
  return {
    matchupId, period, version, type: 'total', isAlternate,
    prices: [
      { designation: 'over', points, price: overUS },
      { designation: 'under', points, price: underUS },
    ],
  };
}

const KILLS_IDS = new Set([9001, 9002, 9003]); // 3 sub-matchups "irmãos" de Kills da série
const SERIES_ML_IDS = new Set([8000]); // matchup principal da série (fora do teste de total)

test('3 sub-matchups conflitantes (isAlternate=false) no mesmo period → vence maior version', () => {
  // Reproduz o tick #4 do relatório 2026-08-23: 27.5@1.763 (v3), 27.5@1.877 (v3, empate),
  // 26.5@2.01 (v5, vencedor). Ordem de chegada = ordem "normal" (empate primeiro, vencedor por último).
  const rows = [
    totalRow({ matchupId: 9001, period: 2, points: 27.5, overUS: -110, underUS: -110, version: 3 }),
    totalRow({ matchupId: 9002, period: 2, points: 27.5, overUS: -120, underUS: 100, version: 3 }),
    totalRow({ matchupId: 9003, period: 2, points: 26.5, overUS: 101, underUS: -125, version: 5 }),
  ];
  const byMap = core.parseRelatedMarkets(rows, KILLS_IDS, SERIES_ML_IDS);
  const mains = byMap[2].totals.filter((t) => !t.isAlternate);
  assertEq(mains.length, 1, 'exatamente 1 total principal sobrevive ao conflito');
  assertEq(mains[0].points, 26.5, 'sobrevivente é o de maior version (v5)');
  assertEq(mains[0].overUS, 101, 'preço do sobrevivente é o do v5, não dos v3 descartados');
});

test('mesmo conflito, ORDEM DE CHEGADA invertida → resultado idêntico (não depende mais de ordem)', () => {
  // Mesmas 3 rows, vencedor (v5) chega PRIMEIRO desta vez — antes do fix isso já mudava
  // o resultado (dependia de ordem/pontos); com o fix o resultado tem que ser igual.
  const rows = [
    totalRow({ matchupId: 9003, period: 2, points: 26.5, overUS: 101, underUS: -125, version: 5 }),
    totalRow({ matchupId: 9001, period: 2, points: 27.5, overUS: -110, underUS: -110, version: 3 }),
    totalRow({ matchupId: 9002, period: 2, points: 27.5, overUS: -120, underUS: 100, version: 3 }),
  ];
  const byMap = core.parseRelatedMarkets(rows, KILLS_IDS, SERIES_ML_IDS);
  const mains = byMap[2].totals.filter((t) => !t.isAlternate);
  assertEq(mains.length, 1, 'exatamente 1 total principal sobrevive (ordem invertida)');
  assertEq(mains[0].points, 26.5, 'vencedor continua sendo o de maior version, independente de ordem');
  assertEq(mains[0].overUS, 101, 'preço correto independente de ordem de chegada');
});

test('empate de version entre 2 candidatos principais → mantém o 1º visto, determinístico', () => {
  const rows = [
    totalRow({ matchupId: 9001, period: 3, points: 24.5, overUS: -105, underUS: -115, version: 7 }),
    totalRow({ matchupId: 9002, period: 3, points: 25.5, overUS: -108, underUS: -112, version: 7 }),
  ];
  const byMap = core.parseRelatedMarkets(rows, KILLS_IDS, SERIES_ML_IDS);
  const mains = byMap[3].totals.filter((t) => !t.isAlternate);
  assertEq(mains.length, 1, 'empate de version não deixa 2 principais convivendo');
  assertEq(mains[0].points, 24.5, 'em empate, mantém o 1º visto (determinístico dentro de 1 parse)');
});

test('ladder (isAlternate=true) não é afetada pelo tiebreak — sobrevive mesmo com version baixa', () => {
  const rows = [
    totalRow({ matchupId: 9001, period: 1, points: 23.5, overUS: -200, underUS: 150, version: 1, isAlternate: true }),
    totalRow({ matchupId: 9001, period: 1, points: 24.5, overUS: -150, underUS: 120, version: 1, isAlternate: true }),
    totalRow({ matchupId: 9001, period: 1, points: 25.5, overUS: -110, underUS: -110, version: 9, isAlternate: false }),
    totalRow({ matchupId: 9002, period: 1, points: 25.5, overUS: -108, underUS: -112, version: 3, isAlternate: false }), // challenger velho
  ];
  const byMap = core.parseRelatedMarkets(rows, KILLS_IDS, SERIES_ML_IDS);
  const alternates = byMap[1].totals.filter((t) => t.isAlternate);
  const mains = byMap[1].totals.filter((t) => !t.isAlternate);
  assertEq(alternates.length, 2, 'as 2 alternates da ladder sobrevivem intactas');
  assertEq(mains.length, 1, 'só 1 principal sobrevive');
  assertEq(mains[0].points, 25.5, 'principal é o de maior version (v9)');
  assertEq(mains[0].overUS, -110, 'preço do principal vencedor preservado');
});

test('regressão — cenário normal sem conflito (1 fonte só) continua funcionando como antes', () => {
  const rows = [
    totalRow({ matchupId: 9001, period: 1, points: 27.5, overUS: -110, underUS: -110, version: 2 }),
    totalRow({ matchupId: 9001, period: 1, points: 26.5, overUS: -150, underUS: 120, version: 2, isAlternate: true }),
    totalRow({ matchupId: 9001, period: 1, points: 28.5, overUS: 105, underUS: -130, version: 2, isAlternate: true }),
  ];
  const byMap = core.parseRelatedMarkets(rows, KILLS_IDS, SERIES_ML_IDS);
  assertEq(byMap[1].totals.length, 3, 'total de 3 linhas (1 principal + 2 alternates)');
  const main = byMap[1].totals.find((t) => !t.isAlternate);
  assertEq(main.points, 27.5, 'linha principal preservada no caso sem conflito');
  // buildTimelineEntries usa o mesmo find() pra extrair mainTotal — checa que ele
  // ainda resolve corretamente contra o byMap produzido.
  const ladder = byMap[1].totals.slice().sort((a, b) => a.points - b.points).map((t) => t.points);
  assert(JSON.stringify(ladder) === JSON.stringify([26.5, 27.5, 28.5]), 'ladder ordenada preservada');
});

console.log('\n══ pinnacle_core — tiebreak de version pra total (série ao vivo) — resultado ══\n');
for (const r of results) console.log(r);
console.log(`\n${results.length - failures}/${results.length} passaram${failures ? ` — ${failures} FALHARAM` : ''}`);
process.exit(failures ? 1 : 0);
