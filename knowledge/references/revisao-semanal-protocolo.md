# Protocolo — Revisão Semanal de Domingo

**Origem:** decisão Elvis 2026-07-23, após o contrafactual das flags provar que a regra verde×verde operou ~3 meses sem re-teste e custou −R$22k (`knowledge/reports/2026-07-23-contrafactual-flags.md`). Lição-mãe: **regra sem data de re-validação vira vazamento silencioso de dinheiro.**

**Quando:** todo domingo, primeira mensagem do dia — SEM o Elvis pedir (hook `weekly-review-check.cjs` injeta o lembrete até o relatório existir).
**Modelo:** agentes Fable 5 (`model: 'fable'` nos subagents) — análise pesada merece o modelo top.
**Output:** relatório `knowledge/reports/YYYY-MM-DD-revisao-semanal.md` + resumo no chat com veredito. Salvar o arquivo desarma o lembrete.

## Os 7 ângulos (rodar TODOS, em paralelo via agentes quando possível)

1. **Integridade de dados** — re-rodar fases da auditoria (`scripts/audit/`) na semana: kills/status/profit vs API, pendings órfãs, campos obrigatórios, duplicatas. Amostra da semana + spot-check gol.gg.
2. **Performance vs esperado** — hit da semana (Under e janela Over) vs o CI histórico. Abaixo do intervalo = alerta amarelo; 2 semanas seguidas = investigação obrigatória.
3. **⭐ TRIBUNAL DAS REGRAS (o ângulo anti-verde×verde)** — enumerar TODA regra ativa do playbook (skips, boosts, tiers de stake, janelas) e, pra cada uma, perguntar friamente: *qual é a evidência atual? out-of-sample? qual o n novo da semana? ela ainda passa?* Regra sem evidência re-confirmada em 4 semanas = rebaixar pra "em observação" e avisar o Elvis. NENHUMA regra é vitalícia.
4. **Meta/patch watch** — taxa de trigger peel, kills médio por liga, champions novos emergindo (a próxima Camille), patch notes da Riot (nerf em pick da janela = pausa imediata).
5. **Oportunidades** — ligas de expansão (performance ao vivo das novas), sinais da watchlist (Pyke, MF, Aurora, Sylas, Yasuo-se-voltar), mercados não explorados.
6. **Higiene operacional** — cron do GitHub verde? repo sincronizado? dashboard atualizado? bets sem registro (cruzar extrato mental do Elvis)? bugs pendentes do CLAUDE.md.
7. **Contrafactual da semana** — o que o Elvis fez vs o que o playbook puro teria feito (disciplina de linha/odd/stake). Sem julgamento — só o número do custo/ganho da discrição.

## Formato do relatório

1. **Veredito em 1 linha** (verde: nada errado / amarelo: atenção em X / vermelho: parar e corrigir Y).
2. Tabela de achados por ângulo com severidade.
3. Tribunal das regras: tabela regra × evidência × veredito (mantém/observa/mata).
4. Ações propostas (só executar com aprovação, como sempre).

## Regras do processo

- Achado que contradiz o playbook → NUNCA esperar o Elvis perguntar. Vai no topo do relatório.
- Amostra pequena → dizer "sem dado ainda", não inventar tendência.
- Se a semana não teve jogos (pausa), rodar mesmo assim os ângulos 1, 3, 6 (dados e regras não tiram férias).
