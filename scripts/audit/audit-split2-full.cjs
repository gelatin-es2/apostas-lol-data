// scripts/audit/audit-split2-full.cjs
//
// Orquestrador da auditoria completa Split 2. Fases 0-5 + build-report (fase 6) todas
// implementadas — ver knowledge/audits/2026-07-20-auditoria-split2.md pro relatório
// consolidado e C:\Users\Elvis\.claude\plans\breezy-fluttering-rivest.md pro plano original.
//
// Uso:
//   node audit-split2-full.cjs --phase=0 --league=LCK
//   node audit-split2-full.cjs --phase=0 --all
//   node audit-split2-full.cjs --phase=1
//   node audit-split2-full.cjs --phase=all      (roda 0→6 em sequência)
//
// Qualquer flag além de --phase= é repassada como está pro script da fase (ex: --league=X, --all).
// Fases 1-6 ignoram flags extras (não usam --league/--all, só a 0 usa).

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const argv = process.argv.slice(2);
const phaseArg = argv.find((a) => a.startsWith('--phase='));
const phase = phaseArg ? phaseArg.split('=')[1] : null;
const passthroughArgs = argv.filter((a) => !a.startsWith('--phase='));

if (!phase) {
  console.error('Uso: node audit-split2-full.cjs --phase=0|1|2|3|4|5|6|all [--league=X|--all]');
  process.exit(1);
}

function runScript(scriptName, args) {
  const scriptPath = path.join(__dirname, scriptName);
  console.error(`\n>>> node ${scriptName} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[audit-split2-full] ${scriptName} saiu com código ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function runPhase(p) {
  switch (p) {
    case '0':
      runScript('phase0-universe.cjs', passthroughArgs);
      return;
    case '1':
      runScript('phase1-coverage.cjs', []);
      return;
    case '2':
      runScript('phase2-bet-data.cjs', []);
      return;
    case '3':
      runScript('phase3-method-reports.cjs', []);
      return;
    case '4':
      runScript('phase4-existing.cjs', []);
      return;
    case '5':
      runScript('phase5-ewc.cjs', []);
      return;
    case '6':
      runScript('build-report.cjs', []);
      return;
    default:
      console.error(`Fase desconhecida: "${p}". Válidas: 0, 1, 2, 3, 4, 5, 6, all`);
      process.exit(1);
  }
}

const phasesToRun = phase === 'all' ? ['0', '1', '2', '3', '4', '5', '6'] : [phase];
for (const p of phasesToRun) runPhase(p);
