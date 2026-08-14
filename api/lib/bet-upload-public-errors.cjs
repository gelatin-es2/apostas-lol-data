'use strict';

const REJECTION_MESSAGES = Object.freeze({
  unsupported_bookmaker: 'Casa de aposta inválida.',
  unreadable_image: 'Não consegui ler o comprovante. Envie outro print mais claro.',
  unsupported_receipt: 'Comprovante de aposta não reconhecido.',
  unsupported_currency: 'Moeda da aposta não suportada.',
  multiple_bet: 'Apostas múltiplas não são suportadas.',
  ambiguous_match: 'Não consegui identificar a partida com segurança.',
  invalid_map: 'Não consegui confirmar o mapa da aposta.',
  invalid_amounts: 'Os valores do comprovante não conferem.',
  not_lol_bet: 'O comprovante não é de uma aposta de LoL.',
});

function publicJobErrorMessage(job) {
  if (!job || !job.status) return null;
  if (job.status === 'error') return 'Falha técnica no processamento. Tente novamente.';
  if (job.status !== 'rejected') return null;
  return REJECTION_MESSAGES[job.error_code] || 'Não consegui validar o comprovante.';
}

module.exports = { REJECTION_MESSAGES, publicJobErrorMessage };
