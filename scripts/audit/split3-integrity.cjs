// scripts/audit/split3-integrity.cjs — AUDITORIA 2026-07-26 (READ-ONLY, offline sobre snapshot)
// Checks de integridade nas bets do split 3 (>= 2026-07-21):
//  A. campos obrigatórios (bet_datetime, lolesports_match_id)
//  B. status × profit invariantes (green: profit≈stake*(odd-1); red: profit=-stake)
//  C. settle_source breakdown + lista de settles manuais
//  D. is_method_bet × trigger real (via match_context) + method_variant
//  E. moeda (Clutch USD) — profit em BRL vs stake USD?
//  F. bookmakers usados (flag novibet)
//  G. SIMULATED: schema, dedup (game_id+variant+line), is_method_bet
//  H. ladder_group_id: paths duplos
'use strict';

const fs = require('fs');
const path = require('path');

const SNAP = path.resolve(__dirname, '..', '..', 'audit-output', '30-split3-bets.json');
const OUT = path.resolve(__dirname, '..', '..', 'audit-output', '31-split3-integrity.json');
const { bets } = JSON.parse(fs.readFileSync(SNAP, 'utf8'));

const findings = [];
const add = (sev, code, bet, detail) =>
  findings.push({ sev, code, bet_id: bet ? bet.id.slice(0, 8) : null, league: bet?.league, teams: bet ? `${bet.team_a}×${bet.team_b}` : null, map: bet?.map_number, detail });

const isSim = (b) => b.raw_extraction?.simulated === true || /^SIMULATED/i.test(b.notes || '') || b.bookmaker === 'SIMULATED';
const real = bets.filter(b => !isSim(b));
const sims = bets.filter(isSim);

// === A. campos obrigatórios ===
for (const b of bets) {
  if (!b.bet_datetime) add('HIGH', 'A_missing_bet_datetime', b, 'bet_datetime null');
  const mid = b.raw_extraction?.match_context?.lolesports_match_id;
  if (!mid) add('HIGH', 'A_missing_match_id', b, 'raw_extraction.match_context.lolesports_match_id ausente');
}

// === B. status × profit ===
for (const b of real) {
  const stake = parseFloat(b.stake);
  const odd = parseFloat(b.odd);
  if (b.status === 'green' || b.status === 'red') {
    if (b.profit == null) { add('HIGH', 'B_profit_null', b, `status=${b.status} profit=null`); continue; }
    const p = parseFloat(b.profit);
    if (b.status === 'green') {
      const expected = +(stake * (odd - 1)).toFixed(2);
      if (Math.abs(p - expected) > 0.5) add('MED', 'B_green_profit_mismatch', b, `profit=${p} esperado=${expected} (stake=${stake} odd=${odd})`);
    } else {
      if (Math.abs(p + stake) > 0.5) add('MED', 'B_red_profit_mismatch', b, `profit=${p} esperado=-${stake}`);
    }
  } else if (b.status === 'pending') {
    add('INFO', 'B_still_pending', b, `pending desde ${b.bet_datetime}`);
  } else if (b.status === 'cashout') {
    add('INFO', 'B_cashout', b, `cashout profit=${b.profit} notes=${(b.notes || '').slice(0, 120)}`);
  }
}

// === C. settle_source ===
const bySource = {};
for (const b of real) {
  const s = b.settle_source || 'NULL';
  bySource[s] = (bySource[s] || 0) + 1;
}
const manual = real.filter(b => /manual/i.test(b.settle_source || ''));

// === D. método/trigger/variant ===
for (const b of real) {
  const mc = b.raw_extraction?.match_context || {};
  const variant = b.raw_extraction?.method_variant || mc.method_variant || null;
  if (b.is_method_bet === true && !mc.trigger_type && !variant) {
    add('MED', 'D_method_no_trigger', b, `is_method_bet=true mas match_context.trigger_type=null e sem method_variant`);
  }
  if (b.is_method_bet == null) add('LOW', 'D_is_method_null', b, 'is_method_bet null');
  // kills presentes em bets settladas?
  if ((b.status === 'green' || b.status === 'red') && mc.total_kills == null) {
    add('MED', 'D_no_kills', b, `settled sem match_context.total_kills (settle_source=${b.settle_source})`);
  }
}

// === E. moeda ===
for (const b of real) {
  const cur = b.raw_extraction?.original_currency || b.raw_extraction?.currency || null;
  if (/clutch/i.test(b.bookmaker || '') && !cur) add('MED', 'E_clutch_sem_currency', b, 'Clutch sem original_currency no raw_extraction');
  if (cur && cur !== 'BRL') add('INFO', 'E_moeda', b, `original_currency=${cur} stake=${b.stake} profit=${b.profit}`);
}

// === F. bookmakers ===
const byBook = {};
for (const b of real) byBook[b.bookmaker || 'NULL'] = (byBook[b.bookmaker || 'NULL'] || 0) + 1;

// === G. SIMULATED ===
const simDedup = new Map();
for (const b of sims) {
  if (b.is_method_bet !== false) add('HIGH', 'G_sim_is_method', b, `SIMULATED com is_method_bet=${b.is_method_bet} — polui stats do método`);
  const mc = b.raw_extraction?.match_context || {};
  const variant = b.raw_extraction?.method_variant || mc.trigger_type;
  const key = `${mc.lolesports_game_id}|${variant}|${mc.simulated_line}`;
  if (simDedup.has(key)) add('MED', 'G_sim_dup', b, `duplicada de ${simDedup.get(key).slice(0, 8)} key=${key}`);
  else simDedup.set(key, b.id);
  if (!mc.lolesports_game_id) add('MED', 'G_sim_no_game_id', b, 'SIMULATED sem lolesports_game_id');
}

// === H. ladder paths ===
for (const b of bets) {
  const r = b.raw_extraction || {};
  const paths = [];
  if (r.ladder_group_id) paths.push('raiz');
  if (r.ladder_info?.ladder_group_id) paths.push('ladder_info');
  if (r.match_context?.ladder_group_id) paths.push('match_context');
  if (paths.length > 1) add('LOW', 'H_ladder_dual_path', b, `ladder_group_id em: ${paths.join('+')}`);
  if (paths.length === 1) add('INFO', 'H_ladder', b, `ladder em ${paths[0]}: ${r.ladder_group_id || r.ladder_info?.ladder_group_id || r.match_context?.ladder_group_id}`);
}

// === Saída ===
const report = {
  generated_at: new Date().toISOString(),
  totals: { all: bets.length, real: real.length, simulated: sims.length },
  by_settle_source: bySource,
  by_bookmaker: byBook,
  manual_settles: manual.map(b => ({
    id8: b.id.slice(0, 8), full_id: b.id, date: (b.bet_datetime || '').slice(0, 10),
    league: b.league, teams: `${b.team_a}×${b.team_b}`, map: b.map_number,
    pick: b.pick, odd: b.odd, stake: b.stake, status: b.status, profit: b.profit,
    settle_source: b.settle_source,
    kills: b.raw_extraction?.match_context?.total_kills ?? null,
    game_id: b.raw_extraction?.match_context?.lolesports_game_id ?? null,
    match_id: b.raw_extraction?.match_context?.lolesports_match_id ?? null,
  })),
  findings_count: findings.reduce((acc, f) => { acc[f.sev] = (acc[f.sev] || 0) + 1; return acc; }, {}),
  findings,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, findings: undefined, manual_settles: report.manual_settles.length }, null, 2));
console.log('findings por código:');
const byCode = {};
for (const f of findings) byCode[`${f.sev}:${f.code}`] = (byCode[`${f.sev}:${f.code}`] || 0) + 1;
console.log(JSON.stringify(byCode, null, 2));
console.log('OK →', OUT);
