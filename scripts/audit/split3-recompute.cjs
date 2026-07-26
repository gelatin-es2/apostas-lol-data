// scripts/audit/split3-recompute.cjs — AUDITORIA 2026-07-26 (READ-ONLY)
// Re-verifica FRIAMENTE todos os settles do split 3: refetch eventDetails + livestats
// window por game, recomputa kills/winner e compara com status/profit/kills salvos.
// Nenhum PATCH — só relatório em audit-output/32-split3-recompute.json.
'use strict';

const fs = require('fs');
const path = require('path');
const {
  getEventDetails, getWindow, getTeams, tsRoundedTo10sCapped, AuditFetchError,
} = require(path.resolve(__dirname, 'lib', 'api-cache.cjs'));

const SNAP = path.resolve(__dirname, '..', '..', 'audit-output', '30-split3-bets.json');
const OUT = path.resolve(__dirname, '..', '..', 'audit-output', '32-split3-recompute.json');
const { bets } = JSON.parse(fs.readFileSync(SNAP, 'utf8'));

const isSim = (b) => b.raw_extraction?.simulated === true || /^SIMULATED/i.test(b.notes || '') || b.bookmaker === 'SIMULATED';
const real = bets.filter(b => !isSim(b));

function parsePick(pickRaw, market) {
  const lower = (pickRaw || '').toLowerCase();
  const all = Array.from(lower.matchAll(/(\d+(?:[.,]\d+)?)/g));
  const numMatch = all.length ? all[all.length - 1] : null;
  const line = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;
  if (/menos\s*de|under/i.test(pickRaw || '')) return { kind: 'under', line };
  if (/mais\s*de|over/i.test(pickRaw || '')) return { kind: 'over', line };
  if (/money\s*line|vencedor|resultado\s*final|winner/i.test(market || '')) return { kind: 'moneyline' };
  return { kind: 'other' };
}

const teamKey = (s) => (s || '').toLowerCase().replace(/[\s.\-']/g, '');

async function windowWithFallback(gameId, startMs) {
  const offsets = [6, 2, 4, 8, 10]; // horas após início do match
  for (const h of offsets) {
    let win;
    try {
      win = await getWindow(gameId, tsRoundedTo10sCapped(startMs + h * 3600 * 1000));
    } catch (e) {
      if (e instanceof AuditFetchError) continue;
      throw e;
    }
    if (win && Array.isArray(win.frames) && win.frames.length > 0 && win.gameMetadata) return win;
  }
  return null;
}

(async () => {
  const teamsJson = await getTeams();
  const teamById = new Map();
  for (const t of teamsJson?.data?.teams || []) teamById.set(String(t.id), t.name);

  const rows = [];
  for (const b of real) {
    const mc = b.raw_extraction?.match_context || {};
    const matchId = mc.lolesports_match_id;
    const row = {
      id8: b.id.slice(0, 8), date: (b.bet_datetime || '').slice(0, 10),
      league: b.league, teams: `${b.team_a}×${b.team_b}`, map: b.map_number,
      market: b.market, pick: b.pick, odd: b.odd, stake: b.stake,
      stored: { status: b.status, profit: b.profit, kills: mc.total_kills ?? null },
      settle_source: b.settle_source,
      manual: /manual/i.test(b.settle_source || ''),
    };
    rows.push(row);

    if (!matchId) { row.verdict = 'NO_MATCH_ID'; continue; }

    let detail;
    try { detail = await getEventDetails(matchId); }
    catch (e) { row.verdict = 'FETCH_ERROR_EVENT'; row.error = e.message; continue; }
    const event = detail?.data?.event;
    const games = event?.match?.games || [];
    row.event_state = games.map(g => `g${g.number}:${g.state}`).join(' ');

    const parsed = parsePick(b.pick, b.market);
    row.pick_kind = parsed.kind;

    // ===== mercado por MAPAS (match-level, ex: "Over 2.5 mapas") =====
    if (!b.is_map_bet && /mapas|maps|total de mapas/i.test(`${b.market} ${b.pick}`) && parsed.line != null) {
      const completed = games.filter(g => g.state === 'completed').length;
      const isOver = /mais|over/i.test(b.pick);
      const won = isOver ? completed > parsed.line : completed < parsed.line;
      row.recomputed = { maps_completed: completed, expected_status: won ? 'green' : 'red' };
      row.verdict = row.stored.status === row.recomputed.expected_status ? 'MATCH' : 'MISMATCH';
      continue;
    }

    // localizar game
    let game = null;
    if (b.map_number) game = games.find(g => g.number === b.map_number);
    else game = games.find(g => g.state === 'completed') || games[0];
    if (!game) { row.verdict = 'NO_GAME'; continue; }
    row.game_state = game.state;
    row.game_id = String(game.id);
    if (mc.lolesports_game_id && String(mc.lolesports_game_id) !== String(game.id)) {
      row.game_id_mismatch = `stored=${mc.lolesports_game_id} api=${game.id}`;
    }

    const startMs = new Date(event?.startTime || b.bet_datetime).getTime();
    const win = await windowWithFallback(String(game.id), startMs);
    if (!win) { row.verdict = 'NO_WINDOW'; continue; }

    const last = win.frames[win.frames.length - 1];
    const kBlue = last.blueTeam?.totalKills ?? 0;
    const kRed = last.redTeam?.totalKills ?? 0;
    const totalKills = kBlue + kRed;
    const blueInh = last.blueTeam?.inhibitors || 0;
    const redInh = last.redTeam?.inhibitors || 0;
    const blueTow = last.blueTeam?.towers || 0;
    const redTow = last.redTeam?.towers || 0;
    let winnerSide = null;
    if (blueInh !== redInh) winnerSide = blueInh > redInh ? 'blue' : 'red';
    else if (blueTow !== redTow) winnerSide = blueTow > redTow ? 'blue' : 'red';
    const blueName = teamById.get(String(win.gameMetadata.blueTeamMetadata?.esportsTeamId)) || null;
    const redName = teamById.get(String(win.gameMetadata.redTeamMetadata?.esportsTeamId)) || null;
    const supOf = (md) => md?.participantMetadata?.find(p => p.role === 'support')?.championId || null;

    row.recomputed = {
      frame_state: last.gameState, game_time_min: last.gameTime ? Math.round(last.gameTime / 60000) : null,
      kBlue, kRed, totalKills, winnerSide,
      blue: blueName, red: redName,
      supBlue: supOf(win.gameMetadata.blueTeamMetadata), supRed: supOf(win.gameMetadata.redTeamMetadata),
    };

    // frame suspeito?
    const suspect = last.gameState !== 'finished' && ((last.gameTime ?? 0) / 1000 < 600 || totalKills < 5);
    if (suspect) { row.verdict = 'SUSPECT_FRAME'; continue; }

    if (parsed.kind === 'under' || parsed.kind === 'over') {
      const won = parsed.kind === 'under' ? totalKills < parsed.line : totalKills > parsed.line;
      const expStatus = won ? 'green' : 'red';
      const stake = parseFloat(b.stake); const odd = parseFloat(b.odd);
      const expProfit = won ? +(stake * (odd - 1)).toFixed(2) : -stake;
      row.recomputed.expected_status = expStatus;
      row.recomputed.expected_profit = expProfit;
      const statusOk = b.status === expStatus;
      const profitOk = b.profit != null && Math.abs(parseFloat(b.profit) - expProfit) <= 0.5;
      const killsOk = row.stored.kills == null || row.stored.kills === totalKills;
      row.verdict = statusOk && profitOk ? (killsOk ? 'MATCH' : 'MATCH_KILLS_DIFF') : 'MISMATCH';
      if (b.status === 'cashout') row.verdict = 'CASHOUT_MANUAL_CHECK';
    } else if (parsed.kind === 'moneyline') {
      const winnerName = winnerSide === 'blue' ? blueName : winnerSide === 'red' ? redName : null;
      row.recomputed.winner_name = winnerName;
      const pickKey = teamKey(b.pick);
      const wKey = teamKey(winnerName);
      let won = null;
      if (winnerName && pickKey) {
        won = wKey.includes(pickKey) || pickKey.includes(wKey)
          || teamKey(b.team_a) === pickKey && wKey.includes(teamKey(b.team_a))
          || teamKey(b.team_b) === pickKey && wKey.includes(teamKey(b.team_b));
        // fallback: compara contra team_a/team_b
        if (!won) {
          const aKey = teamKey(b.team_a); const bKey = teamKey(b.team_b);
          const pickIsA = aKey.includes(pickKey) || pickKey.includes(aKey);
          const pickIsB = bKey.includes(pickKey) || pickKey.includes(bKey);
          if (pickIsA !== pickIsB) {
            const pickedName = pickIsA ? b.team_a : b.team_b;
            won = wKey.includes(teamKey(pickedName)) || teamKey(pickedName).includes(wKey);
          }
        }
      }
      if (won == null) { row.verdict = 'ML_MANUAL_CHECK'; continue; }
      const expStatus = won ? 'green' : 'red';
      row.recomputed.expected_status = expStatus;
      row.verdict = b.status === expStatus ? 'MATCH' : 'MISMATCH';
    } else {
      row.verdict = 'OTHER_MARKET_MANUAL_CHECK';
    }
  }

  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), counts, rows }, null, 2));
  console.log(JSON.stringify(counts, null, 2));
  for (const r of rows.filter(r => r.verdict !== 'MATCH')) {
    console.log(`${r.verdict} | ${r.id8} ${r.date} ${r.league} ${r.teams} map${r.map} | ${r.market} :: ${r.pick} | stored=${r.stored.status}/${r.stored.profit}/${r.stored.kills}k | recomp=${JSON.stringify(r.recomputed || {})} ${r.game_id_mismatch ? '| GAMEID! ' + r.game_id_mismatch : ''}`);
  }
  console.log('OK →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
