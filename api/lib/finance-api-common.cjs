'use strict';

// Helpers HTTP compartilhados pelas 3 rotas de /api/finance/*. Nao duplicam nada de
// api/bets/register.js — so o que e especifico do dominio de financas (mes, paginacao,
// busca livre).

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseJsonBody(req) {
  const body = req?.body;
  if (body === undefined || body === null || body === '') return {};
  return typeof body === 'string' ? JSON.parse(body) : body;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isMonth(value) {
  return typeof value === 'string' && MONTH_RE.test(value);
}

function currentMonthSaoPaulo(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
}

// Janela de N meses (default 6), ascendente, terminando em `month`. Usa UTC pra somar
// mes sem depender de timezone local do processo — o mes em si ja e um rotulo (YYYY-MM),
// nao um instante no tempo.
function monthsWindow(month, count = 6) {
  if (!isMonth(month)) throw new Error('month invalido');
  const [year, mon] = month.split('-').map(Number);
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(year, mon - 1 - i, 1));
    months.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// Busca livre da lista de transacoes: mantem so letra/numero/espaco/ponto/hifen. Remove
// curinga do ilike (*), virgula e parenteses (quebrariam a sintaxe or=(...) do PostgREST)
// e o coringa de LIKE (%, _). Colapsa espacos e limita a 60 chars.
function sanitizeSearch(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// Parser generico de inteiro com faixa. `fallback` volta quando o parametro nao veio
// (undefined/null/''); retorna null quando veio mas e invalido — quem chama decide o 400.
function parseIntInRange(raw, { min, max, fallback = null } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  if (min !== undefined && value < min) return null;
  if (max !== undefined && value > max) return null;
  return value;
}

module.exports = {
  send,
  parseJsonBody,
  isUuid,
  isMonth,
  currentMonthSaoPaulo,
  monthsWindow,
  sanitizeSearch,
  parseIntInRange,
};
