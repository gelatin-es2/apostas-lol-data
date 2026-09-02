// Corrige o bug de orientação (team_blue/team_red trocados) no HISTÓRICO de
// cron-data/*-results.json (e qualquer outro diretório passado via --dir).
//
// Contexto (mineração 31/08/2026): o gerador antigo (_archive/scripts/analyze_range.cjs,
// versão commitada até 2026-07-22) rotulava team_blue/team_red pela ORDEM DA SÉRIE
// (ev.match.teams[0]/[1]), mas os times ALTERNAM de lado a cada mapa — então o rótulo
// não acompanhava a troca. Resultado: ~29% dos mapas com team_blue/team_red invertidos
// (LPL pior liga, mapas 2+ piores que mapa 1). kills_blue/kills_red e sup_blue/sup_red
// NÃO são afetados (vêm direto do lado azul/vermelho da window, sempre corretos).
//
// Ground truth: audit-cache/orientation-full.json { game_id: 'ok'|'swapped' },
// construído 1x a partir de audit-cache/window-<game_id>.json (esportsTeamId do
// blueTeamMetadata -> nome via event-*.json). Onde não existe window local, o
// game_id fica ausente desse arquivo — esses mapas são listados como "sem ground
// truth" e NUNCA tocados (não adivinha, não baixa da Riot em massa).
//
// Campos LADO (nunca trocam): kills_blue/kills_red, sup_blue/sup_red,
// peel_count/peel_bucket/flex_engages/trigger_type (derivados de sup_*),
// under_hit, matchup_fair/fair_pinnacle/fair_formula/fair_raw/fair_adjusted/
// fair_source/league_baseline/vs_league (simétricos blue+red, não dependem de
// qual NOME é qual lado).
//
// Campos TIME (trocam junto com team_blue/team_red porque são indexados pelo
// NOME do time, não pelo lado): blue_avg/red_avg, blue_sample_n/red_sample_n.
//
// Idempotente: linha já processada ganha orientation_fixed (trocada) ou
// orientation_checked (confirmada ok) — 2ª rodada pula sem reconsultar o
// ground truth (evita destrocar se rodar 2x).
//
// Uso:
//   node scripts/fix-results-orientation.cjs                 → dry-run em cron-data/
//   node scripts/fix-results-orientation.cjs --apply         → aplica em cron-data/
//   node scripts/fix-results-orientation.cjs --dir X --apply → aplica em X (repetível)
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ORIENTATION_FILE = path.join(REPO, 'audit-cache', 'orientation-full.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dirs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir' && argv[i + 1]) { dirs.push(path.resolve(argv[i + 1])); i++; }
}
const TARGET_DIRS = dirs.length ? dirs : [path.join(REPO, 'cron-data')];

const orientation = JSON.parse(fs.readFileSync(ORIENTATION_FILE, 'utf8'));
console.log(`ground truth: ${Object.keys(orientation).length} game_ids decidíveis (${ORIENTATION_FILE})`);
console.log(`modo: ${APPLY ? 'APLICANDO' : 'DRY-RUN (nada será escrito — use --apply)'}`);
console.log(`diretórios: ${TARGET_DIRS.join(', ')}`);

// campos indexados pelo NOME do time (trocam junto com team_blue/team_red)
const TEAM_FIELD_PAIRS = [
  ['blue_avg', 'red_avg'],
  ['blue_sample_n', 'red_sample_n'],
];

function fixFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  const results = j.results || [];
  let swapped = 0, ok = 0, noGroundTruth = 0, alreadyDone = 0;
  const noGtRows = [];

  for (const r of results) {
    if (r.orientation_fixed || r.orientation_checked) { alreadyDone++; continue; }
    const verdict = orientation[String(r.game_id)];
    if (!verdict) {
      noGroundTruth++;
      noGtRows.push({ game_id: r.game_id, league: r.league, map_number: r.map_number, team_blue: r.team_blue, team_red: r.team_red });
      continue;
    }
    if (verdict === 'ok') {
      r.orientation_checked = true;
      ok++;
      continue;
    }
    // verdict === 'swapped'
    r.orientation_original_team_blue = r.team_blue;
    r.orientation_original_team_red = r.team_red;
    const tmpBlue = r.team_blue, tmpRed = r.team_red;
    r.team_blue = tmpRed; r.team_red = tmpBlue;
    for (const [bf, rf] of TEAM_FIELD_PAIRS) {
      if (r[bf] !== undefined || r[rf] !== undefined) {
        const tmp = r[bf]; r[bf] = r[rf]; r[rf] = tmp;
      }
    }
    r.orientation_fixed = true;
    swapped++;
  }

  const changed = swapped > 0 || ok > 0;
  if (changed && APPLY) {
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
  }
  return { swapped, ok, noGroundTruth, alreadyDone, noGtRows, total: results.length };
}

let totSwapped = 0, totOk = 0, totNoGt = 0, totAlready = 0, totRows = 0;
const allNoGt = [];
for (const dir of TARGET_DIRS) {
  if (!fs.existsSync(dir)) { console.log(`\n[SKIP] diretório não existe: ${dir}`); continue; }
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-results\.json$/.test(f));
  console.log(`\n=== ${dir} (${files.length} arquivos) ===`);
  for (const f of files.sort()) {
    const res = fixFile(path.join(dir, f));
    totRows += res.total;
    totSwapped += res.swapped;
    totOk += res.ok;
    totNoGt += res.noGroundTruth;
    totAlready += res.alreadyDone;
    allNoGt.push(...res.noGtRows);
    if (res.swapped || res.noGroundTruth || res.alreadyDone) {
      console.log(`  ${f}: trocados=${res.swapped} ok=${res.ok} sem_ground_truth=${res.noGroundTruth} ja_processados=${res.alreadyDone} (de ${res.total})`);
    }
  }
}

console.log(`\n=== TOTAL ===`);
console.log(`mapas: ${totRows}`);
console.log(`trocados agora: ${totSwapped}`);
console.log(`confirmados ok agora: ${totOk}`);
console.log(`já processados (idempotência): ${totAlready}`);
console.log(`sem ground truth (não tocados): ${totNoGt}`);
if (totNoGt) {
  const byLeague = {};
  for (const r of allNoGt) byLeague[r.league] = (byLeague[r.league] || 0) + 1;
  console.log('sem ground truth por liga:', byLeague);
  const outList = path.join(path.dirname(ORIENTATION_FILE), 'no-ground-truth-game-ids.json');
  if (APPLY) {
    fs.writeFileSync(outList, JSON.stringify(allNoGt, null, 1));
    console.log(`lista completa salva em: ${outList}`);
  }
}
if (!APPLY) console.log('\nDRY-RUN — nada foi escrito. Rode com --apply pra gravar.');
