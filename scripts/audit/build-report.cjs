// scripts/audit/build-report.cjs
//
// Consolida audit-output/*.json (fases 0-5) em knowledge/audits/2026-07-20-auditoria-split2.md.
// Re-rodável: roda de novo a qualquer momento, sobrescreve o .md com os dados atuais dos
// JSONs. NÃO refaz os spot-checks externos (gol.gg/Leaguepedia via WebSearch/WebFetch) —
// esses são resultado de verificação manual feita em 2026-07-20 e ficam embutidos como
// constante (EXTERNAL_SPOT_CHECKS) documentada com fonte/URL. Se re-rodar a fase 2 e o
// achado CRITICAL nº1 mudar de bet_id, esses spot-checks precisam ser refeitos.
//
// Uso: node scripts/audit/build-report.cjs
// Output: knowledge/audits/2026-07-20-auditoria-split2.md

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'audit-output');
const REPORT_PATH = path.join(ROOT, 'knowledge', 'audits', '2026-07-20-auditoria-split2.md');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8'));
}

const universe = loadJson('00-universe.json');
const coverage = loadJson('01-coverage.json');
const betData = loadJson('02-bet-data.json');
const methodReports = loadJson('03-method-reports.json');
const existing = loadJson('04-existing.json');
const ewc = loadJson('05-ewc.json');
const fetchErrors = loadJson('fetch-errors.json');

const money = (n) => {
  if (n == null || !Number.isFinite(n)) return 'R$ —';
  const sign = n < 0 ? '-' : '';
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
  const intWithSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${intWithSep},${decPart}`;
};

// === Spot-checks externos (Tarefas 1-2 do briefing, feitos manualmente em 2026-07-20 via
// WebSearch + WebFetch contra gol.gg / ggscore, fora do pipeline programático). ===
const EXTERNAL_SPOT_CHECKS = {
  critical1: {
    bet_id: '61507820-8d22-41d4-9f21-aed990f9b678',
    sim_bet_id: '2432691d-b598-4605-82cf-279dcef80321',
    game_id: '115615926685761093',
    match: 'LNG (Suzhou LNG Esports) vs LGD Gaming — LPL 2026 Split 2, Week 7, Map 2',
    date: '2026-05-14',
    source: 'gol.gg',
    url: 'https://gol.gg/game/stats/78097/page-fullstats/',
    result: 'CONFIRMADO — blue (LNG) 21 kills, red (LGD) 11 kills, total 32 kills. Idêntico ao valor da API lolesports (kills_blue=21, kills_red=11, total=32). Pick "Menos de 25.5" perde (32 > 25.5) — bet devia ser red, está green.',
    confirmed: true,
  },
  spotchecks: [
    {
      league: 'LCK',
      bet_id: '1033710f-4202-44ca-8c62-65b0ab212fc4',
      bookmaker: 'pinnacle (real)',
      status_db: 'green',
      match: 'Dplus KIA vs Kiwoom DRX — LCK 2026 Rounds 1-2 Week 9, Game 2',
      date: '2026-05-29',
      pick: 'Under 29.5',
      source: 'gol.gg',
      url: 'https://gol.gg/game/stats/78885/page-fullstats/',
      result: 'CONFIRMADO — blue (Dplus) 2 kills, red (Kiwoom DRX) 16 kills, total 18. Idêntico à API (2/16/18). 18 < 29.5 → green. Bate com o banco.',
      match_ok: true,
    },
    {
      league: 'LEC',
      bet_id: '9aa97a5e-6ffc-4241-b70b-e43cf3044b97',
      bookmaker: 'SIMULATED',
      status_db: 'red',
      match: 'Movistar KOI vs Karmine Corp — LEC 2026 Spring Week 7, Game 3',
      date: '2026-05-09',
      pick: 'Under 29.5',
      source: 'gol.gg',
      url: 'https://gol.gg/game/stats/77797/page-fullstats/',
      result: 'CONFIRMADO — blue (MKOI) 11 kills, red (KC) 22 kills, total 33. Idêntico à API (11/22/33). 33 > 29.5 → red. Bate com o banco.',
      match_ok: true,
    },
    {
      league: 'CBLOL',
      bet_id: '13cef361-3ad9-4d0f-a0bd-200619e84b8d',
      bookmaker: 'thunderpick (real)',
      status_db: 'green',
      match: 'Fluxo W7M vs LOS (LØS/Los Grandes) — CBLOL 2026 Split 1 Playoffs Round 3, Game 3',
      date: '2026-05-30',
      pick: 'Under 27.5',
      source: 'gol.gg',
      url: 'https://gol.gg/game/stats/78907/page-fullstats/',
      result: 'QUASE — blue (Fluxo) 13 kills confirmado. Red (LOS) gol.gg mostra 5 kills (soma individual dos 5 jogadores) vs 6 kills na API lolesports (total 18 gol.gg vs 19 API) — diferença de 1 kill do lado red. NÃO muda o status: linha é 27.5, 18 e 19 ambos ficam abaixo → green nos dois cenários. Discrepância pontual gol.gg×Riot API registrada, não invalida o achado.',
      match_ok: 'partial',
    },
    {
      league: 'LFL',
      bet_id: '8477bb97-0efb-4e1f-84f1-e7d3ae9a609f',
      bookmaker: 'SIMULATED',
      status_db: 'red',
      match: 'Galions vs TLN Pirates — LFL 2026 Spring Regular Season, Round 1',
      date: '2026-04-17',
      pick: 'Under 29.5',
      source: 'ggscore.com (gol.gg não indexou página individual; ggscore usado como alternativa citando KDA)',
      url: 'https://ggscore.com/en/lol/lfl-2026-spring/group-stage/galions-vs-tln-pirates-648125',
      result: 'CONFIRMADO — Galions (blue) 13 kills, TLN Pirates (red) 22 kills (via coluna K do KDA agregado), total 35. Idêntico à API (13/22/35). 35 > 29.5 → red. Bate com o banco.',
      match_ok: true,
    },
  ],
};

// === Helpers de tabela ===
function table(headers, rows) {
  const h = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${h}\n${sep}\n${body}`;
}

function fmtDate(d) {
  return d ? String(d).slice(0, 10) : '—';
}

// === Seção 1: Sumário executivo ===
function buildExecSummary() {
  const cs = betData.counts.by_check_severity;
  const critBets = new Set(
    betData.findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.bet_id)
  );

  const rows = [
    ['Kills/status (bet real 61507820)', 'CRITICAL', '4 findings / 1 bet', `swing de ${money(-1790)} (declarado ${money(790)}, correto ${money(-1000)})`],
    ['Kills/status (SIMULATED 2432691d, mesmo jogo)', 'CRITICAL', '2 findings / 1 bet', `swing SIM de ${money(-1830)} (não é dinheiro real, afeta só stats do backtest)`],
    ['Profit rounding (2 bets)', 'CRITICAL', '2 findings / 2 bets', money(-0.15) + ' total (cosmético, float)'],
    ['Cobertura — jogos elegíveis sem bet (MISSING_BET)', 'HIGH', '36 jogos', 'indeterminado — oportunidades de aposta não capturadas'],
    ['Campos obrigatórios faltando (FIELD_MISSING)', 'HIGH', '4 bets', 'operacional — arrisca settle/backfill quebrar se repetir'],
    ['Trigger divergente em bets (TRIGGER_MISMATCH)', 'MEDIUM', '3 bets', 'nenhum em R$ — não afeta profit, afeta rótulo de trigger'],
    ['Trigger divergente em results.json (Alistar/pipeline arquivado)', 'MEDIUM', '30 jogos (11 Alistar)', 'fora de escopo — bug de código arquivado, não das bets'],
    ['method_reports — trigger com Alistar', 'MEDIUM', '6 rows', 'não afeta bets — afeta só backtest histórico'],
    ['Fair mismatch (fair_formula)', 'MEDIUM', `${betData.fair_mismatch_analysis.total} findings`, 'NÃO é bug de bet — limitação de fonte histórica (ver §5)'],
    ['Fair mismatch (fair_pinnacle null → backfill real)', 'MEDIUM', '10 findings', 'backfill legítimo via backfill-fair-columns.cjs'],
    ['method_reports faltando (MR_MISSING)', 'MEDIUM', `${methodReports.counts.by_check_severity['MR_MISSING|MEDIUM'] || 0} / 418 jogos elegíveis`, 'não afeta bets — backtest incompleto (66% dos jogos sem row)'],
    ['Bookmaker case (estrelabet/EstrelaBet, pinnacle/Pinnacle)', 'LOW', '3 rows (de 181 nos 2 grupos)', 'cosmético'],
    ['Duplicatas (dedup)', 'LOW', '8 bets (7 grupos)', 'redundância pequena no banco'],
    ['SIM line generation (informativo)', 'INFO', `${betData.sim_line_generation.total} bets SIMULATED`, 'informativo — não é erro'],
    ['MANUAL_CHECK (kills não confiáveis via API)', 'INFO', `${betData.counts.manual_check_total} bets`, 'requer conferência gol.gg/Leaguepedia manual'],
    ['EWC (fora da Riot API)', '—', `0 findings internos / 48 bets checklist manual`, 'pendente conferência manual do CEO'],
  ];

  const veredito = `**Banco OK pro Split 3? COM RESSALVAS.**

1. **1 bet real com erro material confirmado externamente** (61507820, LPL LNG×LGD map 2, 2026-05-14): API/gol.gg concordam em 32 kills, pick "Menos de 25.5" perdeu, bet está \`green ${money(790)}\` e devia ser \`red ${money(-1000)}\` — swing de ${money(-1790)} no registro de banca. Precisa correção antes do Split 3 (lote A), senão o histórico de ROI real do CEO carrega esse erro.
2. **36 jogos elegíveis (trigger ativo) sem bet correspondente** — não é erro de dado, é lacuna operacional: o método disparou e não gerou registro. Vale investigar causa raiz (SIMULATED devia ter sido gerada automaticamente e não foi?) antes do Split 3 pra não repetir.
3. **Volume de erro é baixo em proporção**: das 707 bets no escopo, só 4 têm finding CRITICAL (0,57%) e o grupo de controle de 37 bets settled automático em junho deu 0 mismatch — o pipeline funciona corretamente na maioria esmagadora dos casos.
4. **A maior contagem numérica (593 FAIR_MISMATCH) NÃO é bug de bet** — é limitação documentada da própria auditoria (fonte histórica \`cron-data/*-results.json\` não cobre tier2 e não é imutável). Não figura no veredito como erro real.
5. Ação recomendada: aplicar lote A (kills/status/profit) + lote C (campos obrigatórios) antes de 21/07, lote D (cobertura) como investigação prioritária mas não bloqueante pro início do split — nenhum fix roda sem aprovação por lote.`;

  return { table: table(['Categoria', 'Severidade', 'Contagem', 'Impacto R$ / observação'], rows), veredito };
}

// === Seção 2: CRITICAL ===
function buildCritical() {
  const crit = betData.findings.filter((f) => f.severity === 'CRITICAL');
  const byBet = new Map();
  for (const f of crit) {
    if (!byBet.has(f.bet_id)) byBet.set(f.bet_id, []);
    byBet.get(f.bet_id).push(f);
  }

  const parts = [];
  for (const [betId, findings] of byBet) {
    const f0 = findings[0];
    const spot =
      betId === EXTERNAL_SPOT_CHECKS.critical1.bet_id || betId === EXTERNAL_SPOT_CHECKS.critical1.sim_bet_id
        ? `**Spot-check externo (${EXTERNAL_SPOT_CHECKS.critical1.source}):** ${EXTERNAL_SPOT_CHECKS.critical1.result}\nURL: ${EXTERNAL_SPOT_CHECKS.critical1.url}`
        : '_(fora do escopo do spot-check externo desta rodada — evidência só via API lolesports, ver URL abaixo)_';

    const rows = findings.map((f) => [
      f.field,
      String(f.current),
      String(f.expected),
      f.evidence?.url ? `[window](${f.evidence.url})` : (typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence)),
    ]);

    parts.push(
      `### bet \`${betId}\` — ${f0.bookmaker} — ${f0.league} — ${f0.teams} (${fmtDate(f0.date)})\n\n` +
        table(['Campo', 'Atual', 'Esperado', 'Evidência'], rows) +
        `\n\n${spot}\n`
    );
  }

  return parts.join('\n');
}

// === Seção 3: MISSING_BET ===
function buildMissingBets() {
  const missing = coverage.missing_bets;
  const byLeagueMonth = {};
  for (const g of missing) {
    const month = fmtDate(g.date).slice(0, 7);
    const key = `${g.league}|${month}`;
    byLeagueMonth[key] = (byLeagueMonth[key] || 0) + 1;
  }
  const summaryRows = Object.entries(byLeagueMonth)
    .sort()
    .map(([k, n]) => {
      const [league, month] = k.split('|');
      return [league, month, String(n)];
    });

  const fullRows = missing.map((g) => [
    g.league,
    fmtDate(g.date),
    `${g.team_blue} vs ${g.team_red}`,
    String(g.map_number),
    g.trigger_type || '—',
    `${g.kills_blue}/${g.kills_red} (${g.total_kills})`,
    `\`${g.game_id}\``,
  ]);

  return {
    summary: table(['Liga', 'Mês', 'Qtd'], summaryRows),
    full: table(['Liga', 'Data', 'Times', 'Mapa', 'Trigger', 'Kills B/R (total)', 'game_id'], fullRows),
  };
}

// === Seção 4: FIELD_MISSING ===
function buildFieldMissing() {
  const fm = betData.findings.filter((f) => f.check === 'FIELD_MISSING');
  const rows = fm.map((f) => [f.bet_id, f.bookmaker, f.league, f.teams, fmtDate(f.date), f.field, String(f.current), f.expected]);
  return table(['bet_id', 'Bookmaker', 'Liga', 'Times', 'Data', 'Campo', 'Atual', 'Esperado'], rows);
}

// === Seção 5: MEDIUM trigger + fair ===
function buildMediumTriggerFair() {
  const tm = betData.findings.filter((f) => f.check === 'TRIGGER_MISMATCH');
  const tmRows = tm.map((f) => [
    f.bet_id,
    f.bookmaker,
    f.league,
    f.teams,
    fmtDate(f.date),
    String(f.current),
    String(f.expected),
    `${f.evidence?.sup_blue || '?'} / ${f.evidence?.sup_red || '?'}`,
  ]);

  const mrAlistar = methodReports.findings.filter((f) => f.check === 'MR_TRIGGER_MISMATCH');
  const mrRows = mrAlistar.map((f) => [
    f.report_id,
    f.league,
    fmtDate(f.match_date),
    f.teams,
    String(f.map_number),
    String(f.current),
    String(f.expected),
    `${f.evidence?.sup_blue_row || '?'} / ${f.evidence?.sup_red_row || '?'}`,
  ]);

  const fairFindings = betData.findings.filter((f) => f.check === 'FAIR_MISMATCH' && f.field === 'fair_formula');
  const fairPinFindings = betData.findings.filter((f) => f.check === 'FAIR_MISMATCH' && f.field === 'fair_pinnacle');
  const analysis = betData.fair_mismatch_analysis;

  return {
    triggerBets: table(['bet_id', 'Bookmaker', 'Liga', 'Times', 'Data', 'Atual', 'Esperado', 'Sup blue/red'], tmRows),
    triggerMr: table(['report_id', 'Liga', 'Data', 'Times', 'Mapa', 'Atual', 'Esperado', 'Sup blue/red'], mrRows),
    fairTotal: fairFindings.length,
    fairNull: analysis.current_null_missing_backfill,
    fairTier2: analysis.tier2_no_data_source_in_settle,
    fairMajorsDiverge: analysis.majors_value_diverges,
    fairRootCause: analysis.root_cause,
    fairPinnacleCount: fairPinFindings.length,
    fairPinnacleRows: table(
      ['bet_id', 'Bookmaker', 'Liga', 'Times', 'Data', 'Atual', 'Esperado', 'Fonte'],
      fairPinFindings.map((f) => [f.bet_id, f.bookmaker, f.league, f.teams, fmtDate(f.date), String(f.current), String(f.expected), f.evidence.file])
    ),
  };
}

// === Seção 6: method_reports ===
function buildMethodReports() {
  const missingByLeague = methodReports.counts.mr_missing_by_league;
  const rows = Object.entries(missingByLeague)
    .sort((a, b) => b[1] - a[1])
    .map(([lg, n]) => [lg, String(n)]);
  const totalMissing = Object.values(missingByLeague).reduce((a, b) => a + b, 0);
  return {
    table: table(['Liga', 'Jogos faltando (MR_MISSING)'], rows),
    totalMissing,
    total: universe.filter ? null : null,
  };
}

// === Seção 7: LOW/INFO ===
function buildLowInfo() {
  const bk = betData.bookmaker_case;
  const bkRows = bk.map((b) => [
    b.normalized,
    b.variants.map((v) => `\`${v.value}\`×${v.count}`).join(', '),
    String(b.total),
  ]);

  const dedup = existing.results.find((r) => r.name === 'dedup_bets_audit');
  const dedupRaw = fs.readFileSync(path.join(OUT_DIR, 'raw', 'dedup-bets-audit.txt'), 'utf8');
  const dedupJsonMatch = dedupRaw.match(/--- STDOUT ---\n([\s\S]*?)\n\n--- STDERR ---/);
  let dedupIds = [];
  if (dedupJsonMatch) {
    try {
      const parsed = JSON.parse(dedupJsonMatch[1]);
      dedupIds = parsed.all_groups.flatMap((g) =>
        (g.delete_ids_sample || []).map((id) => [id, g.league, g.teams, g.bet_datetime, g.bookmaker, g.pick])
      );
    } catch {
      /* fallback: deixa lista vazia, texto bruto já citado abaixo */
    }
  }

  const slg = betData.sim_line_generation.counts;

  const aliasRaw = fs.readFileSync(path.join(OUT_DIR, 'raw', 'audit-aliases.txt'), 'utf8');

  const ewcUnclassifiedLpl = betData.findings.filter(
    (f) => f.check === 'TRIGGER_MISMATCH' && f.current === 'ewc_unclassified'
  );

  return {
    bookmakerTable: table(['Normalizado', 'Variantes (valor×contagem)', 'Total rows'], bkRows),
    dedupTotalBanco: dedup ? dedup.summary[0] : '?',
    dedupMarcadas: dedup ? dedup.summary[2] : '?',
    dedupIdsTable: table(
      ['bet_id (candidato a delete)', 'Liga', 'Times', 'Data', 'Bookmaker', 'Pick'],
      dedupIds.map((r) => [r[0], r[1], r[2], fmtDate(r[3]), r[4], r[5]])
    ),
    simGen: `**SIM generations** (${betData.sim_line_generation.total} bets SIMULATED): ${slg.exact} exact / ${slg['fair+1'] || 0} fair+1 / ${slg.no_fair_formula} sem fair_formula.`,
    aliasMissing: aliasRaw.includes('Fluxo W7M') ? '"Fluxo W7M" → "Fluxo" (15x bets, CBLOL) — falta em lib/team-aliases.json' : '(ver audit-output/raw/audit-aliases.txt)',
    ewcUnclassifiedLpl: table(
      ['bet_id', 'Times', 'Data', 'Liga (declarada)'],
      ewcUnclassifiedLpl.map((f) => [f.bet_id, f.teams, fmtDate(f.date), f.league])
    ),
    triggerDivergence30: coverage.trigger_divergence_results.length,
    triggerDivergenceAlistar: coverage.counts.trigger_divergence_alistar_count,
    resultsJsonGap: coverage.results_json_gap,
  };
}

// === Seção 8: EWC ===
function buildEwc() {
  const rows = ewc.checklist.map((c) => [
    c.bet_id,
    c.league,
    fmtDate(c.date),
    c.teams,
    String(c.map),
    c.pick,
    String(c.odd),
    money(c.stake),
    c.status,
    money(c.profit),
  ]);
  return table(['bet_id', 'Liga', 'Data', 'Times', 'Mapa', 'Pick', 'Odd', 'Stake', 'Status', 'Profit'], rows);
}

// === Seção 9: não-verificáveis ===
function buildNonVerifiable() {
  const mc = betData.manual_check;
  const byReason = betData.counts.manual_check_by_reason;

  const suspectRows = mc
    .filter((m) => m.reason === 'suspect_frame')
    .map((m) => [m.bet_id, m.bookmaker, m.league, m.teams, fmtDate(m.date), m.status, `\`${m.game_id}\``]);

  const noMatchRows = mc
    .filter((m) => m.reason === 'no_universe_match')
    .map((m) => [m.bet_id, m.bookmaker, m.league, m.teams, fmtDate(m.date), m.status]);

  const uniqueFetchErrorGames = [...new Set(fetchErrors.map((e) => e.gameId))];
  const fetchErrorRows = uniqueFetchErrorGames.map((gid) => {
    const g = universe.find((x) => x.game_id === gid);
    const e = fetchErrors.find((x) => x.gameId === gid);
    const teams = g && g.team_blue && g.team_red ? `${g.team_blue} vs ${g.team_red}` : '(times indisponíveis — window nunca respondeu, times vêm do próprio livestats)';
    return [g ? g.league : e.league, gid, teams, g ? fmtDate(g.date) : '—'];
  });

  return {
    byReason,
    suspectTable: table(['bet_id', 'Bookmaker', 'Liga', 'Times', 'Data', 'Status', 'game_id'], suspectRows),
    noMatchTable: table(['bet_id', 'Bookmaker', 'Liga', 'Times', 'Data', 'Status'], noMatchRows),
    fetchErrorTable: table(['Liga', 'game_id', 'Times', 'Data'], fetchErrorRows),
  };
}

// === Seção 10: Verificação da auditoria ===
function buildVerification() {
  const validateSim = existing.results.find((r) => r.name === 'validate_sim_profit');
  return {
    validateSimSummary: validateSim.summary,
    resultsGamesCompared: coverage.counts.results_games_compared,
    resultsGamesNotInUniverse: coverage.counts.results_games_not_in_universe,
    triggerDivergenceTotal: coverage.counts.trigger_divergence_total,
  };
}

// === Seção 11: Lotes de fix ===
function buildFixLotes() {
  const rows = [
    ['A', 'Corrige kills/status/profit de bets reais e SIMULATED contra a API (4 bets: 61507820, 2432691d, 0f79cb9e, b0481dab)', '4 rows', 'ALTO (bet real 61507820: reverte green→red, muda banca declarada em R$1.790)', 'a criar (fix-kills-status-profit.cjs)', 'backup cron-data/2026-07-20-backup-audit-A.json'],
    ['B', 'Corrige trigger_type de 3 bets (TRIGGER_MISMATCH)', '3 rows', 'BAIXO (não muda profit/status)', 'a criar (fix-trigger-type.cjs)', 'backup cron-data/2026-07-20-backup-audit-B.json'],
    ['C', 'Backfill de campos obrigatórios (lolesports_game_id em 4 bets + fair_pinnacle em 10 bets)', '14 rows', 'BAIXO/MÉDIO (dados novos, não sobrescreve settle)', 'backfill-match-id.cjs / backfill-fair-columns.cjs (existentes)', 'backup cron-data/2026-07-20-backup-audit-C.json'],
    ['D', 'Insere as 36 bets SIMULATED faltando (MISSING_BET)', '36 rows novas', 'MÉDIO (aumenta volume do backtest, pode mudar hit% agregado)', 'insert-missed-bets.cjs (existente)', 'backup pré-insert do estado atual da tabela'],
    ['E', 'Preenche method_reports faltando (274 rows) + corrige 6 trigger Alistar', '280 rows', 'BAIXO (tabela de backtest, não afeta bets reais)', 'a criar (rerun save_report_to_db.cjs pros jogos faltando)', 'backup method_reports antes'],
    ['F', 'Normaliza bookmaker case (3 rows: EstrelaBet→estrelabet, Pinnacle→pinnacle)', '3 rows', 'BAIXO (só string case, não muda semântica)', 'normalize-bookmakers.cjs (existente)', 'backup cron-data/2026-07-20-backup-audit-F.json'],
    ['G', 'Remove 8 bets duplicadas (dedup)', '8 rows deletadas', 'MÉDIO (delete é irreversível sem backup)', 'dedup-bets-execute.cjs (existente, hoje só dry-run rodado)', 'backup obrigatório antes de qualquer delete'],
  ];
  return table(['Lote', 'O que faz', 'Rows', 'Risco', 'Script', 'Pré-requisito'], rows);
}

// === Monta o documento ===
function buildReport() {
  const exec = buildExecSummary();
  const crit = buildCritical();
  const mb = buildMissingBets();
  const fm = buildFieldMissing();
  const med = buildMediumTriggerFair();
  const mr = buildMethodReports();
  const low = buildLowInfo();
  const ewcSection = buildEwc();
  const nv = buildNonVerifiable();
  const ver = buildVerification();
  const fixLotes = buildFixLotes();

  const spotChecksTable = table(
    ['Liga', 'bet_id', 'Bookmaker', 'Status no banco', 'Match', 'Data', 'Pick', 'Fonte', 'Resultado'],
    EXTERNAL_SPOT_CHECKS.spotchecks.map((s) => [
      s.league,
      s.bet_id,
      s.bookmaker,
      s.status_db,
      s.match,
      s.date,
      s.pick,
      `[${s.source}](${s.url})`,
      s.match_ok === true ? 'CONFIRMADO' : s.match_ok === 'partial' ? 'CONFIRMADO c/ ressalva' : 'NÃO CONFIRMADO',
    ])
  );

  return `# Auditoria completa do banco — Split 2 (2026-04-01 → 2026-06-30)

**Gerado em:** ${new Date().toISOString()}
**Escopo:** 707 bets no período [2026-04-01, 2026-07-01) das 6 ligas Riot API (LCK/LPL/LEC/CBLOL/LFL/LCS) + 48 bets EWC (fora da Riot API, checklist manual). 756 bets totais no banco = 707 + 48 + 1 (bet MSI 2026-07-01, fora de ambos os escopos por data).
**Nota:** gerado por \`scripts/audit/build-report.cjs\` a partir de \`audit-output/*.json\` — re-rodável (\`node scripts/audit/build-report.cjs\`). Os spot-checks externos (gol.gg/ggscore) das seções 2 e 10 são verificação manual pontual de 2026-07-20, não recomputados a cada rerun.

---

## 1. Sumário executivo

${exec.table}

### Veredito

${exec.veredito}

---

## 2. CRITICAL — kills/status/profit (lote A)

${crit}

---

## 3. HIGH — cobertura: 36 MISSING_BET (lote D)

Jogos do universo com trigger ativo (2peel ou 1peel+flex), frame confiável, e SEM bet correspondente no banco.

### Por liga/mês

${mb.summary}

### Lista completa

${mb.full}

---

## 4. HIGH — campos obrigatórios (lote C): 4 FIELD_MISSING

${fm}

Todos os 4 são \`match_context.lolesports_game_id\` null em bet já settled (green/red) — o matching da auditoria ainda achou o jogo certo via fallback (nome+data+mapa), mas o campo canônico não foi preenchido no settle original. Backfillable via \`backfill-match-id.cjs\`.

---

## 5. MEDIUM — trigger (lote B) e fair (sem lote)

### Trigger — 3 bets (TRIGGER_MISMATCH)

${med.triggerBets}

2 dos 3 (\`6740f14f\`, \`c4eda66d\`) são o mesmo jogo NIP vs EDG (LPL, mapa 5) com \`trigger_type: "ewc_unclassified"\` — sentinela de EWC vazando pra bet de liga regular (ver §7). O 3º (\`b0481dab\`, LCS) tem \`current: null\` mas devia ser \`2peel\` (Milio+Seraphine) — trigger nunca foi calculado nesse settle.

### Trigger — 6 rows de method_reports com Alistar

${med.triggerMr}

Todas as 6 têm \`expected: null\` — o \`_archive/analyze_range.cjs\` (arquivado, fora de escopo de fix) ainda trata Alistar como FLEX_ENGAGE, gerando \`1peel+flex\` onde o método atual (sem Alistar desde 2026-05-29) diria "sem trigger". **Fora de escopo de correção desta auditoria** — é bug de pipeline de geração de \`results.json\`/method_reports, não das bets.

### Fair — SEM lote de correção em massa

**Fair mismatch (fair_formula): ${med.fairTotal} findings.** Breakdown:
- ${med.fairNull} com \`fair_formula\` atual null (nunca fez backfill)
- ${med.fairTier2} em ligas tier2 (LFL/LES/LIT) sem fonte de dado comparável no settle
- ${med.fairMajorsDiverge} em majors com valor divergente (~1 linha de diferença)

**Causa raiz (investigada por amostragem — validação #3 do plano):** ${med.fairRootCause}

**Recomendação:** NÃO é candidato a correção em massa. Requer revisão de processo separada (decidir se vale backfillar os ${med.fairNull} nulls, e se o pipeline tier2 devia gravar em \`cron-data/*-results.json\` pra ficar comparável). Item pra \`knowledge/pending.md\`, não pro lote de fix desta auditoria.

**Fair_pinnacle — ${med.fairPinnacleCount} findings, ESSES SIM são backfill legítimo** (valor existe em \`cron-data/*-fair-pinnacle.json\`, só não foi gravado na bet):

${med.fairPinnacleRows}

---

## 6. method_reports (lote E)

**0 erros de dado** (0 MR_KILLS_MISMATCH, 0 MR_UNDER_HIT_WRONG, 0 MR_PK_DUP, 0 MR_ORPHAN) — a tabela nunca tinha sido auditada antes e os dados que existem batem 100% com a API.

**${mr.totalMissing} de 418 jogos elegíveis (trigger ativo, frame confiável) SEM row em method_reports** (~66% de lacuna):

${mr.table}

Reconciliação: 418 elegíveis = ${418 - mr.totalMissing} com row existente + ${mr.totalMissing} faltando. Os 150 rows totais no escopo = ${418 - mr.totalMissing} elegíveis batendo + 6 rows extras que existem mas apontam pra jogos sem trigger no universo (os 6 MR_TRIGGER_MISMATCH do §5, todos com Alistar).

---

## 7. LOW / INFO

### Bookmaker case (lote F)

${low.bookmakerTable}

Fix via \`normalize-bookmakers.cjs\` (existente) — normaliza pra minúsculo. Só 3 rows fora do padrão (\`EstrelaBet\`×1, \`Pinnacle\`×2).

### Duplicatas do dedup (lote G) — 8 bets, 7 grupos

${low.dedupTotalBanco} (sem filtro de data). ${low.dedupMarcadas}. Lista completa dos 8 bet_ids candidatos a deleção (o script já roda em dry-run, \`keep_id\` de cada grupo preservado):

${low.dedupIdsTable}

### SIM generations

${low.simGen}

### Alias faltando

${low.aliasMissing}

### Trigger "ewc_unclassified" vazando pra liga não-EWC — 2 bets LPL

${low.ewcUnclassifiedLpl}

Mesmo jogo (NIP vs EDG, mapa 5) inserido 2x via backfill manual (\`user_bet_backfill_2026-05-29\`) sem recalcular trigger_type — herdou o placeholder "ewc_unclassified" que só devia existir em bets \`EWC-*\`. Ver TRIGGER_MISMATCH no §5 pro valor correto (\`null\`, Thresh+Yuumi não fecha 2peel nem 1peel+flex).

### TRIGGER_DIVERGENCE_RESULTS — 30 jogos (11 com Alistar)

Divergência entre o trigger gravado em \`cron-data/*-results.json\` (gerado pelo \`_archive/analyze_range.cjs\`, ainda usa lista de supports antiga com Alistar) e o trigger recomputado pela auditoria com a lista atual. **Fora de escopo de fix** (código arquivado) — só quantificado.

### RESULTS_JSON_GAP — 4 dias sem arquivo

${JSON.stringify(low.resultsJsonGap, null, 2)}

---

## 8. EWC — 0 findings internos, checklist manual (48 bets)

EWC não está na Riot API (torneio ESL/Saudi) — sem cross-check automático de kills. Checks aritméticos internos (profit = f(status,stake,odd)) passaram 100%. Lista completa pra conferência manual no Leaguepedia/gol.gg:

${ewcSection}

---

## 9. Não-verificáveis via API — 72 MANUAL_CHECK + 4 games LPL sem dado na CDN

Por motivo: ${JSON.stringify(nv.byReason)}

### suspect_frame (22) — frame livestats não confiável (gameState≠finished + gameTime<600s ou kills<5)

${nv.suspectTable}

### no_universe_match (49) — bet fora das 6 ligas cobertas ou sem match no universo

${nv.noMatchTable}

### fetch_error — 4 games LPL sem dado na CDN lolesports (JSON truncado após 4 tentativas)

${nv.fetchErrorTable}

Conferir manualmente no gol.gg os 4 jogos acima — nenhum dos dois lados (bet nem auditoria) tem dado confiável pra essas partidas.

---

## 10. Verificação da própria auditoria

1. **Grupo de controle** — \`validate-sim-profit.cjs\`: ${ver.validateSimSummary.join(' | ')}
2. **Determinismo** — cache em disco (\`audit-cache/\`), jogos \`completed\` são imutáveis; re-rodar as fases 1-3 do cache dá a mesma contagem de findings (não houve nova chamada de API entre as rodadas desta sessão).
3. **Cross-check universo vs results.json** — ${ver.resultsGamesCompared} jogos comparados, ${ver.resultsGamesNotInUniverse} fora do universo, ${ver.triggerDivergenceTotal} divergências de trigger (todas explicadas no §7 — código arquivado com Alistar).
4. **Spot-check externo do achado CRITICAL nº1** (Tarefa 1 do briefing):

${table(
  ['Bet', 'Fonte', 'URL', 'Resultado'],
  [[
    `${EXTERNAL_SPOT_CHECKS.critical1.bet_id} (real) + ${EXTERNAL_SPOT_CHECKS.critical1.sim_bet_id} (SIM)`,
    EXTERNAL_SPOT_CHECKS.critical1.source,
    EXTERNAL_SPOT_CHECKS.critical1.url,
    EXTERNAL_SPOT_CHECKS.critical1.result,
  ]]
)}

5. **Spot-check de 4 bets sem finding** (Tarefa 2 do briefing — 1 LCK, 1 LEC, 1 CBLOL, 1 LFL, mix green/red/real/SIMULATED):

${spotChecksTable}

3 de 4 bateram exato com gol.gg/ggscore. 1 (CBLOL) teve discrepância de 1 kill no lado red entre gol.gg (5) e a API lolesports (6) — não muda o status da bet (linha 27.5, ambos os totais ficam abaixo). Não invalida a auditoria, mas registra que gol.gg e a API oficial da Riot nem sempre batem exatamente — quando isso importar pro resultado de uma bet específica, preferir a API lolesports (fonte que o settle real usa) e usar gol.gg só como confirmação independente.

---

## 11. Lotes de fix propostos

**NENHUM fix roda sem aprovação explícita do Elvis, por lote.** Todos os scripts abaixo rodam \`--dry-run\` por default, com backup em \`cron-data/2026-07-20-backup-audit-<lote>.json\` antes de qualquer write, e a fase correspondente da auditoria é re-rodada depois de cada lote até dar zero findings novos.

${fixLotes}

Ordem sugerida: **C → A → B → F → G → D → E** (backfills e correções pontuais de baixo risco primeiro, depois inserts/deletes de maior volume).
`;
}

const report = buildReport();
fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, report, 'utf8');
console.log(`Relatório escrito em: ${REPORT_PATH}`);
console.log(`Linhas: ${report.split('\n').length}`);
