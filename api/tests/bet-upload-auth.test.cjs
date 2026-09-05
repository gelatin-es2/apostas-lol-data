'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COOKIE_NAME,
  clearAccessCookie,
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
  assert.ok(Array.isArray(response.headers['Set-Cookie']), 'Set-Cookie precisa ser array (cookie novo + clear do legado)');
  assert.equal(response.headers['Set-Cookie'].length, 2);
  const [issued, legacyClear] = response.headers['Set-Cookie'];
  assert.match(issued, new RegExp(`^${COOKIE_NAME}=`));
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api', 'Max-Age=2592000']) {
    assert.match(issued, new RegExp(attribute));
  }
  // O cookie novo agora vale pra /api inteiro (bets + finance) — nao pode voltar a ficar preso em /api/bets.
  assert.doesNotMatch(issued, /Path=\/api\/bets/);
  // O segundo Set-Cookie apaga o v1 legado (Path=/api/bets) — sem ele o navegador
  // ficaria guardando os 2 pra sempre.
  assert.match(legacyClear, new RegExp(`^${COOKIE_NAME}=;`));
  assert.match(legacyClear, /Path=\/api\/bets/);
  assert.match(legacyClear, /Max-Age=0/);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(ENV.BET_UPLOAD_ACCESS_CODE));
});

test('cookie assinado autoriza GET e adulteracao falha fechada', async () => {
  const now = Date.now();
  const issued = createAccessSession({ ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now });
  assert.deepEqual(verifyAccessSession(issued, { ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now: now + 1000 }), {
    id: OWNER_ID, source: 'access_cookie', version: 2,
  });
  assert.equal(verifyAccessSession(`${issued}x`, { ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now: now + 1000 }), null);

  const allowed = fakeResponse();
  await createAccessHandler(ENV)({ method: 'GET', headers: { cookie: `${COOKIE_NAME}=${issued}` } }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.scope, 'api');
  const denied = fakeResponse();
  await createAccessHandler(ENV)({ method: 'GET', headers: { cookie: `${COOKIE_NAME}=${issued}x` } }, denied);
  assert.equal(denied.statusCode, 401);
});

test('cookie v1 legado (Path=/api/bets) ainda autentica com scope bets', async () => {
  const now = Date.now();
  const v1Payload = Buffer.from(JSON.stringify({ v: 1, sub: OWNER_ID, exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
  const v1Token = `${v1Payload}.${require('crypto').createHmac('sha256', ENV.BET_UPLOAD_SESSION_SECRET).update(v1Payload).digest('base64url')}`;
  assert.deepEqual(verifyAccessSession(v1Token, { ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now }), {
    id: OWNER_ID, source: 'access_cookie', version: 1,
  });

  const response = fakeResponse();
  await createAccessHandler(ENV)({ method: 'GET', headers: { cookie: `${COOKIE_NAME}=${v1Token}` } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.scope, 'bets');
});

test('quando o navegador manda os 2 cookies (v1 mais especifico primeiro, v2 depois), o v2 vence e o scope vira api', async () => {
  const now = Date.now();
  const v1Payload = Buffer.from(JSON.stringify({ v: 1, sub: OWNER_ID, exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
  const v1Token = `${v1Payload}.${require('crypto').createHmac('sha256', ENV.BET_UPLOAD_SESSION_SECRET).update(v1Payload).digest('base64url')}`;
  const v2Token = createAccessSession({ ownerId: OWNER_ID, secret: ENV.BET_UPLOAD_SESSION_SECRET, now });

  const response = fakeResponse();
  await createAccessHandler(ENV)({
    method: 'GET',
    headers: { cookie: `${COOKIE_NAME}=${v1Token}; ${COOKIE_NAME}=${v2Token}` },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.scope, 'api');
});

test('clearAccessCookie apaga os 2 paths (novo e legado)', () => {
  const cleared = clearAccessCookie();
  assert.ok(Array.isArray(cleared));
  assert.equal(cleared.length, 2);
  assert.ok(cleared.some((c) => /Path=\/api;/.test(c) && /Max-Age=0/.test(c)));
  assert.ok(cleared.some((c) => /Path=\/api\/bets/.test(c) && /Max-Age=0/.test(c)));
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
