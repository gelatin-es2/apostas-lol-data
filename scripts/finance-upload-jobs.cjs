'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { configFromEnv } = require('./bet-upload-jobs.cjs');
const { validateFinanceExtract, FinanceExtractError, sanitizeFinanceError } = require('../api/lib/finance-extract-contract.cjs');
const {
  coerceFinanceErrorCode, FINANCE_REJECTION_MESSAGES, FINANCE_GENERIC_REJECTION_MESSAGE,
} = require('../api/lib/finance-error-codes.cjs');

const WORK_DIR = path.resolve(__dirname, '..', 'cron-data', 'finance-upload-work');
const BUCKET = 'finance-uploads';
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEANUP_SUFFIXES = ['.png', '.jpg', '.webp', '-extract.json', '-result.json'];

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function jsonResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body?.message || body?.code || 'erro'}`);
  return body;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} obrigatório`);
  return value;
}

function resolveExtractPath(inputPath) {
  const requested = path.resolve(requireArg(inputPath, 'extract_json'));
  const resolvedRoot = fs.realpathSync(WORK_DIR);
  const resolved = fs.realpathSync(requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('-extract.json')) {
    throw new Error('extract_json deve estar em cron-data/finance-upload-work e terminar em -extract.json');
  }
  if (!fs.statSync(resolved).isFile()) throw new Error('extract_json deve ser arquivo regular');
  return resolved;
}

// Apaga somente os TEMPs exatos de um job (imagem + extract + result), nada alem
// disso: sem curinga, sem -Recurse, sem tocar em outro path. `id` precisa ser um
// uuid puro, entao nao ha como o argumento carregar `..` ou separador de path.
function cleanupJobFiles(id) {
  const jobId = requireArg(id, 'job_id');
  if (!JOB_ID_RE.test(jobId)) throw new Error('cleanup exige um job_id uuid valido');
  const removed = [];
  for (const suffix of CLEANUP_SUFFIXES) {
    const candidate = path.join(WORK_DIR, `${jobId}${suffix}`);
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
      removed.push(path.basename(candidate));
    }
  }
  return { id: jobId, removed };
}

function resultCachePathFor(jobId) {
  return path.join(WORK_DIR, `${jobId}-result.json`);
}

// Hash das dedup_key das linhas do extract (ORDENADAS, pra nao depender da ordem em que
// o LLM escreveu as transacoes). Usado pra saber se o `<id>-result.json` em cache ainda
// corresponde ao extract ATUAL — se o worker reescreveu o arquivo com conteudo diferente
// (ex.: corrigiu uma linha depois de um erro de validacao anterior), o cache velho nao
// pode ser reaproveitado: precisa inserir de novo (insertTransactions e idempotente via
// on_conflict=ignore-duplicates, entao repetir e seguro).
function computeRowsHash(rows) {
  const keys = rows.map((row) => row.dedup_key).sort();
  return crypto.createHash('sha256').update(keys.join('\x1f')).digest('hex');
}

function createFinanceJobClient({ fetchImpl = fetch, env = process.env, loadConfig } = {}) {
  const config = configFromEnv(env, { loadConfig });
  return {
    async list() {
      const response = await fetchImpl(`${config.url}/rest/v1/finance_upload_jobs?select=id,status,storage_path,mime_type,note,attempts,created_at,purge_after,image_deleted_at,updated_at,lease_expires_at,error_code&status=in.(queued,processing)&order=created_at.asc`, { headers: headers(config.key) });
      return jsonResponse(response);
    },
    async claim(workerId, leaseSeconds = 900) {
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/claim_finance_upload_job`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_worker_id: workerId, p_lease_seconds: leaseSeconds }),
      });
      const rows = await jsonResponse(response);
      return rows?.[0] || null;
    },
    async download(jobId, claimToken, outputPath) {
      const query = new URLSearchParams({ id: `eq.${jobId}`, claim_token: `eq.${claimToken}`, status: 'eq.processing', select: 'storage_path' });
      const jobResponse = await fetchImpl(`${config.url}/rest/v1/finance_upload_jobs?${query}`, { headers: headers(config.key) });
      const jobs = await jsonResponse(jobResponse);
      if (!jobs?.[0]) throw new Error('job não está processing com este claim_token');
      const objectPath = jobs[0].storage_path.split('/').map(encodeURIComponent).join('/');
      const imageResponse = await fetchImpl(`${config.url}/storage/v1/object/${BUCKET}/${objectPath}`, { headers: headers(config.key) });
      if (!imageResponse.ok) throw new Error(`download HTTP ${imageResponse.status}`);
      const resolved = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, Buffer.from(await imageResponse.arrayBuffer()));
      return resolved;
    },
    async getClaimedJob(jobId, claimToken) {
      const query = new URLSearchParams({ id: `eq.${jobId}`, claim_token: `eq.${claimToken}`, status: 'eq.processing', select: 'id,owner_id,note,storage_path' });
      const response = await fetchImpl(`${config.url}/rest/v1/finance_upload_jobs?${query}`, { headers: headers(config.key) });
      const jobs = await jsonResponse(response);
      return jobs?.[0] || null;
    },
    // Dead-letter do watcher (composto de scripts/bet-upload-watcher.cjs) manda
    // sempre p_bet_id:null no payload de finish — a RPC de financas nao tem esse
    // parametro, entao a chave precisa ser descartada antes do POST (senao o
    // PostgREST responde 404 PGRST202 e o job veneno nunca fecha).
    async finish(payload) {
      const { p_bet_id, ...rest } = payload || {};
      void p_bet_id;
      const response = await fetchImpl(`${config.url}/rest/v1/rpc/finish_finance_upload_job`, {
        method: 'POST',
        headers: headers(config.key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(rest),
      });
      const rows = await jsonResponse(response);
      if (!rows?.[0]) throw new Error('lease inválido/expirado ou job já finalizado');
      return rows[0];
    },
    async insertTransactions(rows) {
      if (!Array.isArray(rows) || !rows.length) return [];
      const response = await fetchImpl(`${config.url}/rest/v1/finance_transactions?on_conflict=owner_id,dedup_key`, {
        method: 'POST',
        headers: headers(config.key, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=representation',
        }),
        body: JSON.stringify(rows),
      });
      return jsonResponse(response);
    },
    async listPurgeable(limit) {
      const nowIso = new Date().toISOString();
      const query = new URLSearchParams({
        image_deleted_at: 'is.null',
        select: 'id,storage_path',
        order: 'purge_after.asc',
        limit: String(limit),
      });
      const response = await fetchImpl(`${config.url}/rest/v1/finance_upload_jobs?${query}&purge_after=lte.${encodeURIComponent(nowIso)}&status=in.(registered,rejected,error)`, { headers: headers(config.key) });
      return jsonResponse(response);
    },
    async deleteImage(storagePath) {
      if (typeof storagePath !== 'string' || !storagePath) throw new Error('invalid storage_path');
      const objectPath = storagePath.split('/').map(encodeURIComponent).join('/');
      const response = await fetchImpl(`${config.url}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'DELETE',
        headers: headers(config.key),
      });
      if (!response.ok && response.status !== 404) throw new Error(`purge storage HTTP ${response.status}`);
      return { already_missing: response.status === 404 };
    },
    async markImageDeleted(jobId) {
      const nowIso = new Date().toISOString();
      const response = await fetchImpl(`${config.url}/rest/v1/finance_upload_jobs?id=eq.${jobId}`, {
        method: 'PATCH',
        headers: headers(config.key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({ image_deleted_at: nowIso, updated_at: nowIso }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`purge patch HTTP ${response.status}`);
      return { image_deleted_at: nowIso };
    },
  };
}

// Sem RPC de purge propria (o lock do watcher garante instancia unica, entao nao
// precisa de claim atomico como o purge de bets). So marca image_deleted_at quando
// o delete do Storage nao lancar — se lancar, a auditoria fica pendente pro proximo
// ciclo em vez de mentir que a foto sumiu.
async function purgeExpiredImages(client, options = {}) {
  const limit = Number(options.limit ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('purge limit must be 1..100');
  const jobs = await client.listPurgeable(limit);
  const summary = { claimed: jobs.length, deleted: 0, already_missing: 0, jobs: [] };
  for (const job of jobs) {
    const deletion = await client.deleteImage(job.storage_path);
    summary.deleted += deletion.already_missing ? 0 : 1;
    summary.already_missing += deletion.already_missing ? 1 : 0;
    const marked = await client.markImageDeleted(job.id);
    summary.jobs.push({ id: job.id, image_deleted_at: marked.image_deleted_at });
  }
  return summary;
}

async function finishRejected(client, jobId, claimToken, code) {
  const { code: known } = coerceFinanceErrorCode(code);
  await client.finish({
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_status: 'rejected',
    p_error_code: known,
    p_error_message: FINANCE_REJECTION_MESSAGES[known] || FINANCE_GENERIC_REJECTION_MESSAGE,
    p_result: null,
  });
  return { ok: false, job_id: jobId, status: 'rejected', error_code: known };
}

// Le <id>-extract.json, valida contra o contrato (api/lib/finance-extract-contract.cjs),
// insere as transacoes com dedup automatico e finaliza o job. Idempotente: se o insert
// ja tiver acontecido numa chamada anterior (mesmo job ainda 'processing' porque o
// finish daquela chamada se perdeu) E o conteudo do extract for o MESMO (mesmo
// rows_hash — ver computeRowsHash), reaproveita inserted/duplicates do <id>-result.json
// em vez de inserir de novo. Se o worker reescreveu o extract com conteudo DIFERENTE
// (ex.: corrigiu uma linha), o cache velho e ignorado e o insert roda de novo.
//
// JSON invalido ou erro de VALIDACAO de conteudo (categoria fora da lista, data
// impossivel, valor zerado etc.) NUNCA fecha o job: so lanca um Error com a mensagem
// acionavel (campo + motivo) e o job continua `processing` (lease viva). O worker
// corrige o `<id>-extract.json` e roda `register` de novo — a validacao roda sempre
// ANTES de qualquer insert, entao repetir depois de corrigir e seguro. So
// `unsupported_document` e terminal (a foto nunca vai virar fatura/extrato de novo).
async function registerExtract(client, { jobId, claimToken, extractPath }) {
  const resolvedExtractPath = resolveExtractPath(extractPath);
  const claimed = await client.getClaimedJob(jobId, claimToken);
  if (!claimed) throw new Error('job não está processing com este claim_token');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedExtractPath, 'utf8'));
  } catch (error) {
    throw new Error(`extract invalido: ${sanitizeFinanceError(error)}`);
  }

  let document;
  let rows;
  let baseResult;
  try {
    ({ document, rows, result: baseResult } = validateFinanceExtract(parsed, { ownerId: claimed.owner_id, jobId }));
  } catch (error) {
    if (error instanceof FinanceExtractError && error.code === 'unsupported_document') {
      return finishRejected(client, jobId, claimToken, 'unsupported_document');
    }
    throw new Error(`extract invalido: ${sanitizeFinanceError(error)}`);
  }
  void document;

  const cachePath = resultCachePathFor(jobId);
  const rowsHash = computeRowsHash(rows);
  let inserted;
  let duplicates;
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.rows_hash === rowsHash) {
      inserted = cached.inserted;
      duplicates = cached.duplicates;
    }
  }
  if (inserted === undefined) {
    const insertedRows = await client.insertTransactions(rows);
    inserted = insertedRows.length;
    duplicates = rows.length - inserted;
    fs.writeFileSync(cachePath, JSON.stringify({
      inserted, duplicates, claim_token: claimToken, rows_hash: rowsHash,
    }));
  }

  const result = { ...baseResult, inserted, duplicates };
  await client.finish({
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_status: 'registered',
    p_error_code: null,
    p_error_message: null,
    p_result: result,
  });

  return {
    ok: true, job_id: jobId, inserted, duplicates,
    lines_detected: result.lines_detected, reconciliation: result.reconciliation,
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const client = deps.client || createFinanceJobClient(deps);
  const [command, ...args] = argv;
  let output;
  if (command === 'list') {
    output = await client.list();
  } else if (command === 'claim') {
    output = await client.claim(args[0] || `claude-${process.pid}`, Number(args[1] || 900));
  } else if (command === 'download') {
    output = { path: await client.download(requireArg(args[0], 'job_id'), requireArg(args[1], 'claim_token'), requireArg(args[2], 'output_path')) };
  } else if (command === 'register') {
    output = await registerExtract(client, {
      jobId: requireArg(args[0], 'job_id'),
      claimToken: requireArg(args[1], 'claim_token'),
      extractPath: requireArg(args[2], 'extract_json'),
    });
  } else if (command === 'finish') {
    // Formato canonico e 6 args (job, claim, status, error_code, message, result_json).
    // Aceita tambem o formato legado de 7 args com um slot vazio ("-") logo depois do
    // status — sobra do tempo em que o prompt confundia com o `finish` de bets (que tem
    // p_bet_id no meio) — descarta esse slot com aviso em vez de falhar.
    let finishArgs = args;
    if (finishArgs.length === 7 && finishArgs[3] === '-') {
      process.stderr.write('aviso: finish recebeu 7 args (formato legado) — descartando o 4o arg vazio\n');
      finishArgs = [...finishArgs.slice(0, 3), ...finishArgs.slice(4)];
    }
    const [jobId, claimToken, status, errorCodeArg, errorMessage, resultPathArg] = finishArgs;
    let result = resultPathArg && resultPathArg !== '-' ? JSON.parse(fs.readFileSync(path.resolve(resultPathArg), 'utf8')) : null;
    // O worker (LLM) escreve error_code livremente pelo CLI — nunca confiar sem validar
    // contra a allowlist fechada. Codigo desconhecido vira `extraction_failed`, mas o
    // codigo original fica preservado dentro de `result` pra auditoria.
    let errorCode = errorCodeArg && errorCodeArg !== '-' ? errorCodeArg : null;
    if (errorCode) {
      const coerced = coerceFinanceErrorCode(errorCode);
      errorCode = coerced.code;
      if (coerced.original_code) result = { ...(result || {}), original_error_code: coerced.original_code };
    }
    output = await client.finish({
      p_job_id: requireArg(jobId, 'job_id'),
      p_claim_token: requireArg(claimToken, 'claim_token'),
      p_status: requireArg(status, 'status'),
      p_error_code: errorCode,
      p_error_message: errorMessage && errorMessage !== '-' ? errorMessage : null,
      p_result: result,
    });
  } else if (command === 'cleanup') {
    output = cleanupJobFiles(args[0]);
  } else if (command === 'purge') {
    output = await purgeExpiredImages(client, { limit: Number(args[0] || 25) });
  } else {
    throw new Error('uso: list | claim [worker] [lease_s] | download <job> <token> <path> | register <job> <token> <extract_json> | finish <job> <token> <registered|rejected|error> <error_code|-> <message|-> <result_json|-> | cleanup <job> | purge [limit]');
  }
  if (!deps.quiet) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

module.exports = {
  WORK_DIR,
  BUCKET,
  createFinanceJobClient,
  purgeExpiredImages,
  resolveExtractPath,
  cleanupJobFiles,
  registerExtract,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  });
}
