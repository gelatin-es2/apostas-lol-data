// Helper: carrega credenciais (Supabase) do projeto.
// Ordem de prioridade: .env (raiz do repo) > .claude/settings.local.json > variáveis de ambiente do processo.
// Uso: const { supabaseUrl, supabaseKey } = require('./_load-config').loadConfig();

const fs = require('fs');
const path = require('path');

function parseDotEnv(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadConfig() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const envPath = path.join(repoRoot, '.env');
  const settingsPath = path.join(repoRoot, '.claude', 'settings.local.json');

  let supabaseUrl = process.env.SUPABASE_URL;
  // Aceita ambos os nomes (workflow GH Actions usa SUPABASE_SECRET_KEY; local e .env tipicamente SUPABASE_SERVICE_ROLE_KEY)
  let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  let source = 'process.env';

  if ((!supabaseUrl || !supabaseKey) && fs.existsSync(envPath)) {
    const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
    supabaseUrl = supabaseUrl || env.SUPABASE_URL;
    supabaseKey = supabaseKey || env.SUPABASE_SERVICE_ROLE_KEY;
    source = '.env';
  }

  if ((!supabaseUrl || !supabaseKey) && fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) { throw new Error(`settings.local.json inválido: ${e.message}`); }
    const env = cfg.env || {};
    supabaseUrl = supabaseUrl || env.SUPABASE_URL;
    supabaseKey = supabaseKey || env.SUPABASE_SERVICE_ROLE_KEY;
    source = source === '.env' ? '.env+settings.local.json' : 'settings.local.json';
  }

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      `Credenciais não encontradas. Crie ${envPath} com:\n` +
      `  SUPABASE_URL=https://...\n` +
      `  SUPABASE_SERVICE_ROLE_KEY=eyJ...\n` +
      `(ou exporte como variáveis de ambiente)`
    );
  }

  return { supabaseUrl, supabaseKey, repoRoot, source };
}

module.exports = { loadConfig };
