'use strict';

// Formato publico do job de upload de financas — espelho de publicJob em
// api/bets/register.js, mas SO copia os campos esperados (S2.8). Nunca repassa
// storage_path/owner_id/claim_token/worker_id, mesmo que a row do banco venha com eles.
const { publicFinanceJobErrorMessage } = require('./finance-error-codes.cjs');

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function publicReconciliation(reconciliation) {
  if (!reconciliation || typeof reconciliation !== 'object') return null;
  return {
    sum_lines: numberOrNull(reconciliation.sum_lines),
    statement_total: numberOrNull(reconciliation.statement_total),
    diff: numberOrNull(reconciliation.diff),
  };
}

function publicResult(row) {
  if (row.status !== 'registered') return null;
  const result = row.result && typeof row.result === 'object' ? row.result : {};
  return {
    doc_kind: stringOrNull(result.doc_kind),
    institution: stringOrNull(result.institution),
    account_label: stringOrNull(result.account_label),
    ref_month: stringOrNull(result.ref_month),
    period_start: stringOrNull(result.period_start),
    period_end: stringOrNull(result.period_end),
    statement_total: numberOrNull(result.statement_total),
    lines_detected: integerOrNull(result.lines_detected),
    inserted: integerOrNull(result.inserted),
    duplicates: integerOrNull(result.duplicates),
    skipped: integerOrNull(result.skipped),
    reconciliation: publicReconciliation(result.reconciliation),
  };
}

function publicFinanceJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    note: row.note || null,
    error_code: row.error_code || null,
    error_message: publicFinanceJobErrorMessage(row),
    result: publicResult(row),
    created_at: row.created_at || null,
    purge_after: row.purge_after || null,
    image_deleted_at: row.image_deleted_at || null,
    updated_at: row.updated_at || null,
  };
}

module.exports = { publicFinanceJob, publicResult };
