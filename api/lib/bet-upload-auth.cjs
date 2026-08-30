'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'bet_upload_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function requiredEnv(env, name, minLength = 1) {
  const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
  if (value.length < minLength) throw new Error(`${name} nao configurada com seguranca`);
  return value;
}

function ownerIdFromEnv(env) {
  const ownerId = requiredEnv(env, 'BET_UPLOAD_OWNER_ID');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ownerId)) {
    throw new Error('BET_UPLOAD_OWNER_ID invalido');
  }
  return ownerId;
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createAccessSession({ ownerId, secret, now = Date.now(), maxAgeSeconds = SESSION_MAX_AGE_SECONDS }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: ownerId, exp: Math.floor(now / 1000) + maxAgeSeconds })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifyAccessSession(token, { ownerId, secret, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed.sub !== ownerId || !Number.isInteger(parsed.exp) || parsed.exp <= Math.floor(now / 1000)) return null;
    return { id: parsed.sub, source: 'access_cookie' };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

function credentialFromRequest(req) {
  const bearer = String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return { type: 'supabase', token: bearer };
  const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
  return token ? { type: 'access_cookie', token } : null;
}

function authenticateAccessCredential(credential, env = process.env) {
  if (credential?.type !== 'access_cookie') return null;
  const ownerId = ownerIdFromEnv(env);
  const secret = requiredEnv(env, 'BET_UPLOAD_SESSION_SECRET', 32);
  return verifyAccessSession(credential.token, { ownerId, secret });
}

function validateAccessCode(code, env = process.env) {
  const expected = requiredEnv(env, 'BET_UPLOAD_ACCESS_CODE', 16);
  return typeof code === 'string' && code.length <= 256 && safeEqual(code.trim(), expected);
}

function issueAccessCookie(env = process.env, now = Date.now()) {
  const ownerId = ownerIdFromEnv(env);
  const secret = requiredEnv(env, 'BET_UPLOAD_SESSION_SECRET', 32);
  const token = createAccessSession({ ownerId, secret, now });
  return `${COOKIE_NAME}=${token}; Path=/api/bets; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearAccessCookie() {
  return `${COOKIE_NAME}=; Path=/api/bets; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  authenticateAccessCredential,
  clearAccessCookie,
  createAccessSession,
  credentialFromRequest,
  issueAccessCookie,
  ownerIdFromEnv,
  safeEqual,
  validateAccessCode,
  verifyAccessSession,
};
