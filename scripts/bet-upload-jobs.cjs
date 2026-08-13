'use strict';

const fs = require('fs');
const path = require('path');

const MISSING_CONFIG_MESSAGE = 'Configuracao Supabase ausente: defina SUPABASE_URL e SUPABASE_SECRET_KEY no ambiente ou no .env local';

function canonicalLoadConfig() {
  return require('../.claude/scripts/_load-config.cjs').loadConfig();
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configFromEnv(env = process.env, deps = {}) {
  let url = nonEmpty(env?.SUPABASE_URL);
  let key = nonEmpty(env?.SUPABASE_SECRET_KEY) || nonEmpty(env?.SUPABASE_SERVICE_ROLE_KEY);

  if (!url || !key) {
    let fallback;
    try {
      fallback = (deps.loadConfig || canonicalLoadConfig)();
    } catch {
      throw new Error(MISSING_CONFIG_MESSAGE);
    }
    url = url || nonEmpty(fallback?.supabaseUrl);
    key = key || nonEmpty(fallback?.supabaseKey);
  }

  if (!url || !key) {
    throw new Error(MISSING_CONFIG_MESSAGE);
  }
  return { url: url.replace(/\/$/, ''), key };
}

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function jsonResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body?.message || body?.code || 'erro'}`);
  return body;
}

function createJobClient({ fetchImpl = fetch, env = process.env, loadConfig } = {}) {
  const config = configFromEnv(env, { loadConfig });
  return {
    async list() {
      const response = await fetchImpl(`${config.url}/rest/v1/bet_upload_jobs?select=id,status,storage_path,mime_type,description,attempts,created_at,purge_after,screenshot_deleted_at,updated_at,lease_expires_at,error_code&status=in.(queued,processing)&order=created_at.asc`, { headers: headers(config.key) });
      return jsonResponse(response);
    },
    async claim(workerId, leaseSeconds = 900) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/claim_bet_upload_job`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_worker_id: workerId, p_lease_seconds: leaseSeconds }),
      });
      const rows = await jsonResponse(response);
      return rows?.[0] || null;
    },
    async download(jobId, claimToken, outputPath) {
      const query = new URLSearchParams({ id: `eq.${jobId}`, claim_token: `eq.${claimToken}`, status: 'eq.processing', select: 'storage_path' });
      const jobResponse = await fetchImpl(`${config.url}/rest/v1/bet_upload_jobs?${query}`, { headers: headers(config.key) });
      const jobs = await jsonResponse(jobResponse);
      if (!jobs?.[0]) throw new Error('job não está processing com este claim_token');
      const objectPath = jobs[0].storage_path.split('/').map(encodeURIComponent).join('/');
      const imageResponse = await fetchImpl(`${config.url}/storage/v1/object/bet-screenshots/${objectPath}`, { headers: headers(config.key) });
      if (!imageResponse.ok) throw new Error(`download HTTP ${imageResponse.status}`);
      const resolved = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, Buffer.from(await imageResponse.arrayBuffer()));
      return resolved;
    },
    async finish(payload) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/finish_bet_upload_job`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      const rows = await jsonResponse(response);
      if (!rows?.[0]) throw new Error('lease inválido/expirado ou job já finalizado');
      return rows[0];
    },
    async claimPurge(workerId, leaseSeconds = 600) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/claim_bet_upload_purge`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_worker_id: workerId, p_lease_seconds: leaseSeconds }),
      });
      const rows = await jsonResponse(response);
      return rows?.[0] || null;
    },
    async deleteScreenshot(storagePath) {
      if (typeof storagePath !== 'string' || !storagePath) throw new Error('invalid storage_path');
      const objectPath = storagePath.split('/').map(encodeURIComponent).join('/');
      const response = await fetchImpl(`${config.url}/storage/v1/object/bet-screenshots/${objectPath}`, {
        method: 'DELETE',
        headers: headers(config.key),
      });
      if (!response.ok && response.status !== 404) throw new Error(`purge storage HTTP ${response.status}`);
      return { already_missing: response.status === 404 };
    },
    async finishPurge(jobId, purgeClaimToken) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/finish_bet_upload_purge`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_job_id: jobId, p_purge_claim_token: purgeClaimToken }),
      });
      const rows = await jsonResponse(response);
      if (!rows?.[0]) throw new Error('invalid/expired purge lease or ineligible job');
      return rows[0];
    },
  };
}

async function purgeExpiredScreenshots(client, options = {}) {
  const workerId = options.workerId || `codex-purge-${process.pid}`;
  const leaseSeconds = Number(options.leaseSeconds || 600);
  const limit = Number(options.limit || 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('purge limit must be 1..100');
  const summary = { claimed: 0, deleted: 0, already_missing: 0, jobs: [] };
  for (let index = 0; index < limit; index += 1) {
    const job = await client.claimPurge(workerId, leaseSeconds);
    if (!job) break;
    summary.claimed += 1;
    const deletion = await client.deleteScreenshot(job.storage_path);
    const finished = await client.finishPurge(job.id, job.purge_claim_token);
    summary.deleted += deletion.already_missing ? 0 : 1;
    summary.already_missing += deletion.already_missing ? 1 : 0;
    summary.jobs.push({ id: finished.id, screenshot_deleted_at: finished.screenshot_deleted_at });
  }
  return summary;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} obrigatório`);
  return value;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const client = deps.client || createJobClient(deps);
  const [command, ...args] = argv;
  let output;
  if (command === 'list') {
    output = await client.list();
  } else if (command === 'claim') {
    output = await client.claim(args[0] || `codex-${process.pid}`, Number(args[1] || 900));
  } else if (command === 'download') {
    output = { path: await client.download(requireArg(args[0], 'job_id'), requireArg(args[1], 'claim_token'), requireArg(args[2], 'output_path')) };
  } else if (command === 'finish') {
    const [jobId, claimToken, status, betId, errorCode, errorMessage, resultPath] = args;
    const result = resultPath && resultPath !== '-' ? JSON.parse(fs.readFileSync(path.resolve(resultPath), 'utf8')) : null;
    output = await client.finish({
      p_job_id: requireArg(jobId, 'job_id'),
      p_claim_token: requireArg(claimToken, 'claim_token'),
      p_status: requireArg(status, 'status'),
      p_bet_id: betId && betId !== '-' ? betId : null,
      p_error_code: errorCode && errorCode !== '-' ? errorCode : null,
      p_error_message: errorMessage && errorMessage !== '-' ? errorMessage : null,
      p_result: result,
    });
  } else if (command === 'purge') {
    output = await purgeExpiredScreenshots(client, {
      workerId: args[0] || `codex-purge-${process.pid}`,
      leaseSeconds: Number(args[1] || 600),
      limit: Number(args[2] || 25),
    });
  } else {
    throw new Error('uso: list | claim [worker] [lease_s] | download <job> <token> <path> | finish <job> <token> <registered|rejected|error> <bet_id|-> <error_code|-> <message|-> <result_json|-> | purge [worker] [lease_s] [limit]');
  }
  if (!deps.quiet) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

module.exports = { createJobClient, purgeExpiredScreenshots, main, configFromEnv };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
