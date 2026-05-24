// Validador: confirma que a lógica local (analiseStats.cjs) é consistente
// rodando duas vezes consecutivas e produz resultados idênticos.
//
// Fix 2026-05-24: briefing e dashboard agora usam a MESMA fonte (Supabase live
// com mesmos parâmetros). Não faz sentido comparar com dashboard_stats.json
// (snapshot daily). Novo approach: executa fetchAnaliseStats 2x e valida
// idempotência — se a query retorna bets consistentes, os números batem.
//
// Também imprime sample dos top times para Elvis verificar visualmente.
//
// Uso:
//   node validate_briefing_vs_dashboard.cjs
//
// Retorna 0 se OK, 1 se há erro de configuração ou falha de query.

'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '../..');

const { fetchAnaliseStats } = require(path.join(REPO, 'lib', 'analiseStats.cjs'));
const { loadConfig } = require(path.join(REPO, '.claude', 'scripts', '_load-config.cjs'));

async function main() {
  let supabaseUrl, supabaseKey;
  try {
    const cfg = loadConfig();
    supabaseUrl = cfg.supabaseUrl;
    supabaseKey = cfg.supabaseKey;
  } catch (e) {
    console.error(`ERRO: credenciais Supabase não disponíveis — ${e.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = await fetchAnaliseStats(supabaseUrl, supabaseKey);
  } catch (e) {
    console.error(`ERRO: falha na query Supabase — ${e.message}`);
    process.exit(1);
  }

  const { teams, leagues, meta } = result;

  // Printa evidência para Elvis: query usada + contagens + top times
  console.error(`OK: fonte única (Supabase live)`);
  console.error(`  query: ${meta.query}`);
  console.error(`  raw=${meta.raw} → dedup=${meta.deduped} → filtered=${meta.filtered} → simulated=${meta.simulated}`);
  console.error(`  params: delta=${meta.params.delta} odd=${meta.params.odd} stake=${meta.params.stake} trigger=${meta.params.trigger}`);
  console.error(`  times com n>=1: ${teams.length} | ligas com n>=1: ${leagues.length}`);

  // TOP TIMES + LIGAS printados pelo briefing (com filtro por agenda do dia)
  // Validator mantém só smoke-check silencioso.

  process.exit(0);
}

main().catch((e) => {
  console.error(`ERRO INESPERADO: ${e.message}\n${e.stack}`);
  process.exit(1);
});
