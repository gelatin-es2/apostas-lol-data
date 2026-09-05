'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = path.resolve(__dirname, '../../vercel.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Fonte única das rotas publicadas — bets (print de aposta) e finance (fatura/extrato).
// Generalizado em 2026-09-04 pra cobrir os 2 diretórios em vez de só api/bets.
const ROUTE_DIRS = {
  bets: ['register', 'upload-status', 'access'],
  finance: ['upload', 'summary', 'transactions'],
};

test('Vercel publica somente dashboard e raiz aponta para index.html', () => {
  assert.equal(config.outputDirectory, 'dashboard');
  assert.deepEqual(config.rewrites, [{ source: '/', destination: '/index.html' }]);
});

test('funcoes Vercel apontam para entrypoints .js sem runtime legado explicito', () => {
  assert.deepEqual(config.functions, { 'api/**/*.js': { maxDuration: 60 } });
  assert.equal(config.functions['api/**/*.js'].runtime, undefined);
  assert.equal('api/**/*.cjs' in config.functions, false);
});

test('rotas publicadas possuem um unico handler .js sem basename conflitante', () => {
  for (const [dir, routes] of Object.entries(ROUTE_DIRS)) {
    for (const route of routes) {
      const entryPath = path.resolve(__dirname, `../${dir}/${route}.js`);
      const conflictingPath = path.resolve(__dirname, `../${dir}/${route}.cjs`);
      assert.equal(fs.existsSync(entryPath), true, `entrypoint ausente: ${dir}/${route}.js`);
      assert.equal(fs.existsSync(conflictingPath), false, `handler conflitante: ${dir}/${route}.cjs`);
      assert.equal(typeof require(entryPath), 'function');
    }
  }
  // 2026-08-30: a trava de acesso VOLTOU por ordem do CEO. Em 13/08 (71ba801) ela
  // tinha sido removida como codigo morto — a UI de codigo ja estava escondida desde
  // 9c82028, entao a auth ficou "sem uso" e os guards abaixo diziam que nao podia
  // voltar. Agora ela esta ligada de ponta a ponta (campo de codigo no dashboard ->
  // /api/bets/access -> cookie -> register/upload-status, e agora tambem /api/finance/*),
  // entao o guard inverte: o que nao pode e a rota sumir e deixar o upload aberto de novo.
  assert.equal(fs.existsSync(path.resolve(__dirname, '../lib/bet-upload-auth.cjs')), true, 'lib de auth do bet upload ausente');
});

test('api nao possui basenames duplicados entre extensoes de funcoes, por diretorio', () => {
  const apiRoot = path.resolve(__dirname, '..');
  const functionExtensions = new Set(['.js', '.cjs', '.mjs', '.ts']);
  for (const dir of Object.keys(ROUTE_DIRS)) {
    const files = fs.readdirSync(path.join(apiRoot, dir))
      .filter((file) => functionExtensions.has(path.extname(file)));
    const basenames = new Map();
    for (const file of files) {
      const basename = path.basename(file, path.extname(file)).toLowerCase();
      assert.equal(basenames.has(basename), false, `${dir}/${file} conflita com ${basenames.get(basename)}`);
      basenames.set(basename, file);
    }
  }
});

test('total de funcoes .js em api/bets + api/finance e 6 e no maximo 12', () => {
  const apiRoot = path.resolve(__dirname, '..');
  const total = Object.keys(ROUTE_DIRS).reduce((count, dir) => {
    const files = fs.readdirSync(path.join(apiRoot, dir)).filter((file) => file.endsWith('.js'));
    return count + files.length;
  }, 0);
  assert.equal(total, 6);
  assert.ok(total <= 12);
});

test('rewrites nao expoem diretorios internos do repositorio', () => {
  const internalPaths = ['.claude', 'migrations', '.git', 'cron-data', 'knowledge'];
  for (const rewrite of config.rewrites || []) {
    const serialized = `${rewrite.source} ${rewrite.destination}`.toLowerCase();
    for (const internalPath of internalPaths) {
      assert.equal(serialized.includes(internalPath), false, `rewrite expoe ${internalPath}`);
    }
  }
});
