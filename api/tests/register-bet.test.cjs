'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enqueueBetUpload } = require('../lib/register-bet.cjs');
const { RegistrationError, parseImageDataUrl } = require('../lib/bet-extraction-contract.cjs');
const { createHandler, createSupabaseGateway } = require('../bets/register.js');
const { createStatusHandler } = require('../bets/upload-status.js');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')}`;
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeDeps(overrides = {}) {
  const calls = { upload: [], delete: [], create: [] };
  const deps = {
    authenticate: async () => ({ id: 'user-1', email: 'owner@example.com' }),
    findJobByHash: async () => null,
    uploadImage: async (...args) => calls.upload.push(args),
    deleteImage: async (...args) => calls.delete.push(args),
    createJob: async (job) => {
      calls.create.push(job);
      return { id: JOB_ID, ...job, created_at: '2026-08-12T12:00:00Z' };
    },
    ...overrides,
  };
  return { deps, calls };
}

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

test('imagem valida MIME real e hash estável antes da fila', () => {
  const first = parseImageDataUrl(PNG_DATA_URL);
  assert.equal(first.mimeType, 'image/png');
  assert.equal(first.hash, parseImageDataUrl(PNG_DATA_URL).hash);
  assert.throws(() => parseImageDataUrl('data:image/png;base64,SGVsbG8='), (error) => error.code === 'invalid_image');
});

test('enqueue salva print privado e cria somente job queued', async () => {
  const { deps, calls } = makeDeps();
  const result = await enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'queued');
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.match(calls.create[0].storage_path, /^user-1\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(Object.keys(calls.create[0]).sort(), ['ingestion_hash', 'mime_type', 'owner_id', 'status', 'storage_path']);
  assert.equal('insertBet' in deps, false);
  assert.equal('extract' in deps, false);
});

test('mesmo hash do mesmo owner retorna job existente sem novo upload', async () => {
  const existing = { id: JOB_ID, owner_id: 'user-1', status: 'processing' };
  const { deps, calls } = makeDeps({ findJobByHash: async () => existing });
  const result = await enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job, existing);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('corrida de hash é idempotente e limpa apenas o upload desta tentativa', async () => {
  const existing = { id: JOB_ID, owner_id: 'user-1', status: 'queued' };
  let finds = 0;
  const duplicateError = Object.assign(new Error('duplicate'), { code: '23505' });
  const { deps, calls } = makeDeps({
    findJobByHash: async () => (++finds === 1 ? null : existing),
    createJob: async () => { throw duplicateError; },
  });
  const result = await enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job.id, JOB_ID);
  assert.equal(calls.delete.length, 0);
});

test('hash de outro owner falha sem vazar o job', async () => {
  const { deps, calls } = makeDeps({
    findJobByHash: async () => ({ id: 'private-job', owner_id: 'other-user', status: 'queued' }),
  });
  await assert.rejects(
    enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps),
    (error) => error.code === 'duplicate_image' && error.status === 409,
  );
  assert.equal(calls.upload.length, 0);
});

test('colisao no Storage por corrida retorna o job vencedor', async () => {
  const existing = { id: JOB_ID, owner_id: 'user-1', status: 'queued' };
  let finds = 0;
  const { deps, calls } = makeDeps({
    findJobByHash: async () => (++finds === 1 ? null : existing),
    uploadImage: async () => {
      const error = Object.assign(new Error('object already exists'), { code: 'Duplicate' });
      throw error;
    },
  });
  const result = await enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job.id, JOB_ID);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.delete.length, 0);
});

test('falha ao criar job limpa o upload e não vira sucesso', async () => {
  const { deps, calls } = makeDeps({ createJob: async () => { throw new Error('db down'); } });
  await assert.rejects(enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps), /db down/);
  assert.equal(calls.delete.length, 1);
});

test('auth falha antes de storage/fila', async () => {
  const { deps, calls } = makeDeps({
    authenticate: async () => { throw new RegistrationError('forbidden', 'não', 403); },
  });
  await assert.rejects(enqueueBetUpload({ token: 'valid', imageDataUrl: PNG_DATA_URL }, deps), (error) => error.status === 403);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('endpoint retorna 202 com job, sem processar aposta no request', async () => {
  const { deps } = makeDeps();
  const response = fakeResponse();
  await createHandler(() => deps)({
    method: 'POST', headers: { authorization: 'Bearer valid' }, body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.job.status, 'queued');
  assert.equal(response.body.bet, undefined);
  assert.equal(response.body.job.storage_path, undefined);
  assert.equal(response.body.job.owner_id, undefined);
});

test('endpoint sem bearer retorna 401 antes de criar dependencias', async () => {
  let created = false;
  const response = fakeResponse();
  await createHandler(() => { created = true; return {}; })({
    method: 'POST', headers: {}, body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(created, false);
});

test('gateway autentica pelo bearer e aplica allowlist de email', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'BET_UPLOAD_ALLOWED_EMAILS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: 'https://fake.supabase.test',
    SUPABASE_SECRET_KEY: 'fake-secret',
    SUPABASE_PUBLISHABLE_KEY: 'fake-publishable',
    BET_UPLOAD_ALLOWED_EMAILS: 'OWNER@example.com',
  });
  let request;
  try {
    const allowed = createSupabaseGateway(async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: 'user-1', email: 'owner@example.com' }) };
    });
    assert.equal((await allowed.authenticate('user-token')).id, 'user-1');
    assert.match(request.url, /\/auth\/v1\/user$/);
    assert.equal(request.options.headers.Authorization, 'Bearer user-token');
    assert.equal(request.options.headers.apikey, 'fake-publishable');

    const denied = createSupabaseGateway(async () => ({
      ok: true,
      json: async () => ({ id: 'user-2', email: 'outsider@example.com' }),
    }));
    await assert.rejects(denied.authenticate('other-token'), (error) => error.code === 'forbidden');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('status exige auth e consulta job somente pelo owner autenticado', async () => {
  const unauthorized = fakeResponse();
  await createStatusHandler(() => ({}))({ method: 'GET', headers: {}, query: { id: JOB_ID } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  let lookup;
  const response = fakeResponse();
  await createStatusHandler(() => ({
    authenticate: async () => ({ id: 'owner-1', email: 'owner@example.com' }),
    getJobForOwner: async (id, ownerId) => {
      lookup = { id, ownerId };
      return {
        id,
        status: 'registered',
        bet_id: 'bet-1',
        purge_after: '2026-08-26T12:00:00Z',
        screenshot_deleted_at: null,
      };
    },
  }))({ method: 'GET', headers: { authorization: 'Bearer valid' }, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookup, { id: JOB_ID, ownerId: 'owner-1' });
  assert.equal(response.body.job.status, 'registered');
  assert.equal(response.body.job.purge_after, '2026-08-26T12:00:00Z');
  assert.equal(response.body.job.screenshot_deleted_at, null);
});
