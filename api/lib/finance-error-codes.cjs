'use strict';

// Allowlist FECHADA de error_code que o worker de finanças pode gravar em finance_upload_jobs.
// Fonte única: scripts/finance-upload-jobs.cjs (finish) e api/lib/finance-public-job.cjs (UI)
// leem daqui — nunca duplicar a lista em outro lugar. Mesmo contrato de bet-upload-error-codes.cjs.
const FINANCE_ERROR_CODE_ALLOWLIST = Object.freeze([
  'unreadable_image',
  'unsupported_document',
  'extraction_failed',
]);

const FINANCE_ERROR_CODE_SET = new Set(FINANCE_ERROR_CODE_ALLOWLIST);

// Código genérico pra qualquer causa que não mapeia num código específico da allowlist.
const FINANCE_FALLBACK_ERROR_CODE = 'extraction_failed';

// Mensagens que o dashboard mostra pro dono. `max_attempts_exceeded` é gravado pelo
// dead-letter do watcher (não pelo worker), por isso fica fora da allowlist e dentro daqui.
const FINANCE_REJECTION_MESSAGES = Object.freeze({
  unreadable_image: 'Não consegui ler a foto. Tire outra com mais luz, sem cortar o documento.',
  unsupported_document: 'Isso não parece fatura de cartão nem extrato bancário.',
  extraction_failed: 'Não consegui extrair as transações com segurança. Tente uma foto mais nítida.',
  max_attempts_exceeded: 'Não consegui processar este documento após várias tentativas.',
});

const FINANCE_TECHNICAL_FAILURE_MESSAGE = 'Falha técnica no processamento. Tente novamente.';
const FINANCE_GENERIC_REJECTION_MESSAGE = 'Não consegui validar o documento.';

function isFinanceErrorCode(code) {
  return typeof code === 'string' && FINANCE_ERROR_CODE_SET.has(code);
}

// Nunca deixa error_code desconhecido ir pro banco: coage pro fallback e devolve o
// código original junto, pra quem chamar decidir se quer preservar pra auditoria.
function coerceFinanceErrorCode(code) {
  if (isFinanceErrorCode(code)) return { code, original_code: null };
  return { code: FINANCE_FALLBACK_ERROR_CODE, original_code: typeof code === 'string' && code ? code : null };
}

// Mensagem pública por status do job — nunca repassa error_message cru do banco
// (pode carregar detalhe técnico); só texto fixo escolhido pelo código.
function publicFinanceJobErrorMessage(job) {
  if (!job || typeof job !== 'object') return null;
  if (job.status === 'error') {
    return FINANCE_REJECTION_MESSAGES[job.error_code] || FINANCE_TECHNICAL_FAILURE_MESSAGE;
  }
  if (job.status === 'rejected') {
    return FINANCE_REJECTION_MESSAGES[job.error_code] || FINANCE_GENERIC_REJECTION_MESSAGE;
  }
  return null;
}

module.exports = {
  FINANCE_ERROR_CODE_ALLOWLIST,
  FINANCE_ERROR_CODE_SET,
  FINANCE_FALLBACK_ERROR_CODE,
  FINANCE_REJECTION_MESSAGES,
  FINANCE_TECHNICAL_FAILURE_MESSAGE,
  FINANCE_GENERIC_REJECTION_MESSAGE,
  isFinanceErrorCode,
  coerceFinanceErrorCode,
  publicFinanceJobErrorMessage,
};
