#!/usr/bin/env node
'use strict';

// Watchdog da captura Pinnacle: lê o heartbeat (capture_runs) e falha (exit 1)
// se a última execução foi há mais de 75min — o baseline roda a cada 30min 24/7,
// então >75min = 2+ slots perdidos = coleta parada.
// O workflow trata exit 1: redispara o baseline e termina em failure de propósito
// (workflow failure → e-mail automático do GitHub = alerta grátis).
//
// Lê capture_runs e NÃO odds_timeline de propósito: mercado parado gera zero rows
// na timeline com a coleta perfeitamente viva — heartbeat é a única fonte confiável.

const { loadConfig } = require('./_load-config.cjs');

const STALE_MINUTES = 75;

async function main() {
  const cfg = loadConfig();
  const url = cfg.supabaseUrl.replace(/\/$/, '');

  const res = await fetch(`${url}/rest/v1/capture_runs?select=ran_at,source,mode&order=ran_at.desc&limit=1`, {
    headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` },
  });
  if (!res.ok) {
    console.error(`[watchdog] Supabase respondeu HTTP ${res.status} — tratando como falha.`);
    process.exit(1);
  }
  const rows = await res.json();
  if (!rows.length) {
    console.error('[watchdog] capture_runs vazia — captura nunca rodou ou tabela recém-criada.');
    process.exit(1);
  }

  const last = rows[0];
  const ageMin = Math.round((Date.now() - new Date(last.ran_at).getTime()) / 60000);
  console.log(`[watchdog] última execução: ${last.ran_at} (${last.source}/${last.mode}) — há ${ageMin}min`);

  if (ageMin > STALE_MINUTES) {
    console.error(`[watchdog] STALE: ${ageMin}min > ${STALE_MINUTES}min — captura parada.`);
    process.exit(1);
  }
  console.log('[watchdog] OK.');
}

main().catch((err) => {
  console.error('[watchdog] erro:', err.message || err);
  process.exit(1);
});
