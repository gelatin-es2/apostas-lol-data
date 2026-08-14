'use strict';

// Testa o mapeamento canônico de `.claude/scripts/normalize-bookmakers.cjs` LENDO o
// arquivo como texto (nunca com require/import): o módulo dispara um IIFE que chama
// Supabase assim que é carregado, então requerê-lo aqui tocaria produção. Os testes
// extraem os blocos VALID_BOOKMAKERS/BOOKMAKER_ALIASES do código-fonte e, no último
// teste, os re-executam isolados via `new Function` (sem nenhuma outra linha do
// arquivo, sem rede) para validar o comportamento real de normalização.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '../../.claude/scripts/normalize-bookmakers.cjs');
const source = fs.readFileSync(scriptPath, 'utf8');

function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `marcador nao encontrado: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `fim do bloco nao encontrado apos: ${startMarker}`);
  return source.slice(start, end);
}

test('VALID_BOOKMAKERS usa whale.io (com .io) como canonico, nunca "whale" solto', () => {
  const validBlock = block('const VALID_BOOKMAKERS = [', '];');
  assert.match(validBlock, /'whale\.io'/);
  assert.doesNotMatch(validBlock, /'whale'(?!\.io)/, 'whale.io nao pode ter sido substituido de forma parcial, restando "whale" solto');
  for (const label of ['pinnacle', 'estrelabet', 'parimatch', 'betano', 'thunderpick', 'clutch', 'polymarket']) {
    assert.match(validBlock, new RegExp(`'${label}'`), `rotulo canonico ausente: ${label}`);
  }
});

test('BOOKMAKER_ALIASES converge whale/"whale io" para whale.io e nao inverte mais para whale', () => {
  const aliasBlock = block('const BOOKMAKER_ALIASES = new Map([', ']);');
  assert.match(aliasBlock, /\['whale',\s*'whale\.io'\]/);
  assert.match(aliasBlock, /\['whale io',\s*'whale\.io'\]/);
  assert.doesNotMatch(aliasBlock, /\['whale\.io',\s*'whale'\]/, 'alias antigo whale.io->whale nao pode voltar (era o bug)');
});

test('nenhum alias de whale referencia termos ou casa da Pinnacle', () => {
  const aliasBlock = block('const BOOKMAKER_ALIASES = new Map([', ']);');
  assert.doesNotMatch(aliasBlock, /accepted bet/i);
  assert.doesNotMatch(aliasBlock, /pinnacle/i);
});

test('normalizacao real (isolada, sem rede): whale/case variantes -> whale.io; pinnacle continua pinnacle', () => {
  const validSrc = `${block('const VALID_BOOKMAKERS = [', '];')}];`;
  const aliasSrc = `${block('const BOOKMAKER_ALIASES = new Map([', ']);')}]);`;
  const factory = new Function(`
    ${validSrc}
    ${aliasSrc}
    return { VALID_BOOKMAKERS, BOOKMAKER_ALIASES };
  `);
  const { VALID_BOOKMAKERS, BOOKMAKER_ALIASES } = factory();

  function canonicalOf(raw) {
    const lower = raw.toLowerCase().trim();
    return BOOKMAKER_ALIASES.get(lower) || lower;
  }

  for (const raw of ['whale', 'Whale', 'WHALE', 'whale io', 'Whale Io', 'whale.io', 'Whale.io', 'WHALE.IO']) {
    assert.equal(canonicalOf(raw), 'whale.io', `raw="${raw}" deveria normalizar para whale.io`);
  }
  for (const raw of ['pinnacle', 'Pinnacle', 'PINNACLE']) {
    assert.equal(canonicalOf(raw), 'pinnacle', `raw="${raw}" deveria permanecer pinnacle`);
  }
  for (const raw of ['thunderpick', 'Thunderpick', 'THUNDERPICK', ' thunderpick ']) {
    assert.equal(canonicalOf(raw), 'thunderpick', `raw="${raw}" deveria estabilizar em thunderpick`);
  }

  assert.ok(VALID_BOOKMAKERS.includes('whale.io'), 'whale.io precisa estar na lista canonica');
  assert.ok(!VALID_BOOKMAKERS.includes('whale'), '"whale" sozinho nao pode ser canonico');
  assert.ok(VALID_BOOKMAKERS.includes('pinnacle'));

  // set de saida bate com os rotulos do banco citados na tarefa
  for (const canonical of ['pinnacle', 'estrelabet', 'parimatch', 'betano', 'whale.io', 'polymarket', 'thunderpick', 'clutch']) {
    assert.ok(VALID_BOOKMAKERS.includes(canonical), `rotulo do banco ausente do canonico: ${canonical}`);
  }
});
