# Lição: briefing escondeu sinal vermelho do NRF — custou R$2.000

**Data:** 2026-05-23
**Custo:** R$2.000 reais (2 bets RED em NRF vs HLE map 1, Under 30.5)
**Commit do fix:** `4493c98`

## Quando aparece

- CEO confia em flag amarela do briefing diário e entra com stake normal
- Time aparenta "marginal" (🟡 hit 50-60%) com amostra pequena (n=4-7)
- Realidade: time tem PnL real fortemente negativo OU tem hit ruim em outro bucket do método (1peel+flex) que o briefing nem considera

## Causa raiz

`buildTeamHitMap` no `daily_briefing.cjs` lia SÓ `dashboard.by_trigger['2peel'].teams`. Três defeitos compostos:

1. **Só um bucket do backtest** — ignorava `1peel+flex.teams`. NRF tinha n=7 hit 28.6% nesse bucket (vermelho) ignorado.
2. **Sem PnL real** — Tracker mostrava NRF -R$7.400 em 16 bets reais. Briefing nem consultava o Supabase pra cruzar.
3. **n_min muito baixo (4)** — bastava n=5 com hit ≥50% pra virar amarelo "marginal", quando 5-6 jogos é estatisticamente inválido pra decisão de R$1k+.

Resultado: NRF saiu como `🟡 marginal 50% n=6` quando o agregado real era `🔴 38.5% n=13 + PnL -R$7.400`.

## Fix

`apostas-lol-data/.claude/scripts/daily_briefing.cjs` (commit `4493c98`):

1. `buildTeamHitMap` agora agrega `2peel + 1peel+flex` ponderando por n (reconstitui contagem absoluta de hits)
2. `buildTeamRealPnLMap` (nova) consulta Supabase pra agregar PnL real por time
3. `flagTeam` prioriza PnL real:
   - profit ≤ -R$2k → `🔴🔴 PERDA REAL` sempre, override de qualquer hit
   - profit ≤ -R$500 e n_real ≥ 3 → `🔴 PnL real -R$X`
4. n_min subido pra 8 — amostra <8 vira `null` (sem flag)
5. `lookupTeam` faz match tolerante (strips spaces) — resolve mismatch "NONGSHIM RED FORCE" vs "Nongshim RedForce"

## Como evitar

**Princípio geral:** quando criar/manter scripts de decisão (briefing, alertas, dashboards), SEMPRE:
- Agregar TODOS os buckets/categorias do método, não só o "principal"
- Cruzar com PnL real do Tracker quando disponível
- Usar n_min ≥ 8 pra flags não-vermelhas; <8 é "sem opinião"
- Flag de PERDA REAL precisa override qualquer hit teórico positivo

**Princípio específico:** se método tem múltiplos triggers (2peel, 1peel+flex), agregação por time ou liga precisa somar os dois. Mexer em UM trigger sem revisar o briefing/dashboard é receita pra regressão silenciosa.

## Referência

- Commit fix: `4493c98 fix(briefing): aggregate triggers + cross-check real PnL when flagging teams`
- Mensagem CEO original: "tipo tem algo errado voce nao ta pegando que nongshim e vermelho nao amarelo tipo e muito ruim"
- Screenshot do Tracker mostrando -R$7.400 31.3% n=16 (CEO mandou no chat 2026-05-23)
- Auditoria precedente que adicionou Lux+Anivia como flex (commit `883e92d`) — foi o que expandiu 1peel+flex e tornou o bucket mais relevante, agravando o blind spot do briefing
