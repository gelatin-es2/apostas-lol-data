'use strict';

// Allowlist FECHADA de error_code que o worker (Claude Code) pode gravar em bet_upload_jobs.
// Fonte unica: scripts/bet-upload-jobs.cjs (finish) e api/lib/bet-upload-public-errors.cjs (UI)
// leem daqui — nunca duplicar a lista em outro lugar.
const ERROR_CODE_ALLOWLIST = Object.freeze([
  'unsupported_bookmaker',
  'unreadable_image',
  'unsupported_receipt',
  'too_many_bets',
  'ambiguous_bet',
  'duplicate_bet',
  'extraction_failed',
]);

const ERROR_CODE_SET = new Set(ERROR_CODE_ALLOWLIST);

// Codigo generico pra qualquer causa que nao mapeia num codigo especifico da allowlist.
const FALLBACK_ERROR_CODE = 'extraction_failed';

function isKnownErrorCode(code) {
  return typeof code === 'string' && ERROR_CODE_SET.has(code);
}

// Nunca deixa error_code desconhecido ir pro banco: coage pro fallback e devolve o
// codigo original junto, pra quem chamar decidir se quer preservar pra auditoria.
function coerceErrorCode(code) {
  if (isKnownErrorCode(code)) return { code, original_code: null };
  return { code: FALLBACK_ERROR_CODE, original_code: typeof code === 'string' && code ? code : null };
}

module.exports = {
  ERROR_CODE_ALLOWLIST,
  ERROR_CODE_SET,
  FALLBACK_ERROR_CODE,
  isKnownErrorCode,
  coerceErrorCode,
};
