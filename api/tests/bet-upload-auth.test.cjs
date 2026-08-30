'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COOKIE_NAME,
  createAccessSession,
  credentialFromRequest,
  verifyAccessSession,
} = require('../lib/bet-upload-auth.cjs');
const { createAccessHandler } = require('../bets/access.js');

const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ENV = {
  BET_UPLOAD_OWNER_ID: OWNER_ID,
  BET_UPLOAD_ACCESS_CODE: 'correct-horse-battery-staple',
  BET_UPLOAD_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

test('codigo forte vira cookie HttpOnly sem retornar segredo no body', async () => {
  const response = fakeResponse();
  await createAccessHandler(ENV)({ method: 'POST', headers: {}, body: { code: ENV.BET_UPLOAD_ACCESS_CODE } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.match(response.headers['Set-Cookie'], new RegExp(`^${COOKIE_NAME}=`));
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/bets', 'Max-Age=2592000']) {
    assert.match(response.headers['Set-Cookie'], new RegExp(attribute));
  }
  assert.doesNotMatch(JSON.stringify(response), new RegExp(ENV.BET_UPLOAD_ACCESS_CODE));
});

test('cookie assinado autoriza GET e adulteracao falha fechada', async () => {
  const now = Date.now();
  const issued = createAccessSession({ ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now });
  assert.deepEqual(verifyAccessSession(issued, { ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now: now + 1000 }), {
    id: OWNER_ID, source: 'access_cookie',
  });
  assert.equal(verifyAccessSession(`${issued}x`, { ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now: now + 1000 }), null);

  const allowed = fakeResponse();
  await createAccessHandler(ENV)({ method: 'GET', headers: { cookie: `${COOKIE_NAME}=${issued}` } }, allowed);
  assert.equal(allowed.statusCode, 200);
  const denied = fakeResponse();
  await createAccessHandler(ENV)({ method: 'GET', headers: { cookie: `${COOKIE_NAME}=${issued}x` } }, denied);
  assert.equal(denied.statusCode, 401);
});

test('credential prefere bearer existente e aceita cookie sem expor valor', () => {
  assert.deepEqual(credentialFromRequest({ headers: { authorization: 'Bearer existing-session', cookie: `${COOKIE_NAME}=cookie-session` } }), {
    type: 'supabase', token: 'existing-session',
  });
  assert.deepEqual(credentialFromRequest({ headers: { cookie: `${COOKIE_NAME}=cookie-session` } }), {
    type: 'access_cookie', token: 'cookie-session',
  });
});

test('codigo invalido e configuracao fraca falham sem cookie', async () => {
  const invalid = fakeResponse();
  await createAccessHandler(ENV)({ method: 'POST', headers: {}, body: { code: 'wrong' } }, invalid);
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.headers['Set-Cookie'], undefined);

  const unavailable = fakeResponse();
  await createAccessHandler({ ...ENV, BET_UPLOAD_SESSION_SECRET: 'short' })({
    method: 'POST', headers: {}, body: { code: ENV.BET_UPLOAD_ACCESS_CODE },
  }, unavailable);
  assert.equal(unavailable.statusCode, 500);
  assert.deepEqual(unavailable.body, { ok: false, code: 'access_unavailable', message: 'Acesso indisponivel.' });
  assert.equal(unavailable.headers['Set-Cookie'], undefined);
});
