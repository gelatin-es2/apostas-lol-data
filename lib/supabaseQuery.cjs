// Helper: executa query REST no Supabase sem depender do SDK @supabase/supabase-js.
// Usa https nativo — mesma abordagem de rebuild_dashboard_stats_cron.cjs.
//
// Uso:
//   const { supabaseGet } = require('./supabaseQuery.cjs');
//   const rows = await supabaseGet(url, key, '/rest/v1/bets?select=*&...');

'use strict';

const https = require('https');

/**
 * Faz GET autenticado na API REST do Supabase.
 * @param {string} supabaseUrl  — ex: 'https://xxx.supabase.co'
 * @param {string} supabaseKey  — service_role key
 * @param {string} endpoint     — ex: '/rest/v1/bets?select=*&limit=2000'
 * @returns {Promise<any[]>}    — array de linhas parsed
 */
function supabaseGet(supabaseUrl, supabaseKey, endpoint) {
  return new Promise((resolve, reject) => {
    const u = new URL(supabaseUrl + endpoint);
    https.get(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        headers: {
          apikey: supabaseKey,
          Authorization: 'Bearer ' + supabaseKey,
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Supabase HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Supabase parse error: ${e.message}`));
          }
        });
      }
    ).on('error', reject);
  });
}

module.exports = { supabaseGet };
