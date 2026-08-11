// Data operacional CANÔNICA do projeto — America/Sao_Paulo (Fase 3B, runbook 2026-08-11).
//
// "Dia operacional" = o dia do Elvis (BRT), não o dia UTC. Antes cada script fazia
// o próprio corte manual (new Date(now - 3h), toISOString().slice(0,10), offset fixo -3)
// — isso quebra se o Brasil voltar a ter horário de verão e divergia entre scripts.
// Aqui usamos Intl.DateTimeFormat com timeZone (IANA tzdata do Node), nunca offset fixo.
//
// Consumidores: fair-guard.cjs, settle-pending-bets.cjs, supabase-save-bet.cjs,
// daily_briefing.cjs, weekly-review-check.cjs, hooks (check-fair-logged com fallback inline).
//
// NÃO confundir com a convenção de BUCKETING dos arquivos fair (promote_fair_pinnacle_auto.cjs
// agrupa jogos por data UTC do startTime — decisão deliberada, casada com
// loadFairPinnacle(bet_datetime.slice(0,10))). Este módulo responde "que dia é HOJE
// pro Elvis", não "em que bucket cai este jogo".

'use strict';

const OPERATIONAL_TZ = 'America/Sao_Paulo';

// en-CA => formato YYYY-MM-DD direto do Intl (Node >= 14 com full-icu; Node 24 ok).
const ymdFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const hmFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: OPERATIONAL_TZ,
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function assertValidDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new TypeError(`operational-date: esperado Date válido, veio ${Object.prototype.toString.call(d)}`);
  }
}

/**
 * Data operacional (YYYY-MM-DD) em America/Sao_Paulo.
 * @param {Date} [d] - instante; default agora.
 */
function operationalDateYmd(d = new Date()) {
  assertValidDate(d);
  return ymdFmt.format(d);
}

/**
 * Hora local (HH:MM) em America/Sao_Paulo — pra display.
 * @param {Date} [d]
 */
function operationalTimeHm(d = new Date()) {
  assertValidDate(d);
  return hmFmt.format(d);
}

/**
 * Dia da semana do dia operacional (0=domingo ... 6=sábado).
 * Calculado a partir do YMD operacional (meio-dia UTC evita qualquer borda de fuso).
 * @param {Date} [d]
 */
function operationalDayOfWeek(d = new Date()) {
  const ymd = operationalDateYmd(d);
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

module.exports = { OPERATIONAL_TZ, operationalDateYmd, operationalTimeHm, operationalDayOfWeek };
