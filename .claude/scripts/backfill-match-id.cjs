// Backfill lolesports_match_id para bets settled (green/red) que não possuem o campo.
//
// Modos:
//   node backfill-match-id.cjs --dry-run   → lista o que faria, não faz PATCH (default seguro)
//   node backfill-match-id.cjs --execute   → aplica PATCHes nos "match seguro"
//   BACKFILL_EXECUTE=1 node backfill-match-id.cjs → idem via env
//
// Lógica por bet:
//   1. Chama lolesports-find-match.cjs (como módulo) passando team_a, team_b, data da bet
//   2. Se found=false → "sem_match" (lista pra CEO)
//   3. Se found=true e ambiguous=false → "match_seguro" → PATCH raw_extraction.match_context.lolesports_match_id
//   4. Se found=true e ambiguous=true → "match_ambiguo" → lista pra CEO resolver manual
//
// Nota: NÃO cruza total_kills aqui — settle já usou fallback e o resultado está registrado.
// O objetivo do backfill é só preencher o campo pra evitar problemas futuros no re-settle.

'use strict';
const https = require('https');
const { execFileSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('./_load-config.cjs');

const EXECUTE = process.argv.includes('--execute') || process.env.BACKFILL_EXECUTE === '1';
const DRY_RUN = !EXECUTE;

const FIND_MATCH_SCRIPT = path.join(__dirname, 'lolesports-find-match.cjs');

function supabaseRequest(supabaseUrl, supabaseKey, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + urlPath);
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    let data = null;
    if (body !== null) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
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
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Chama lolesports-find-match.cjs como subprocess e retorna o objeto JSON parseado
function findMatch(teamA, teamB, date) {
  try {
    const out = execFileSync(process.execPath, [FIND_MATCH_SCRIPT, teamA, teamB, date], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().slice(0, 200) : '';
    // Tenta parsear stdout mesmo com exit code != 0
    if (e.stdout) {
      try { return JSON.parse(e.stdout.trim()); } catch {}
    }
    return { found: false, reason: `subprocess error: ${e.message} | stderr: ${stderr}` };
  }
}

// Busca todas bets settled sem lolesports_match_id no raw_extraction
async function fetchSettledWithoutMatchId(supabaseUrl, supabaseKey) {
  // Busca bets green/red paginando
  const PAGE = 1000;
  const bets = [];
  let offset = 0;
  while (true) {
    const end = offset + PAGE - 1;
    const data = await new Promise((resolve, reject) => {
      const u = new URL(supabaseUrl + '/rest/v1/bets?select=id,team_a,team_b,bet_datetime,status,league,bookmaker,pick,raw_extraction&status=in.(green,red)&order=bet_datetime.asc');
      const req = https.request({
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'count=exact',
          Range: `${offset}-${end}`,
        },
      }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`JSON err: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
    if (!Array.isArray(data) || data.length === 0) break;
    bets.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  // Filtra só os sem match_id
  return bets.filter(b => {
    const mc = b.raw_extraction?.match_context;
    return !mc?.lolesports_match_id;
  });
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();

  process.stderr.write(`[1/3] Buscando bets settled sem lolesports_match_id...\n`);
  const bets = await fetchSettledWithoutMatchId(supabaseUrl, supabaseKey);
  process.stderr.write(`  ${bets.length} bets encontradas\n`);

  if (bets.length === 0) {
    process.stdout.write(JSON.stringify({
      mode: DRY_RUN ? 'DRY-RUN' : 'EXECUTE',
      summary: { total: 0, match_seguro: 0, match_ambiguo: 0, sem_match: 0, errors: 0 },
      message: 'Nenhuma bet settled sem match_id. Banco OK.',
    }, null, 2) + '\n');
    return;
  }

  process.stderr.write(`[2/3] Resolvendo match_id via lolesports API...\n`);
  const results = { match_seguro: [], match_ambiguo: [], sem_match: [], errors: [] };

  for (const bet of bets) {
    const date = bet.bet_datetime ? bet.bet_datetime.slice(0, 10) : null;
    if (!date || !bet.team_a || !bet.team_b) {
      results.errors.push({ id: bet.id, reason: 'dados insuficientes (sem date/team_a/team_b)' });
      continue;
    }

    const found = findMatch(bet.team_a, bet.team_b, date);

    const entry = {
      id: bet.id,
      team_a: bet.team_a,
      team_b: bet.team_b,
      date,
      bet_datetime: bet.bet_datetime,
      status: bet.status,
      league: bet.league,
      bookmaker: bet.bookmaker,
      pick: bet.pick,
      match_found: found.found,
    };

    if (!found.found) {
      entry.reason = found.reason;
      results.sem_match.push(entry);
    } else if (found.ambiguous) {
      entry.match_id = found.match_id;
      entry.start_time = found.start_time;
      entry.all_candidates = found.all_candidates?.map(c => ({
        match_id: c.match_id, league: c.league, start_time: c.start_time,
        teams: c.teams, state: c.state,
      }));
      entry.reason = 'ambiguous — múltiplos candidatos, requer decisão manual';
      results.match_ambiguo.push(entry);
    } else {
      entry.match_id = found.match_id;
      entry.start_time = found.start_time;
      entry.league_short = found.league_short;
      entry.teams_resolved = found.teams?.map(t => t.code).join(' vs ');
      results.match_seguro.push(entry);
    }
    process.stderr.write(`  ${bet.id.slice(0, 8)}... → ${found.found ? (found.ambiguous ? 'AMBIGUO' : `SEGURO (${found.match_id})`) : 'SEM MATCH'}\n`);
  }

  process.stderr.write(`[3/3] ${DRY_RUN ? 'DRY-RUN — nenhum PATCH' : 'Aplicando PATCHes...'}\n`);

  let patched = 0;
  let patchErrors = 0;
  if (!DRY_RUN && results.match_seguro.length > 0) {
    for (const m of results.match_seguro) {
      // Primeiro busca o raw_extraction atual pra fazer merge
      try {
        const current = await supabaseRequest(supabaseUrl, supabaseKey, 'GET',
          `/rest/v1/bets?select=id,raw_extraction&id=eq.${m.id}`
        );
        const bet = Array.isArray(current) ? current[0] : current;
        const raw = bet?.raw_extraction || {};
        const mc = raw.match_context || {};
        mc.lolesports_match_id = m.match_id;
        raw.match_context = mc;

        await supabaseRequest(supabaseUrl, supabaseKey, 'PATCH',
          `/rest/v1/bets?id=eq.${m.id}`,
          { raw_extraction: raw }
        );
        patched++;
        process.stderr.write(`  PATCH OK: ${m.id.slice(0, 8)} → match_id=${m.match_id}\n`);
      } catch (e) {
        patchErrors++;
        process.stderr.write(`  PATCH ERRO: ${m.id.slice(0, 8)} — ${e.message}\n`);
      }
    }
  }

  const output = {
    mode: DRY_RUN ? 'DRY-RUN — nenhum PATCH feito' : 'EXECUTE',
    summary: {
      total_sem_match_id: bets.length,
      match_seguro: results.match_seguro.length,
      match_ambiguo: results.match_ambiguo.length,
      sem_match: results.sem_match.length,
      errors: results.errors.length,
      patched: DRY_RUN ? 'n/a (dry-run)' : patched,
      patch_errors: DRY_RUN ? 'n/a (dry-run)' : patchErrors,
    },
    // Inclui todos os ambíguos e sem_match pra CEO revisar
    match_ambiguo: results.match_ambiguo,
    sem_match: results.sem_match,
    errors: results.errors,
    // Em dry-run, lista os seguros também pra validação
    match_seguro: DRY_RUN ? results.match_seguro.slice(0, 20) : [],
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
})().catch(e => {
  process.stderr.write(`ERRO FATAL: ${e.message}\n`);
  process.exit(1);
});
