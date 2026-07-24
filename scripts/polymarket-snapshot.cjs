// Grava um snapshot de TODOS os mercados moneyline de LoL abertos na Polymarket agora.
// Pensado pra série histórica de odds pro estudo ML fase 2 (odds pré-jogo/ao-vivo ao longo
// do tempo, não só um corte no momento da aposta).
//
// Uso:
//   node scripts/polymarket-snapshot.cjs
//
// Output: cron-data/polymarket-ml/YYYY-MM-DDTHH-MM.json
//
// IMPORTANTE: manual/por sessão. NÃO está registrado no cron do GitHub Actions
// (.github/workflows/daily-cron.yml) — decisão 2026-07-24 ao ressuscitar a integração:
// reviver só on-demand pro estudo ML, sem tocar no pipeline diário existente (Pinnacle
// manual + fórmula seguem como fontes de fair line em produção).

const fs = require('fs');
const path = require('path');
const { fetchAllOpenLolEvents, buildSummary } = require('./polymarket-odds.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'cron-data', 'polymarket-ml');

function tsForFilename(d) {
  // YYYY-MM-DDTHH-MM (sem caracteres inválidos pra nome de arquivo no Windows)
  return d.toISOString().slice(0, 16).replace(':', '-');
}

async function main() {
  const now = new Date();
  console.error('[1/2] consultando gamma-api.polymarket.com (series_id=10311, LoL)...');

  let events;
  try {
    events = await fetchAllOpenLolEvents();
  } catch (e) {
    console.error(`ERRO ao consultar Polymarket: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const summaries = events
    .map(buildSummary)
    .sort((a, b) => (a.start_time_utc || '').localeCompare(b.start_time_utc || ''));

  const withMoneyline = summaries.filter(s => s.moneyline_series || s.moneyline_maps.length > 0);

  const snapshot = {
    captured_at: now.toISOString(),
    source: 'gamma-api.polymarket.com/events?series_id=10311&closed=false',
    events_total: summaries.length,
    events_with_moneyline: withMoneyline.length,
    events: summaries,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${tsForFilename(now)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));

  console.error(`[2/2] gravado ${outFile}`);
  console.error(`       eventos: ${snapshot.events_total} | com moneyline: ${snapshot.events_with_moneyline}`);
  console.log(JSON.stringify({ outFile, events_total: snapshot.events_total, events_with_moneyline: snapshot.events_with_moneyline }, null, 2));
}

main().catch(e => { console.error('ERRO:', e.message, e.stack); process.exitCode = 1; });
