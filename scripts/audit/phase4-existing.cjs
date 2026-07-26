// scripts/audit/phase4-existing.cjs
//
// Roda a bateria de auditorias que JÁ EXISTE no repo (não recria lógica — só orquestra
// via child_process, captura stdout/stderr/exit code e extrai um resumo de cada uma).
//
// Scripts agregados:
//   1. npm run audit:aliases              (.claude/scripts/audit_team_aliases.cjs)
//   2. node scripts/validate-sim-profit.cjs
//   3. node .claude/scripts/dedup-bets-audit.cjs
//   4. node audit_status_settle.cjs
//   5. node quick-audit.cjs
//
// IMPORTANTE: nenhum desses 5 scripts filtra por data — auditam o banco INTEIRO. Um
// finding aqui pode estar fora do período do split 2 (2026-04-01 a 2026-06-30). A
// triagem por escopo fica pro relatório consolidado (fase 6), não pra este script.
//
// Read-only: nenhum dos 5 escreve no Supabase (dedup roda em --dry-run por padrão, que
// é o modo usado aqui — não passamos flag de execução).
//
// Output: audit-output/04-existing.json + outputs completos em audit-output/raw/*.txt
//
// Uso: node scripts/audit/phase4-existing.cjs

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'audit-output');
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const SCOPE_NOTE =
  'Script audita o banco INTEIRO, sem filtro de data — findings podem cair fora do ' +
  'split 2 (2026-04-01 a 2026-06-30); triagem por escopo fica pro relatório consolidado.';

function runCmd(cmd, args, shell) {
  // Nota: com shell:true, passar o comando inteiro como string única (args=[]) em vez
  // de array evita DEP0190 (Node desencoraja array de args + shell:true) e é necessário
  // no Windows pra achar npm.cmd (spawnSync direto em 'npm.cmd' sem shell dá EINVAL).
  if (shell) {
    const full = [cmd, ...args].join(' ');
    return spawnSync(full, [], { cwd: REPO, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  }
  return spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function saveRaw(name, cmdLabel, r) {
  const rawPath = path.join(RAW_DIR, `${name}.txt`);
  const body =
    `$ ${cmdLabel}\n\n` +
    `--- STDOUT ---\n${r.stdout || ''}\n\n` +
    `--- STDERR ---\n${r.stderr || ''}\n\n` +
    `--- exit: ${r.status} ${r.error ? `(spawn error: ${r.error.message})` : ''} ---\n`;
  fs.writeFileSync(rawPath, body);
  return path.relative(REPO, rawPath).replace(/\\/g, '/');
}

function firstMatch(str, re) {
  const m = re.exec(str);
  return m ? m[0] : null;
}

// ─── 1. npm run audit:aliases ───────────────────────────────────────────────
function checkAliases() {
  const cmdLabel = 'npm run audit:aliases';
  const r = runCmd('npm', ['run', 'audit:aliases'], true);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rawPath = saveRaw('audit-aliases', cmdLabel, r);

  // exit 1 é comportamento ESPERADO quando há aliases faltando (não é crash).
  // Só é crash de verdade se o marcador final "Cobertura:" nunca apareceu.
  const crashed = !!r.error || !/^Cobertura:/m.test(stdout);

  const coverageLine = firstMatch(stdout, /^Cobertura:.*$/m);
  const missingLine = firstMatch(stdout, /^Aliases faltando:.*$/m);
  const dupCount = (stdout.match(/🔴 DUPLICATA ATIVA/g) || []).length;
  const missingCount = (stdout.match(/❌ FALTA ALIAS/g) || []).length;

  const summary = crashed
    ? [
        `ERRO: script não completou como esperado (exit=${r.status}).`,
        ...(r.error ? [`spawn error: ${r.error.message}`] : []),
        ...stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
      ]
    : [
        coverageLine || 'Cobertura: (marcador não encontrado)',
        missingLine || 'Aliases faltando: (marcador não encontrado)',
        `Duplicatas ativas (grupos): ${dupCount}`,
        `Sugestões de alias faltando: ${missingCount}`,
        SCOPE_NOTE,
      ];

  return {
    script: cmdLabel,
    exit_code: r.status,
    ok: !crashed,
    summary,
    raw_output_path: rawPath,
  };
}

// ─── 2. validate-sim-profit.cjs ─────────────────────────────────────────────
function checkSimProfit() {
  const cmdLabel = 'node scripts/validate-sim-profit.cjs';
  const r = runCmd(process.execPath, [path.join(REPO, 'scripts', 'validate-sim-profit.cjs')]);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rawPath = saveRaw('validate-sim-profit', cmdLabel, r);

  const totalLine = firstMatch(stdout, /^Total bets:.*$/m);
  const passouLine = firstMatch(stdout, /^PASSOU:.*$/m);
  // FALHOU e as linhas de violação vão pra stderr (console.error)
  const falhouLine = firstMatch(stderr, /^FALHOU:.*$/m);
  const resultLine = passouLine || falhouLine;
  const espritLine = firstMatch(stdout, /^Esprit Shonen[\s\S]{0,20}/m);

  const crashed = !!r.error || !resultLine;

  const violationLines = falhouLine
    ? (stderr.match(/^\s+-\s.+$/gm) || []).slice(0, 4)
    : [];

  const summary = crashed
    ? [
        `ERRO: script não completou (exit=${r.status}).`,
        ...(r.error ? [`spawn error: ${r.error.message}`] : []),
        ...stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
      ]
    : [
        totalLine || 'Total bets: (não encontrado)',
        resultLine,
        ...violationLines,
        SCOPE_NOTE,
      ];

  return {
    script: cmdLabel,
    exit_code: r.status,
    ok: !crashed,
    summary,
    raw_output_path: rawPath,
  };
}

// ─── 3. dedup-bets-audit.cjs ────────────────────────────────────────────────
function checkDedup() {
  const cmdLabel = 'node .claude/scripts/dedup-bets-audit.cjs';
  const r = runCmd(process.execPath, [path.join(REPO, '.claude', 'scripts', 'dedup-bets-audit.cjs')]);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rawPath = saveRaw('dedup-bets-audit', cmdLabel, r);

  let parsed = null;
  let parseErr = null;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    parseErr = e.message;
  }

  const crashed = !!r.error || !parsed || !parsed.summary;

  const summary = crashed
    ? [
        `ERRO: não foi possível parsear JSON de saída (exit=${r.status}).`,
        ...(parseErr ? [`parse error: ${parseErr}`] : []),
        ...stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
      ]
    : [
        `Total bets no banco: ${parsed.summary.total_bets_in_db}`,
        `Grupos duplicados: ${parsed.summary.duplicate_groups}`,
        `Bets marcadas p/ deleção (se rodar execute): ${parsed.summary.total_bets_to_delete}`,
        `Bets após dedup: ${parsed.summary.bets_after_dedup}`,
        `Maior grupo: ${parsed.summary.largest_group_size} bets`,
        SCOPE_NOTE,
      ];

  return {
    script: cmdLabel,
    exit_code: r.status,
    ok: !crashed,
    summary,
    raw_output_path: rawPath,
  };
}

// ─── 4. audit_status_settle.cjs ─────────────────────────────────────────────
function checkStatusSettle() {
  const cmdLabel = 'node audit_status_settle.cjs';
  const r = runCmd(process.execPath, [path.join(REPO, 'audit_status_settle.cjs')]);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rawPath = saveRaw('audit_status_settle', cmdLabel, r);

  const crashed = !!r.error || r.status !== 0 || !/STATUS DISTRIBUTION/.test(stdout);

  const totalBets = firstMatch(stdout, /^Total bets:\s*\d+/m);
  const pendingForever = (stdout.match(/PENDING FOREVER \(>7 days\):\s*(\d+)/) || [])[1];
  const cashoutCount = (stdout.match(/CASHOUT:\s*(\d+) bets/) || [])[1];
  const voidCount = (stdout.match(/VOID:\s*(\d+)/) || [])[1];
  const refundCount = (stdout.match(/REFUND:\s*(\d+)/) || [])[1];
  const settledPending = (stdout.match(/SETTLED BUT PENDING \(bug\):\s*(\d+)/) || [])[1];

  const summary = crashed
    ? [
        `ERRO: script não completou (exit=${r.status}).`,
        ...(r.error ? [`spawn error: ${r.error.message}`] : []),
        ...stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
      ]
    : [
        totalBets || 'Total bets: (não encontrado)',
        `Pending forever (>7 dias): ${pendingForever ?? '?'}`,
        `Settled mas pending (bug): ${settledPending ?? '?'}`,
        `Cashout: ${cashoutCount ?? '?'} | Void: ${voidCount ?? '?'} | Refund: ${refundCount ?? '?'}`,
        SCOPE_NOTE,
      ];

  return {
    script: cmdLabel,
    exit_code: r.status,
    ok: !crashed,
    summary,
    raw_output_path: rawPath,
  };
}

// ─── 5. quick-audit.cjs ─────────────────────────────────────────────────────
function checkQuickAudit() {
  const cmdLabel = 'node quick-audit.cjs';
  const r = runCmd(process.execPath, [path.join(REPO, 'quick-audit.cjs')]);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rawPath = saveRaw('quick-audit', cmdLabel, r);

  const crashed = !!r.error || r.status !== 0 || !/LEVENSHTEIN DISTANCE/.test(stdout);

  const levSection = (stdout.split('=== LEVENSHTEIN DISTANCE')[1] || '').split('=== SHORT SIGLAS')[0];
  const levPairs = (levSection.match(/↔/g) || []).length;
  const sigSection = (stdout.split('=== SHORT SIGLAS')[1] || '').split('=== LIGAS')[0];
  const sigLines = (sigSection.match(/n=\d+/g) || []).length;
  const legitCount = (stdout.match(/LEGIT \(main \+ EWC\):\s*(\d+)/) || [])[1];
  const suspCount = (stdout.match(/SUSPEITO \(unusual\):\s*(\d+)/) || [])[1];

  const summary = crashed
    ? [
        `ERRO: script não completou (exit=${r.status}).`,
        ...(r.error ? [`spawn error: ${r.error.message}`] : []),
        ...stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
      ]
    : [
        `Pares de nomes suspeitos (Levenshtein<3): ${levPairs}`,
        `Siglas curtas (≤3 chars) sem mapeamento: ${sigLines}`,
        `Times multi-liga — legit (main+EWC): ${legitCount ?? '0'} | suspeito: ${suspCount ?? '0'}`,
        SCOPE_NOTE,
      ];

  return {
    script: cmdLabel,
    exit_code: r.status,
    ok: !crashed,
    summary,
    raw_output_path: rawPath,
  };
}

function main() {
  console.error('[phase4-existing] Rodando bateria de auditorias já existentes...\n');

  const checks = [
    { name: 'audit_team_aliases', fn: checkAliases },
    { name: 'validate_sim_profit', fn: checkSimProfit },
    { name: 'dedup_bets_audit', fn: checkDedup },
    { name: 'audit_status_settle', fn: checkStatusSettle },
    { name: 'quick_audit', fn: checkQuickAudit },
  ];

  const results = [];
  for (const c of checks) {
    console.error(`>>> ${c.name}`);
    let result;
    try {
      result = c.fn();
    } catch (e) {
      result = {
        script: c.name,
        exit_code: null,
        ok: false,
        summary: [`ERRO inesperado no runner: ${e.message}`],
        raw_output_path: null,
      };
    }
    console.error(`    ok=${result.ok} exit=${result.exit_code}`);
    results.push({ name: c.name, ...result });
  }

  const output = {
    generated_at: new Date().toISOString(),
    scope_note: SCOPE_NOTE,
    results,
  };

  const outPath = path.join(OUT_DIR, '04-existing.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n=== Fase 4 — bateria de auditorias existentes ===\n`);
  console.log(`Script`.padEnd(28) + `OK`.padEnd(6) + `Exit`.padEnd(6) + 'Resumo');
  console.log('-'.repeat(100));
  for (const r of results) {
    console.log(`${r.name.padEnd(28)}${String(r.ok).padEnd(6)}${String(r.exit_code).padEnd(6)}${r.summary[0] || ''}`);
  }
  console.log(`\nOutput salvo em: ${path.relative(REPO, outPath).replace(/\\/g, '/')}`);
  console.log(`Raws completos em: ${path.relative(REPO, RAW_DIR).replace(/\\/g, '/')}/`);
}

main();
