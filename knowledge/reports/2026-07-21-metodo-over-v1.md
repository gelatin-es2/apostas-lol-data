# Método OVER kills — análise do split 2 e proposta v1

> ## ⛔ UPDATE v2 (2026-07-21, mesmo dia): REPROVADO na validação com split 1
>
> A pedido do Elvis, o backtest foi refeito com (a) régua limpa: fair calculada nossa + odd flat 1.80 (BE 55.6%), e (b) validação em dados que a regra nunca viu: split 1 (jan-mar, 696 games coletados da API, fair leave-one-out própria do split). Fonte: `scripts/analysis/over-method-v2.cjs` → `audit-output/12-over-v2.json`.
>
> | Regra (Over na fair, odd 1.80) | Split 1 | Split 2 | Pooled | Veredito |
> |---|---|---|---|---|
> | 2×Engage | 50.0% (n=204) → −10.0% | 57.6% (n=66) → +3.7% | 51.9% [CI 45.9–57.7] → −6.6% | **NEGATIVO** |
> | ≥1 engage, 0 peel | 50.3% (n=356) → −9.5% | 56.6% (n=159) → +1.9% | 52.2% [CI 47.9–56.5] → −6.0% | **NEGATIVO** |
> | Baseline (tudo) | 48.3% | 45.0% | 46.5% → −16.3% | NEGATIVO |
>
> **O sinal do split 2 NÃO replicou no split 1** — que tem amostra 3× maior (o meta de support era 50% engage no split 1 vs 23% no split 2). 57.6% em n=66 era, com alta probabilidade, sorte de amostra pequena. Nas 6 células testadas (2 regras × 3 réguas de linha), nenhuma passou.
>
> **Contraste que valida a régua:** o método UNDER passou nos DOIS splits com folga — split 1: 62.6% (n=147, CI inferior 54.5%... no rung 1.72 BE 58.1%: +7.6% ROI) · split 2: 67.5% (n=418, +16.0%) · pooled 66.2%, CI [62.2–70.0], todo acima do BE. O peel puxa kills pra baixo de forma confiável; o engage NÃO empurra pra cima acima da fair de forma confiável.
>
> **Decisão: não operar Over. As seções abaixo ficam como registro histórico da análise v1 (só split 2).**
>
> ### Follow-ups do mesmo dia (todos com fair leave-one-out + odd flat 1.80, dois splits)
> - **Por suporte individual** (`13-over-by-support.json`): de 18 testados, só Rell passa (58.6% pooled, replicada nos 2 splits, +5.5%) — mas delta controlado por time colapsa no split 1 (−0.2); Nautilus INCERTO. Under é onde os suportes pagam: Milio +29.6%, Lulu +11.5%.
> - **Pares do OVER_SET do Elvis {Rell,Naut,Pyke,Leona,Elise}** (`14-over-pairs.json`): conjunto inteiro NEGATIVO (splits se contradizem); **Rell+Nautilus juntos = único INCERTO promissor** (60.6% pooled, ambos splits acima do BE, mas n=33). Nautilus+Leona 40% (veneno). Elise sup: n=18, sem dado.
> - **Over em time VERMELHO** (`15-over-red-teams.json`): as 4 regras NEGATIVO. Terceira confirmação independente: tendência de time (delta ou under-rate, trailing) NÃO persiste — vermelho até foi MENOS Over que verde (45.0% vs 47.5%). A fair já absorve a tendência do time; flag de time não gera edge no Over.
> - **Vaga de observação split 3:** simuladas `over_rell_naut` quando ambos supports forem Rell+Naut (~5 jogos/mês), decisão após ~60 jogos acumulados.
>
> ### ⚡ SWEEP 30 LIGAS (2026-07-21, mesmo dia — `17-camille-sweep.json`): reviravolta
> - **Rell+Naut MORREU com amostra grande:** par n=98 → 51.0%; Rell n=364 → 55.5%; Naut n=683 → 54.2%; engage×engage n=622 → 52.9%. Todos ≈/abaixo do BE 55.6% @ 1.80.
> - **Camille SUPPORT é o único sinal que passa o corte rigoroso:** n=113, 67.3% Over na fair, CI95% [58.2–75.2] (inferior ACIMA do BE), ROI +21.1% @ 1.80. Fenômeno do patch de julho (72% da amostra em jul; 0 antes de abril). Controle de mês: jul com Camille 66.7% vs jul sem 46.7%. Fraco no topo (MSI 46.7%, EWC 55.6%), forte em ligas menores.
> - **Operação "janela Camille"** (não é método, é janela de patch): Over só com Camille SUP + linha ≤ fair + odd ≥ 1.80, stake teste R$500–1k, tag `over_experimental_elvis`. Reavaliar a cada patch.
> - Bets reais do experimento em 2026-07-21: −R$1.000 (TLN×IJC, sinal certo preço ruim) · +R$800 + +R$1.440 (VIT.Bee×ES, Camille+Naut, 38 kills) = **+R$1.240 no dia**.

**Data:** 2026-07-21 · **Fonte:** `scripts/analysis/split2-over-method.cjs` → `audit-output/11-over-method.json` (re-rodável, 100% do cache — zero API) · **Base:** 828 games do split 2 com os 10 picks + kills da API, fair leave-one-out por jogo.

**BE por odd (linha X.5, sem push):** 1.85 → 54.1% · 1.95 → 51.3% · 2.05 → 48.8%.

---

## Veredito

**Existe um método Over lucrativo — mas o sinal é o DRAFT, não o time.**

- Over "cru" (apostar Over em tudo): 45.0% hit, ROI negativo em qualquer odd. Não existe.
- Over quando os 2 supports são de ENGAGE (Nautilus, Rell, Leona, Pyke, Alistar, Thresh...): **57.6% hit (n=66)**, positivo nas 3 odds, e validado fora da amostra (treino abril 58.6% / teste mai-jun 56.8%, ROI@1.95 +10.7%).
- Variante com mais volume: **≥1 engage e ZERO peel no jogo** — 56.5% no teste com n=92 (2.5× mais jogos), ROI@1.95 +10.2%. Estatisticamente a mais robusta.
- **Zero canibalização:** 100% desses jogos estão fora do trigger Under (populações mutuamente exclusivas por construção).

## Regras do Método Over v1 (proposta)

1. **Trigger base:** jogo com ≥1 support de engage e NENHUM support de peel → candidato a Over na linha de abertura (fair).
2. **Trigger premium:** os DOIS supports de engage → confiança maior (57.6% vs 56.6%).
3. **Odd mínima: 1.85.** Abaixo disso o BE (54.1%) come a margem. Em 1.95+ o método respira (BE 51.3%).
4. **SEM filtro de time.** Ver seção "tese do time quente" — não passou no teste.
5. **Skip:** peel presente em qualquer lado (célula OUTRO×PEEL = 38.6% Over; MAGE×PEEL = 43.9%).
6. **Volume esperado:** ~22 jogos/mês (premium) ou ~50/mês (base) nas 6 ligas.

## A tese do "time sempre over" (BLG) — refutada

Classificando times como quentes/frios em abril e testando em maio-junho: hot 45.1% / neutro 46.4% / cold 45.6% — **idênticos ao baseline**. A tendência de kills do time NÃO persiste fora da amostra. O próprio BLG: abril 65% Over → maio 56% → junho 37.5%, regrediu à média dentro do split. Time quente é retrovisor, não previsão. (Espelho do que vimos no Under: o valor está na linha/draft, não na etiqueta do time.)

## Combinações (a pergunta do Milio+Naut)

Confirmado: **Milio+Nautilus = 50% Over (n=12)** — o engage do lado oposto anula o peel. Célula agregada PEEL×ENGAGE: 53.6% Over (n=151). "Peel presente = Under" só vale quando o outro lado NÃO é engage.

- Piores pares pra Over (= melhores Under): Lulu+Milio 24.1% (n=29), Bard+Milio 23.1%, Milio+Rakan 22.2%.
- Melhores pares (n≥10): Nautilus+Seraphine 70.6% (n=17), Bard+Nautilus 68.8% (n=16), Karma+Nautilus 63.2% (n=19).

## Bonecos Over (delta kills vs fair, com controle de time — 9/10 sobrevivem)

| Boneco (role) | Delta controlado | Nota |
|---|---|---|
| Yuumi (sup) | **+5.4** | ⚠️ ela tá na lista PEEL do Under! Ver abaixo |
| Camille (sup) | +5.1 | |
| Kalista (adc) | +2.8 | |
| Varus (adc) | +2.5 | |
| Leona (sup) | +2.4 | |
| Pyke (sup) | +2.0 | |
| Rell (sup) | +1.5 | |
| Nautilus (sup) | +0.8 | efeito fraco controlado; n=124 |
| Mel (adc) | −0.5 | ERA efeito de time, descartada |

Mais Under do split: Milio −3.2 (n=137), Aatrox top −3.8, Olaf jg −3.9, Lucian −3.1.

### ⚠️ Achado colateral pro método UNDER: Yuumi

Yuumi está no PEEL_PURE, mas os jogos dela rodaram **+5.4 kills acima da fair** (efeito sobrevive ao controle de time) e o hit Under dela nas bets foi 57.1% (n=7, abaixo do BE). Amostra pequena nas bets, mas o sinal do universo é forte e na direção errada. Sugestão: **tratar Yuumi como exceção do trigger Under** (skip ou flag de atenção) até o split 3 dar mais amostra.

## Arquétipos usados (documentados no script)

PEEL = lista canônica do método. ENGAGE = alistar, nautilus, rell, leona, pyke, thresh, blitzcrank, rakan, amumu, camille, elise, gragas, pantheon, skarner, tahmkench, taric, morgana. MAGE = lux, brand, xerath, zyra, velkoz, swain, anivia, mel, neeko, rumble. Braum testado como engage e como outro — irrelevante (n=9).

## Plano de validação (antes de dinheiro real)

1. **Split 3 = temporada simulada.** Registrar bets SIMULATED com `method_variant='over_engage_v1'` em todo jogo que disparar o trigger, na linha de abertura, com a odd Over real da casa anotada.
2. Adicionar detecção do trigger Over no briefing diário (aviso "jogo candidato a Over hoje").
3. Meta de validação: ≥40 jogos simulados com hit ≥54% e odd média real ≥1.90 → aí libera stake real pequena.
4. Atenção operacional: conferir a odd REAL do Over na abertura (a análise assume 1.85-2.05; se a casa pagar 1.75 no Over, não há método).

## Limitações honestas

- Fair usada é a nossa fórmula (leave-one-out), não a linha real de abertura da casa — o edge real depende da linha que a casa efetivamente abrir (o timing do Elvis).
- n do teste out-of-sample ainda é modesto (37 premium / 92 base).
- Grid de regras foi pré-especificado (9 combinações) pra evitar overfit, mas split 2 é uma amostra só — por isso a fase simulada é obrigatória.
