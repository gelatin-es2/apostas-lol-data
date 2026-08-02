# Revisão Semanal — 2026-08-02 (janela 27/07–01/08)

Rito de domingo (protocolo `knowledge/references/revisao-semanal-protocolo.md`), 7 ângulos rodados em paralelo por agentes Fable 5. Fontes: Supabase (50 bets reais + 3 SIMULATED na janela), `cron-data/*-results.json` (43 mapas majors; 131 válidos no universo de 11 ligas), fair manual + captura auto sombra, GitHub Actions, lolesports API, livestats, patch notes Riot.

---

## 1. Veredito

**🟡 AMARELO — o método está saudável; a operação ao redor dele é que vaza.**

Em uma frase de gente: a semana lucrou +R$7,7 mil e o método acertou quase tudo que apostou (7 de 8 mapas) — mas ficou entre R$8 mil e R$14 mil na mesa por regras ignoradas, entradas antes do draft e principalmente por **triggers do método que ninguém apostou**.

Nada vermelho em dados, infra ou patch. Os amarelos têm dono e ação proposta (seção 5).

---

## 2. Achados por ângulo

| # | Ângulo | Status | Resumo |
|---|---|---|---|
| 1 | Integridade de dados | 🟢 | 53/53 bets limpas, spot-check 4/4 vs dado cru, invariantes ok. Amarelo: 2 bets não-método marcadas como método (`37dbe25e` ML discricionária, `24e6ebb9` saída de hedge) — inflam stats |
| 2 | Performance | 🟢 | +R$7.686,58 (ROI 15,2%). Under 7/8 por mapa (acima da baseline 63–66%), Camille 6/9 = 66,7% (hist. 67,3%). Sem alerta de CI — nem 1 semana abaixo, muito menos 2 |
| 3 | ⭐ Tribunal das regras | 🟡 | Núcleo passa. 4 regras operadas contra a própria letra (ML, piso odd, pré-draft, LCP) ≈ −R$9k na semana. 3 skips antigos caem pra "em observação" por idade. Tripwire Milio NO FIO (ver 4.1) |
| 4 | Meta/patch | 🟡 estável | Patch 26.15 não toca Camille/Milio → **sem pausa**. Trigger do peel segue colapsado: 14,0% vs 49,5% split 2. Kills alto estável (+1,8 vs split 2). 26.16 em 12/08 — ler notas finais |
| 5 | Oportunidades | 🟡 | Método nas ligas novas: 12/13 triggers under-hit, mas nenhum teste fechou n decidível. LCP: recorte 10/10 green (+R$4.834) soterrado por −R$6.981 de discricionário. Prime: promover janela Camille (+R$7.760 acum.). Sylas mid 8/10 over → propor tracker |
| 6 | Higiene operacional | 🟡 | Infra verde (crons 7/7, dashboard ok, zero pending velha). Docs podres: pending.md/NEXT-SESSION.md/CLAUDE.md defasados, 6 arquivos knowledge sem commit, bug `analyze_tier2_eu` (fair fixa 29.5) no cron há >2 meses, service_role key sem evidência de rotação |
| 7 | Contrafactual | ℹ️ | Discrição da semana: **−R$8,4k a −R$14,4k**. ~80% = bets NÃO feitas (3 triggers Under +R$6.480, janela Camille +R$6.000), não bets erradas. Desvios de stake POUPARAM +R$1.847 |

---

## 3. Números da semana

- **PnL real: +R$7.686,58** — 49 settled (27G/22R), stake R$50.733,53, ROI 15,2%. Por dia: 28/07 +1.509 · 29/07 −99 · 30/07 +1.086 · 31/07 −320 · 01/08 +5.511.
- **Por classe: Under +R$6.639 · Over +R$5.647 · ML/outros −R$4.600 (2/8).** O prejuízo da semana mora inteiro fora do método.
- **Trigger rate: 6/43 mapas majors (14,0%)** vs 16% semana passada, 19,1% julho, 49,5% split 2. Universo 11 ligas: 13/131 (9,9%), com 12/13 under-hit onde disparou. O problema segue sendo volume, não hit.
- Semana anterior (20–26/07) recontada: 2peel real 5/6 — também acima da baseline. Investigação obrigatória (2 semanas < CI) **não dispara**.

## 4. Decisões que o dado da semana já sustenta

### 4.1 Tripwire Milio 4u — DISPAROU na leitura por sinal (decidir hoje)

O combinado de 31/07: 2 reds Milio em 5 bets → volta 2u. O dado:

- Único slip formal 4u: JDG×BLG M2, **green +R$3.080**.
- Mapas Under com Milio no draft desde 31/07: 4 → **2G/2R**. Reds: CFO×GAM M2 (ladder −R$4.091) e C9×DIG M1 (hedgeado, −R$20 líquido).
- **Conflito de dado resolvível:** o playbook anotou CFO×GAM M2 como "1peel+flex SEM Milio", mas o livestats mostra **Milio sup na GAM** (Lucian/Ryze/Gnar/Skarner/Milio). Contando o sinal como Milio: 2 reds em 4 mapas → **tripwire batido**.
- **Recomendação COO: voltar a 2u.** O gatilho era pré-combinado; ambiguidade de contagem se resolve pelo lado conservador. Se Elvis preferir contar por slip 4u (0 reds), formalizar o critério por escrito hoje — mas aí o tripwire vira regra de papel.

### 4.2 Regras operadas contra a própria letra (~−R$9k na semana)

1. **ML "parar até ter régua" (30/07)** — violada em <48h (girosbet 01/08 −R$500). Semana: 2/8, **−R$4.600**. Cumprir ou revogar formalmente.
2. **Pré-draft sem regra** — 3ª semana do mesmo padrão: 0/3 mapas, **−R$4.103** na semana (LES ladder −2.063, TSW M1 −1.040, SHG −1.000); ≈ **−R$7.540 em 2 semanas**. Propor: entrada só com draft confirmado (fonte própria vale, mas confirmada).
3. **Piso odd ≥1.80 da janela Camille** — 3ª semana ignorado (≥6 slips 1.68–1.77; custo −R$608 vs precificar @1.80). Reafirmar ou matar.
4. **LCP pós-revogação do recorte** — semana −R$4.587 em 15 slips. Recorte antigo (draft confirmado): **10/10 green, +R$4.834 acumulado**; discricionário: −R$6.981. Propor: re-instaurar recorte OU encerrar teste; em qualquer caso, reiniciar o checkpoint contando só bets conformes.
5. **SKIP Over LEC absoluto** — dado fecha a questão: sem Camille 0/5 (−R$6,0k) × com Camille 5/0 (+R$4,7k). Reformular pra "só janela Camille com draft confirmado".

### 4.3 Tribunal — vereditos por regra (resumo; tabela completa do agente no anexo mental do tribunal desta noite)

| Regra | Veredito |
|---|---|
| Under trigger core (2peel fair+1 @~1.72) | **MANTÉM** (6/6 triggers na semana; hit ok, volume colapsado) |
| 1peel+flex 1u | **OBSERVA** — conflito backtest 68,7% × real 54,5% n=66 segue sem dono |
| Milio 4u | **TRIPWIRE BATIDO na leitura por sinal → recomendação: volta 2u** (4.1) |
| Janela Camille Over 2u | **MANTÉM** (66,7% na semana, colada na baseline) |
| — piso odd 1.80 | **MATA ou reafirma hoje** (morta de fato) |
| — linha máx fair+1 | **MANTÉM** (violação análoga custou −R$4.091) |
| — premium 2u vs Rell/Naut/Leona | **MANTÉM** (79,4%, formalizar no 35º caso) |
| — Camille×Shen | **OBSERVA→SKIP** (6º caso contra: 0/2 −R$1.040) |
| Over geral reprovado | **MANTÉM** (semana re-confirma: 0/6 sem sinal, −R$5,1k) |
| Skip Rell/Naut no Under | **MANTÉM** (re-confirmada em 30/07) |
| Skips antigos: Yuumi peel · ≤fair−2 · teto odd 1.85 | **OBSERVA (idade)** — 4+ semanas sem re-teste |
| Cautela mapa 2 | **OBSERVA** — precedência M2×Milio sem dono |
| map5_underkill | **ARQUIVAR adormecida** até playoffs (0 casos em 2+ meses) |
| Under LEC (45% n=20) | Criar skip/observação — decisão aberta |
| Set de ligas | **MANTÉM** (LIT/LRS/NACL 0 bets ✓). Volume seco → NACL (69,4% n=49) é o próximo candidato formal |
| Teste Prime | **Promover janela Camille; Under segue teste** (acum. +R$7.760, mas só 1 settle do objeto) |
| Teste LES | **MANTÉM teste** — 0 settle do objeto; Camille LES 5/11 (2º dado fraco) |
| Teste KCL | **ENCERRAR formalmente** (n=0 de novo; as 3 bets de 28/07 na liga eram SIMULATED) |
| Trava fair 1ª msg + hierarquia | **MANTÉM** (6/6 dias ✓; captura auto segue em sombra) |
| Observação = SIMULATED only | **MANTÉM** (0 dinheiro real ✓; pyke 8/8 n<20) |

## 5. Ações propostas (executar só com aprovação)

**Decisão de método (Elvis, hoje):**
1. Tripwire Milio → volta 2u (recomendação COO) ou formalizar contagem por slip.
2. D2 pré-draft: proibir entrada sem draft confirmado.
3. D3 ML: cumprir ou revogar o "parar ML".
4. Piso 1.80 Camille: reafirmar ou matar.
5. Over LEC: reformular pra "só janela com draft confirmado".
6. LCP: re-instaurar recorte 12/13 (ou encerrar teste) + reiniciar checkpoint com bets conformes.
7. Prime: promover janela Camille a dinheiro real padrão; KCL: encerrar; map5: arquivar.

**Execução COO (após OK, uma por vez):**
8. Reclassificar `37dbe25e` e `24e6ebb9` pra `is_method_bet=false` (write pontual no banco).
9. Fix `analyze_tier2_eu.cjs` LINE=29.5 fixa (bug no cron há >2 meses).
10. Higiene docs: limpar pending.md / NEXT-SESSION.md / CLAUDE.md do projeto; commitar os 6 arquivos knowledge órfãos; push da branch `fix/settle-parsepick-last-number`.
11. **Segurança:** service_role key citada como vazada em NEXT-SESSION.md (05/05) sem evidência de rotação — rotacionar ou documentar que já foi.
12. Infra CLV: estender captura auto pra ladder map2 + snapshot entre mapas (deciders) — em ~3 semanas o relatório CLV vira rotina.
13. Watchlist: adicionar `over_sylas_mid` ao tracker SIMULATED (8/10 na semana); descartar Miss Fortune; religar `track-observation-variants.cjs` (parado desde 29/07).

**Calendário:** notas finais do patch 26.16 em 11–12/08 (penalidade de roam pode favorecer o trigger) · checkpoint LES ~11/08 · 35º caso premium formaliza a trava.

---

*Gerado pelo rito de domingo. Relatórios-fonte dos 7 agentes na sessão de 02/08; dados intermediários no scratchpad da sessão.*
