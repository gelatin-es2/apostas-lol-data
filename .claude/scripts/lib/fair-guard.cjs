// Guarda canônica de fair line — Fase 3A (runbook 2026-08-11).
//
// assertFairReady() é a FRONTEIRA DE SEGURANÇA das mutações financeiras:
// supabase-save-bet.cjs (modo real) e settle-pending-bets.cjs (antes de PATCH)
// chamam esta função. O hook check-fair-logged.cjs vira só aviso antecipado.
//
// Valida CONTEÚDO do arquivo cron-data/YYYY-MM-DD-fair-pinnacle.json do dia
// operacional (America/Sao_Paulo), não só a existência:
//   - JSON válido
//   - campo "date" == dia operacional de hoje
//   - source permitido (operação: pinnacle_manual_elvis | pinnacle-auto-promoted;
//     skip do dia: no_games_today | skipped_by_elvis — skip SÓ com note/motivo)
//   - fair_lines com schema válido (array, cada entry com fair_line numérico são)
//
// Sem rede, sem credencial — só fs local. Erro => FairGuardError com .code
// estruturado; quem chama NÃO pode mutar nada nesse caso.
//
// Decisão documentada: NÃO existe env de bypass genérico aqui. O caminho aprovado
// pra destravar é sempre gerar o arquivo do dia (promote_fair_pinnacle_auto.cjs,
// /log-fair, ou skip explícito com motivo). FAIR_GUARD_DIR existe só pra testes
// apontarem um cron-data alternativo (os testes nunca tocam o real).

'use strict';

const fs = require('fs');
const path = require('path');
const { operationalDateYmd } = require('./operational-date.cjs');

// lib/ está em <repo>/.claude/scripts/lib → cron-data em <repo>/cron-data
const DEFAULT_FAIR_DIR = path.resolve(__dirname, '..', '..', '..', 'cron-data');

const ALLOWED_OPERATING_SOURCES = ['pinnacle_manual_elvis', 'pinnacle-auto-promoted'];
const ALLOWED_SKIP_SOURCES = ['no_games_today', 'skipped_by_elvis'];
const MIN_SKIP_NOTE_LEN = 10; // "skip só com motivo aprovado" — note vazia/token não conta

class FairGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FairGuardError';
    this.code = code;       // estruturado, estável pra máquina
    this.exitCode = 5;      // save/settle usam exit 5 = fair guard (Fase 2 usou 1-4)
  }
}

function remediation(date, file) {
  return (
    `Como destravar (NÃO pedir fair ao Elvis — decisão 2026-08-05, pipeline gera o arquivo): ` +
    `1) rodar node .claude/scripts/promote_fair_pinnacle_auto.cjs (usa a captura automática LolFairAutoCapture); ` +
    `2) se Elvis mandou fair manual, salvar via /log-fair; ` +
    `3) dia sem operação: criar ${file} com source "no_games_today"/"skipped_by_elvis" + note com o motivo. ` +
    `Dia operacional (America/Sao_Paulo): ${date}.`
  );
}

/**
 * Versão não-lançante. Retorna sempre um objeto:
 *   ok=true  → { ok, date, file, source, skip?, note?, lines_count? }
 *   ok=false → { ok:false, code, error, date, file }
 * @param {object} [opts]
 * @param {string} [opts.date]    - YYYY-MM-DD; default = dia operacional de agora
 * @param {Date}   [opts.now]     - instante de referência (teste)
 * @param {string} [opts.fairDir] - diretório dos arquivos fair (teste)
 */
function checkFairReady(opts = {}) {
  const date = opts.date || operationalDateYmd(opts.now || new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, code: 'fair_bad_date_arg', error: `data inválida: ${JSON.stringify(date)}`, date, file: null };
  }
  const fairDir = opts.fairDir || process.env.FAIR_GUARD_DIR || DEFAULT_FAIR_DIR;
  const file = path.join(fairDir, `${date}-fair-pinnacle.json`);
  const fail = (code, error) => ({ ok: false, code, error: `${error} ${remediation(date, path.basename(file))}`, date, file });

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch {
    return fail('fair_missing', `Fair do dia operacional NÃO registrada: ${file} não existe.`);
  }

  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); }
  catch (e) {
    return fail('fair_invalid_json', `Arquivo de fair existe mas não é JSON válido (${e.message}).`);
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    return fail('fair_invalid_json', 'Arquivo de fair não é um objeto JSON.');
  }

  if (j.date !== date) {
    return fail('fair_wrong_date', `Arquivo de fair com "date" divergente: arquivo diz ${JSON.stringify(j.date)}, hoje operacional é ${date}.`);
  }

  const source = typeof j.source === 'string' ? j.source : null;

  // Skip do dia — válido e auditável SÓ com motivo real na note.
  if (ALLOWED_SKIP_SOURCES.includes(source)) {
    const note = typeof j.note === 'string' ? j.note.trim() : '';
    if (note.length < MIN_SKIP_NOTE_LEN) {
      return fail('fair_skip_without_reason', `source "${source}" (skip do dia) exige "note" com o motivo (>= ${MIN_SKIP_NOTE_LEN} chars).`);
    }
    return { ok: true, skip: true, date, file, source, note };
  }

  if (!ALLOWED_OPERATING_SOURCES.includes(source)) {
    return fail('fair_source_not_allowed',
      `source ${JSON.stringify(j.source)} não permitido. Operação: ${ALLOWED_OPERATING_SOURCES.join(', ')}. Skip: ${ALLOWED_SKIP_SOURCES.join(', ')}.`);
  }

  // Schema das fair lines
  const lines = j.fair_lines;
  if (!Array.isArray(lines)) {
    return fail('fair_lines_invalid', '"fair_lines" ausente ou não é array.');
  }
  if (lines.length === 0) {
    return fail('fair_lines_empty', `source "${source}" com fair_lines vazio — dia de operação sem nenhuma linha. Se o dia não tem jogos, use skip com motivo.`);
  }
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      return fail('fair_lines_invalid', `fair_lines[${i}] não é objeto.`);
    }
    const fl = e.fair_line;
    if (typeof fl !== 'number' || !Number.isFinite(fl) || fl <= 0 || fl >= 100) {
      return fail('fair_lines_invalid', `fair_lines[${i}].fair_line inválida: ${JSON.stringify(fl)} (esperado número finito entre 0 e 100).`);
    }
    if (e.lolesports_match_id != null && typeof e.lolesports_match_id !== 'string' && typeof e.lolesports_match_id !== 'number') {
      return fail('fair_lines_invalid', `fair_lines[${i}].lolesports_match_id com tipo inválido.`);
    }
    if (e.team_anchor != null && typeof e.team_anchor !== 'string') {
      return fail('fair_lines_invalid', `fair_lines[${i}].team_anchor com tipo inválido.`);
    }
  }

  return { ok: true, skip: false, date, file, source, lines_count: lines.length };
}

/**
 * Fronteira de segurança: retorna o resultado ok, ou lança FairGuardError.
 * Chamar ANTES de qualquer mutação financeira (insert de bet, PATCH de settle).
 */
function assertFairReady(opts = {}) {
  const r = checkFairReady(opts);
  if (!r.ok) throw new FairGuardError(r.error, r.code);
  return r;
}

module.exports = {
  assertFairReady,
  checkFairReady,
  FairGuardError,
  ALLOWED_OPERATING_SOURCES,
  ALLOWED_SKIP_SOURCES,
  DEFAULT_FAIR_DIR,
};
