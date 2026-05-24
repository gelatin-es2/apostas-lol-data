// Executa dedup de bets duplicadas (DELETE das cópias mais novas, preserva a mais antiga).
//
// ATENÇÃO: ação destrutiva e irreversível. Requer aprovação explícita do CEO.
// Só roda com flag --execute (ou env DEDUP_EXECUTE=1).
// Sem a flag, comportamento = dry-run equivalente ao dedup-bets-audit.cjs.
//
// Uso:
//   node dedup-bets-execute.cjs              → abortado (print msg de segurança)
//   node dedup-bets-execute.cjs --execute    → deleta duplicatas confirmado
//   DEDUP_EXECUTE=1 node dedup-bets-execute.cjs → idem via env
//
// Lógica:
//   - Chave de duplicação: pick + bookmaker + stake + bet_datetime (19 chars)
//   - Preserva a bet com created_at mais antigo (a original)
//   - Deleta todas as demais do grupo uma a uma (DELETE /rest/v1/bets?id=eq.<uuid>)
//   - Reporta total deletadas + IDs + erros

'use strict';
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const EXECUTE = process.argv.includes('--execute') || process.env.DEDUP_EXECUTE === '1';
const PAGE_SIZE = 1000;

function supaRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };
    let data = null;
    if (body !== null) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
      headers['Prefer'] = 'return=minimal';
    }
    if (method === 'GET') {
      headers['Range'] = '0-999';
      headers['Prefer'] = 'count=exact';
    }
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(b ? JSON.parse(b) : null); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function supaGetRange(supabaseUrl, supabaseKey, urlPath, rangeStart, rangeEnd) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'count=exact',
        'Range': `${rangeStart}-${rangeEnd}`,
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllBets(supabaseUrl, supabaseKey) {
  const bets = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const data = await supaGetRange(
      supabaseUrl, supabaseKey,
      '/rest/v1/bets?select=id,pick,bookmaker,stake,bet_datetime,created_at,status,team_a,team_b,league&order=created_at.asc',
      offset, end
    );
    if (!Array.isArray(data) || data.length === 0) break;
    bets.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return bets;
}

function buildDupGroups(bets) {
  const map = new Map();
  for (const bet of bets) {
    const stake = Number(bet.stake);
    const dt = bet.bet_datetime ? bet.bet_datetime.slice(0, 19) : '';
    const key = `${bet.pick}||${(bet.bookmaker || '').toLowerCase()}||${stake}||${dt}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(bet);
  }
  const groups = [];
  for (const [key, items] of map.entries()) {
    if (items.length < 2) continue;
    items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    groups.push({ key, items });
  }
  return groups;
}

(async () => {
  if (!EXECUTE) {
    process.stderr.write(
      '=== MODO SEGURO (sem --execute) ===\n' +
      'Este script deleta bets duplicadas de forma irreversível.\n' +
      'Rode "node dedup-bets-audit.cjs" primeiro pra revisar o que seria deletado.\n' +
      'Após aprovação do CEO, rode com --execute para confirmar.\n'
    );
    process.exit(0);
  }

  const { supabaseUrl, supabaseKey } = loadConfig();

  process.stderr.write('[1/3] Buscando todas as bets...\n');
  const bets = await fetchAllBets(supabaseUrl, supabaseKey);
  process.stderr.write(`  ${bets.length} bets carregadas\n`);

  process.stderr.write('[2/3] Computando grupos duplicados...\n');
  const groups = buildDupGroups(bets);

  let totalToDelete = 0;
  const toDeleteIds = [];
  for (const g of groups) {
    const idsToDelete = g.items.slice(1).map(x => x.id);
    toDeleteIds.push(...idsToDelete);
    totalToDelete += idsToDelete.length;
  }

  process.stderr.write(`  ${groups.length} grupos, ${totalToDelete} bets a deletar\n`);

  if (totalToDelete === 0) {
    process.stdout.write(JSON.stringify({ deleted: 0, errors: 0, groups: 0, message: 'Nenhuma duplicata encontrada.' }) + '\n');
    return;
  }

  process.stderr.write('[3/3] Executando DELETEs...\n');
  let deleted = 0;
  const errors = [];

  // Deleta em lotes de 20 IDs usando cláusula IN do Supabase
  const CHUNK = 20;
  for (let i = 0; i < toDeleteIds.length; i += CHUNK) {
    const chunk = toDeleteIds.slice(i, i + CHUNK);
    const inClause = chunk.map(id => `"${id}"`).join(',');
    try {
      await supaRequest(supabaseUrl, supabaseKey, 'DELETE',
        `/rest/v1/bets?id=in.(${chunk.join(',')})`
      );
      deleted += chunk.length;
      process.stderr.write(`  deletadas ${deleted}/${totalToDelete}\n`);
    } catch (e) {
      errors.push({ chunk_start: i, ids: chunk, error: e.message });
      process.stderr.write(`  ERRO no chunk ${i}: ${e.message}\n`);
    }
  }

  const result = {
    executed: true,
    groups_found: groups.length,
    total_to_delete: totalToDelete,
    deleted,
    errors: errors.length,
    error_details: errors,
    bets_remaining: bets.length - deleted,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (errors.length > 0) process.exit(1);
})().catch(e => {
  process.stderr.write(`ERRO FATAL: ${e.message}\n`);
  process.exit(1);
});
