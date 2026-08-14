'use strict';

const { enqueueBetUpload } = require('../lib/register-bet.cjs');
const { RegistrationError } = require('../lib/bet-extraction-contract.cjs');
const { publicJobErrorMessage } = require('../lib/bet-upload-public-errors.cjs');

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} nao configurada`);
  return value;
}

function headers(secret, extra = {}) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, ...extra };
}

function requestHost(req) {
  return String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
}

function originMatchesHost(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

// POST (register): fail-closed. Um fetch POST de navegador SEMPRE manda Origin — a
// ausencia dela indica um cliente que nao e um navegador comum (curl, script, replay
// forjado), entao trata como cross-site em vez de assumir same-site como antes.
function requestIsSameSite(req) {
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) return ['same-origin', 'same-site', 'none'].includes(fetchSite);
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return false;
  return originMatchesHost(origin, requestHost(req));
}

// GET (status): fetch GET same-origin de navegador nem sempre manda Origin (so em modo
// cors), entao aceita sec-fetch-site OU Origin/Referer batendo com o host. So fecha em
// 403 quando NENHUM dos tres sinais existe.
function requestIsSameSiteRead(req) {
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) return ['same-origin', 'same-site'].includes(fetchSite);
  const host = requestHost(req);
  const origin = String(req?.headers?.origin || '').trim();
  if (origin) return originMatchesHost(origin, host);
  const referer = String(req?.headers?.referer || req?.headers?.referrer || '').trim();
  if (referer) return originMatchesHost(referer, host);
  return false;
}

function ownerIdFromEnv(environment = process.env) {
  const ownerId = typeof environment.BET_UPLOAD_OWNER_ID === 'string' ? environment.BET_UPLOAD_OWNER_ID.trim() : '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ownerId)) {
    throw new Error('BET_UPLOAD_OWNER_ID invalido');
  }
  return ownerId;
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Supabase retornou HTTP ${response.status}`);
    error.code = body?.code;
    throw error;
  }
  return body;
}

function createSupabaseGateway(fetchImpl = fetch) {
  const url = env('SUPABASE_URL').replace(/\/$/, '');
  const secret = env('SUPABASE_SECRET_KEY');
  return {
    ownerId: ownerIdFromEnv(),
    async findJobByHash(hash) {
      const response = await fetchImpl(`${url}/rest/v1/bet_upload_jobs?ingestion_hash=eq.${encodeURIComponent(hash)}&select=*&limit=1`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },
    async getJobForOwner(id, ownerId) {
      const response = await fetchImpl(`${url}/rest/v1/bet_upload_jobs?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=id,status,description,bet_id,error_code,error_message,result,created_at,purge_after,screenshot_deleted_at,updated_at&limit=1`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },
    async uploadImage(storagePath, buffer, mimeType) {
      const response = await fetchImpl(`${url}/storage/v1/object/bet-screenshots/${storagePath}`, {
        method: 'POST',
        headers: headers(secret, { 'Content-Type': mimeType, 'x-upsert': 'false' }),
        body: buffer,
      });
      await parseResponse(response);
    },
    async deleteImage(storagePath) {
      const response = await fetchImpl(`${url}/storage/v1/object/bet-screenshots/${storagePath}`, { method: 'DELETE', headers: headers(secret) });
      await parseResponse(response);
    },
    async createJob(job) {
      const response = await fetchImpl(`${url}/rest/v1/bet_upload_jobs`, {
        method: 'POST',
        headers: headers(secret, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(job),
      });
      const rows = await parseResponse(response);
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Fila nao retornou exatamente um job');
      return rows[0];
    },
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function publicJob(job) {
  if (!job) return null;
  const rawBetIds = Array.isArray(job.result?.bet_ids) ? job.result.bet_ids : [];
  const betIds = rawBetIds.filter((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)).slice(0, 10);
  if (betIds.length === 0 && job.bet_id) betIds.push(job.bet_id);
  const total = Number.isInteger(job.result?.total) && job.result.total >= 1 && job.result.total <= 10
    ? job.result.total
    : betIds.length;
  const publicResult = job.status === 'registered' ? {
    total,
    inserted: Number.isInteger(job.result?.inserted) ? job.result.inserted : null,
    reused: Number.isInteger(job.result?.reused) ? job.result.reused : null,
    bet_ids: betIds,
  } : null;
  return {
    id: job.id,
    status: job.status,
    description: job.description || null,
    bet_id: job.bet_id || null,
    error_code: job.error_code || null,
    error_message: publicJobErrorMessage(job),
    bet_ids: betIds,
    bet_count: total,
    result: publicResult,
    created_at: job.created_at || null,
    purge_after: job.purge_after || null,
    screenshot_deleted_at: job.screenshot_deleted_at || null,
    updated_at: job.updated_at || null,
  };
}

function createHandler(dependenciesFactory = createSupabaseGateway) {
  return async function registerHandler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!requestIsSameSite(req)) return send(res, 403, { ok: false, code: 'cross_site_request' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const dependencies = dependenciesFactory();
      const result = await enqueueBetUpload({
        ownerId: dependencies.ownerId,
        imageDataUrl: body?.image_data_url,
        description: body?.description,
      }, dependencies);
      return send(res, result.duplicate ? 200 : 202, { ...result, job: publicJob(result.job) });
    } catch (error) {
      if (error instanceof SyntaxError) return send(res, 400, { ok: false, code: 'invalid_json' });
      if (error instanceof RegistrationError) return send(res, error.status, { ok: false, code: error.code, message: error.message });
      console.error('bet_upload_enqueue_failed', { name: error.name, code: error.code || null });
      return send(res, 500, { ok: false, code: 'internal_error', message: 'Falha ao enfileirar. Tente novamente.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.createSupabaseGateway = createSupabaseGateway;
module.exports.parseResponse = parseResponse;
module.exports.publicJob = publicJob;
module.exports.ownerIdFromEnv = ownerIdFromEnv;
module.exports.requestIsSameSite = requestIsSameSite;
module.exports.requestIsSameSiteRead = requestIsSameSiteRead;
