#!/usr/bin/env node
// Hook UserPromptSubmit — lembrete da REVISÃO SEMANAL de domingo.
// Decisão Elvis 2026-07-23 (pós-contrafactual das flags): todo domingo, na primeira
// mensagem do dia, o agente roda uma revisão geral multi-ângulo do sistema/método
// SEM ser pedido, e entrega relatório. Este hook só INJETA O LEMBRETE quando:
//   (a) hoje é domingo (BRT), e
//   (b) o relatório da semana ainda não existe em knowledge/reports/.
// Rápido, sem rede, nunca bloqueia. Protocolo completo:
//   knowledge/references/revisao-semanal-protocolo.md
const fs = require('fs');
const path = require('path');

try {
  const REPO = path.resolve(__dirname, '..', '..');
  // data em BRT (UTC-3); override pra teste: WEEKLY_REVIEW_TEST_DATE=YYYY-MM-DD
  const test = process.env.WEEKLY_REVIEW_TEST_DATE;
  const nowBrt = test ? new Date(test + 'T12:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
  const isSunday = nowBrt.getUTCDay() === 0;
  if (!isSunday) process.exit(0);

  const ymd = nowBrt.toISOString().slice(0, 10);
  const reportPath = path.join(REPO, 'knowledge', 'reports', `${ymd}-revisao-semanal.md`);
  if (fs.existsSync(reportPath)) process.exit(0);

  console.log(`[revisao-semanal] HOJE É DOMINGO (${ymd}) e a revisão semanal ainda não foi feita.
  Obrigatório ANTES de qualquer outra tarefa (decisão Elvis 2026-07-23):
    1. Rodar a revisão geral multi-ângulo do sistema de apostas (protocolo:
       knowledge/references/revisao-semanal-protocolo.md) usando agentes Fable 5.
    2. Entregar o relatório completo ao Elvis no chat (achados + veredito).
    3. Salvar em knowledge/reports/${ymd}-revisao-semanal.md (isso desarma este lembrete).
  Contexto: esta rotina existe porque a regra verde×verde operou 3 meses sem re-teste
  e custou -R$22k. Toda regra ativa deve ser re-validada com o dado da semana.`);
} catch (e) {
  // hook defensivo: nunca quebra o fluxo
  process.exit(0);
}
