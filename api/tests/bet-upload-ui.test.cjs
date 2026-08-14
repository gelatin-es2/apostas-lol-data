'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dashboard = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf8');
const prompt = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-worker-prompt.txt'), 'utf8');
const registerApi = fs.readFileSync(path.resolve(__dirname, '../bets/register.js'), 'utf8');
const imageComposer = fs.readFileSync(path.resolve(__dirname, '../../dashboard/register-image-composer.mjs'), 'utf8');
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

test('feature nao depende de OpenAI/Codex e prompt usa o checklist canonico do bet-logger', () => {
  assert.doesNotMatch(registerApi, /openai|OPENAI_API_KEY/i);
  assert.doesNotMatch(prompt, /codex|skill `bet-logger-extract`/i);
  assert.match(prompt, /\.claude\/agents\/bet-logger\.md/);
  assert.match(prompt, /Nunca finalize `registered` sem UUID real/);
  assert.match(prompt, /claim claude-bet-logger 3600/);
  assert.match(prompt, /EstrelaBet, Pinnacle, Parimatch, Betano legado, Whale\.io e Polymarket/);
  assert.match(prompt, /stake.*round\(cost_usd \* fx_usd_brl, 2\)/);
  assert.match(prompt, /ticket\/order id e opcional/);
  assert.match(prompt, /getEventDetails para confirmar o mapa/);
});

test('prompt manda o worker resolver lolesports_match_id e mapping esportsTeamId antes de salvar', () => {
  assert.match(prompt, /lolesports-find-match\.cjs <team_a> <team_b> today/);
  assert.match(prompt, /esportsTeamId -> nome canonico/);
  assert.match(prompt, /NUNCA assuma blue=team_a/);
  assert.match(prompt, /bet_datetime.*startTime.*do match/);
  assert.match(prompt, /hedge sintetico/);
});

test('worker usa allowlist fechada de error_code para rejeicoes', () => {
  assert.match(prompt, /unsupported_bookmaker` -> `Casa de aposta invalida\.`/);
  assert.match(prompt, /unreadable_image` -> `Nao consegui ler o comprovante\. Envie outro print mais claro\.`/);
  assert.match(prompt, /unsupported_receipt` -> `Comprovante de aposta nao reconhecido\.`/);
  assert.match(prompt, /too_many_bets` -> `O print tem mais de 10 apostas\.`/);
  assert.match(prompt, /ambiguous_bet` -> /);
  assert.match(prompt, /duplicate_bet` -> /);
  assert.match(prompt, /extraction_failed` -> /);
  assert.doesNotMatch(prompt, /demais -> mensagem curta e sanitizada coerente\./);
  assert.doesNotMatch(prompt, /<codigo_curto> "Envie outro print mais claro"/);
});

test('UI informa 14 dias e automacao executa purge restrito', () => {
  assert.match(dashboard, /salvo por 14 dias/);
  assert.match(prompt, /bet-upload-jobs\.cjs purge claude-bet-purge 600 25/);
  assert.match(prompt, /somente o comando purge/);
  assert.match(registerApi, /purge_after,screenshot_deleted_at/);
});

test('registrar aceita ate 2 previews por paste ou seletor multiplo', () => {
  assert.match(registerMarkup, /register-chat-log/);
  assert.match(registerMarkup, /Informação extra \(opcional\)/);
  assert.match(registerMarkup, /registerPreview/);
  assert.match(registerMarkup, /\+ Imagem/);
  assert.match(registerMarkup, /type="file"[^>]*multiple/);
  assert.match(registerMarkup, /Até 2 prints/);
  assert.match(dashboard, /document\.addEventListener\('paste'/);
  assert.match(dashboard, /event\.clipboardData/);
  assert.match(dashboard, /selectRegisterImages\(registerImage\.files\)/);
  assert.match(dashboard, /removeRegisterImageAt\(registerImages/);
  assert.match(dashboard, /composeRegisterImages\(selectedImages\)/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ image_data_url: dataUrl, description \}\)/);
  for (const message of ['Enviando o comprovante', 'está na fila', 'lendo o print', 'registrada como pendente', 'Envie outro print', 'Falha técnica']) {
    assert.match(dashboard, new RegExp(message), `bolha ausente: ${message}`);
  }
});

test('paste global so captura imagem quando a pane registrar esta ativa', () => {
  const pasteStart = dashboard.indexOf("document.addEventListener('paste'");
  const pasteEnd = dashboard.indexOf("registerSend.addEventListener('click'", pasteStart);
  const pasteHandler = dashboard.slice(pasteStart, pasteEnd);
  assert.ok(pasteStart > 0, 'listener global de paste ausente');
  assert.match(pasteHandler, /\.tab-pane\[data-pane="registrar"\]/);
  assert.match(pasteHandler, /if \(!registerPane\?\.classList\.contains\('active'\)\) return/);
  assert.match(pasteHandler, /item\.kind === 'file' && item\.type\.startsWith\('image\/'\)/);
  assert.match(pasteHandler, /if \(!imageItems\.length\) return;\s*event\.preventDefault\(\)/);
  assert.match(pasteHandler, /selectRegisterImages\(imageItems\.map/);
  assert.doesNotMatch(pasteHandler, /preventDefault\(\)[\s\S]*if \(!imageItems\.length\)/);
});

test('compositor preserva single e limita o composto final a 3 MB', () => {
  assert.match(imageComposer, /if \(entries\.length === 1\)[\s\S]*return entries\[0\]\.dataUrl/);
  assert.match(imageComposer, /REGISTER_MAX_DECODED_BYTES = 3 \* 1024 \* 1024/);
  assert.match(imageComposer, /FIM DO PRINT 1[\s\S]*INÍCIO DO PRINT 2/);
  assert.match(imageComposer, /\['image\/webp', 'image\/jpeg'\]\.includes\(blob\.type\)/);
  assert.match(imageComposer, /composite_too_large/);
  assert.doesNotMatch(registerApi, /image_data_urls|images\s*:/);
  const sendHandler = dashboard.slice(
    dashboard.indexOf("registerSend.addEventListener('click'"),
    dashboard.indexOf("const existingRegisterJobId", dashboard.indexOf("registerSend.addEventListener('click'")),
  );
  assert.ok(sendHandler.indexOf('composeRegisterImages(selectedImages)') < sendHandler.indexOf("fetch('/api/bets/register'"));
  assert.match(sendHandler, /body: JSON\.stringify\(\{ image_data_url: dataUrl, description \}\)/);
  assert.match(sendHandler, /clearRegisterImages\(\)/);
});

test('aba publica abre composer sem login, cookie ou codigo', () => {
  assert.doesNotMatch(registerMarkup, /e-mail|email|magic|link de acesso|código de acesso|liberar|type="password"|registerAccessCode|registerUnlock/i);
  assert.doesNotMatch(dashboard, /signInWithOtp|registerMagicLink|registerEmail|\/api\/bets\/access|registerAuthHeaders|Este navegador precisa ser liberado|credentials:\s*'same-origin'/);
  assert.doesNotMatch(registerMarkup, /id="registerDescription"[^>]*disabled/);
  assert.doesNotMatch(registerMarkup, /id="registerSend"[^>]*disabled/);
  assert.match(dashboard, /headers: \{ 'Content-Type': 'application\/json' \}/);
  assert.doesNotMatch(dashboard, /BET_UPLOAD_ACCESS_CODE|BET_UPLOAD_SESSION_SECRET|BET_UPLOAD_OWNER_ID/);
});

test('descricao e contexto auxiliar e nunca substitui evidencia do print', () => {
  assert.match(prompt, /description.*somente contexto auxiliar/);
  assert.match(prompt, /nunca substitui evidencia do print/);
  assert.match(prompt, /nunca relaxa validacoes/);
  assert.match(prompt, /JSON minimo auditavel[\s\S]*description recebida/);
});

test('automacao limpa somente o TEMP local exato via subcomando cleanup', () => {
  assert.match(prompt, /cron-data\/bet-upload-work\/<id>\.<ext>/);
  assert.match(prompt, /node scripts\/bet-upload-jobs\.cjs cleanup <id>/);
  assert.match(prompt, /estado terminal `registered`, `rejected` ou `error`/);
  assert.match(prompt, /Nunca apague manualmente, nunca use curinga, `-Recurse`/);
  assert.match(prompt, /Nunca apague o objeto do Storage diretamente/);
  assert.match(prompt, /retencao privada de 14 dias/);
  assert.doesNotMatch(prompt, /Remove-Item/);
});

test('toggle existente continua direto no Supabase sem depender da nova API', () => {
  const start = dashboard.indexOf('async function toggleMethodBet(');
  const end = dashboard.indexOf('\n    function renderOffMethodSection', start);
  const toggle = dashboard.slice(start, end);
  assert.match(toggle, /sb\s*\.from\('bets'\)\s*\.update\(\{ is_method_bet: newVal \}\)\s*\.eq\('id', betId\)/);
  assert.doesNotMatch(toggle, /\/api\/bets\/toggle-method|sb\.auth|getSession/);
});

test('UI mostra contagem de apostas registradas e preserva mensagem single', () => {
  assert.match(dashboard, /registeredCount = Number\(job\.bet_count \|\| job\.result\?\.total/);
  assert.match(dashboard, /`\$\{registeredCount\} apostas registradas como pendentes\.`/);
  assert.match(dashboard, /'Aposta registrada como pendente\.'/);
  assert.match(dashboard, /reusedCount = Number\(job\.result\?\.reused \|\| 0\)/);
  assert.match(dashboard, /`\$\{registeredCount\} \$\{processedLabel\}: \$\{insertedCount\} \$\{insertedLabel\} e \$\{reusedCount\} \$\{reusedLabel\}\.`/);
});
