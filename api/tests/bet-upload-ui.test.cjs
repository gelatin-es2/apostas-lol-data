'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dashboard = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf8');
const prompt = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-codex-prompt.txt'), 'utf8');
const registerApi = fs.readFileSync(path.resolve(__dirname, '../bets/register.js'), 'utf8');
const registerMarkup = dashboard.slice(
  dashboard.indexOf('<main class="container tab-pane" data-pane="registrar">'),
  dashboard.indexOf('<main class="container tab-pane" data-pane="tracker">'),
);

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
  assert.match(dashboard, /salvo por 14 dias/);
  assert.match(prompt, /bet-upload-jobs\.cjs purge codex-bet-purge 600 25/);
  assert.match(prompt, /somente o comando purge/);
  assert.match(registerApi, /purge_after,screenshot_deleted_at/);
});

test('registrar e chat com paste, fallback de arquivo, preview e descricao opcional', () => {
  assert.match(registerMarkup, /register-chat-log/);
  assert.match(registerMarkup, /Informação extra \(opcional\)/);
  assert.match(registerMarkup, /registerPreview/);
  assert.match(registerMarkup, /\+ Imagem/);
  assert.match(dashboard, /document\.addEventListener\('paste'/);
  assert.match(dashboard, /event\.clipboardData/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ image_data_url: dataUrl, description \}\)/);
  for (const message of ['Enviando o comprovante', 'está na fila', 'lendo o print', 'registrada como pendente', 'Envie outro print', 'Falha técnica']) {
    assert.match(dashboard, new RegExp(message), `bolha ausente: ${message}`);
  }
});

test('paste global so captura imagem quando a pane registrar esta ativa', () => {
  const pasteStart = dashboard.indexOf("document.addEventListener('paste'");
  const pasteEnd = dashboard.indexOf('\n    });', pasteStart) + '\n    });'.length;
  const pasteHandler = dashboard.slice(pasteStart, pasteEnd);
  assert.ok(pasteStart > 0, 'listener global de paste ausente');
  assert.match(pasteHandler, /\.tab-pane\[data-pane="registrar"\]/);
  assert.match(pasteHandler, /if \(!registerPane\?\.classList\.contains\('active'\)\) return/);
  assert.match(pasteHandler, /item\.kind === 'file' && item\.type\.startsWith\('image\/'\)/);
  assert.match(pasteHandler, /if \(!imageItem\) return;\s*event\.preventDefault\(\)/);
  assert.doesNotMatch(pasteHandler, /preventDefault\(\)[\s\S]*if \(!imageItem\)/);
});

test('aba nao aceita segredo e exige cookie server-side invisivel', () => {
  assert.doesNotMatch(registerMarkup, /e-mail|email|magic|link de acesso|código de acesso|type="password"|registerAccessCode|registerUnlock|>Liberar</i);
  assert.doesNotMatch(dashboard, /signInWithOtp|registerMagicLink|registerEmail|method:\s*'POST'[\s\S]{0,300}\/api\/bets\/access/);
  assert.match(dashboard, /fetch\('\/api\/bets\/access'/);
  assert.match(dashboard, /credentials: 'same-origin'/);
  assert.match(dashboard, /Este navegador precisa ser liberado\./);
  assert.match(registerMarkup, /id="registerDescription"[^>]*disabled/);
  assert.match(registerMarkup, /id="registerSend"[^>]*disabled/);
  assert.match(dashboard, /setRegisterComposerEnabled\(Boolean\(registerAuthHeaders\)\)/);
  assert.doesNotMatch(dashboard, /BET_UPLOAD_ACCESS_CODE|BET_UPLOAD_SESSION_SECRET|BET_UPLOAD_OWNER_ID/);
});

test('descricao e contexto auxiliar e nunca substitui evidencia do print', () => {
  assert.match(prompt, /description.*somente contexto auxiliar/);
  assert.match(prompt, /nunca substitui evidencia do print/);
  assert.match(prompt, /nunca relaxa validacoes/);
  assert.match(prompt, /JSON minimo auditavel[\s\S]*description recebida/);
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
