# Melhorias pro Split 3 — análise completa do Split 2

**Data:** 2026-07-20 · **Fonte:** `scripts/analysis/split2-improve.cjs` → `audit-output/10-improve.json` (re-rodável) · **Base:** 464 mapas simulados (odd 1.72, stake 1000, dedup por mapa) + 333 bets reais + universo de 861 games da API (auditado em `knowledge/audits/2026-07-20-auditoria-split2.md`).

**Baseline split 2:** 60.8% hit / +4.5% ROI global. Tendência: abril 63.8% → maio 58.7% → junho 51.9% (junho = amostra pequena).

---

## Recomendações rankeadas

| # | Recomendação | Evidência | Confiança |
|---|---|---|---|
| 1 | **Cap de odd: não entrar Under com odd >1.85** | Bets reais odd >1.85: 40% hit, **-17.5% ROI** (n=40). Todos os buckets ≤1.85 positivos (+10.5 a +13.8%) | Alta — PnL real, gap enorme vs BE |
| 2 | **Skip Bard vs Karma (e manter Bard vs Lulu)** | Bard vs Karma: 44% hit, **-24.3% ROI** (n=25). Bard vs Lulu: 50%, -14% (n=18). Bard geral: 58.1% (breakeven) | Alta — estende regra existente com amostra nova |
| 3 | **Cautela em MAPA 2: exigir edge extra ou stake reduzida** | Map1 65.1%/+12% (n=212) vs Map2 55.9%/-3.8% (n=186). Kills médios quase iguais (28.2 vs 28.8) → problema é a linha do mapa 2, não o jogo | Alta — n grande dos dois lados |
| 4 | **Manter boost Milio; tratar Milio+Lulu como par premium** | Milio: 69.2%/+19% (n=120). Lulu+Milio: 71.4%/+22.9% (n=28). Melhor PEEL de amostra relevante | Alta |
| 5 | **Rebaixar Lulu e Karma como peels "fracos"** (sem Milio/Seraphine junto, pedir edge extra) | Lulu 56.4%/-3% (n=149), Karma 56.3%/-3.1% (n=103) — abaixo do BE 58.1%. Lulu+Nami: 52%/-10.6% (n=50). Seraphine 61.8%/+6.3% (n=157) | Média-alta — consistente em vários cortes |
| 6 | **LEC em observação/stake mínima no início do split 3** | LEC: 53.8%/-7.4% no split (n=65); maio foi 37.5%/-35.5% (n=24). CBLOL (+14.7%) e LFL (+13%) seguem premium | Média — liga pode mudar com patch/roster |
| 7 | **⚠️ SUSPENDER o filtro "verde×verde = stack premium" até re-validar** | Out-of-sample: verde×verde 53.7%/**-7.7%** (n=82) vs resto 62.3%/+7.2% (n=382). Ver seção "Conflito com playbook" | Média — tem confusor, mas derruba a confiança na regra atual |
| 8 | **Automatizar simuladas (cron) — 36 jogos com trigger ficaram sem bet** | 24/36 teriam sido green (66.7%), ~R$5.280 de ROI simulado na mesa. `insert-missed-bets.cjs` roda manual hoje | Alta — fix operacional simples |

## Conflito com playbook atual (importante)

**As regras "ambos ≥60% = premium" e "vermelho freia stack" NÃO se sustentaram no teste out-of-sample do split 2:**
- verde×verde: 53.7% / -7.7% (n=82) — pior combo relevante.
- verde×vermelho: 64.6% / +11.1% (n=65); vermelho presente (62%) ≥ sem vermelho (60.4%).

**Duas explicações possíveis, ambas plausíveis:**
1. **A análise original tinha leakage** — classificava o time como verde usando o split inteiro (incluindo os próprios jogos avaliados). O teste novo só usa histórico ANTERIOR à data do jogo, que é o que você realmente sabe na hora de apostar.
2. **Confusor de calendário** — no out-of-sample, abril é quase todo "neutro×neutro" (ainda sem amostra) e abril foi o melhor mês; verde×verde só existe de maio em diante, que foi pior. Parte da diferença pode ser época, não o filtro.

**Conclusão honesta:** nem "verde×verde é premium" nem "verde×verde é ruim" está provado. O que está claro é que a base estatística da regra atual era mais fraca do que parecia. Sugestão: no split 3, verde×verde entra com stake NORMAL (não premium 4k), e a gente re-testa com dados novos + flags do split 2 fechado (essas sim, sem leakage pro split 3).

## Sinais que se confirmaram

- **Remoção do Alistar (2026-05-29): correta.** Testado no universo inteiro (n=15 games, não só as 2 bets): 40% hit / -31.2% ROI.
- **Calibração de stake do CEO é boa:** stake ≤300 (baixa convicção) foi o único tier negativo (-6.4%); tier 701-1500 o melhor (+15.7%).
- **Discrição do CEO agrega:** nas 184 maps com bet real, real bateu a simulação padrão em +2.2pp hit / +3.0pp ROI.
- **Sem drift global de kills** — a queda abril→maio não é "meta matando o Under"; é liga-específica (LEC maio 29.9 avg kills vs 26.8 abril).

## R&D (não-urgente)

- **Fair line é fraca nos dois modos:** erro médio |fair−kills| = 6.5 (fórmula) vs 6.8 (Pinnacle manual), n=34. A fórmula não perde pro Pinnacle, mas nenhuma das duas é precisa. Melhorar o modelo de linha (features: side, patch, head-to-head, tempo de jogo) é o maior upside estrutural do método.
- Sensibilidade: a fair+1 hit sobe pra 67.5% global — mas com odd proporcionalmente pior no mercado real; serve só pra mostrar que a margem da linha importa mais que o filtro de time.

## Melhorias operacionais (da auditoria de hoje)

1. Aplicar lotes A (kills/status/profit — corrige -R$1.790 na banca declarada) e C antes do split 3. **Aguardando aprovação.**
2. `insert-missed-bets.cjs` pro cron diário + alerta no briefing de jogo com trigger sem bet (mata os 36 missed).
3. Consertar `save_report_to_db.cjs` (method_reports 65% incompleta) e tirar Alistar do `_archive/scripts/analyze_range.cjs` (results.json com trigger falso).
4. Rodar a auditoria (`scripts/audit/`) no fim de cada split — infra pronta, custa minutos com cache.

## Monitorar no início do split 3

- Primeiras 2 rodadas: flags de time do split 2 valem pouco (roster/patch novos) — stake conservadora (já combinado pro dia 21/07).
- LEC e LPL: confirmar se a fraqueza persiste antes de operar volume.
- Verde×verde: coletar amostra limpa com flags fechadas do split 2.
