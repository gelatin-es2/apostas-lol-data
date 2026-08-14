'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  prepareBatch, main, MAX_BATCH_ITEMS, canonicalDedupKey, itemHash, stableStringify,
} = require('../../scripts/bet-upload-jobs.cjs');

const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.sql'), 'utf8');
const rollback = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.rollback.sql'), 'utf8');
const prompt = fs.readFileSync(path.resolve(__dirname, '../../scripts/bet-upload-worker-prompt.txt'), 'utf8');
const preflight = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.preflight.sql'), 'utf8');
const postflight = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.postflight.sql'), 'utf8');
const postflightSummary = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.postflight-summary.sql'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-14-bet-upload-batch.manifest.json'), 'utf8'));
const restBackup = fs.readFileSync(path.resolve(__dirname, '../../scripts/prepare-bet-upload-batch-rest-backup.cjs'), 'utf8');
const legacyWriter = fs.readFileSync(path.resolve(__dirname, '../../.claude/scripts/supabase-save-bet.cjs'), 'utf8');
const pinnacleFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'pinnacle-ee5776e3.fixture.json'), 'utf8'));
const batchWorkDir = path.resolve(__dirname, '../../cron-data/bet-upload-work');

function workBatchPath(label) {
  fs.mkdirSync(batchWorkDir, { recursive: true });
  return path.join(batchWorkDir, `${label}-${process.pid}-${Date.now()}-batch.json`);
}

function bet(overrides = {}) {
  return {
    bookmaker: 'pinnacle',
    league: 'LCK',
    team_a: 'T1',
    team_b: 'Dplus KIA',
    market: 'Total Map 1',
    pick: 'Over 31.5',
    odd: 1.826,
    stake: 400,
    bet_datetime: '2026-08-14T12:00:00Z',
    is_map_bet: true,
    map_number: 1,
    status: 'green',
    profit: 330.4,
    settled_at: '2026-08-14T13:00:00Z',
    settle_source: 'untrusted',
    raw_extraction: {
      bookmaker_native: { bet_id: '3101928902' },
      match_context: {
        schema_version: 1,
        lolesports_match_id: 'match-1',
        start_time: '2026-08-14T12:00:00Z',
        ambiguous: false,
      },
    },
    ...overrides,
  };
}

test('prepareBatch suporta single e força todos os campos financeiros pending', () => {
  const [item] = prepareBatch({ items: [{ bet: bet() }] });
  assert.equal(MAX_BATCH_ITEMS, 10);
  assert.equal(item.item_index, 1);
  assert.match(item.item_hash, /^[a-f0-9]{64}$/);
  assert.equal(item.bet.status, 'pending');
  assert.equal(item.bet.profit, null);
  assert.equal(item.bet.settled_at, null);
  assert.equal(item.bet.settle_source, null);
  assert.deepEqual(item.result, {
    item_index: 1,
    bookmaker: 'pinnacle', team_a: 'T1', team_b: 'Dplus',
    market: 'Total Map 1', pick: 'Over 31.5', odd: 1.826,
    stake: 400, map_number: 1,
  });
});

test('prepareBatch valida todos e identifica o card invalido antes de qualquer dependencia mutavel', () => {
  assert.throws(
    () => prepareBatch({ items: [{ bet: bet() }, { bet: bet({ odd: 1 }) }] }),
    /Aposta 2: odd .* deve ser > 1/,
  );
  assert.throws(() => prepareBatch({ items: [] }), /1\.\.10/);
  assert.throws(() => prepareBatch({ items: Array.from({ length: 11 }, () => bet()) }), /1\.\.10/);
});

test('hash do item e estavel e ladders diferentes nao colapsam', () => {
  const first = prepareBatch({ items: [bet({ pick: 'Over 31.5', odd: 1.826, stake: 400 })] })[0];
  const same = prepareBatch({ items: [bet({ pick: 'Over 31.5', odd: 1.826, stake: 400 })] })[0];
  const ladder = prepareBatch({ items: [bet({ pick: 'Over 30.5', odd: 1.704, stake: 1500.62 })] })[0];
  assert.equal(first.item_hash, same.item_hash);
  assert.notEqual(first.item_hash, ladder.item_hash);
  assert.equal(first.item_hash, itemHash(first.bet));
  assert.equal(first.item_hash, require('crypto').createHash('sha256').update(stableStringify(first.bet)).digest('hex'));
  assert.notEqual(canonicalDedupKey(first.bet), canonicalDedupKey(ladder.bet));
  assert.equal(
    canonicalDedupKey({ ...first.bet, bookmaker: 'Whale.io' }),
    canonicalDedupKey({ ...first.bet, bookmaker: 'whale' }),
  );
});

test('fixture real ee5776e3 preserva os 3 tickets/stakes/ladders Pinnacle em ordem visual', (t) => {
  if (fs.existsSync(pinnacleFixture.source_path)) {
    const image = fs.readFileSync(pinnacleFixture.source_path);
    assert.equal(require('crypto').createHash('sha256').update(image).digest('hex'), pinnacleFixture.sha256);
    assert.equal(image.readUInt32BE(16), pinnacleFixture.width);
    assert.equal(image.readUInt32BE(20), pinnacleFixture.height);
  } else {
    t.diagnostic(`fixture visual externa ausente; validando sidecar auditavel: ${pinnacleFixture.job_id}`);
  }

  const items = pinnacleFixture.cards.map((card) => bet({
    bookmaker: pinnacleFixture.bookmaker_visual,
    pick: card.pick,
    odd: card.odd,
    stake: card.stake,
    raw_extraction: {
      bookmaker_native: {
        bet_id: card.ticket,
        raw_pick_text: card.pick,
        raw_stake_text: `BRL ${card.stake.toFixed(2)}`,
        raw_win_text: `BRL ${card.win.toFixed(2)}`,
        potential_profit: card.win,
      },
      match_context: {
        schema_version: 1, lolesports_match_id: 'match-1',
        start_time: '2026-08-14T12:00:00Z', ambiguous: false,
      },
    },
  }));
  const prepared = prepareBatch({ items });
  assert.equal(prepared.length, 3);
  assert.deepEqual(prepared.map((item) => item.bet.bookmaker), ['pinnacle', 'pinnacle', 'pinnacle']);
  assert.deepEqual(prepared.map((item) => item.bet.raw_extraction.bookmaker_native.bet_id), pinnacleFixture.cards.map((card) => card.ticket));
  assert.deepEqual(prepared.map((item) => item.bet.stake), [400, 1599.62, 1000]);
  assert.deepEqual(prepared.map((item) => item.bet.pick), ['Over 31.5', 'Over 30.5', 'Over 29.5']);
  assert.equal(new Set(prepared.map((item) => item.dedup_key)).size, 3);
});

test('concorrencia simulada serializa assinatura sem colapsar as 3 ladders Pinnacle', async () => {
  const prepared = pinnacleFixture.cards.map((card) => prepareBatch({ items: [bet({
    bookmaker: 'pinnacle', pick: card.pick, odd: card.odd, stake: card.stake,
    raw_extraction: {
      bookmaker_native: {
        bet_id: card.ticket,
        raw_stake_text: `BRL ${card.stake.toFixed(2)}`,
        raw_win_text: `BRL ${card.win.toFixed(2)}`,
      },
      match_context: { schema_version: 1, lolesports_match_id: 'match-1', start_time: '2026-08-14T12:00:00Z', ambiguous: false },
    },
  })] })[0]);
  const stored = new Map();
  const tails = new Map();

  async function registerSimulated(items) {
    let inserted = 0;
    let reused = 0;
    for (const item of items) {
      const previous = tails.get(item.dedup_key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      tails.set(item.dedup_key, previous.then(() => current));
      await previous;
      try {
        if (stored.has(item.dedup_key)) reused += 1;
        else {
          await new Promise((resolve) => setImmediate(resolve));
          stored.set(item.dedup_key, item.item_hash);
          inserted += 1;
        }
      } finally {
        release();
      }
    }
    return { inserted, reused };
  }

  const results = await Promise.all([registerSimulated(prepared), registerSimulated(prepared)]);
  assert.equal(stored.size, 3);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 3);
  assert.equal(results.reduce((sum, result) => sum + result.reused, 0), 3);
});

test('quatro casas BRL aceitam os quatro paths legados de ticket', () => {
  const fixtures = [
    ['estrelabet', { bookmaker_native: { bet_id: '#A-1' } }],
    ['pinnacle', { bet_id_bookmaker: 'B-2' }],
    ['parimatch', { bet_id: 'C-3' }],
    ['betano', { bookmaker_bet_id: 'D-4' }],
  ];
  const items = fixtures.map(([bookmaker, rawTicket], index) => bet({
    bookmaker,
    pick: `Over ${28 + index}.5`,
    raw_extraction: {
      ...rawTicket,
      match_context: {
        schema_version: 1, lolesports_match_id: 'match-1',
        start_time: '2026-08-14T12:00:00Z', ambiguous: false,
      },
    },
  }));
  assert.equal(prepareBatch({ items }).length, 4);
  assert.throws(() => prepareBatch({ items: [bet({ raw_extraction: {
    match_context: { schema_version: 1, lolesports_match_id: 'match-1', start_time: '2026-08-14T12:00:00Z' },
  } })] }), /Aposta 1: ticket da casa obrigatorio/);
});

test('Polymarket sem ticket preserva USD, FX, shares e odd_exact', () => {
  const polymarket = bet({
    bookmaker: 'polymarket',
    market: 'Game 2 Winner',
    pick: 'ROSS',
    odd: 2.22,
    stake: 1093.5,
    map_number: 2,
    raw_extraction: {
      original_currency: 'USD',
      original_stake_usd: 202.5,
      fx_usd_brl: 5.4,
      fx_source: 'BCB PTAX 2026-08-14T10:00:00Z',
      execution_totals: {
        cost_usd: 202.5,
        shares: 450,
        payout_usd: 450,
        odd_display: 2.22,
        odd_exact: 2.2222222222222223,
      },
      match_context: {
        schema_version: 1, lolesports_match_id: 'match-1',
        start_time: '2026-08-14T12:00:00Z', ambiguous: false,
      },
    },
  });
  const [prepared] = prepareBatch({ items: [polymarket] });
  assert.equal(prepared.bet.raw_extraction.original_currency, 'USD');
  assert.equal(prepared.bet.raw_extraction.execution_totals.shares, 450);
  assert.equal(prepared.bet.raw_extraction.execution_totals.odd_exact, 450 / 202.5);
  assert.equal(prepared.bet.raw_extraction.bookmaker_native?.bet_id, undefined);
  assert.equal(prepared.dedup_key, null);
});

test('register-batch chama fair guard e uma unica RPC depois da validacao integral', async (t) => {
  const batchPath = workBatchPath('valid');
  fs.writeFileSync(batchPath, JSON.stringify({ items: [bet(), bet({ pick: 'Over 30.5', odd: 1.704, stake: 1500.62 })] }));
  t.after(() => fs.rmSync(batchPath, { force: true }));
  const calls = [];
  const output = await main(['register-batch', 'job-1', 'claim-1', batchPath], {
    quiet: true,
    client: { async registerBatch(jobId, claim, items) { calls.push({ jobId, claim, items }); return { total: 2, inserted: 2, reused: 0 }; } },
    assertFairReady() { calls.push('fair'); return { ok: true }; },
  });
  assert.deepEqual(output, { total: 2, inserted: 2, reused: 0 });
  assert.equal(calls[0], 'fair');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].items.length, 2);
});

test('batch invalido nao chama fair guard nem RPC', async (t) => {
  const batchPath = workBatchPath('invalid');
  fs.writeFileSync(batchPath, JSON.stringify({ items: [bet(), bet({ stake: 0 })] }));
  t.after(() => fs.rmSync(batchPath, { force: true }));
  let calls = 0;
  await assert.rejects(() => main(['register-batch', 'job-1', 'claim-1', batchPath], {
    quiet: true,
    client: { async registerBatch() { calls += 1; } },
    assertFairReady() { calls += 1; },
  }), /Aposta 2:/);
  assert.equal(calls, 0);
});

test('register-batch rejeita batchPath fora de cron-data/bet-upload-work', async (t) => {
  const outside = path.join(os.tmpdir(), `outside-${process.pid}-${Date.now()}-batch.json`);
  fs.writeFileSync(outside, JSON.stringify({ items: [bet()] }));
  t.after(() => fs.rmSync(outside, { force: true }));
  await assert.rejects(() => main(['register-batch', 'job-1', 'claim-1', outside], {
    quiet: true,
    client: { async registerBatch() { throw new Error('nao deve chamar RPC'); } },
  }), /cron-data\/bet-upload-work/);
});

test('migration define lote atomico, lease, grants fechados e auditoria por item', () => {
  assert.match(migration, /create table if not exists public\.bet_upload_job_items/);
  assert.match(migration, /item_index between 1 and 10/);
  assert.match(migration, /for update/);
  assert.match(migration, /status <> 'processing'/);
  assert.match(migration, /claim_token is distinct from p_claim_token/);
  assert.match(migration, /lease_expires_at <= now\(\)/);
  assert.match(migration, /finished_at is not null or job_row\.bet_id is not null/);
  assert.match(migration, /batch size must be 1\.\.10/);
  const firstPass = migration.indexOf('Primeira passada');
  const secondPass = migration.indexOf('Segunda passada');
  assert.ok(firstPass >= 0 && secondPass > firstPass);
  assert.doesNotMatch(migration.slice(firstPass, secondPass), /insert into|update public/i);
  assert.match(migration, /'pending', null, null, null/);
  assert.match(migration, /'total'.*'inserted'.*'reused'.*'bet_ids'/s);
  assert.match(migration, /revoke all on function public\.register_bet_upload_batch.*public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.register_bet_upload_batch.*service_role/);
  assert.doesNotMatch(migration, /alter table public\.bets|revoke .*public\.bets|drop .*public\.bets/i);
  assert.match(rollback, /ROLLBACK_ABORTED.*contem auditoria/);
  assert.match(migration, /bet_id = bet_ids\[1\].*compatibilidade legada/);
});

test('SQL recalcula hashes/dedup, aceita retry identico e serializa concorrencia', () => {
  assert.match(migration, /create or replace function public\.bet_upload_canonical_json/);
  assert.match(migration, /extensions\.digest\(convert_to\(public\.bet_upload_canonical_json\(bet_doc\)/);
  assert.match(migration, /item ->> 'item_hash' is distinct from computed_item_hash/);
  assert.match(migration, /item ->> 'dedup_key' is distinct from dedup_key_value/);
  assert.match(migration, /job_row\.status = 'registered'/);
  assert.match(migration, /registered job retry hash mismatch/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(dedup_key_value, 0\)\)/);
  assert.match(migration, /for update/);
});

test('preflight/backup/manifest ficam preparados sem executar migration', () => {
  for (const column of ['bet_datetime', 'raw_extraction', 'pandascore_match_id', 'settle_source']) {
    assert.match(preflight, new RegExp(`'bets', '${column}'`));
  }
  assert.match(preflight, /'bets', 'fair_formula', array\['numeric','float4','float8'\]/);
  assert.match(migration, /typed_bet\.fair_formula/);
  assert.doesNotMatch(migration, /nullif\(typed_bet\.fair_formula/);
  assert.match(preflight, /BET_UPLOAD_BATCH_PREFLIGHT_READ_ONLY_OK/);
  assert.match(preflight, /when 'whale\.io' then 'whale'/);
  assert.equal(manifest.deployment_executed, false);
  assert.equal(manifest.rest_backup_script, 'scripts/prepare-bet-upload-batch-rest-backup.cjs');
  assert.match(manifest.rollback_guard, /abort/i);
  assert.match(manifest.legacy_writer.residual_race, /direct REST writers/);
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.resolve(__dirname, '../..', artifact.path);
    const content = fs.readFileSync(artifactPath);
    assert.equal(content.length, artifact.bytes, artifact.path);
    assert.equal(require('crypto').createHash('sha256').update(content).digest('hex'), artifact.sha256, artifact.path);
  }
  assert.match(restBackup, /method: 'GET'/);
  assert.doesNotMatch(restBackup, /method:\s*['"`](?:POST|PATCH|PUT|DELETE)['"`]/i);
  assert.match(legacyWriter, /rest\/v1\/rpc\/register_canonical_bet/);
  assert.doesNotMatch(legacyWriter.slice(legacyWriter.indexOf('Credenciais só aqui')), /postJson\([^\n]*'\/rest\/v1\/bets'/);
});

test('grants das funcoes batch sao somente service_role', () => {
  const grantLines = migration.split(/\r?\n/).filter((line) => /^grant execute on function public\.(?:bet_upload_|register_)/i.test(line.trim()));
  assert.ok(grantLines.length >= 5);
  assert.ok(grantLines.every((line) => / to service_role;$/i.test(line.trim())));
  assert.doesNotMatch(migration, /grant execute on function public\.(?:bet_upload_|register_).*to (?:public|anon|authenticated)/i);
});

test('postflight e estritamente read-only e valida objetos, contagens e grants', () => {
  assert.doesNotMatch(postflight, /^\s*\\(?:pset|timing)\b/im);
  const executableSql = postflight
    .replace(/--.*$/gm, '')
    .replace(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(executableSql, /\b(?:insert|update|delete|create|alter|drop|grant|revoke|truncate|call)\b/i);
  assert.match(postflight, /to_regclass\('public\.bet_upload_job_items'\)/);
  assert.match(postflight, /to_regprocedure\('public\.register_bet_upload_batch\(uuid,uuid,jsonb\)'\)/);
  assert.match(postflight, /relrowsecurity/);
  assert.match(postflight, /count\(\*\) from public\.bet_upload_job_items/);
  assert.match(postflight, /count\(\*\) from public\.bets/);
  assert.match(postflight, /count\(\*\) from public\.bet_upload_jobs/);
  assert.match(postflight, /has_function_privilege\('anon'/);
  assert.match(postflight, /has_function_privilege\('authenticated'/);
  assert.match(postflight, /has_function_privilege\('service_role'/);
  assert.match(postflight, /has_table_privilege\('service_role'/);
});

test('postflight summary retorna todos os invariantes em uma unica grade read-only', () => {
  const executableSql = postflightSummary
    .replace(/--.*$/gm, '')
    .replace(/'(?:''|[^'])*'/g, "''");
  assert.equal(executableSql.split(';').filter((part) => part.trim()).length, 1);
  assert.doesNotMatch(postflightSummary, /^\s*\\(?:pset|timing)\b/im);
  assert.doesNotMatch(executableSql, /\b(?:insert|update|delete|create|alter|drop|grant|revoke|truncate|call)\b/i);
  assert.match(postflightSummary, /target_functions/);
  assert.match(postflightSummary, /to_regprocedure\(signature\)/);
  assert.match(postflightSummary, /jsonb_object_agg/);
  assert.match(postflightSummary, /item_table_present/);
  assert.match(postflightSummary, /rls_enabled/);
  assert.match(postflightSummary, /item_count/);
  assert.match(postflightSummary, /bet_count/);
  assert.match(postflightSummary, /job_count/);
  assert.match(postflightSummary, /jobs_by_status/);
  assert.match(postflightSummary, /function_grants/);
  assert.match(postflightSummary, /table_grants/);
});

test('assinatura SQL cobre quatro paths, ticket opcional e ladder completa', () => {
  const orderedPaths = [
    '{raw_extraction,bookmaker_native,bet_id}',
    '{raw_extraction,bet_id_bookmaker}',
    '{raw_extraction,bet_id}',
    '{raw_extraction,bookmaker_bet_id}',
  ];
  let cursor = -1;
  for (const ticketPath of orderedPaths) {
    const next = migration.indexOf(ticketPath);
    assert.ok(next > cursor, `path ausente/fora da prioridade: ${ticketPath}`);
    cursor = next;
  }
  assert.match(migration, /if ticket is null then return null/);
  for (const field of ["'bookmaker'", "'pick'", "'stake'", "'map_number'", "'odd'"]) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /when 'whale\.io' then 'whale'/);
});

test('prompt proibe inserts individuais e exige array 1..10 e erro por card', () => {
  assert.match(prompt, /todos os cards.*ordem visual/i);
  assert.match(prompt, /Aceite 1\.\.10/);
  assert.match(prompt, /composto vertical de 2 prints/);
  assert.match(prompt, /todos os cards do Print 1, depois todos do Print 2/);
  assert.match(prompt, /1\.\.10 somando os dois paineis/);
  assert.match(prompt, /Nao presuma que os paineis mostram a mesma casa, partida ou evento/);
  assert.match(prompt, /register-batch/);
  assert.match(prompt, /Nunca chame `supabase-save-bet\.cjs` individualmente/);
  assert.match(prompt, /Aposta N: motivo/);
  assert.match(prompt, /total`, `inserted`, `reused` e todos os `bet_ids`/);
});

test('prompt identifica casa pelos termos do bilhete — "Accepted bet" e sempre Pinnacle, nunca Whale.io', () => {
  // Pinnacle e reconhecida pela faixa literal do bilhete, nao por cor/estilo.
  assert.match(prompt, /Pinnacle = faixa `Accepted bet: #<ticket>`/);
  assert.match(prompt, /`Accepted bet: #` e SEMPRE Pinnacle, NUNCA Whale\.io/);

  // A descricao de identificacao da Whale.io (isolada ate "USD/cripto;") nao pode
  // conter "Accepted bet" — essa era a causa raiz do bug de 12 bets Pinnacle
  // registradas como whale em 2026-08-14.
  const whaleIdentification = prompt.match(/Whale\.io = branding explicito[\s\S]*?USD\/cripto;/);
  assert.ok(whaleIdentification, 'descricao de identificacao da Whale.io nao encontrada no prompt');
  assert.doesNotMatch(whaleIdentification[0], /Accepted bet/i);
  assert.doesNotMatch(whaleIdentification[0], /card azul-escuro|faixa verde-clara/i);

  // fail-closed: sem certeza de branding whale.io + valores cripto/USD, rejeita.
  assert.match(prompt, /sem essa certeza, rejeite com `unsupported_bookmaker` \(fail-closed/);

  // Normalizacao correta — pinnacle e whale.io (com .io), nunca "whale" sozinho.
  assert.match(prompt, /Pinnacle -> `pinnacle`/);
  assert.match(prompt, /Whale\.io -> `whale\.io`/);
  assert.match(prompt, /NUNCA `whale` sem o `\.io`/);
  assert.doesNotMatch(prompt, /Normalize para `whale`/);

  // Cross-check Win ~= round(Stake*(odd-1)) e regra geral de slip, nao so da Whale.io.
  assert.match(prompt, /Em qualquer casa, trate o campo Win\/Ganhos/);
  assert.match(prompt, /Win ~= round\(Stake \* \(odd - 1\), 2\)/);
});

test('prompt cobre Thunderpick: ticket opcional, identificacao propria, formato pt-BR e casas mistas no mesmo print', () => {
  // Thunderpick entra na enumeracao de casas e normaliza pro slug canonico.
  assert.match(prompt, /Whale\.io, Thunderpick e Polymarket/);
  assert.match(prompt, /Thunderpick -> `thunderpick`/);

  // Ticket e opcional na Thunderpick (mesmo tratamento da Polymarket) — as demais
  // 5 casas BRL continuam exigindo ticket legivel.
  assert.match(prompt, /Ticket legivel e obrigatorio em EstrelaBet\/Pinnacle\/Parimatch\/Betano\/Whale\.io/);
  assert.match(prompt, /na Polymarket e na Thunderpick, ticket\/order id e opcional/);

  // Identificacao propria pelos termos do bilhete (nao por cor/estilo).
  assert.match(prompt, /Thunderpick = logo\/marca-dagua "THUNDERPICK" no slip/);
  assert.match(prompt, /abas "Open \/ Cash out \/ Live \/ Settled"/);
  assert.match(prompt, /`Odds`\/`Wager`\/`Payout` em BRL/);

  // Formato numerico pt-BR (milhar com ponto, decimal com virgula) — exemplo concreto.
  assert.match(prompt, /formato numerico pt-BR/);
  assert.match(prompt, /`2\.130,50 BRL` = `2130\.50`/);
  assert.match(prompt, /nunca `2\.13` nem `213050`/);

  // "Cash Out R$X" e so oferta de cashout, nunca stake/payout.
  assert.match(prompt, /"Cash Out R\$X" no slip da Thunderpick e somente o valor de cashout disponivel/);
  assert.match(prompt, /NUNCA e stake nem payout, ignore-o no registro/);

  // Casas mistas no mesmo print/painel sao uso legitimo — identificacao e por CARD.
  assert.match(prompt, /sempre por CARD — cards do mesmo print\/painel podem ser de casas diferentes/);
});
