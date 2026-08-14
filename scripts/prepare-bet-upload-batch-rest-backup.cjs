'use strict';

// Fallback read-only quando psql/pg_dump nao estao disponiveis.
// Faz somente GET no PostgREST e grava backup local ignorado pelo Git.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalDedupKey } = require('./bet-upload-jobs.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'cron-data', 'migration-backups');
const REQUIRED_BET_COLUMNS = [
  'id', 'created_at', 'bookmaker', 'league', 'team_a', 'team_b', 'market', 'pick',
  'odd', 'stake', 'bet_datetime', 'is_map_bet', 'map_number', 'screenshot_path',
  'notes', 'raw_extraction', 'pandascore_match_id', 'pandascore_match_name',
  'fair_pinnacle', 'fair_formula', 'fair_line_source', 'is_method_bet', 'status',
  'profit', 'settled_at', 'settle_source',
];
const REQUIRED_JOB_COLUMNS = [
  'id', 'status', 'claim_token', 'lease_expires_at', 'bet_id', 'result',
  'storage_path', 'finished_at', 'updated_at', 'error_code', 'error_message',
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function loadConfig() {
  const configProject = process.env.BET_CONFIG_PROJECT
    ? path.resolve(process.env.BET_CONFIG_PROJECT)
    : ROOT;
  const loaderPath = path.join(configProject, '.claude', 'scripts', '_load-config.cjs');
  return require(loaderPath).loadConfig();
}

async function main() {
  const { supabaseUrl, supabaseKey, source } = loadConfig();
  const base = supabaseUrl.replace(/\/$/, '');
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const outputDir = path.join(outputRoot, `bet-upload-batch-rest-${timestamp}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const auth = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  async function getJson(urlPath, extraHeaders = {}) {
    const response = await fetch(`${base}${urlPath}`, {
      method: 'GET',
      headers: { ...auth, ...extraHeaders },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${urlPath.split('?')[0]} HTTP ${response.status}`);
    return { response, body: text ? JSON.parse(text) : null };
  }

  async function fetchTable(table) {
    const rows = [];
    let expectedTotal = null;
    for (let offset = 0; ; offset += 1000) {
      const end = offset + 999;
      const { response, body } = await getJson(
        `/rest/v1/${table}?select=*&order=id.asc`,
        { Prefer: 'count=exact', Range: `${offset}-${end}`, 'Range-Unit': 'items' },
      );
      const page = Array.isArray(body) ? body : [];
      const contentRange = response.headers.get('content-range') || '';
      const total = Number(contentRange.split('/')[1]);
      if (expectedTotal === null && Number.isInteger(total)) expectedTotal = total;
      rows.push(...page);
      if (page.length < 1000) break;
    }
    if (!Number.isInteger(expectedTotal) || rows.length !== expectedTotal) {
      throw new Error(`backup ${table} incompleto: esperado=${expectedTotal} recebido=${rows.length}`);
    }
    return rows;
  }

  const openapi = (await getJson('/rest/v1/', { Accept: 'application/openapi+json' })).body;
  const definitions = openapi.definitions || openapi.components?.schemas || {};
  const paths = new Set(Object.keys(openapi.paths || {}));
  const [bets, jobs] = await Promise.all([fetchTable('bets'), fetchTable('bet_upload_jobs')]);
  const betColumns = Object.keys(definitions.bets?.properties || {});
  const jobColumns = Object.keys(definitions.bet_upload_jobs?.properties || {});
  const now = Date.now();
  const statusCounts = Object.fromEntries(['queued', 'processing', 'registered', 'rejected', 'error']
    .map((status) => [status, jobs.filter((job) => job.status === status).length]));
  const signatures = new Map();
  for (const bet of bets) {
    const key = canonicalDedupKey(bet);
    if (key) signatures.set(key, (signatures.get(key) || 0) + 1);
  }
  const duplicateSignatureGroups = [...signatures.values()].filter((count) => count > 1).length;
  const processingInvalid = jobs.filter((job) => job.status === 'processing'
    && (!job.claim_token || !job.lease_expires_at
      || new Date(job.lease_expires_at).getTime() <= now
      || job.finished_at || job.bet_id)).length;
  const bookmakerCounts = {};
  for (const bet of bets) {
    const bookmaker = String(bet.bookmaker || '').trim().toLowerCase();
    bookmakerCounts[bookmaker] = (bookmakerCounts[bookmaker] || 0) + 1;
  }

  const relevantOpenApi = {
    swagger: openapi.swagger || openapi.openapi || null,
    definitions: {
      bets: definitions.bets || null,
      bet_upload_jobs: definitions.bet_upload_jobs || null,
    },
    paths: {
      bet_upload_job_items: paths.has('/bet_upload_job_items'),
      register_bet_upload_batch: paths.has('/rpc/register_bet_upload_batch'),
      register_canonical_bet: paths.has('/rpc/register_canonical_bet'),
      claim_bet_upload_job: paths.has('/rpc/claim_bet_upload_job'),
      finish_bet_upload_job: paths.has('/rpc/finish_bet_upload_job'),
    },
  };
  const preflight = {
    checked_at: new Date().toISOString(),
    source: 'production_rest_get_only',
    counts: { bets: bets.length, bet_upload_jobs: jobs.length, jobs_by_status: statusCounts },
    bookmaker_counts: bookmakerCounts,
    bets_required_columns_missing: REQUIRED_BET_COLUMNS.filter((name) => !betColumns.includes(name)),
    jobs_required_columns_missing: REQUIRED_JOB_COLUMNS.filter((name) => !jobColumns.includes(name)),
    processing_invalid_lease_or_terminal_metadata: processingInvalid,
    existing_duplicate_signature_groups: duplicateSignatureGroups,
    migration_present: relevantOpenApi.paths.bet_upload_job_items
      || relevantOpenApi.paths.register_bet_upload_batch
      || relevantOpenApi.paths.register_canonical_bet,
    postgres_only_checks: ['extensions.digest(bytea,text)', 'exact udt_name compatibility'],
  };

  const documents = new Map([
    ['bets.json', bets],
    ['bet_upload_jobs.json', jobs],
    ['schema.openapi.relevant.json', relevantOpenApi],
    ['preflight.json', preflight],
  ]);
  const files = [];
  for (const [name, document] of documents) {
    const content = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const filePath = path.join(outputDir, name);
    fs.writeFileSync(filePath, content);
    files.push({ name, bytes: content.length, sha256: sha256(content) });
  }
  const migrationArtifacts = [
    'migrations/2026-08-14-bet-upload-batch.sql',
    'migrations/2026-08-14-bet-upload-batch.preflight.sql',
    'migrations/2026-08-14-bet-upload-batch.rollback.sql',
  ].map((relativePath) => {
    const content = fs.readFileSync(path.join(ROOT, relativePath));
    return { path: relativePath, bytes: content.length, sha256: sha256(content) };
  });
  const manifest = {
    created_at: new Date().toISOString(),
    credential_source: source,
    request_mode: 'GET_ONLY',
    migration_executed: false,
    counts: preflight.counts,
    files,
    migration_artifacts: migrationArtifacts,
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), manifestContent);
  process.stdout.write(JSON.stringify({
    ok: true,
    output_dir: outputDir,
    counts: preflight.counts,
    migration_present: preflight.migration_present,
    duplicate_signature_groups: duplicateSignatureGroups,
    processing_invalid: processingInvalid,
    manifest_sha256: sha256(manifestContent),
  }, null, 2));
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
