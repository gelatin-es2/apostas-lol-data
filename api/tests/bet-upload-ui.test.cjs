'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dashboard = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf8');
const prompt = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-codex-prompt.txt'), 'utf8');
const registerApi = fs.readFileSync(path.resolve(__dirname, '../bets/register.js'), 'utf8');

test('dashboard enfileira e acompanha todos os estados sem revisao humana', () => {
  assert.match(dashboard, /fetch\('\/api\/bets\/register'/);
  assert.match(dashboard, /\/api\/bets\/upload-status\?id=/);
  for (const status of ['queued', 'processing', 'registered', 'rejected', 'error']) {
    assert.match(dashboard, new RegExp(`job\\.status === '${status}'`), `estado ausente: ${status}`);
  }
  assert.match(dashboard, /localStorage\.setItem\('betUploadJobId'/);
  assert.match(dashboard, /setTimeout\(\(\) => pollRegisterJob/);
  assert.doesNotMatch(dashboard, /revisar campos|confirmar campos/i);
});

test('feature nao depende de OpenAI e prompt obriga skill canonica', () => {
  assert.doesNotMatch(registerApi, /openai|OPENAI_API_KEY/i);
  assert.match(prompt, /skill `bet-logger-extract`/);
  assert.match(prompt, /Nunca finalize `registered` sem UUID real/);
  assert.match(prompt, /claim codex-bet-logger 3600/);
});

test('UI informa 14 dias e automacao executa purge restrito', () => {
  assert.match(dashboard, /privado por 14 dias/);
  assert.match(prompt, /bet-upload-jobs\.cjs purge codex-bet-purge 600 25/);
  assert.match(prompt, /somente o comando purge/);
  assert.match(registerApi, /purge_after,screenshot_deleted_at/);
});

test('automacao limpa somente o TEMP local exato depois de estado terminal', () => {
  assert.match(prompt, /cron-data\/bet-upload-work\/<id>\.<ext>/);
  assert.match(prompt, /Remove-Item -LiteralPath "cron-data\/bet-upload-work\/<id>\.<ext>" -Force/);
  assert.match(prompt, /estado terminal `registered`, `rejected` ou `error`/);
  assert.match(prompt, /Nunca use curingas, `-Recurse` nem remova outro path/);
  assert.match(prompt, /Nunca apague o objeto do Storage diretamente/);
  assert.match(prompt, /retencao privada de 14 dias/);
});

test('toggle existente continua direto no Supabase sem depender da nova API', () => {
  const start = dashboard.indexOf('async function toggleMethodBet(');
  const end = dashboard.indexOf('\n    function renderOffMethodSection', start);
  const toggle = dashboard.slice(start, end);
  assert.match(toggle, /sb\s*\.from\('bets'\)\s*\.update\(\{ is_method_bet: newVal \}\)\s*\.eq\('id', betId\)/);
  assert.doesNotMatch(toggle, /\/api\/bets\/toggle-method|sb\.auth|getSession/);
});
