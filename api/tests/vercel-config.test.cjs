'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = path.resolve(__dirname, '../../vercel.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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
  for (const route of ['access', 'register', 'upload-status']) {
    const entryPath = path.resolve(__dirname, `../bets/${route}.js`);
    const conflictingPath = path.resolve(__dirname, `../bets/${route}.cjs`);
    assert.equal(fs.existsSync(entryPath), true, `entrypoint ausente: ${route}.js`);
    assert.equal(fs.existsSync(conflictingPath), false, `handler conflitante: ${route}.cjs`);
    assert.equal(typeof require(entryPath), 'function');
  }
});

test('api nao possui basenames duplicados entre extensoes de funcoes', () => {
  const apiRoot = path.resolve(__dirname, '..');
  const functionExtensions = new Set(['.js', '.cjs', '.mjs', '.ts']);
  const files = fs.readdirSync(path.join(apiRoot, 'bets'))
    .filter((file) => functionExtensions.has(path.extname(file)));
  const basenames = new Map();

  for (const file of files) {
    const basename = path.basename(file, path.extname(file)).toLowerCase();
    assert.equal(basenames.has(basename), false, `${file} conflita com ${basenames.get(basename)}`);
    basenames.set(basename, file);
  }
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
