'use strict';

const { requestIsSameSiteRead, denyWithoutAccess } = require('../bets/register.js');
const { createFinanceGateway } = require('../lib/finance-gateway.cjs');
const { summarizeFinance } = require('../lib/finance-summary.cjs');
const { currentMonthSaoPaulo, isMonth, monthsWindow, send } = require('../lib/finance-api-common.cjs');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function createSummaryHandler(dependenciesFactory = createFinanceGateway) {
  return async function financeSummaryHandler(req, res) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!requestIsSameSiteRead(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
    if (denyWithoutAccess(req, res, send)) return;

    const now = new Date();
    const rawMonth = typeof req.query?.month === 'string' ? req.query.month.trim() : '';
    const month = rawMonth || currentMonthSaoPaulo(now);
    if (!isMonth(month)) return send(res, 400, { ok: false, code: 'invalid_month' });

    try {
      const deps = dependenciesFactory();
      const window = monthsWindow(month, 6);
      const sinceIso = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
      const [transactions, documents] = await Promise.all([
        deps.listTransactionsForMonths(deps.ownerId, window[0], month),
        deps.listDocuments(deps.ownerId, month, sinceIso),
      ]);
      const summary = summarizeFinance({ month, transactions, documents });
      return send(res, 200, { ok: true, ...summary });
    } catch (error) {
      console.error('finance_summary_failed', { name: error.name, code: error.code || null });
      return send(res, 500, { ok: false, code: 'internal_error' });
    }
  };
}

module.exports = createSummaryHandler();
module.exports.createSummaryHandler = createSummaryHandler;
