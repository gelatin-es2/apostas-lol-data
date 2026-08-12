'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const workflowPath = path.resolve(__dirname, '../../.github/workflows/settle-pending.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('workflow de settle roda a cada 30 min e também manualmente', () => {
  assert.match(workflow, /cron:\s*['"]\*\/30 \* \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:\s*\{\}/);
});

test('workflow serializa execuções, não cancela settle ativo e tem timeout', () => {
  assert.match(workflow, /group:\s*settle-pending-bets/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /timeout-minutes:\s*10/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*read/);
});

test('workflow usa Node 20, secrets via env e modo outcome-only', () => {
  assert.match(workflow, /node-version:\s*['"]20['"]/);
  for (const name of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'LOLESPORTS_API_KEY']) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  assert.match(workflow, /run:\s*node \.claude\/scripts\/settle-pending-bets\.cjs --outcome-only/);
  assert.doesNotMatch(workflow, /--dry-run\s+--outcome-only|--no-verify|continue-on-error/);
});
