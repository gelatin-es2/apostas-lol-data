// Helper: carrega credenciais do .claude/settings.local.json
// Uso: const { supabaseUrl, supabaseKey } = require('./_load-config');

const fs = require('fs');
const path = require('path');

function loadConfig() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const settingsPath = path.join(repoRoot, '.claude', 'settings.local.json');

  if (!fs.existsSync(settingsPath)) {
    throw new Error(`settings.local.json não encontrado em ${settingsPath}. Crie o arquivo com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.`);
  }

  const raw = fs.readFileSync(settingsPath, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new Error(`settings.local.json inválido: ${e.message}`); }

  const env = cfg.env || {};
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('settings.local.json precisa ter env.SUPABASE_URL e env.SUPABASE_SERVICE_ROLE_KEY');
  }

  return { supabaseUrl, supabaseKey, repoRoot };
}

module.exports = { loadConfig };
