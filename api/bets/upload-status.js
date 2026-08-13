'use strict';

const { RegistrationError } = require('../lib/bet-extraction-contract.cjs');
const { createSupabaseGateway, publicJob } = require('./register.js');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function createStatusHandler(dependenciesFactory = createSupabaseGateway) {
  return async function statusHandler(req, res) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' });
    const id = typeof req.query?.id === 'string' ? req.query.id : '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
      return send(res, 400, { ok: false, code: 'invalid_job_id' });
    }
    try {
      const deps = dependenciesFactory();
      const job = await deps.getJobForOwner(id, deps.ownerId);
      if (!job) return send(res, 404, { ok: false, code: 'job_not_found' });
      return send(res, 200, { ok: true, job: publicJob(job) });
    } catch (error) {
      if (error instanceof RegistrationError) return send(res, error.status, { ok: false, code: error.code, message: error.message });
      console.error('bet_upload_status_failed', { name: error.name, code: error.code || null });
      return send(res, 500, { ok: false, code: 'internal_error' });
    }
  };
}

module.exports = createStatusHandler();
module.exports.createStatusHandler = createStatusHandler;
