'use strict';

const { ERROR_CODE_ALLOWLIST } = require('./bet-upload-error-codes.cjs');

// Mensagens publicas em pt-BR pra toda a allowlist atual (api/lib/bet-upload-error-codes.cjs)
// mais os codigos legados que ja foram gravados no banco antes da allowlist existir.
// Nenhuma rejeicao pode cair no fallback generico por codigo desconhecido.
const REJECTION_MESSAGES = Object.freeze({
  // allowlist vigente
  unsupported_bookmaker: 'Casa de aposta inválida.',
  unreadable_image: 'Não consegui ler o comprovante. Envie outro print mais claro.',
  unsupported_receipt: 'Comprovante de aposta não reconhecido.',
  too_many_bets: 'O print tem mais de 10 apostas.',
  ambiguous_bet: 'Não consegui confirmar a partida ou o mapa desta aposta com segurança.',
  duplicate_bet: 'Esta aposta já foi registrada antes.',
  extraction_failed: 'Não consegui extrair os dados desta aposta com segurança.',
  // codigos legados ja gravados no banco antes da allowlist (nao remover, senao regride
  // pro fallback generico pra jobs antigos)
  multiple_bets: 'Apostas múltiplas não são suportadas.',
  multiple_bet: 'Apostas múltiplas não são suportadas.',
  ambiguous_match: 'Não consegui identificar a partida com segurança.',
  unsupported_currency: 'Moeda da aposta não suportada.',
  invalid_map: 'Não consegui confirmar o mapa da aposta.',
  invalid_amounts: 'Os valores do comprovante não conferem.',
  not_lol_bet: 'O comprovante não é de uma aposta de LoL.',
  // dead-letter do watcher (status error, nao rejected — mantido aqui por completude)
  max_attempts_exceeded: 'Não consegui processar este print após várias tentativas.',
});

// Confere em CI que nenhum codigo da allowlist vigente fica sem mensagem publica.
for (const code of ERROR_CODE_ALLOWLIST) {
  if (!REJECTION_MESSAGES[code]) throw new Error(`bet-upload-public-errors: falta mensagem publica pro codigo '${code}'`);
}

function publicJobErrorMessage(job) {
  if (!job || !job.status) return null;
  if (job.status === 'error') return 'Falha técnica no processamento. Tente novamente.';
  if (job.status !== 'rejected') return null;
  return REJECTION_MESSAGES[job.error_code] || 'Não consegui validar o comprovante.';
}

module.exports = { REJECTION_MESSAGES, publicJobErrorMessage };
