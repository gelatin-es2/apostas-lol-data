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

test('funções mantêm api/** sem runtime legado explícito', () => {
  assert.deepEqual(config.functions, { 'api/**/*.cjs': { maxDuration: 60 } });
  assert.equal(config.functions['api/**/*.cjs'].runtime, undefined);
});

test('rewrites não expõem diretórios internos do repositório', () => {
  const internalPaths = ['.claude', 'migrations', '.git', 'cron-data', 'knowledge'];
  for (const rewrite of config.rewrites || []) {
    const serialized = `${rewrite.source} ${rewrite.destination}`.toLowerCase();
    for (const internalPath of internalPaths) {
      assert.equal(serialized.includes(internalPath), false, `rewrite expõe ${internalPath}`);
    }
  }
});
