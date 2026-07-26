// scripts/audit/phase5-ewc.cjs
//
// EWC (Esports World Cup) NÃO está na Riot API — é torneio ESL/Saudi, cobertura só via
// Liquipedia. Sem fonte automática de kills/resultado pra cross-check, então best-effort:
//   - checks aritméticos internos (profit = f(status, odd, stake); campos obrigatórios;
//     status vs kills quando kills já foram registrados no banco)
//   - checklist manual (bet a bet) pra conferência no Leaguepedia/gol.gg
//
// Escopo: TODAS as bets EWC do banco (audit-common.isEwc), sem recorte de data — cortar
// em 30/06 (fim nominal do split 2) excluiria bets EWC reais (torneio roda até julho, e
// os qualifiers já registrados vão de abril a junho). Ver CLAUDE.md do projeto: EWC não
// tem filtro de escopo temporal na fonte, então a auditoria também não aplica um aqui.
//
// Output: audit-output/05-ewc.json + tabela markdown no stdout
//
// Uso: node scripts/audit/phase5-ewc.cjs

'use strict';

const fs = require('fs');
const path = require('path');

const { loadAllBets, isEwc, parsePick } = require('./lib/audit-common.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(REPO, 'audit-output', '05-ewc.json');

// sync: .claude/scripts/supabase-save-bet.cjs L44-69 (normalizeLeague) — duplicada aqui
// porque aquele arquivo é um script executável (IIFE que lê stdin ao carregar), não um
// módulo — dar require nele dispararia o fluxo de save. Mesma semântica, char por char.
function normalizeLeague(league) {
  if (!league) return league;
  const l = String(league).trim();
  const m = l.match(/^(?:EWC[-_\s]+|Esports\s*World\s*Cup[-_\s]+)(.+)$/i);
  if (m) {
    const region = m[1].toLowerCase().replace(/[\s_-]/g, '');
    if (/^(sk|korea|korean|lck|kr|skquali|skqual|koreaquali)/i.test(region)) return 'EWC-LCK';
    if (/^(emea|eu|europe|european|lec|emeaquali)/i.test(region)) return 'EWC-LEC';
    if (/^(china|chinese|lpl|cn|chinaquali|lplquali)/i.test(region)) return 'EWC-LPL';
    if (/^(na|americas|lcs|northamerica)/i.test(region)) return 'EWC-LCS';
    if (/^(apac|asiapacific|asiapac)/i.test(region)) return 'EWC-APAC';
    if (/^(sa|southamerica|brazil|cblol|brasil)/i.test(region)) return 'EWC-CBLOL';
    return 'EWC-' + region.toUpperCase();
  }
  return l;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pushFinding(findings, check, severity, bet, extra) {
  findings.push({
    check,
    severity,
    bet_id: bet.id,
    league: bet.league,
    bet_datetime: bet.bet_datetime,
    teams: `${bet.team_a ?? '?'} vs ${bet.team_b ?? '?'}`,
    ...extra,
  });
}

async function main() {
  const allBets = await loadAllBets();
  const ewcBets = allBets.filter(isEwc);

  const findings = [];
  const info = [];
  const checklist = [];

  for (const bet of ewcBets) {
    const mc = bet.raw_extraction?.match_context || {};
    const totalKillsReg = mc.total_kills ?? null;
    const mapNumber = bet.map_number ?? mc.map_number ?? null;

    // ─── EWC_FIELD_MISSING (HIGH) ───────────────────────────────────────────
    if ((bet.status === 'green' || bet.status === 'red') && bet.profit == null) {
      pushFinding(findings, 'EWC_FIELD_MISSING', 'HIGH', bet, {
        field: 'profit',
        current: null,
        expected: 'não-null (status settled)',
        detail: `status=${bet.status} mas profit=null`,
      });
    }
    if (!bet.bet_datetime) {
      pushFinding(findings, 'EWC_FIELD_MISSING', 'HIGH', bet, {
        field: 'bet_datetime',
        current: null,
        expected: 'ISO 8601 não-null',
        detail: 'bet_datetime ausente',
      });
    }
    const normLeague = normalizeLeague(bet.league);
    if (bet.league !== normLeague) {
      pushFinding(findings, 'EWC_FIELD_MISSING', 'HIGH', bet, {
        field: 'league',
        current: bet.league,
        expected: normLeague,
        detail: 'league fora do formato canônico EWC-<LIGA> (ver normalizeLeague)',
      });
    }

    // ─── EWC_PROFIT_MISMATCH (CRITICAL) — cashout/void são manuais, viram INFO ──
    if (bet.status === 'cashout' || bet.status === 'void') {
      info.push({
        check: 'EWC_MANUAL_STATUS',
        bet_id: bet.id,
        status: bet.status,
        detail: `status=${bet.status} — hedge/void manual e legítimo, não auditado por aritmética`,
      });
    } else if (bet.status === 'green' && bet.profit != null && bet.odd != null && bet.stake != null) {
      const expected = round2(bet.stake * (bet.odd - 1));
      const diff = Math.abs(bet.profit - expected);
      if (diff > 0.01) {
        pushFinding(findings, 'EWC_PROFIT_MISMATCH', 'CRITICAL', bet, {
          field: 'profit',
          current: bet.profit,
          expected,
          detail: `green: stake(${bet.stake})×(odd(${bet.odd})-1)=${expected} vs banco=${bet.profit} (diff=${round2(diff)})`,
        });
      }
    } else if (bet.status === 'red' && bet.profit != null && bet.stake != null) {
      const expected = -bet.stake;
      if (Math.abs(bet.profit - expected) > 0.01) {
        pushFinding(findings, 'EWC_PROFIT_MISMATCH', 'CRITICAL', bet, {
          field: 'profit',
          current: bet.profit,
          expected,
          detail: `red: esperado profit=-stake=${expected} vs banco=${bet.profit}`,
        });
      }
    } else if (bet.status !== 'pending' && bet.status !== 'refund') {
      // status inesperado/desconhecido — não sabemos como validar, registra como info
      info.push({
        check: 'EWC_UNCHECKED_STATUS',
        bet_id: bet.id,
        status: bet.status,
        detail: `status="${bet.status}" não coberto pela regra de profit (não é green/red/cashout/void)`,
      });
    }

    // ─── EWC_STATUS_VS_KILLS (HIGH) — só quando kills já registrados no banco ──
    if (totalKillsReg != null && (bet.status === 'green' || bet.status === 'red')) {
      const parsed = parsePick(bet.pick, bet.market);
      if ((parsed.kind === 'under' || parsed.kind === 'over') && parsed.line != null) {
        const hit = parsed.kind === 'under' ? totalKillsReg < parsed.line : totalKillsReg > parsed.line;
        const expectedStatus = hit ? 'green' : 'red';
        if (expectedStatus !== bet.status) {
          pushFinding(findings, 'EWC_STATUS_VS_KILLS', 'HIGH', bet, {
            field: 'status',
            current: bet.status,
            expected: expectedStatus,
            detail: `pick=${parsed.kind} ${parsed.line}, total_kills registrado=${totalKillsReg} → recompute=${expectedStatus}`,
          });
        }
      }
    }

    // ─── EWC_MANUAL_CHECKLIST (INFO) — TODA bet EWC vira linha de conferência ──
    checklist.push({
      bet_id: bet.id,
      date: bet.bet_datetime ? bet.bet_datetime.slice(0, 10) : null,
      league: bet.league,
      teams: `${bet.team_a ?? '?'} vs ${bet.team_b ?? '?'}`,
      map: mapNumber,
      pick: bet.pick,
      odd: bet.odd,
      stake: bet.stake,
      status: bet.status,
      profit: bet.profit,
      kills_registrados: totalKillsReg,
    });
  }

  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const byCheck = {};
  for (const f of findings) byCheck[f.check] = (byCheck[f.check] || 0) + 1;

  const dates = ewcBets.map((b) => b.bet_datetime).filter(Boolean).sort();

  const output = {
    generated_at: new Date().toISOString(),
    note:
      'EWC não está na API lolesports (Riot) — é torneio ESL/Saudi, cobertura via ' +
      'Liquipedia. Sem cross-check automático de kills; checks aritméticos internos + ' +
      'checklist manual pra conferência no Leaguepedia/gol.gg.',
    scope: 'TODAS as bets com isEwc()=true, sem recorte de data (ver comentário no topo do arquivo)',
    total_bets_all: allBets.length,
    total_ewc_bets: ewcBets.length,
    ewc_date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    ewc_bets_null_date: ewcBets.filter((b) => !b.bet_datetime).length,
    by_severity: bySeverity,
    by_check: byCheck,
    findings,
    info,
    checklist,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  // ─── Stdout: contagens + checklist markdown ────────────────────────────
  console.log(`\n=== Fase 5 — EWC (best-effort, sem API) ===\n`);
  console.log(`Total bets no banco: ${allBets.length}`);
  console.log(`Bets EWC (isEwc=true): ${ewcBets.length}`);
  if (dates.length) console.log(`Range de datas EWC: ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log(`Bets EWC com bet_datetime null: ${output.ewc_bets_null_date}`);

  console.log(`\nFindings por severidade:`);
  if (Object.keys(bySeverity).length === 0) console.log('  (nenhum)');
  for (const [sev, n] of Object.entries(bySeverity)) console.log(`  ${sev}: ${n}`);

  console.log(`\nFindings por check:`);
  if (Object.keys(byCheck).length === 0) console.log('  (nenhum)');
  for (const [chk, n] of Object.entries(byCheck)) console.log(`  ${chk}: ${n}`);

  console.log(`\nInfo (cashout/void/status não coberto — não auditados por aritmética): ${info.length}`);

  if (findings.length) {
    console.log(`\n--- Findings detalhados ---`);
    for (const f of findings) {
      console.log(
        `  [${f.severity}] ${f.check} bet_id=${f.bet_id} ${f.league} ${f.teams} (${f.bet_datetime || 'sem data'})\n` +
          `      campo=${f.field} atual=${JSON.stringify(f.current)} esperado=${JSON.stringify(f.expected)}\n` +
          `      ${f.detail}`
      );
    }
  }

  console.log(`\n=== Checklist manual EWC (${checklist.length} bets) — conferir no Leaguepedia/gol.gg ===\n`);
  console.log('| bet_id | data | liga | times | mapa | pick | odd | stake | status | profit | kills_registrados |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of checklist) {
    console.log(
      `| ${c.bet_id} | ${c.date ?? '—'} | ${c.league ?? '—'} | ${c.teams} | ${c.map ?? '—'} | ` +
        `${c.pick ?? '—'} | ${c.odd ?? '—'} | ${c.stake ?? '—'} | ${c.status} | ${c.profit ?? '—'} | ${c.kills_registrados ?? '—'} |`
    );
  }

  console.log(`\nOutput salvo em: ${path.relative(REPO, OUT_PATH).replace(/\\/g, '/')}`);
}

main().catch((e) => {
  console.error('ERRO fase5-ewc:', e);
  process.exit(1);
});
