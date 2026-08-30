'use strict';

const {
  authenticateAccessCredential,
  clearAccessCookie,
  credentialFromRequest,
  issueAccessCookie,
  validateAccessCode,
} = require('../lib/bet-upload-auth.cjs');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function createAccessHandler(env = process.env) {
  return async function accessHandler(req, res) {
    try {
      if (req.method === 'GET') {
        const credential = credentialFromRequest(req);
        const user = authenticateAccessCredential(credential, env);
        return send(res, user ? 200 : 401, { ok: Boolean(user) });
      }
      if (req.method === 'DELETE') {
        res.setHeader('Set-Cookie', clearAccessCookie());
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' });

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!validateAccessCode(body?.code, env)) {
        return send(res, 401, { ok: false, code: 'invalid_access', message: 'Codigo invalido.' });
      }
      res.setHeader('Set-Cookie', issueAccessCookie(env));
      return send(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof SyntaxError) return send(res, 400, { ok: false, code: 'invalid_json' });
      console.error('bet_upload_access_failed', { name: error.name });
      return send(res, 500, { ok: false, code: 'access_unavailable', message: 'Acesso indisponivel.' });
    }
  };
}

module.exports = createAccessHandler();
module.exports.createAccessHandler = createAccessHandler;
