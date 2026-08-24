// backfill-bet-phase.cjs — marca cada bet como PRÉ ou LIVE **do mapa apostado**.
//
// Escreve em `raw_extraction.bet_phase` ('pre' | 'live') + `raw_extraction.bet_phase_meta`
// (evidência + data + versão da regra). Não existe coluna `bet_phase` ainda; quando a
// migration 2026-08-23-fase3-flags.sql for aplicada, ela promove este jsonb pra coluna.
//
// REGRA DURA: só marca com evidência EXPLÍCITA. Sem evidência = fica NULL (não escreve).
// Chutar aqui é pior que não ter o campo — foi exatamente um chute implícito que gerou
// o artefato "linha abaixo da fair acerta 80%" (era bet live em jogo lento).
//
// Uso:
//   node .claude/scripts/backfill-bet-phase.cjs --dry-run     → não escreve, só reporta
//   node .claude/scripts/backfill-bet-phase.cjs --apply       → aplica (lote de 25)
//   node .claude/scripts/backfill-bet-phase.cjs --apply --only=live
//   node .claude/scripts/backfill-bet-phase.cjs --undo        → remove as duas chaves
//
// Idempotente: read-modify-write por linha, preservando todo o resto do raw_extraction.

'use strict';

const https = require('https');
const { loadConfig } = require('./_load-config.cjs');
const { supabaseGetAll, supabaseGet } = require('../../lib/supabaseQuery.cjs');

const RULE_VERSION = '2026-08-23.1';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNDO = args.includes('--undo');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const BATCH = 25;

// ---------------------------------------------------------------------------
// Detecção
// ---------------------------------------------------------------------------
// Armadilhas medidas em 23/08, todas em dado real:
//  - "livestats" é a FONTE DE SETTLE, não evidência de live. `\blive\b` não casa
//    "livestats" (não há word-boundary depois de "live"), mas casava "linha live",
//    "selected_reason=live" e "mercado ao vivo se moveu" — 10 falsos positivos.
//  - Negação: "Bet AO VIVO (... nao pre-jogo)" e "Bet PRE-JOGO (nao live)" apareciam
//    as duas como conflito. Negações são neutralizadas ANTES do match.
//  - "pre-jogo" solto também não serve: aparece em "a fair pre-jogo capturada pela
//    Pinnacle", que fala da FAIR e não da aposta.
// Por isso a evidência tem que estar ANCORADA na aposta.

const RE_NEG = /\bn[ãa]o\s+(?:[ée]\s+|foi\s+|era\s+)?(?:live|ao\s*vivo|in[-\s]?play|pr[ée][-\s]?jogo|pr[ée][-\s]?draft|p[óo]s[-\s]?draft)\b/gi;

const LIVE_PATTERNS = [
  [/\b(?:bet|aposta|entrada|punt|slip|over|under|menos de|mais de)\s+(?:\S+\s+){0,2}?(?:ao\s*vivo|live)\b/i, 'aposta ancorada em "ao vivo/live"'],
  // ordem inversa: "Live bet no mapa 2", "Live punt de virada"
  [/\b(?:ao\s*vivo|live)\s+(?:\S+\s+){0,1}?(?:bet|aposta|entrada|punt|slip)\b/i, '"live/ao vivo" + aposta (ordem inversa)'],
  [/\blive\s*\/\s*instinto\b/i, '"Live/instinto"'],
  [/\bmarcado\s+live\b/i, 'slip "marcado Live"'],
  [/\blive\s*:\s*\w*\d/i, 'placar live no registro (live:XX/YY)'],
  [/\bcategoria\s+live\b/i, '"categoria live"'],
  [/\bmapa?\s*\d*\s*(?:ja\s+)?(?:est(?:ava|á)\s+)?(?:em\s+andamento|ao\s*vivo|'?inprogress'?)\b/i, 'mapa em andamento/inProgress no registro'],
  [/\bmap\s*\d*\s*(?:ja\s+)?(?:est(?:ava|á)\s+)?(?:em\s+andamento|ao\s*vivo|'?inprogress'?)\b/i, 'map em andamento/inProgress no registro'],
  [/\b(?:jogo|mapa)\s+em\s+andamento\b/i, 'jogo em andamento'],
  [/\bmapa\s+live\b/i, '"Mapa live" com kills no registro'],
  [/\bao\s*vivo\s+mapa\s*\d/i, 'slip AO VIVO com relógio do mapa'],
  [/\bposi[cç][ãa]o\s+ao\s*vivo\b/i, 'aumento de posição ao vivo'],
  [/\bmomentos?\s+diferentes\s+do\s+jogo\s+ao\s*vivo\b/i, 'pernas tomadas em momentos do jogo ao vivo'],
];

const RE_PRE = /\bpr[ée][-\s]?draft\b|\bp[óo]s[-\s]?draft\b|\b(?:bet|aposta|entrada|slip|ml|ladder)\s+(?:\S+\s+){0,2}?pr[ée][-\s]?jogo\b|\bpr[ée][-\s]?jogo\s*[:)]/i;

// Revisão manual 23/08 das 47 candidatas: estas 10 casaram um padrão de "live" que,
// lido no contexto, fala de OUTRA coisa. Ficam NULL de propósito. A lista existe pra
// a decisão ser auditável — e pro script GRITAR se o texto da nota mudar.
const REVIEWED_NOT_LIVE = {
  '46020d9a': '"~fair da linha live" fala da LINHA, não da aposta (ladder pós-mapa-1)',
  'ec843afb': '"~fair da linha live" fala da LINHA, não da aposta (ladder pós-mapa-1)',
  'f3c6904e': '"~fair da linha live" fala da LINHA, não da aposta (ladder pós-mapa-1)',
  '1118b90c': '"~fair da linha live" fala da LINHA, não da aposta (ladder pós-mapa-1)',
  '4dfb5f27': '"ML pre/live no mapa 1" — o próprio autor não sabia',
  'aa63f193': '"stream do jogo ao vivo" fala do STREAM usado pra inferir o match',
  '4fca391f': '"selected_reason=live" é motivo do match-finder + state da SÉRIE',
  'f5c613da': 'contraditório: lolesports "unstarted, sem frames ao vivo" x casa mostrando AO VIVO',
  'd28c0ff6': '"mercado ao vivo se moveu entre as entradas" — mercado, não prova da aposta',
  'e75cb380': '"mercado ao vivo se moveu" — mercado, não prova da aposta',
};

function stripNeg(s) { return String(s || '').replace(RE_NEG, ' [NEG] '); }

function liveStructural(b) {
  const re = b.raw_extraction || {};
  const hits = [];
  if (re.score_at_bet_time !== undefined) hits.push('raw.score_at_bet_time');
  if (re.partial_score !== undefined) hits.push('raw.partial_score');
  if (re.map_start_ao_vivo !== undefined) hits.push('raw.map_start_ao_vivo');
  return hits;
}

function classify(b) {
  // SIMULATED é gerada a partir do draft do mapa — por construção, pré-mapa.
  if (b.bookmaker === 'SIMULATED') return { phase: 'pre', why: ['SIMULATED: gerada do draft do mapa'] };

  const notes = stripNeg(b.notes);
  const why = [];
  for (const [re, label] of LIVE_PATTERNS) if (re.test(notes)) why.push(label);
  const struct = liveStructural(b);
  why.push(...struct);

  const short = String(b.id).slice(0, 8);
  if (REVIEWED_NOT_LIVE[short]) {
    return { phase: null, why: [], reviewed_out: REVIEWED_NOT_LIVE[short], had: why };
  }

  if (why.length) return { phase: 'live', why };
  if (RE_PRE.test(notes)) return { phase: 'pre', why: ['notes: pré/pós-draft explícito'] };
  return { phase: null, why: [] };
}

// ---------------------------------------------------------------------------
function supabasePatch(url, key, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url + path);
    const data = JSON.stringify(body);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'PATCH',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data), Prefer: 'return=minimal',
      },
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => res.statusCode >= 400
        ? reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 300)}`))
        : resolve(true));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  const { supabaseUrl, supabaseKey } = loadConfig();
  const bets = await supabaseGetAll(supabaseUrl, supabaseKey,
    '/rest/v1/bets?select=id,bookmaker,notes,raw_extraction,profit,status&order=id.asc');

  if (UNDO) {
    const dirty = bets.filter(b => b.raw_extraction && b.raw_extraction.bet_phase !== undefined);
    process.stderr.write(`[undo] ${dirty.length} linhas com bet_phase gravado\n`);
    let n = 0;
    for (const b of dirty) {
      const cur = await supabaseGet(supabaseUrl, supabaseKey, `/rest/v1/bets?select=raw_extraction&id=eq.${b.id}`);
      const re = { ...(cur[0] || {}).raw_extraction };
      delete re.bet_phase; delete re.bet_phase_meta;
      if (APPLY) await supabasePatch(supabaseUrl, supabaseKey, `/rest/v1/bets?id=eq.${b.id}`, { raw_extraction: re });
      n++;
    }
    process.stdout.write(JSON.stringify({ mode: APPLY ? 'UNDO' : 'UNDO-DRY', rows: n }, null, 2) + '\n');
    return;
  }

  const plan = { live: [], pre: [], null: [], reviewed_out: [] };
  for (const b of bets) {
    const c = classify(b);
    if (c.reviewed_out) plan.reviewed_out.push([b, c]);
    else if (c.phase) plan[c.phase].push([b, c]);
    else plan.null.push([b, c]);
  }

  // Trava de sanidade: nenhuma das 10 linhas revisadas à mão pode acabar como 'live'.
  // (Depois que os padrões foram apertados elas já não casam nada — a lista virou
  // cinto de segurança + registro de POR QUE cada uma ficou de fora. Se um dia um
  // padrão novo alcançar uma delas, isto aborta em vez de gravar às cegas.)
  const leaked = plan.live.map(([b]) => String(b.id).slice(0, 8)).filter(s => REVIEWED_NOT_LIVE[s]);
  if (leaked.length) throw new Error(`Linha revisada como NÃO-live foi classificada live: ${leaked.join(', ')}. Revisar à mão.`);
  const missing = Object.keys(REVIEWED_NOT_LIVE)
    .filter(k => !bets.some(b => String(b.id).startsWith(k)));
  if (missing.length) throw new Error(`REVIEWED_NOT_LIVE cita ids que sumiram do banco: ${missing.join(', ')}`);

  const money = a => a.reduce((s, [b]) => s + Number(b.profit || 0), 0).toFixed(2);
  const real = a => a.filter(([b]) => b.bookmaker !== 'SIMULATED');

  const targets = [];
  for (const ph of ['live', 'pre']) {
    if (ONLY && ONLY !== ph) continue;
    for (const [b, c] of plan[ph]) {
      const cur = (b.raw_extraction || {}).bet_phase;
      if (cur === ph) continue; // já gravado
      targets.push([b, c, ph]);
    }
  }

  let written = 0, errors = 0;
  if (APPLY) {
    for (let i = 0; i < targets.length; i += BATCH) {
      const slice = targets.slice(i, i + BATCH);
      for (const [b, c, ph] of slice) {
        try {
          // re-lê imediatamente antes de escrever: o hook de settle roda a cada msg
          // do CEO e pode ter mexido no raw_extraction desde o fetch inicial.
          const cur = await supabaseGet(supabaseUrl, supabaseKey, `/rest/v1/bets?select=raw_extraction&id=eq.${b.id}`);
          const re = { ...((cur[0] || {}).raw_extraction || {}) };
          re.bet_phase = ph;
          re.bet_phase_meta = { rule_version: RULE_VERSION, at: new Date().toISOString(), evidence: c.why };
          await supabasePatch(supabaseUrl, supabaseKey, `/rest/v1/bets?id=eq.${b.id}`, { raw_extraction: re });
          written++;
        } catch (e) { errors++; process.stderr.write(`  ERRO id=${b.id}: ${e.message}\n`); }
      }
      process.stderr.write(`  lote ${Math.floor(i / BATCH) + 1}: ${written} gravadas, ${errors} erros\n`);
    }
  }

  process.stdout.write(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    rule_version: RULE_VERSION,
    total_bets: bets.length,
    classificacao: {
      live: { n: plan.live.length, reais: real(plan.live).length, profit_reais: money(real(plan.live)) },
      pre: { n: plan.pre.length, reais: real(plan.pre).length, profit_reais: money(real(plan.pre)) },
      null: { n: plan.null.length, reais: real(plan.null).length, profit_reais: money(real(plan.null)) },
      revisadas_fora: plan.reviewed_out.length,
    },
    rows_a_escrever: targets.length,
    written: APPLY ? written : 'n/a (dry-run)',
    errors: APPLY ? errors : 'n/a (dry-run)',
    amostra_live: plan.live.slice(0, 5).map(([b, c]) => ({ id: b.id, why: c.why })),
  }, null, 2) + '\n');
})().catch(e => { process.stderr.write(`ERRO FATAL: ${e.message}\n`); process.exit(1); });
