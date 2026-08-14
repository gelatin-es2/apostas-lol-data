'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateAndNormalize } = require('../.claude/scripts/supabase-save-bet.cjs');
const { isKnownErrorCode, coerceErrorCode } = require('../api/lib/bet-upload-error-codes.cjs');

const MAX_BATCH_ITEMS = 10;
const SUPPORTED_UPLOAD_BOOKMAKERS = new Set(['estrelabet', 'pinnacle', 'parimatch', 'betano', 'whale.io', 'thunderpick', 'polymarket']);
const BATCH_WORK_DIR = path.resolve(__dirname, '..', 'cron-data', 'bet-upload-work');
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEANUP_SUFFIXES = ['.png', '.jpg', '.webp', '-batch.json', '-result.json'];

const MISSING_CONFIG_MESSAGE = 'Configuracao Supabase ausente: defina SUPABASE_URL e SUPABASE_SECRET_KEY no ambiente ou no .env local';

function canonicalLoadConfig(env = process.env) {
  const configProject = nonEmpty(env?.BET_CONFIG_PROJECT);
  const loaderPath = configProject
    ? path.join(path.resolve(configProject), '.claude', 'scripts', '_load-config.cjs')
    : path.join(__dirname, '..', '.claude', 'scripts', '_load-config.cjs');
  return require(loaderPath).loadConfig();
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
      fallback = deps.loadConfig ? deps.loadConfig() : canonicalLoadConfig(env);
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('valor undefined nao pertence ao contrato JSON');
  return encoded;
}

function itemHash(bet) {
  return crypto.createHash('sha256').update(stableStringify(bet)).digest('hex');
}

function publicItemResult(bet, itemIndex) {
  return {
    item_index: itemIndex,
    bookmaker: bet.bookmaker,
    team_a: bet.team_a,
    team_b: bet.team_b,
    market: bet.market,
    pick: bet.pick,
    odd: bet.odd,
    stake: bet.stake,
    map_number: bet.map_number ?? null,
  };
}

function sanitizeItemError(error) {
  const message = String(error?.message || 'dados invalidos')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/)[^ ]+/g, '[path]')
    .slice(0, 300);
  return message || 'dados invalidos';
}

function ticketFromBet(bet) {
  const raw = bet?.raw_extraction;
  const candidates = [
    raw?.bookmaker_native?.bet_id,
    raw?.bet_id_bookmaker,
    raw?.bet_id,
    raw?.bookmaker_bet_id,
  ];
  for (const value of candidates) {
    const ticket = String(value ?? '').trim().replace(/^#+\s*/, '');
    if (ticket) return ticket;
  }
  return null;
}

function canonicalDedupKey(bet) {
  const ticket = ticketFromBet(bet);
  if (!ticket) return null;
  const bookmakerInput = String(bet?.bookmaker ?? '').trim().toLowerCase();
  const bookmaker = bookmakerInput === 'whale.io' || bookmakerInput === 'whale io'
    ? 'whale'
    : bookmakerInput;
  const compactPick = String(bet?.pick ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const stake = Number(bet?.stake);
  const odd = Number(bet?.odd);
  if (!Number.isFinite(stake) || !Number.isFinite(odd)) throw new Error('stake/odd invalidos para dedup');
  const mapNumber = bet?.map_number == null ? '' : String(Number(bet.map_number));
  return [bookmaker, ticket, compactPick, String(stake), mapNumber, String(odd)].join('\x1f');
}

function resolveBatchPath(inputPath) {
  const requested = path.resolve(requireArg(inputPath, 'batch_json'));
  const resolvedRoot = fs.realpathSync(BATCH_WORK_DIR);
  const resolved = fs.realpathSync(requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('-batch.json')) {
    throw new Error('batch_json deve estar em cron-data/bet-upload-work e terminar em -batch.json');
  }
  if (!fs.statSync(resolved).isFile()) throw new Error('batch_json deve ser arquivo regular');
  return resolved;
}

// Apaga somente os TEMPs exatos de um job (imagem + batch + result), nada alem disso:
// sem curinga, sem -Recurse, sem tocar em outro path. `id` precisa ser um uuid puro,
// entao nao ha como o argumento carregar `..` ou separador de path.
function cleanupJobFiles(id) {
  const jobId = requireArg(id, 'job_id');
  if (!JOB_ID_RE.test(jobId)) throw new Error('cleanup exige um job_id uuid valido');
  const removed = [];
  for (const suffix of CLEANUP_SUFFIXES) {
    const candidate = path.join(BATCH_WORK_DIR, `${jobId}${suffix}`);
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
      removed.push(path.basename(candidate));
    }
  }
  return { id: jobId, removed };
}

function prepareBatch(input, deps = {}) {
  const document = typeof input === 'string' ? JSON.parse(input) : input;
  if (!document || !Array.isArray(document.items)) throw new Error('batch deve conter items em ordem visual');
  if (document.items.length < 1 || document.items.length > MAX_BATCH_ITEMS) {
    throw new Error(`batch deve conter 1..${MAX_BATCH_ITEMS} apostas`);
  }

  const validate = deps.validateAndNormalize || validateAndNormalize;
  const prepared = document.items.map((source, zeroIndex) => {
    const itemIndex = zeroIndex + 1;
    const rawBet = source?.bet || source;
    let normalized;
    try {
      normalized = validate(JSON.stringify(rawBet)).bet;
      if (!SUPPORTED_UPLOAD_BOOKMAKERS.has(normalized.bookmaker)) {
        throw new Error('Casa de aposta invalida.');
      }
      if (normalized.bookmaker !== 'polymarket' && normalized.bookmaker !== 'thunderpick' && !ticketFromBet(normalized)) {
        throw new Error('ticket da casa obrigatorio e ilegivel');
      }
    } catch (error) {
      throw new Error(`Aposta ${itemIndex}: ${sanitizeItemError(error)}`);
    }
    const betWithDefaults = {
      ...normalized,
      status: 'pending',
      profit: null,
      settled_at: null,
      settle_source: null,
    };
    // Remove propriedades undefined antes de assinar: e exatamente este JSON que vai para a RPC.
    const bet = JSON.parse(JSON.stringify(betWithDefaults));
    return {
      item_index: itemIndex,
      item_hash: itemHash(bet),
      dedup_key: canonicalDedupKey(bet),
      bet,
      result: publicItemResult(bet, itemIndex),
    };
  });

  return prepared;
}

async function jsonResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body?.message || body?.code || 'erro'}`);
  return body;
}

function validateBatchResult(body, expectedTotal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('resposta batch invalida');
  const { total, inserted, reused, bet_ids: betIds } = body;
  if (!Number.isInteger(total) || total !== expectedTotal
      || !Number.isInteger(inserted) || inserted < 0
      || !Number.isInteger(reused) || reused < 0
      || inserted + reused !== total
      || !Array.isArray(betIds) || betIds.length !== total
      || betIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))) {
    throw new Error('resposta batch incompleta ou inconsistente');
  }
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
    async registerBatch(jobId, claimToken, items) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/register_bet_upload_batch`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_job_id: jobId, p_claim_token: claimToken, p_items: items }),
      });
      return validateBatchResult(await jsonResponse(response), items.length);
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
  const workerId = options.workerId || `claude-purge-${process.pid}`;
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
    output = await client.claim(args[0] || `claude-${process.pid}`, Number(args[1] || 900));
  } else if (command === 'download') {
    output = { path: await client.download(requireArg(args[0], 'job_id'), requireArg(args[1], 'claim_token'), requireArg(args[2], 'output_path')) };
  } else if (command === 'finish') {
    const [jobId, claimToken, status, betId, errorCodeArg, errorMessage, resultPath] = args;
    let result = resultPath && resultPath !== '-' ? JSON.parse(fs.readFileSync(path.resolve(resultPath), 'utf8')) : null;
    let errorCode = errorCodeArg && errorCodeArg !== '-' ? errorCodeArg : null;
    // O worker (LLM) escreve error_code livremente pelo CLI — nunca confiar sem validar
    // contra a allowlist fechada. Codigo desconhecido vira `extraction_failed`, mas o
    // codigo original fica preservado dentro de `result` pra auditoria (nunca se perde).
    if (errorCode && !isKnownErrorCode(errorCode)) {
      const coerced = coerceErrorCode(errorCode);
      errorCode = coerced.code;
      result = { ...(result || {}), original_error_code: coerced.original_code };
    }
    output = await client.finish({
      p_job_id: requireArg(jobId, 'job_id'),
      p_claim_token: requireArg(claimToken, 'claim_token'),
      p_status: requireArg(status, 'status'),
      p_bet_id: betId && betId !== '-' ? betId : null,
      p_error_code: errorCode,
      p_error_message: errorMessage && errorMessage !== '-' ? errorMessage : null,
      p_result: result,
    });
  } else if (command === 'register-batch') {
    const [jobId, claimToken, batchPath] = args;
    const batchText = fs.readFileSync(resolveBatchPath(batchPath), 'utf8');
    const items = prepareBatch(batchText, deps);
    const assertFairReady = deps.assertFairReady || require('../.claude/scripts/lib/fair-guard.cjs').assertFairReady;
    assertFairReady();
    output = await client.registerBatch(
      requireArg(jobId, 'job_id'),
      requireArg(claimToken, 'claim_token'),
      items,
    );
  } else if (command === 'cleanup') {
    output = cleanupJobFiles(args[0]);
  } else if (command === 'purge') {
    output = await purgeExpiredScreenshots(client, {
      workerId: args[0] || `claude-purge-${process.pid}`,
      leaseSeconds: Number(args[1] || 600),
      limit: Number(args[2] || 25),
    });
  } else {
    throw new Error('uso: list | claim [worker] [lease_s] | download <job> <token> <path> | register-batch <job> <token> <batch_json> | finish <job> <token> <registered|rejected|error> <bet_id|-> <error_code|-> <message|-> <result_json|-> | cleanup <job> | purge [worker] [lease_s] [limit]');
  }
  if (!deps.quiet) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

module.exports = {
  MAX_BATCH_ITEMS,
  ticketFromBet,
  canonicalDedupKey,
  resolveBatchPath,
  createJobClient,
  purgeExpiredScreenshots,
  prepareBatch,
  stableStringify,
  itemHash,
  validateBatchResult,
  cleanupJobFiles,
  main,
  configFromEnv,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
