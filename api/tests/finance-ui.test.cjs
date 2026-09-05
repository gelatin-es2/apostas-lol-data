'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dashboard = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf8');
const imageResize = fs.readFileSync(path.resolve(__dirname, '../../dashboard/finance-image-resize.mjs'), 'utf8');

const financeMarkup = dashboard.slice(
  dashboard.indexOf('<main class="container tab-pane" data-pane="financas">'),
  dashboard.indexOf('<main class="container tab-pane" data-pane="baleias">'),
);
const registerToTracker = dashboard.slice(
  dashboard.indexOf('<main class="container tab-pane" data-pane="registrar">'),
  dashboard.indexOf('<main class="container tab-pane" data-pane="tracker">'),
);
// Recorte só do JS da aba Finanças — usado pras checagens negativas (padrão
// antigo que não pode mais existir) pra não falso-positivar com outra aba.
// Marcador com "// " (comentário JS) — o mesmo texto também abre o comentário
// CSS ("/* ...") lá em cima, então sem o prefixo o indexOf pegaria o bloco
// errado (bem maior, cobrindo metade do arquivo).
const financeBlockStart = dashboard.indexOf('// ===== Aba "Finanças" (2026-09-04) =====');
const financeBlockEnd = dashboard.indexOf('// ── Team name aliases', financeBlockStart);
const financeBlock = dashboard.slice(financeBlockStart, financeBlockEnd);

test('nav mostra Finanças logo apos Registrar bet', () => {
  assert.match(
    dashboard,
    /data-tab="registrar">Registrar bet<\/button>\s*<button class="tab" type="button" data-tab="financas">Finanças<\/button>/,
  );
});

test('pane financas fica depois de tracker e antes de baleias (fora do recorte registrar->tracker)', () => {
  assert.ok(dashboard.indexOf('data-pane="tracker"') < dashboard.indexOf('data-pane="financas"'));
  assert.ok(dashboard.indexOf('data-pane="financas"') < dashboard.indexOf('data-pane="baleias"'));
  assert.doesNotMatch(registerToTracker, /id="fin/);
});

test('card de upload informa retencao de 14 dias e nao pede login/email', () => {
  assert.match(financeMarkup, /id="finUpload"/);
  assert.match(financeMarkup, /salva por 14 dias/);
  assert.match(financeMarkup, /id="finLog"[^>]*role="log"/);
  assert.doesNotMatch(financeMarkup, /signInWithOtp|magic ?link/i);
});

test('gate de acesso reusa o mesmo padrao de Registrar bet (codigo -> cookie)', () => {
  assert.match(financeMarkup, /id="finAccess"[^>]*hidden/);
  assert.match(financeMarkup, /id="finAccessCode"[^>]*type="password"/);
  assert.match(financeMarkup, /id="finUnlock"/);
});

test('composer aceita foto (png/jpeg/webp) e nota opcional', () => {
  assert.match(financeMarkup, /id="finPreviewList"/);
  assert.match(financeMarkup, /id="finNote"[^>]*maxlength="500"/);
  assert.match(financeMarkup, /id="finPhotoInput"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp"[^>]*multiple[^>]*hidden/);
  assert.match(financeMarkup, /id="finAttach"[^>]*>\+ Foto</);
  assert.match(financeMarkup, /id="finSend"[^>]*>Enviar</);
});

test('markup de navegacao de mes e resumo (kpis, categorias, estabelecimentos, meses, docs)', () => {
  assert.match(financeMarkup, /class="fin-month-nav"/);
  assert.match(financeMarkup, /id="finMonthPrev"/);
  assert.match(financeMarkup, /id="finMonthLabel"/);
  assert.match(financeMarkup, /id="finMonthNext"/);
  assert.match(financeMarkup, /id="finKpis" class="kpis"/);
  assert.match(financeMarkup, /id="finCategoryBars" class="fin-cat-bars"/);
  assert.match(financeMarkup, /id="finMerchants" class="days"/);
  assert.match(financeMarkup, /id="finMonthsChartWrap"/);
  assert.match(financeMarkup, /id="finMonthsTable" class="days"/);
  assert.match(financeMarkup, /id="finDocs" class="days"/);
});

test('filtros de transacoes: chips de fonte, categoria e busca', () => {
  assert.match(financeMarkup, /id="finTxFilters"[^>]*class="filters"|class="filters" id="finTxFilters"/);
  assert.match(financeMarkup, /data-source="all"/);
  assert.match(financeMarkup, /data-source="cartao"/);
  assert.match(financeMarkup, /data-source="conta"/);
  assert.match(financeMarkup, /id="finTxCategory"/);
  assert.match(financeMarkup, /id="finTxSearch"[^>]*maxlength="60"/);
  assert.match(financeMarkup, /id="finTxList" class="fin-tx-list"/);
});

test('script importa os modulos de categoria e redimensionamento de imagem', () => {
  assert.match(dashboard, /import \{ FINANCE_CATEGORIES, financeCategoryLabel \} from '\.\/finance-categories\.mjs';/);
  assert.match(dashboard, /import \{ prepareFinanceImage \} from '\.\/finance-image-resize\.mjs';/);
});

// ── F1: contrato do summary em inglês ───────────────────────────────────────
test('F1 — summary usa as chaves novas em inglês (income/expenses/balance/card_bill/card_bill_stated)', () => {
  assert.match(financeBlock, /s\.income/);
  assert.match(financeBlock, /s\.expenses/);
  assert.match(financeBlock, /s\.balance/);
  assert.match(financeBlock, /s\.card_bill\b/);
  assert.match(financeBlock, /s\.card_bill_stated/);
  assert.match(financeBlock, /m\.income/);
  assert.match(financeBlock, /m\.expenses/);
  assert.match(financeBlock, /m\.balance/);
});

test('F1 — nenhuma leitura das chaves antigas em pt-BR sobrou no bloco de finanças', () => {
  assert.doesNotMatch(financeBlock, /\bs\.entradas\b|\bs\.saidas\b|\bs\.saldo\b|\bs\.fatura_cartao\b|\bs\.fatura_informada\b/);
  assert.doesNotMatch(financeBlock, /\bm\.entradas\b|\bm\.saidas\b|\bm\.saldo\b/);
  // nomes de variável local também migraram pro inglês (regra do projeto: código em inglês)
  assert.doesNotMatch(financeBlock, /entradasClass|saldoClass|faturaSub/);
  assert.match(financeBlock, /incomeClass/);
  assert.match(financeBlock, /balanceClass/);
  assert.match(financeBlock, /cardBillSub/);
});

// ── F2: gate de acesso ───────────────────────────────────────────────────────
test('gate de finanças reusa /api/bets/access (GET e POST) igual Registrar bet', () => {
  assert.match(dashboard, /async function refreshFinanceAccess\(\)/);
  assert.match(dashboard, /fetch\('\/api\/bets\/access', \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(dashboard, /await refreshRegisterAccess\(\);/);
});

test('F2 — 200 com scope diferente de "api" (cookie antigo) conta como BLOQUEADO, não liberado', () => {
  assert.match(financeBlock, /if \(body && body\.scope === 'api'\) finAuth = \{\};/);
  assert.match(financeBlock, /else staleCookie = true;/);
  assert.match(financeBlock, /Digite o código de novo pra liberar a aba Finanças neste navegador\./);
  assert.match(financeBlock, /finAccessMessage\.textContent = staleCookie \? FIN_ACCESS_STALE_COOKIE_MESSAGE : FIN_ACCESS_DEFAULT_MESSAGE/);
  assert.match(financeMarkup, /id="finAccessMessage"/);
});

test('F2 — clique na aba Finanças sem acesso ainda reconsulta o gate e só carrega se liberar', () => {
  assert.match(
    financeBlock,
    /tab\[data-tab="financas"\]'\)\?\.addEventListener\('click', async \(\) => \{\s*if \(!finAuth\) \{\s*const auth = await refreshFinanceAccess\(\);\s*if \(auth && !finLoaded\) loadFinance\(\);\s*return;\s*\}\s*if \(!finLoaded\) loadFinance\(\);\s*\}\)/,
  );
});

// ── F3: helper único de fetch ────────────────────────────────────────────────
test('F3 — finApi existe e centraliza fetch/json/401/erro pras chamadas de finanças', () => {
  assert.match(financeBlock, /async function finApi\(path, init = \{\}, fallback = '[^']+'\)/);
  assert.match(financeBlock, /if \(response\.status === 401\) \{\s*await refreshFinanceAccess\(\);\s*throw new Error\(FIN_ACCESS_REQUIRED_MESSAGE\);\s*\}/);
  assert.match(financeBlock, /if \(!response\.ok \|\| body\.ok === false\) throw new Error\(body\.message \|\| fallback\);/);
  const finApiCalls = financeBlock.match(/(?:await )?finApi\(/g) || [];
  // definição + >=6 usos reais (upload, poll, summary, transactions, patch categoria, patch ignorar, delete)
  assert.ok(finApiCalls.length >= 7, `esperava pelo menos 7 ocorrências de finApi( (1 def + 6 usos), achei ${finApiCalls.length}`);
});

test('F3 — chamadas de dados de finanças não usam mais fetch cru com parse/401 manual duplicado', () => {
  assert.doesNotMatch(financeBlock, /fetch\('\/api\/finance\/upload'/);
  assert.doesNotMatch(financeBlock, /fetch\(`\/api\/finance\/upload\?id=/);
  assert.doesNotMatch(financeBlock, /fetch\(`\/api\/finance\/summary/);
  assert.doesNotMatch(financeBlock, /fetch\(`\/api\/finance\/transactions/);
  assert.doesNotMatch(financeBlock, /fetch\('\/api\/finance\/transactions'/);
});

test('F3 — loaders organizados em loadFinance / loadFinanceTransactionsOnly / loadFinanceSummaryOnly, convergindo em renderFinSummary', () => {
  assert.match(financeBlock, /function renderFinSummary\(summary\) \{/);
  assert.match(financeBlock, /async function loadFinance\(\)/);
  assert.match(financeBlock, /async function loadFinanceTransactionsOnly\(\)/);
  assert.match(financeBlock, /async function loadFinanceSummaryOnly\(\)/);
  // renderFinSummary chama os 5 renders do summary
  assert.match(financeBlock, /function renderFinSummary\(summary\) \{[\s\S]{0,300}renderFinKpis\(\);[\s\S]{0,300}renderFinCategoryBars\(\);[\s\S]{0,300}renderFinMerchants\(\);[\s\S]{0,300}renderFinMonths\(\);[\s\S]{0,300}renderFinDocs\(\);/);
  // os loaders só chamam renderFinSummary (não repetem os 5 renders)
  assert.match(financeBlock, /async function loadFinance\(\)[\s\S]{0,1000}renderFinSummary\(summary\);/);
  assert.match(financeBlock, /async function loadFinanceSummaryOnly\(\)[\s\S]{0,500}renderFinSummary\(summary\);/);
  // chips de fonte, select de categoria e busca usam o loader que NÃO recarrega o summary
  assert.match(financeBlock, /finFilter\.source = chip\.dataset\.source;\s*loadFinanceTransactionsOnly\(\);/);
  assert.match(financeBlock, /finFilter\.category = finTxCategorySelect\.value;\s*loadFinanceTransactionsOnly\(\);/);
  assert.match(financeBlock, /finFilter\.q = finTxSearch\.value\.trim\(\);\s*loadFinanceTransactionsOnly\(\);/);
});

test('upload chama prepareFinanceImage e envia 1 foto = 1 job pra /api/finance/upload via finApi', () => {
  assert.match(dashboard, /async function sendFinancePhotos\(\)/);
  assert.match(dashboard, /prepareFinanceImage\(file\)/);
  assert.match(dashboard, /finApi\('\/api\/finance\/upload', \{/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ image_data_url: prepared\.dataUrl, note \}\)/);
  assert.match(dashboard, /catch \(error\) \{\s*if \(error\.message === FIN_ACCESS_REQUIRED_MESSAGE\) finAccessCode\.focus\(\);\s*addFinBubble\(error\.message \|\| `Não consegui enviar a foto/);
});

test('jobIds pendentes ficam em localStorage financeUploadJobIds e o boot retoma o polling', () => {
  assert.match(dashboard, /localStorage\.setItem\('financeUploadJobIds', JSON\.stringify\(ids\)\)/);
  assert.match(dashboard, /localStorage\.getItem\('financeUploadJobIds'/);
  assert.match(dashboard, /refreshFinanceAccess\(\)\.then\(\(auth\) => \{/);
  assert.match(dashboard, /pendingIds\.forEach\(\(jobId\) => pollFinanceJob\(jobId\)\)/);
});

test('pollFinanceJob usa finApi e cobre os 5 estados do job', () => {
  assert.match(dashboard, /async function pollFinanceJob\(jobId\)/);
  assert.match(dashboard, /finApi\(`\/api\/finance\/upload\?id=\$\{encodeURIComponent\(jobId\)\}`/);
  for (const status of ['queued', 'processing', 'registered', 'rejected', 'error']) {
    assert.match(dashboard, new RegExp(`job\\.status === '${status}'`), `estado ausente: ${status}`);
  }
});

// ── F5: backoff do poll ──────────────────────────────────────────────────────
test('F5 — poll começa em 3s, volta a 3s quando o status muda e multiplica por 1.5 até o teto de 30s', () => {
  assert.match(financeBlock, /FIN_POLL_BASE_MS = 3000/);
  assert.match(financeBlock, /FIN_POLL_MAX_MS = 30000/);
  assert.match(financeBlock, /FIN_POLL_ERROR_MIN_MS = 8000/);
  assert.match(financeBlock, /FIN_POLL_BACKOFF_FACTOR = 1\.5/);
  assert.match(financeBlock, /function nextFinPollDelay\(jobId, statusKey\)/);
  assert.match(financeBlock, /Math\.min\(FIN_POLL_MAX_MS, Math\.round\(state\.delay \* FIN_POLL_BACKOFF_FACTOR\)\)/);
  assert.match(financeBlock, /const finPollState = new Map\(\);/);
  assert.match(financeBlock, /setTimeout\(\(\) => pollFinanceJob\(jobId\), nextFinPollDelay\(jobId, job\.status\)\)/);
  assert.match(financeBlock, /setTimeout\(\(\) => pollFinanceJob\(jobId\), nextFinPollDelay\(jobId, '__error__'\)\)/);
  // estado do backoff é limpo nos 3 estados terminais (senão vaza Map por job)
  const terminalCleanups = financeBlock.match(/finPollState\.delete\(jobId\);/g) || [];
  assert.ok(terminalCleanups.length >= 3, `esperava finPollState.delete em queued->terminal (registered/rejected/error), achei ${terminalCleanups.length}`);
});

test('job registrado mostra fatura/extrato, mes, novas/repetidas, reconciliacao e atalho de mes', () => {
  assert.match(dashboard, /function finishFinanceRegisteredJob\(jobId, job\)/);
  assert.match(dashboard, /r\.doc_kind === 'extrato' \? 'Extrato' : 'Fatura'/);
  assert.match(dashboard, /monthLabelPt\(r\.ref_month\)/);
  assert.match(dashboard, /Bateu com o total da fatura\./);
  assert.match(dashboard, /Diferença de R\$ \$\{fmtMoney\(Math\.abs\(diff\)\)\} vs total da fatura\./);
  assert.match(dashboard, /r\.ref_month && r\.ref_month !== finMonth/);
});

test('loadFinance busca summary e transactions em paralelo via finApi e renderiza pelo renderFinSummary', () => {
  assert.match(dashboard, /async function loadFinance\(\)/);
  assert.match(dashboard, /finApi\(`\/api\/finance\/summary\?month=\$\{encodeURIComponent\(finMonth\)\}`/);
  assert.match(dashboard, /finApi\(`\/api\/finance\/transactions\?\$\{finTxQueryParams\(\)\.toString\(\)\}`/);
  assert.match(dashboard, /renderFinSummary\(summary\);/);
  assert.match(dashboard, /renderFinTx\(\);/);
});

// ── F4: respostas fora de ordem ─────────────────────────────────────────────
test('F4 — finRequestSeq descarta resposta de loader mais antigo que já foi superado', () => {
  assert.match(financeBlock, /let finRequestSeq = 0;/);
  const captures = financeBlock.match(/const seq = \+\+finRequestSeq;/g) || [];
  assert.ok(captures.length >= 3, `esperava finRequestSeq capturado nos 3 loaders, achei ${captures.length}`);
  const guards = financeBlock.match(/if \(seq !== finRequestSeq\) return;/g) || [];
  assert.ok(guards.length >= 3, `esperava guarda de descarte nos 3 loaders, achei ${guards.length}`);
});

test('grafico de meses usa svgColumnChart/wireColumnChart com balance (1 serie, cor por sinal)', () => {
  assert.match(dashboard, /function renderFinMonths\(\)[\s\S]{0,600}svgColumnChart\(bars, \{ height: 160, id: 'finMonthsChart' \}\)/);
  assert.match(dashboard, /wireColumnChart\('finMonthsChart', bars\)/);
  assert.match(dashboard, /const bars = months\.map\(\(m\) => \(\{ label: monthLabelPt\(m\.month\), value: m\.balance \}\)\)/);
});

test('categorias por dinheiro usam HTML proprio com as classes .hbar-* (nao svgHBarChart)', () => {
  assert.match(dashboard, /function renderFinCategoryBars\(\)/);
  assert.match(dashboard, /class="hbar-rows"/);
  assert.match(dashboard, /class="hbar-row"/);
  assert.match(dashboard, /class="hbar-label"/);
  assert.match(dashboard, /class="hbar-track"/);
  assert.match(dashboard, /class="hbar-fill"/);
  assert.match(dashboard, /class="hbar-tip"/);
});

test('lista de transacoes usa renderPaginatedList com listeners delegados uma vez no container', () => {
  assert.match(dashboard, /renderPaginatedList\('finTxList', finTx, finTxRowHtml, \{ emptyLabel: 'Nenhuma transação neste mês\.', reset \}\)/);
  assert.match(dashboard, /finTxList\.addEventListener\('change', async \(event\) => \{/);
  assert.match(dashboard, /finTxList\.addEventListener\('click', async \(event\) => \{/);
  // as duas rotinas de PATCH usam sempre o mesmo endpoint
  const patchMatches = dashboard.match(/method: 'PATCH'/g) || [];
  assert.ok(patchMatches.length >= 2, 'esperava PATCH pra categoria e pra ignorar/considerar');
});

test('categoria inline dispara PATCH e ignorar/considerar/excluir tambem, tudo via finApi', () => {
  assert.match(dashboard, /body: JSON\.stringify\(\{ id, category: select\.value \}\)/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ id, ignore_in_totals: action === 'ignore' \}\)/);
  assert.match(dashboard, /method: 'DELETE'/);
  assert.match(dashboard, /confirm\('Excluir esta transação\? Não dá pra desfazer\.'\)/);
  assert.match(dashboard, /finApi\('\/api\/finance\/transactions', \{/);
  assert.match(dashboard, /finApi\(`\/api\/finance\/transactions\?id=\$\{encodeURIComponent\(id\)\}`, \{ method: 'DELETE' \}/);
});

test('filtros de fonte/categoria/busca recarregam via loadFinanceTransactionsOnly, busca com debounce de 300ms', () => {
  assert.match(dashboard, /#finTxFilters \.chip/);
  assert.match(dashboard, /finFilter\.source = chip\.dataset\.source;/);
  assert.match(dashboard, /finFilter\.category = finTxCategorySelect\.value;/);
  assert.match(dashboard, /finTxSearch\.addEventListener\('input', \(\) => \{/);
  assert.match(dashboard, /\}, 300\);/);
});

test('navegacao de mes desloca finMonth e recarrega via loadFinance (summary + transactions)', () => {
  assert.match(dashboard, /function shiftMonth\(month, delta\)/);
  assert.match(dashboard, /getElementById\('finMonthPrev'\)\.addEventListener\('click', \(\) => \{\s*finMonth = shiftMonth\(finMonth, -1\);\s*loadFinance\(\);/);
  assert.match(dashboard, /getElementById\('finMonthNext'\)\.addEventListener\('click', \(\) => \{\s*finMonth = shiftMonth\(finMonth, 1\);\s*loadFinance\(\);/);
});

test('aba so carrega sob demanda (clique) e nunca via setInterval', () => {
  assert.match(financeBlock, /tab\[data-tab="financas"\]/);
  assert.doesNotMatch(financeBlock, /setInterval\(/);
});

test('nunca fala com Supabase publico nem vaza nome de tabela/segredo de finanças', () => {
  assert.doesNotMatch(dashboard, /sb\s*\.from\(\s*['"]finance/);
  assert.doesNotMatch(
    dashboard,
    /finance_transactions|finance_upload_jobs|SUPABASE_SECRET|service_role|BET_UPLOAD_(ACCESS_CODE|SESSION_SECRET|OWNER_ID)/,
  );
});

test('CSS .fin-tx tem regra base antes de @media (max-width: 600px) e override depois', () => {
  const baseIdx = dashboard.indexOf('.fin-tx {');
  const mediaIdx = dashboard.indexOf('@media (max-width: 600px)');
  assert.ok(baseIdx > 0, 'regra base .fin-tx { ausente');
  assert.ok(mediaIdx > 0, 'bloco mobile ausente');
  assert.ok(baseIdx < mediaIdx, '.fin-tx base deveria vir antes do bloco mobile');
  const secondIdx = dashboard.indexOf('.fin-tx {', mediaIdx);
  assert.ok(secondIdx > mediaIdx, 'override mobile de .fin-tx ausente dentro do bloco de 600px');
});

test('finance-image-resize.mjs nao depende de DOM real fora do path default (deps injetaveis)', () => {
  assert.match(imageResize, /export async function prepareFinanceImage\(file, dependencies = \{\}\)/);
  assert.match(imageResize, /export function computeResizeScale/);
  assert.match(imageResize, /export function decodedDataUrlBytes/);
  assert.match(imageResize, /export class FinanceImageError/);
});
