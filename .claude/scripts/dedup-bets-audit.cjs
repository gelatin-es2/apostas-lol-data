// Auditoria de bets duplicadas no Supabase.
// Chave de duplicação: pick + bookmaker + stake + bet_datetime
//
// Modo --dry-run (default): só lista grupos, não deleta nada.
// Modo execute (arquivo dedup-bets-execute.cjs): deleta tudo exceto o mais antigo.
//
// Uso:
//   node dedup-bets-audit.cjs            → audit com output JSON
//   node dedup-bets-audit.cjs --verbose  → inclui todos IDs de cada grupo

'use strict';
const https = require('https');
const { loadConfig } = require('./_load-config.cjs');

const VERBOSE = process.argv.includes('--verbose');
const PAGE_SIZE = 1000;

function supaGet(supabaseUrl, supabaseKey, urlPath) {
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
        'Range': '0-999',
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 500)}`));
        try { resolve({ data: JSON.parse(b), headers: res.headers }); }
        catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
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
        try { resolve({ data: JSON.parse(b), headers: res.headers }); }
        catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Busca todas as bets paginando até esgotar
async function fetchAllBets(supabaseUrl, supabaseKey) {
  const bets = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const { data, headers } = await supaGetRange(
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
    // Normaliza valores pra evitar falso-positivo por tipo (number vs string)
    const stake = Number(bet.stake);
    // Trata bet_datetime: usa só os primeiros 19 chars (YYYY-MM-DDTHH:MM:SS) pra ignorar timezone diff leve
    const dt = bet.bet_datetime ? bet.bet_datetime.slice(0, 19) : '';
    const key = `${bet.pick}||${(bet.bookmaker || '').toLowerCase()}||${stake}||${dt}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(bet);
  }
  // Filtra só grupos com mais de 1 bet
  const groups = [];
  for (const [key, items] of map.entries()) {
    if (items.length < 2) continue;
    // Ordena por created_at asc: o primeiro é o mais antigo (que preservamos)
    items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    groups.push({ key, items });
  }
  // Ordena grupos por tamanho desc
  groups.sort((a, b) => b.items.length - a.items.length);
  return groups;
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  process.stderr.write('[1/2] Buscando todas as bets...\n');
  const bets = await fetchAllBets(supabaseUrl, supabaseKey);
  process.stderr.write(`  ${bets.length} bets carregadas\n`);

  process.stderr.write('[2/2] Computando grupos duplicados...\n');
  const groups = buildDupGroups(bets);

  let totalToDelete = 0;
  const groupsSummary = groups.map(g => {
    const toDelete = g.items.length - 1;
    totalToDelete += toDelete;
    const keep = g.items[0];
    const deleteIds = g.items.slice(1).map(x => x.id);
    const sample = {
      key: g.key,
      total_in_group: g.items.length,
      to_delete: toDelete,
      keep_id: keep.id,
      keep_created_at: keep.created_at,
      keep_status: keep.status,
      // Contexto legível
      pick: keep.pick,
      bookmaker: keep.bookmaker,
      stake: keep.stake,
      bet_datetime: keep.bet_datetime,
      team_a: keep.team_a,
      team_b: keep.team_b,
      league: keep.league,
    };
    if (VERBOSE) {
      sample.all_ids = g.items.map(x => ({ id: x.id, created_at: x.created_at, status: x.status }));
      sample.delete_ids = deleteIds;
    } else {
      // Top 5 IDs a deletar pra amostra
      sample.delete_ids_sample = deleteIds.slice(0, 5);
      sample.delete_ids_total = deleteIds.length;
    }
    return sample;
  });

  const top5 = groupsSummary.slice(0, 5).map(g => ({
    pick: g.pick,
    bookmaker: g.bookmaker,
    bet_datetime: g.bet_datetime,
    league: g.league,
    teams: `${g.team_a} vs ${g.team_b}`,
    total_in_group: g.total_in_group,
    to_delete: g.to_delete,
    keep_id: g.keep_id,
    keep_status: g.keep_status,
  }));

  const output = {
    mode: 'DRY-RUN — nenhuma mudança feita',
    summary: {
      total_bets_in_db: bets.length,
      duplicate_groups: groups.length,
      total_bets_to_delete: totalToDelete,
      bets_after_dedup: bets.length - totalToDelete,
      largest_group_size: groups[0]?.items.length ?? 0,
    },
    top5_groups_by_size: top5,
    all_groups: VERBOSE ? groupsSummary : groupsSummary.map(g => ({
      pick: g.pick,
      bookmaker: g.bookmaker,
      bet_datetime: g.bet_datetime,
      league: g.league,
      teams: `${g.team_a} vs ${g.team_b}`,
      total_in_group: g.total_in_group,
      to_delete: g.to_delete,
      keep_id: g.keep_id,
      delete_ids_sample: g.delete_ids_sample,
      delete_ids_total: g.delete_ids_total,
    })),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
})().catch(e => {
  process.stderr.write(`ERRO: ${e.message}\n`);
  process.exit(1);
});
