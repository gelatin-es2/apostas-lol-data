'use strict';

// Lista FECHADA de categorias das finanças pessoais. Fonte única: este arquivo e
// dashboard/finance-categories.mjs têm conteúdo idêntico (teste de paridade em
// api/tests/finance-categories.test.mjs). A migration repete os slugs no check da
// coluna `category` na MESMA ordem — mudar aqui exige migration nova.
// Ordem = ordem de exibição no <select> do dashboard.
const FINANCE_CATEGORIES = Object.freeze([
  { slug: 'alimentacao', label: 'Alimentação' },
  { slug: 'mercado', label: 'Mercado' },
  { slug: 'transporte', label: 'Transporte' },
  { slug: 'moradia', label: 'Moradia' },
  { slug: 'contas', label: 'Contas (luz/água/internet/celular)' },
  { slug: 'saude', label: 'Saúde' },
  { slug: 'lazer', label: 'Lazer' },
  { slug: 'assinaturas', label: 'Assinaturas' },
  { slug: 'compras', label: 'Compras' },
  { slug: 'educacao', label: 'Educação' },
  { slug: 'apostas', label: 'Apostas' },
  { slug: 'cripto', label: 'Cripto' },
  { slug: 'transferencia', label: 'Transferência' },
  { slug: 'pagamento_fatura', label: 'Pagamento de fatura' },
  { slug: 'renda', label: 'Renda' },
  { slug: 'investimento', label: 'Investimento' },
  { slug: 'taxas_juros', label: 'Taxas e juros' },
  { slug: 'outros', label: 'Outros' },
]);

const FINANCE_CATEGORY_SLUGS = Object.freeze(FINANCE_CATEGORIES.map((category) => category.slug));

// Categorias que entram com ignore_in_totals = true por regra: o pagamento da fatura
// já está detalhado linha a linha no cartão — contar o débito na conta dobraria a saída.
const AUTO_IGNORE_CATEGORIES = Object.freeze(['pagamento_fatura']);

function isFinanceCategory(slug) {
  return typeof slug === 'string' && FINANCE_CATEGORY_SLUGS.includes(slug);
}

function financeCategoryLabel(slug) {
  const found = FINANCE_CATEGORIES.find((category) => category.slug === slug);
  return found ? found.label : String(slug ?? '');
}

module.exports = {
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_SLUGS,
  AUTO_IGNORE_CATEGORIES,
  isFinanceCategory,
  financeCategoryLabel,
};
