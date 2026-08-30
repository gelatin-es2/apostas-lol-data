'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enqueueBetUpload } = require('../lib/register-bet.cjs');
const { parseImageDataUrl, sanitizeDescription } = require('../lib/bet-extraction-contract.cjs');
const { createHandler, createSupabaseGateway, ownerIdFromEnv, publicJob, requestIsSameSite, requestIsSameSiteRead } = require('../bets/register.js');
const { REJECTION_MESSAGES } = require('../lib/bet-upload-public-errors.cjs');
const { createStatusHandler } = require('../bets/upload-status.js');

const { COOKIE_NAME, createAccessSession } = require('../lib/bet-upload-auth.cjs');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')}`;
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '223e4567-e89b-42d3-a456-426614174000';

// A trava de acesso (2026-08-30) le process.env direto no handler, entao o ambiente do
// teste precisa carregar o segredo e o owner. Valores sao de fixture, nao credencial real.
process.env.BET_UPLOAD_OWNER_ID = OWNER_ID;
process.env.BET_UPLOAD_SESSION_SECRET = 'x'.repeat(48);
const AUTH_COOKIE = `${COOKIE_NAME}=${createAccessSession({ ownerId: OWNER_ID, secret: process.env.BET_UPLOAD_SESSION_SECRET })}`;
const withAuth = (headers) => ({ ...headers, cookie: AUTH_COOKIE });

const SAME_ORIGIN_HEADERS = withAuth({ host: 'apostas.example', 'sec-fetch-site': 'same-origin' });

function makeDeps(overrides = {}) {
  const calls = { upload: [], delete: [], create: [] };
  const deps = {
    ownerId: OWNER_ID,
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
  const result = await enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'queued');
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.match(calls.create[0].storage_path, new RegExp(`^${OWNER_ID}/[a-f0-9]{64}\\.png$`));
  assert.deepEqual(Object.keys(calls.create[0]).sort(), ['description', 'ingestion_hash', 'mime_type', 'owner_id', 'status', 'storage_path']);
  assert.equal(calls.create[0].description, null);
  assert.equal('insertBet' in deps, false);
  assert.equal('extract' in deps, false);
});

test('descricao opcional e sanitizada e armazenada separada da imagem', async () => {
  const { deps, calls } = makeDeps();
  await enqueueBetUpload({
    ownerId: OWNER_ID,
    imageDataUrl: PNG_DATA_URL,
    description: '  mapa 2\u0000   depois do draft  ',
  }, deps);
  assert.equal(calls.create[0].description, 'mapa 2 depois do draft');
  assert.equal(sanitizeDescription('   '), null);
  assert.throws(() => sanitizeDescription('a'.repeat(501)), (error) => error.code === 'invalid_description');
  assert.throws(() => sanitizeDescription({ text: 'unsafe' }), (error) => error.code === 'invalid_description');
});

test('mesmo hash do mesmo owner retorna job existente sem novo upload', async () => {
  const existing = { id: JOB_ID, owner_id: OWNER_ID, status: 'processing' };
  const { deps, calls } = makeDeps({ findJobByHash: async () => existing });
  const result = await enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job, existing);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('corrida de hash é idempotente e limpa apenas o upload desta tentativa', async () => {
  const existing = { id: JOB_ID, owner_id: OWNER_ID, status: 'queued' };
  let finds = 0;
  const duplicateError = Object.assign(new Error('duplicate'), { code: '23505' });
  const { deps, calls } = makeDeps({
    findJobByHash: async () => (++finds === 1 ? null : existing),
    createJob: async () => { throw duplicateError; },
  });
  const result = await enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job.id, JOB_ID);
  assert.equal(calls.delete.length, 0);
});

test('hash de outro owner falha sem vazar o job', async () => {
  const { deps, calls } = makeDeps({
    findJobByHash: async () => ({ id: 'private-job', owner_id: 'other-user', status: 'queued' }),
  });
  await assert.rejects(
    enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps),
    (error) => error.code === 'duplicate_image' && error.status === 409,
  );
  assert.equal(calls.upload.length, 0);
});

test('colisao no Storage por corrida retorna o job vencedor', async () => {
  const existing = { id: JOB_ID, owner_id: OWNER_ID, status: 'queued' };
  let finds = 0;
  const { deps, calls } = makeDeps({
    findJobByHash: async () => (++finds === 1 ? null : existing),
    uploadImage: async () => {
      const error = Object.assign(new Error('object already exists'), { code: 'Duplicate' });
      throw error;
    },
  });
  const result = await enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.job.id, JOB_ID);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.delete.length, 0);
});

test('falha ao criar job limpa o upload e não vira sucesso', async () => {
  const { deps, calls } = makeDeps({ createJob: async () => { throw new Error('db down'); } });
  await assert.rejects(enqueueBetUpload({ ownerId: OWNER_ID, imageDataUrl: PNG_DATA_URL }, deps), /db down/);
  assert.equal(calls.delete.length, 1);
});

test('owner server-side ausente falha antes de storage/fila', async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(enqueueBetUpload({ imageDataUrl: PNG_DATA_URL }, deps), (error) => error.code === 'owner_unavailable');
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('endpoint retorna 202 com job, sem processar aposta no request', async () => {
  const { deps } = makeDeps();
  const response = fakeResponse();
  await createHandler(() => deps)({
    method: 'POST', headers: SAME_ORIGIN_HEADERS, body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.job.status, 'queued');
  assert.equal(response.body.bet, undefined);
  assert.equal(response.body.job.storage_path, undefined);
  assert.equal(response.body.job.owner_id, undefined);
});

// 2026-08-30: a trava de acesso voltou por ordem do CEO. Sem cookie valido o upload
// nao passa nem com same-site OK — antes disso, quem tivesse a URL gravava bet no banco.
test('register recusa 401 sem cookie de acesso, mesmo same-origin', async () => {
  const response = fakeResponse();
  await createHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST',
    headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' },
    body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'unauthorized');
});

test('upload-status recusa 401 sem cookie de acesso, mesmo same-origin', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET',
    headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' },
    query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'unauthorized');
});

test('cookie assinado com outro segredo nao abre o endpoint', async () => {
  const forged = `${COOKIE_NAME}=${createAccessSession({ ownerId: OWNER_ID, secret: 'y'.repeat(48) })}`;
  const response = fakeResponse();
  await createHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST',
    headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin', cookie: forged },
    body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 401);
});

test('endpoint valida imagem depois de passar pela trava de acesso', async () => {
  const { deps } = makeDeps();
  const response = fakeResponse();
  await createHandler(() => deps)({
    method: 'POST', headers: SAME_ORIGIN_HEADERS, body: {},
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_image');
});

test('endpoint publico aceita uso normal same-origin e barra cross-site ou sem Origin', async () => {
  assert.equal(requestIsSameSite({ headers: { host: 'apostas.example', origin: 'https://apostas.example', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(requestIsSameSite({ headers: { host: 'apostas.example', origin: 'https://apostas.example' } }), true);
  assert.equal(requestIsSameSite({ headers: {} }), false, 'POST sem Origin nem sec-fetch-site precisa fechar 403');
  assert.equal(requestIsSameSite({ headers: { host: 'apostas.example', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), false);
  const response = fakeResponse();
  await createHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST',
    headers: { host: 'apostas.example', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: {},
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('endpoint publico fecha 403 fail-closed quando o POST nao manda Origin', async () => {
  const response = fakeResponse();
  await createHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'POST',
    headers: {},
    body: { image_data_url: PNG_DATA_URL },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('endpoint publico usa owner server-side e repassa descricao', async () => {
  const { deps, calls } = makeDeps();
  const response = fakeResponse();
  await createHandler(() => deps)({
    method: 'POST',
    headers: SAME_ORIGIN_HEADERS,
    body: { image_data_url: PNG_DATA_URL, description: '  contexto  ' },
  }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(calls.create[0].owner_id, OWNER_ID);
  assert.equal(calls.create[0].description, 'contexto');
});

test('gateway usa UUID owner configurado somente no servidor', () => {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'BET_UPLOAD_OWNER_ID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: 'https://fake.supabase.test',
    SUPABASE_SECRET_KEY: 'fake-secret',
    BET_UPLOAD_OWNER_ID: OWNER_ID,
  });
  try {
    assert.equal(createSupabaseGateway(async () => {}).ownerId, OWNER_ID);
    assert.equal(ownerIdFromEnv({ BET_UPLOAD_OWNER_ID: OWNER_ID }), OWNER_ID);
    assert.throws(() => ownerIdFromEnv({ BET_UPLOAD_OWNER_ID: 'invalid' }), /invalido/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('status publico consulta UUID opaco no owner server-side e filtra resposta', async () => {
  let lookup;
  const response = fakeResponse();
  await createStatusHandler(() => ({
    ownerId: OWNER_ID,
    getJobForOwner: async (id, ownerId) => {
      lookup = { id, ownerId };
      return {
        id,
        status: 'registered',
        bet_id: 'bet-1',
        storage_path: 'private/path.png',
        owner_id: ownerId,
        purge_after: '2026-08-26T12:00:00Z',
        screenshot_deleted_at: null,
      };
    },
  }))({ method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookup, { id: JOB_ID, ownerId: OWNER_ID });
  assert.equal(response.body.job.status, 'registered');
  assert.equal(response.body.job.purge_after, '2026-08-26T12:00:00Z');
  assert.equal(response.body.job.screenshot_deleted_at, null);
  assert.equal(response.body.job.storage_path, undefined);
  assert.equal(response.body.job.owner_id, undefined);
});

test('status publico retorna 404 para UUID opaco inexistente', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => ({ ownerId: OWNER_ID, getJobForOwner: async () => null }))({
    method: 'GET', headers: SAME_ORIGIN_HEADERS, query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'job_not_found');
});

test('status publico aceita GET same-origin sem Origin (fetch nao manda em same-origin)', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => ({ ownerId: OWNER_ID, getJobForOwner: async () => ({ id: JOB_ID, status: 'queued' }) }))({
    method: 'GET', headers: withAuth({ host: 'apostas.example', origin: 'https://apostas.example' }), query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 200);
});

test('status publico aceita Referer same-host quando nao ha sec-fetch-site nem Origin', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => ({ ownerId: OWNER_ID, getJobForOwner: async () => ({ id: JOB_ID, status: 'queued' }) }))({
    method: 'GET', headers: withAuth({ host: 'apostas.example', referer: 'https://apostas.example/dashboard' }), query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 200);
});

test('status publico fecha 403 sem nenhum sinal same-site (sec-fetch-site, Origin ou Referer)', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: {}, query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('status publico fecha 403 quando sec-fetch-site diz cross-site', async () => {
  const response = fakeResponse();
  await createStatusHandler(() => { throw new Error('nao deve criar deps'); })({
    method: 'GET', headers: { host: 'apostas.example', 'sec-fetch-site': 'cross-site' }, query: { id: JOB_ID },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'cross_site_request');
});

test('requestIsSameSiteRead cobre sec-fetch-site, Origin, Referer e ausencia total', () => {
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', 'sec-fetch-site': 'same-site' } }), true);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', 'sec-fetch-site': 'none' } }), false);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', origin: 'https://apostas.example' } }), true);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', origin: 'https://evil.example' } }), false);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', referer: 'https://apostas.example/dashboard' } }), true);
  assert.equal(requestIsSameSiteRead({ headers: { host: 'apostas.example', referer: 'https://evil.example/x' } }), false);
  assert.equal(requestIsSameSiteRead({ headers: {} }), false);
});

test('mensagem publica separa casa invalida de comprovante ilegivel', () => {
  assert.equal(REJECTION_MESSAGES.unsupported_bookmaker, 'Casa de aposta inválida.');
  assert.equal(publicJob({ status: 'rejected', error_code: 'unsupported_bookmaker', error_message: 'mensagem interna' }).error_message,
    'Casa de aposta inválida.');
  assert.equal(publicJob({ status: 'rejected', error_code: 'unreadable_image' }).error_message,
    'Não consegui ler o comprovante. Envie outro print mais claro.');
  assert.equal(publicJob({ status: 'rejected', error_code: 'unsupported_receipt' }).error_message,
    'Comprovante de aposta não reconhecido.');
});

test('erro tecnico nao expoe mensagem interna do worker', () => {
  const job = publicJob({ status: 'error', error_code: 'worker_error', error_message: 'stack ou segredo interno' });
  assert.equal(job.error_message, 'Falha técnica no processamento. Tente novamente.');
  assert.doesNotMatch(JSON.stringify(job), /stack ou segredo/);
});

test('status publico resume batch sem expor result interno', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const job = publicJob({
    status: 'registered',
    bet_id: first,
    result: {
      total: 2,
      inserted: 1,
      reused: 1,
      bet_ids: [first, second],
      items: [{ raw_extraction: { private: 'nao expor' } }],
      storage_path: 'private/path.png',
    },
  });
  assert.equal(job.bet_count, 2);
  assert.deepEqual(job.bet_ids, [first, second]);
  assert.deepEqual(job.result, { total: 2, inserted: 1, reused: 1, bet_ids: [first, second] });
  assert.equal(JSON.stringify(job).includes('private/path'), false);
  assert.equal(JSON.stringify(job).includes('raw_extraction'), false);
});
