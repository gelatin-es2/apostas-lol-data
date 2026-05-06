// Wrapper retrocompatível: delega pra analyze_range.cjs (fair line dinâmica via livestats team avg -1).
// Uso: node analyze_yesterday.cjs              → ontem (UTC)
//      node analyze_yesterday.cjs YYYY-MM-DD   → data específica
//
// Substitui a versão antiga que usava Oracle CSV + fair fixa 29.5.
// Razão: ver knowledge/decisions/2026-05-06-fair-line-livestats-team-avg.md

const path = require('path');
const { spawnSync } = require('child_process');

function ymd(d) { return d.toISOString().slice(0, 10); }
const TARGET = process.argv[2] || ymd(new Date(Date.now() - 24 * 3600 * 1000));

const r = spawnSync('node', [
  path.join(__dirname, 'analyze_range.cjs'),
  '--from', TARGET,
  '--to', TARGET,
], { stdio: 'inherit' });

process.exit(r.status ?? 1);
