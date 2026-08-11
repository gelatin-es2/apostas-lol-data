// Runner de testes da Fase 2 — contrato do bet-logger.
// Uso: node .claude/scripts/tests/run-tests.cjs
//
// 100% offline: finder testado por módulo com fetch fake injetado; save testado
// por módulo (validateAndNormalize/decodeInput) e por CLI com --validate-only
// sob net-blocker (qualquer toque em rede derruba o processo).
// NUNCA chama Supabase, NUNCA lê/imprime credencial.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TMP_DIR = path.join(__dirname, 'tmp');
const FINDER = path.join(SCRIPTS_DIR, 'lolesports-find-match.cjs');
const SAVE = path.join(SCRIPTS_DIR, 'supabase-save-bet.cjs');
const NET_BLOCKER = path.join(__dirname, 'net-blocker.cjs');

const { runFindMatch, stateEnum } = require(FINDER);
const { validateAndNormalize, decodeInput, ValidationError, SUPPORTED_SCHEMA_VERSION } = require(SAVE);
const { FIXTURES, makeFetch } = require(path.join(FIXTURES_DIR, 'lolesports-schedules.cjs'));

// ─── mini harness ───────────────────────────────────────────────────────────
const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL  ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`assert falhou: ${msg}`); }
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}
// Espera ValidationError com exitCode e trecho da mensagem
function expectReject(fn, exitCode, msgPart) {
  try { fn(); }
  catch (e) {
    assert(e instanceof ValidationError, `esperava ValidationError, veio ${e.constructor.name}: ${e.message}`);
    assertEq(e.exitCode, exitCode, 'exitCode');
    assert(e.message.toLowerCase().includes(msgPart.toLowerCase()), `mensagem não contém "${msgPart}": ${e.message}`);
    return;
  }
  throw new Error(`esperava rejeição (exit ${exitCode}, "${msgPart}") mas passou`);
}

const baseFixtureText = fs.readFileSync(path.join(FIXTURES_DIR, 'save-valid.json'), 'utf8');
function basePayload(mut) {
  const p = JSON.parse(baseFixtureText);
  if (mut) mut(p);
  return p;
}
function validate(payload) {
  return validateAndNormalize(JSON.stringify(payload));
}

// Silencia stderr dos scripts (avisos de normalização) durante os testes de módulo
const realStderrWrite = process.stderr.write.bind(process.stderr);
function quietStderr(on) {
  process.stderr.write = on ? () => true : realStderrWrite;
}

(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  quietStderr(true);

  // ═══ FINDER — contrato v1 (fetch fake injetado, clock fixo) ═══
  const F = FIXTURES;
  const base = { teamA: 'T1', teamB: 'GEN', dateArg: F.TARGET_DATE, nowMs: F.NOW_MS };

  await test('finder: fixture 1 — match único → schema v1, picked completo, sem ambiguidade', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.unique) });
    assertEq(out.schema_version, 1, 'schema_version');
    assertEq(out.found, true, 'found');
    assertEq(out.ambiguous, false, 'ambiguous');
    assertEq(out.selection_reason, 'starting_soon', 'selection_reason');
    assertEq(out.picked.match_id, '111111111111111111', 'picked.match_id');
    assertEq(out.picked.start_time, `${F.TARGET_DATE}T08:00:00Z`, 'picked.start_time');
    assert(out.picked.startTime === undefined, 'picked NÃO pode ter startTime (camelCase)');
    assertEq(out.picked.state, 'unstarted', 'picked.state');
    assertEq(out.picked.selection_source, 'lolesports_schedule', 'selection_source');
    assertEq(out.picked.selection_confidence, 'high', 'selection_confidence');
    assertEq(out.all_candidates.length, 1, 'all_candidates.length');
  });

  await test('finder: espelho legado top-level preservado (compat backfill-match-id.cjs)', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.unique) });
    assertEq(out.match_id, out.picked.match_id, 'match_id espelho');
    assertEq(out.start_time, out.picked.start_time, 'start_time espelho');
    assertEq(out.league_short, out.picked.league_short, 'league_short espelho');
    assertEq(out.selected_reason, out.selection_reason, 'selected_reason espelho');
    assert(Array.isArray(out.teams), 'teams espelho');
  });

  await test('finder: fixture 2 — dois candidatos → ambiguous=true, confiança low, 2 candidatos', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.ambiguous) });
    assertEq(out.found, true, 'found');
    assertEq(out.ambiguous, true, 'ambiguous');
    assertEq(out.all_candidates.length, 2, 'all_candidates.length');
    assertEq(out.picked.selection_confidence, 'low', 'confidence com ambiguidade');
  });

  await test('finder: fixture 3 — match live → selection_reason=live, confiança high', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.live) });
    assertEq(out.selection_reason, 'live', 'selection_reason');
    assertEq(out.picked.state, 'inProgress', 'state');
    assertEq(out.picked.selection_confidence, 'high', 'confidence');
  });

  await test('finder: fixture 4 — concluído no mesmo dia → exact_date_completed, confiança medium', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.completedSameDay) });
    assertEq(out.selection_reason, 'exact_date_completed', 'selection_reason');
    assertEq(out.picked.selection_confidence, 'medium', 'confidence');
  });

  await test('finder: data sem match → found=false, picked=null, selection_reason=not_found', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.otherDay) });
    assertEq(out.schema_version, 1, 'schema_version');
    assertEq(out.found, false, 'found');
    assertEq(out.picked, null, 'picked');
    assertEq(out.selection_reason, 'not_found', 'selection_reason');
    assert(out.reason.includes('match_id_exception'), 'reason orienta exceção EWC');
  });

  await test('finder: estado fora do enum → state=unknown + state_raw preservado', async () => {
    const out = await runFindMatch({ ...base, fetchJson: makeFetch(F.LCK_ID, F.weirdState) });
    assertEq(out.picked.state, 'unknown', 'state');
    assertEq(out.picked.state_raw, 'somethingNew', 'state_raw');
    assertEq(stateEnum('completed'), 'completed', 'stateEnum passthrough');
  });

  // ═══ SAVE — validação de contrato (módulo, sem rede) ═══

  await test('save: payload válido passa — normaliza bookmaker, mantém contrato', () => {
    const { bet, warnings } = validate(basePayload());
    assertEq(bet.bookmaker, 'estrelabet', 'bookmaker lowercased');
    assertEq(bet.raw_extraction.match_context.schema_version, 1, 'schema_version');
    assertEq(bet.fair_pinnacle, null, 'fair_pinnacle null (sem arquivo fair na data fixture)');
    assert(Array.isArray(warnings), 'warnings é array');
  });

  await test('save: fixture 6 — nomes antigos (startTime/leagueShort) → rejeição clara exit 4', () => {
    const legacy = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'save-legacy-names.json'), 'utf8'));
    expectReject(() => validate(legacy), 4, 'contrato ANTIGO');
  });

  await test('save: fixture 7 — UTF-8 com acentos preservados byte a byte', () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'save-valid.json'));
    const { text, warnings } = decodeInput(buf);
    assertEq(warnings.length, 0, 'sem warnings de encoding');
    const { bet } = validateAndNormalize(text);
    assert(bet.pick.includes('Menos de 27,5 — decisão do capitão José'), 'pick com acento/travessão preservado');
    assert(bet.notes.includes('ação, coração, Fênix, Grün'), 'notes com acentos preservados');
  });

  await test('save: fixture 8a — BOM UTF-8 tolerado com warning', () => {
    const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(baseFixtureText, 'utf8')]);
    const { text, warnings } = decodeInput(bom);
    assert(warnings.some(w => w.includes('BOM UTF-8')), 'warning de BOM');
    const { bet } = validateAndNormalize(text);
    assertEq(bet.bookmaker, 'estrelabet', 'parse ok após strip do BOM');
  });

  await test('save: fixture 8b — UTF-16 LE (com BOM) → rejeição explicada', () => {
    const utf16 = Buffer.from(baseFixtureText, 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xFF, 0xFE]), utf16]);
    expectReject(() => decodeInput(withBom), 1, 'UTF-16');
  });

  await test('save: fixture 8c — UTF-16 sem BOM (bytes NUL) → rejeição explicada', () => {
    const utf16 = Buffer.from(baseFixtureText, 'utf16le');
    expectReject(() => decodeInput(utf16), 1, 'NUL');
  });

  await test('save: fixture 9 — os 4 bookmakers aceitos (EstrelaBet, Pinnacle, Parimatch, Betano)', () => {
    for (const bk of ['EstrelaBet', 'Pinnacle', 'Parimatch', 'Betano']) {
      const { bet } = validate(basePayload(p => { p.bookmaker = bk; }));
      assertEq(bet.bookmaker, bk.toLowerCase(), `bookmaker ${bk}`);
    }
  });

  await test('save: bookmaker fora da lista → rejeitado', () => {
    expectReject(() => validate(basePayload(p => { p.bookmaker = 'CasaFantasma'; })), 1, 'não é canônico');
  });

  await test('save: fixture 10a — EWC sem match_id e SEM exceção → rejeição exit 4', () => {
    expectReject(() => validate(basePayload(p => {
      p.league = 'EWC SK Qualifier';
      delete p.raw_extraction.match_context;
    })), 4, 'match_id_exception');
  });

  await test('save: fixture 10b — EWC com exceção válida → aceito, liga normalizada, warning', () => {
    const { bet, warnings } = validate(basePayload(p => {
      p.league = 'EWC SK Qualifier';
      delete p.raw_extraction.match_context;
      p.raw_extraction.match_id_exception = { reason: 'EWC qualifier — fora da cobertura lolesports', case: 'ewc_qualifier' };
    }));
    assertEq(bet.league, 'EWC-LCK', 'liga normalizada');
    assert(warnings.some(w => w.includes('exceção auditável aceita')), 'warning de exceção');
  });

  await test('save: fixture 10c — exceção com case não aprovado → rejeitada', () => {
    expectReject(() => validate(basePayload(p => {
      delete p.raw_extraction.match_context;
      p.raw_extraction.match_id_exception = { reason: 'sei lá', case: 'preguica' };
    })), 4, 'match_id_exception');
  });

  await test('save: bypass antigo ALLOW_MISSING_MATCH_ID=1 → erro instruindo a exceção nova', () => {
    process.env.ALLOW_MISSING_MATCH_ID = '1';
    try {
      expectReject(() => validate(basePayload()), 4, 'REMOVIDO');
    } finally {
      delete process.env.ALLOW_MISSING_MATCH_ID;
    }
  });

  await test('save: fixture 11 — map bet sem map_number → rejeitada', () => {
    expectReject(() => validate(basePayload(p => { p.map_number = null; })), 1, 'map_number');
  });

  await test('save: map_number "3" (string) é coagido pra 3; 7 é rejeitado', () => {
    const { bet } = validate(basePayload(p => { p.map_number = '3'; }));
    assertEq(bet.map_number, 3, 'coerção string→int');
    expectReject(() => validate(basePayload(p => { p.map_number = 7; })), 1, 'map_number');
  });

  await test('save: ambiguous=true SEM resolução → bloqueio exit 3, nenhum write', () => {
    expectReject(() => validate(basePayload(p => {
      p.raw_extraction.match_context.ambiguous = true;
    })), 3, 'NENHUM write');
  });

  await test('save: ambiguous=true COM escolha explícita do usuário → aceito', () => {
    const { bet } = validate(basePayload(p => {
      p.raw_extraction.match_context.ambiguous = true;
      p.raw_extraction.match_context.ambiguity_resolution = {
        chosen_by: 'user',
        chosen_match_id: '115548128962971919',
      };
    }));
    assertEq(bet.raw_extraction.match_context.ambiguity_resolution.chosen_by, 'user', 'resolução preservada');
  });

  await test('save: ambiguity_resolution com match_id DIFERENTE do salvo → bloqueio', () => {
    expectReject(() => validate(basePayload(p => {
      p.raw_extraction.match_context.ambiguous = true;
      p.raw_extraction.match_context.ambiguity_resolution = { chosen_by: 'user', chosen_match_id: '999' };
    })), 3, 'chosen_match_id');
  });

  await test('save: match_context sem schema_version → rejeição exit 4', () => {
    expectReject(() => validate(basePayload(p => {
      delete p.raw_extraction.match_context.schema_version;
    })), 4, 'schema_version');
  });

  await test(`save: schema_version futura (${SUPPORTED_SCHEMA_VERSION + 1}) → rejeição exit 4`, () => {
    expectReject(() => validate(basePayload(p => {
      p.raw_extraction.match_context.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
    })), 4, 'não suportada');
  });

  await test('save: fixture 5 — bet_datetime fora da janela -24h/+12h → exit 2', () => {
    // start 2027-01-15T08:00Z; bet 2027-01-13T00:00Z = -56h
    expectReject(() => validate(basePayload(p => { p.bet_datetime = '2027-01-13T00:00:00Z'; })), 2, 'fora de janela');
    // +13h também rejeita
    expectReject(() => validate(basePayload(p => { p.bet_datetime = '2027-01-15T21:30:00Z'; })), 2, 'fora de janela');
  });

  await test('save: janela -24h/+12h aceita bordas internas (-20h e +11h)', () => {
    validate(basePayload(p => { p.bet_datetime = '2027-01-14T12:00:00Z'; })); // -20h
    validate(basePayload(p => { p.bet_datetime = '2027-01-15T19:00:00Z'; })); // +11h
  });

  await test('save: bet_datetime ausente → rejeitada (obrigatório pro settle)', () => {
    expectReject(() => validate(basePayload(p => { delete p.bet_datetime; })), 1, 'bet_datetime');
  });

  await test('save: payload array ou com "id" → rejeitado (1 aprovação = 1 insert)', () => {
    expectReject(() => validateAndNormalize(JSON.stringify([basePayload()])), 1, 'um objeto');
    expectReject(() => validate(basePayload(p => { p.id = 'abc-123'; })), 1, 'só INSERE');
  });

  // ═══ SAVE — CLI --validate-only comprovadamente sem rede (fixture 12) ═══

  await test('save CLI: fixture 12 — --validate-only sob net-blocker roda offline e mostra payload', () => {
    const r = spawnSync(process.execPath, [
      '--require', NET_BLOCKER, SAVE, '--validate-only', path.join(FIXTURES_DIR, 'save-valid.json'),
    ], { encoding: 'utf8', timeout: 30000 });
    assertEq(r.status, 0, `exit code (stderr: ${(r.stderr || '').slice(0, 300)})`);
    const out = JSON.parse(r.stdout.trim());
    assertEq(out.ok, true, 'ok');
    assertEq(out.validate_only, true, 'validate_only');
    assertEq(out.would_insert.bookmaker, 'estrelabet', 'payload exibido');
    assert(!JSON.stringify(out).match(/sb_secret|service_role|SUPABASE_URL/i), 'output sem credencial');
  });

  await test('save CLI: net-blocker realmente derruba quem tenta rede (prova do bloqueio)', () => {
    const r = spawnSync(process.execPath, [
      '--require', NET_BLOCKER, '-e', "require('https').get('https://example.com')",
    ], { encoding: 'utf8', timeout: 30000 });
    assert(r.status !== 0, 'processo com rede deveria falhar');
    assert((r.stderr || '').includes('NETWORK BLOCKED'), 'stderr acusa bloqueio');
  });

  await test('save CLI: arquivo legado → exit 4 e mensagem de contrato', () => {
    const r = spawnSync(process.execPath, [
      '--require', NET_BLOCKER, SAVE, '--validate-only', path.join(FIXTURES_DIR, 'save-legacy-names.json'),
    ], { encoding: 'utf8', timeout: 30000 });
    assertEq(r.status, 4, 'exit code');
    const out = JSON.parse(r.stdout.trim());
    assertEq(out.ok, false, 'ok=false');
    assert(out.error.includes('contrato ANTIGO'), 'mensagem clara');
  });

  await test('save CLI: UTF-16 gerado (Set-Content sem encoding simulado) → rejeição explicada', () => {
    const p = path.join(TMP_DIR, 'save-utf16.json');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(baseFixtureText, 'utf16le')]));
    const r = spawnSync(process.execPath, [
      '--require', NET_BLOCKER, SAVE, '--validate-only', p,
    ], { encoding: 'utf8', timeout: 30000 });
    assertEq(r.status, 1, 'exit code');
    const out = JSON.parse(r.stdout.trim());
    assert(out.error.includes('UTF-16'), 'mensagem menciona UTF-16');
  });

  // ─── relatório ───
  quietStderr(false);
  console.log('\n══ Fase 2 — contrato bet-logger — resultado dos testes ══\n');
  for (const r of results) console.log(r);
  console.log(`\n${results.length - failures}/${results.length} passaram${failures ? ` — ${failures} FALHARAM` : ''}`);
  process.exit(failures ? 1 : 0);
})().catch(e => {
  quietStderr(false);
  console.error(`ERRO FATAL no runner: ${e.stack}`);
  process.exit(1);
});
