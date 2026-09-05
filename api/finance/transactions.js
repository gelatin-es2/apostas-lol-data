'use strict';

const { requestIsSameSite, requestIsSameSiteRead, denyWithoutAccess } = require('../bets/register.js');
const { createFinanceGateway } = require('../lib/finance-gateway.cjs');
const { isFinanceCategory, AUTO_IGNORE_CATEGORIES } = require('../lib/finance-categories.cjs');
const { sanitizeDescription, RegistrationError } = require('../lib/bet-extraction-contract.cjs');
const { isMonth, isUuid, parseIntInRange, parseJsonBody, sanitizeSearch, send } = require('../lib/finance-api-common.cjs');

const SOURCES = new Set(['cartao', 'conta']);

// Nunca deixa owner_id/dedup_key/raw saírem pro cliente — o gateway já não os seleciona,
// isso é só uma segunda trava caso a query mude no futuro.
function publicTransaction(row) {
  if (!row) return null;
  const { owner_id, dedup_key, raw, ...rest } = row;
  return rest;
}

async function handleList(req, res, dependenciesFactory) {
  if (!requestIsSameSiteRead(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
  if (denyWithoutAccess(req, res, send)) return;

  const query = req.query || {};
  const rawMonth = typeof query.month === 'string' ? query.month.trim() : '';
  if (rawMonth && !isMonth(rawMonth)) return send(res, 400, { ok: false, code: 'invalid_month' });

  const rawSource = typeof query.source === 'string' ? query.source.trim() : '';
  if (rawSource && !SOURCES.has(rawSource)) return send(res, 400, { ok: false, code: 'invalid_source' });

  const rawCategory = typeof query.category === 'string' ? query.category.trim() : '';
  if (rawCategory && !isFinanceCategory(rawCategory)) return send(res, 400, { ok: false, code: 'invalid_category' });

  let q = '';
  if (query.q !== undefined) {
    if (typeof query.q !== 'string') return send(res, 400, { ok: false, code: 'invalid_query' });
    q = sanitizeSearch(query.q);
  }

  const limit = parseIntInRange(query.limit, { min: 1, max: 200, fallback: 100 });
  if (limit === null) return send(res, 400, { ok: false, code: 'invalid_pagination' });
  const offset = parseIntInRange(query.offset, { min: 0, fallback: 0 });
  if (offset === null) return send(res, 400, { ok: false, code: 'invalid_pagination' });

  try {
    const deps = dependenciesFactory();
    const { items, total } = await deps.queryTransactions(deps.ownerId, {
      month: rawMonth || undefined,
      source: rawSource || undefined,
      category: rawCategory || undefined,
      q: q || undefined,
      limit,
      offset,
    });
    return send(res, 200, { ok: true, items: (items || []).map(publicTransaction), total, limit, offset });
  } catch (error) {
    console.error('finance_transactions_list_failed', { name: error.name, code: error.code || null });
    return send(res, 500, { ok: false, code: 'internal_error' });
  }
}

async function handlePatch(req, res, dependenciesFactory) {
  if (!requestIsSameSite(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
  if (denyWithoutAccess(req, res, send)) return;
  try {
    const body = parseJsonBody(req);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!isUuid(id)) return send(res, 400, { ok: false, code: 'invalid_transaction_id' });

    const patch = {};
    if (body?.category !== undefined) {
      if (!isFinanceCategory(body.category)) return send(res, 400, { ok: false, code: 'invalid_category' });
      patch.category = body.category;
      // Categoria vem sem ignore_in_totals explicito? A regra automatica decide (ex.:
      // "pagamento_fatura" sempre ignora) — só quando o dono manda o flag na mesma
      // chamada é que a escolha manual dele prevalece (checado abaixo).
      if (body.ignore_in_totals === undefined) {
        patch.ignore_in_totals = AUTO_IGNORE_CATEGORIES.includes(body.category);
      }
      patch.category_source = 'manual';
    }
    if (body?.ignore_in_totals !== undefined) {
      if (typeof body.ignore_in_totals !== 'boolean') return send(res, 400, { ok: false, code: 'invalid_ignore_flag' });
      patch.ignore_in_totals = body.ignore_in_totals;
    }
    if (body?.notes !== undefined) {
      patch.notes = sanitizeDescription(body.notes);
    }
    if (Object.keys(patch).length === 0) return send(res, 400, { ok: false, code: 'empty_patch' });
    patch.updated_at = new Date().toISOString();

    const deps = dependenciesFactory();
    const row = await deps.updateTransaction(id, deps.ownerId, patch);
    if (!row) return send(res, 404, { ok: false, code: 'transaction_not_found' });
    return send(res, 200, { ok: true, item: publicTransaction(row) });
  } catch (error) {
    if (error instanceof SyntaxError) return send(res, 400, { ok: false, code: 'invalid_json' });
    if (error instanceof RegistrationError) return send(res, 400, { ok: false, code: 'invalid_notes' });
    console.error('finance_transactions_patch_failed', { name: error.name, code: error.code || null });
    return send(res, 500, { ok: false, code: 'internal_error' });
  }
}

async function handleDelete(req, res, dependenciesFactory) {
  if (!requestIsSameSite(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
  if (denyWithoutAccess(req, res, send)) return;

  const id = typeof req.query?.id === 'string' ? req.query.id : '';
  if (!isUuid(id)) return send(res, 400, { ok: false, code: 'invalid_transaction_id' });

  try {
    const deps = dependenciesFactory();
    const deleted = await deps.deleteTransaction(id, deps.ownerId);
    if (!deleted) return send(res, 404, { ok: false, code: 'transaction_not_found' });
    return send(res, 200, { ok: true, deleted: 1 });
  } catch (error) {
    console.error('finance_transactions_delete_failed', { name: error.name, code: error.code || null });
    return send(res, 500, { ok: false, code: 'internal_error' });
  }
}

function createTransactionsHandler(dependenciesFactory = createFinanceGateway) {
  return async function financeTransactionsHandler(req, res) {
    if (req.method === 'GET') return handleList(req, res, dependenciesFactory);
    if (req.method === 'PATCH') return handlePatch(req, res, dependenciesFactory);
    if (req.method === 'DELETE') return handleDelete(req, res, dependenciesFactory);
    return send(res, 405, { ok: false, code: 'method_not_allowed' });
  };
}

module.exports = createTransactionsHandler();
module.exports.createTransactionsHandler = createTransactionsHandler;
