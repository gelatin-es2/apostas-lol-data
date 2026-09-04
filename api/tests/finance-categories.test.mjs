import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../../dashboard/finance-categories.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../lib/finance-categories.cjs');

test('categorias: .cjs (API/worker) e .mjs (dashboard) são idênticos', () => {
  assert.deepEqual(cjs.FINANCE_CATEGORIES, esm.FINANCE_CATEGORIES);
  assert.deepEqual(cjs.FINANCE_CATEGORY_SLUGS, esm.FINANCE_CATEGORY_SLUGS);
  assert.deepEqual(cjs.AUTO_IGNORE_CATEGORIES, esm.AUTO_IGNORE_CATEGORIES);
  for (const slug of cjs.FINANCE_CATEGORY_SLUGS) {
    assert.equal(cjs.financeCategoryLabel(slug), esm.financeCategoryLabel(slug));
    assert.equal(cjs.isFinanceCategory(slug), true);
    assert.equal(esm.isFinanceCategory(slug), true);
  }
});

test('categorias: 18 slugs únicos, labels não vazios, pagamento_fatura auto-ignorada', () => {
  assert.equal(cjs.FINANCE_CATEGORIES.length, 18);
  assert.equal(new Set(cjs.FINANCE_CATEGORY_SLUGS).size, 18);
  for (const { slug, label } of cjs.FINANCE_CATEGORIES) {
    assert.match(slug, /^[a-z_]+$/, `slug fora do padrão: ${slug}`);
    assert.ok(typeof label === 'string' && label.trim().length > 0, `label vazio em ${slug}`);
  }
  assert.deepEqual(cjs.AUTO_IGNORE_CATEGORIES, ['pagamento_fatura']);
  for (const slug of cjs.AUTO_IGNORE_CATEGORIES) assert.equal(cjs.isFinanceCategory(slug), true);
  assert.equal(cjs.FINANCE_CATEGORY_SLUGS[0], 'alimentacao');
  assert.equal(cjs.FINANCE_CATEGORY_SLUGS.at(-1), 'outros');
  assert.ok(cjs.FINANCE_CATEGORY_SLUGS.includes('apostas'));
});

test('categorias: valores fora da lista são rejeitados e o label cai no slug', () => {
  for (const bad of ['', 'Alimentacao', 'ALIMENTACAO', null, undefined, 42, 'jogos']) {
    assert.equal(cjs.isFinanceCategory(bad), false);
    assert.equal(esm.isFinanceCategory(bad), false);
  }
  assert.equal(cjs.financeCategoryLabel('jogos'), 'jogos');
  assert.equal(cjs.financeCategoryLabel(undefined), '');
  assert.ok(Object.isFrozen(cjs.FINANCE_CATEGORIES));
  assert.ok(Object.isFrozen(esm.FINANCE_CATEGORY_SLUGS));
});
