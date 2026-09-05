'use strict';

const { requestIsSameSite, requestIsSameSiteRead, denyWithoutAccess } = require('../bets/register.js');
const { enqueueBetUpload } = require('../lib/register-bet.cjs');
const { RegistrationError } = require('../lib/bet-extraction-contract.cjs');
const { createFinanceGateway } = require('../lib/finance-gateway.cjs');
const { publicFinanceJob } = require('../lib/finance-public-job.cjs');
const { isUuid, parseJsonBody, send } = require('../lib/finance-api-common.cjs');

async function handleUpload(req, res, dependenciesFactory) {
  if (!requestIsSameSite(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
  if (denyWithoutAccess(req, res, send)) return;
  try {
    const body = parseJsonBody(req);
    const dependencies = dependenciesFactory();
    const result = await enqueueBetUpload({
      ownerId: dependencies.ownerId,
      imageDataUrl: body?.image_data_url,
      description: body?.note,
    }, dependencies);
    return send(res, result.duplicate ? 200 : 202, { ...result, job: publicFinanceJob(result.job) });
  } catch (error) {
    if (error instanceof SyntaxError) return send(res, 400, { ok: false, code: 'invalid_json' });
    if (error instanceof RegistrationError) return send(res, error.status, { ok: false, code: error.code, message: error.message });
    console.error('finance_upload_enqueue_failed', { name: error.name, code: error.code || null });
    return send(res, 500, { ok: false, code: 'internal_error', message: 'Falha ao enfileirar. Tente novamente.' });
  }
}

async function handleStatus(req, res, dependenciesFactory) {
  if (!requestIsSameSiteRead(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
  if (denyWithoutAccess(req, res, send)) return;
  const id = typeof req.query?.id === 'string' ? req.query.id : '';
  if (!isUuid(id)) return send(res, 400, { ok: false, code: 'invalid_job_id' });
  try {
    const deps = dependenciesFactory();
    const job = await deps.getJobForOwner(id, deps.ownerId);
    if (!job) return send(res, 404, { ok: false, code: 'job_not_found' });
    return send(res, 200, { ok: true, job: publicFinanceJob(job) });
  } catch (error) {
    console.error('finance_upload_status_failed', { name: error.name, code: error.code || null });
    return send(res, 500, { ok: false, code: 'internal_error' });
  }
}

function createUploadHandler(dependenciesFactory = createFinanceGateway) {
  return async function financeUploadHandler(req, res) {
    if (req.method === 'GET') return handleStatus(req, res, dependenciesFactory);
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' });
    return handleUpload(req, res, dependenciesFactory);
  };
}

module.exports = createUploadHandler();
module.exports.createUploadHandler = createUploadHandler;
