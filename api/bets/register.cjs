'use strict';

const { enqueueBetUpload } = require('../lib/register-bet.cjs');
const { RegistrationError } = require('../lib/bet-extraction-contract.cjs');

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} nao configurada`);
  return value;
}

function headers(secret, extra = {}) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, ...extra };
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
  const publishable = env('SUPABASE_PUBLISHABLE_KEY');
  return {
    async authenticate(token) {
      const response = await fetchImpl(`${url}/auth/v1/user`, {
        headers: { apikey: publishable, Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new RegistrationError('unauthorized', 'Sessao expirada. Entre novamente.', 401);
      const user = await response.json();
      const allowlist = env('BET_UPLOAD_ALLOWED_EMAILS')
        .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (!user.email || !allowlist.includes(user.email.toLowerCase())) {
        throw new RegistrationError('forbidden', 'Este e-mail nao pode registrar apostas.', 403);
      }
      return user;
    },
    async findJobByHash(hash) {
      const response = await fetchImpl(`${url}/rest/v1/bet_upload_jobs?ingestion_hash=eq.${encodeURIComponent(hash)}&select=*&limit=1`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },
    async getJobForOwner(id, ownerId) {
      const response = await fetchImpl(`${url}/rest/v1/bet_upload_jobs?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=id,status,bet_id,error_code,error_message,result,created_at,purge_after,screenshot_deleted_at,updated_at&limit=1`, { headers: headers(secret) });
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
  res.end(JSON.stringify(body));
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    bet_id: job.bet_id || null,
    error_code: job.error_code || null,
    error_message: job.error_message || null,
    result: job.result || null,
    created_at: job.created_at || null,
    purge_after: job.purge_after || null,
    screenshot_deleted_at: job.screenshot_deleted_at || null,
    updated_at: job.updated_at || null,
  };
}

function createHandler(dependenciesFactory = createSupabaseGateway) {
  return async function registerHandler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' });
    const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    if (!token) return send(res, 401, { ok: false, code: 'unauthorized', message: 'Entre para enviar a aposta.' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const result = await enqueueBetUpload({ token, imageDataUrl: body?.image_data_url }, dependenciesFactory());
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
