# LCP — Viabilidade: Under = TESTE COM STAKE REDUZIDA (50%) · Over Camille = OPERAR (janela global)

**Data:** 2026-07-25 · **Fonte:** `scripts/analysis/lcp-viability.cjs` → `audit-output/28-lcp-viability.json` (LCP leagueId `113476371197627891`, região PACIFIC, histórico 2026 completo: 2026-01-15 → 2026-07-25, 199 mapas válidos, fair leave-one-out dentro da liga, critérios idênticos ao relatório de expansão `2026-07-21-expansao-ligas-meta-julho.md`).

**Contexto do dia:** split 3 da LCP (bloco "Swiss") começou HOJE. Os 2 matches de hoje já estão na base — o map 2 TSW×SHG fechou 37 kills com Camille sup (TSW) vs Shen (SHG), batendo exatamente o green real do CEO (ladder Over 27.5/30.5). Liquidez Pinnacle confirmada na prática.

---

## Vereditos

| Método | Veredito | Stake |
|---|---|---|
| **Under (trigger peel)** | **TESTE COM STAKE REDUZIDA** — só **2peel** | **500 base / 1k com Milio** (50% dos tiers normais 1k/2k) |
| **Under 1peel+flex** | **SKIP na LCP** (55.6% < BE 58.1%, ROI −4.4%) | — |
| **Over janela Camille** | **OPERAR** como parte da janela global (regras inalteradas: linha ≤ fair, fair+1 aceitável, odd ≥ 1.80) | 500–1k flat da janela; premium 2k vs Rell/Naut segue regra global |

Upgrade do Under pra stake cheia: ~15 settles na LCP com hit ≥ BE, ou 2 semanas de operação — mesmo protocolo das 5 ligas da expansão.

---

## 1. Perfil da liga — sangrenta nível LCK, não outlier

| Universo | n | Média | Mediana | Desvio | >27.5 | >30.5 |
|---|---|---|---|---|---|---|
| **LCP 2026 completo** | 199 | 29.2 | 28 | **9.4** | 53.8% | 41.7% |
| LCP abr–jul (janela comparável) | 101 | 29.1 | 28 | 9.3 | 55.4% | 44.6% |
| LCK abr–jul | 218 | 29.2 | 29 | 8.1 | 56.9% | 40.4% |
| LPL abr–jul | 227 | 28.0 | 27 | 8.1 | 47.6% | 33.5% |
| LEC abr–jul | 118 | 27.6 | 26.5 | 8.7 | 44.9% | 34.7% |
| CBLOL abr–jul | 92 | 27.1 | 26 | 6.9 | 42.4% | 27.2% |

A fama de "liga sangrenta" é meio-verdade: média igual à LCK (topo das majors), mas **desvio maior (9.4 vs 8.1)** — mais mapas extremos pros dois lados. Não é uma LJL da vida (36.8 avg); é LCK com caudas mais gordas.

## 2. Calibração da fair fórmula — no padrão das majors, com caudas

| Liga | n | Mediana \|kills−fair\| | Média \|kills−fair\| | Fallback |
|---|---|---|---|---|
| **LCP full 2026** | 199 | 5.5 | **7.0** | 0% |
| LCK | 218 | 5.5 | 6.2 | 0% |
| LPL | 227 | 4.5 | 5.9 | 0% |
| LEC | 118 | 5.5 | 6.9 | 0% |
| CBLOL | 92 | 4.5 | 5.8 | 0% |

Só 8 times na liga → todo time tem histórico farto, zero fallback. Mediana de erro igual LCK/LEC; média é a pior do grupo (caudas do desvio 9.4). Fair fórmula utilizável — e na prática o CEO vai operar com **linha Pinnacle real** (hoje: Pinnacle 27.5/30.5 vs fair fórmula 28.5 — próximas).

## 3. Under — passa os 3 critérios da expansão, mas raspando

Full 2026, mapas com trigger (n=56):

| Linha | Hit | CI95% | ROI realista | BE |
|---|---|---|---|---|
| fair+1 @1.72 | **64.3%** | **[51.2–75.5]** | **+10.6%** | 58.1% |
| fair @1.83 | 58.9% | [45.9–70.8] | +7.8% | 54.6% |
| fair @1.72 travada (piso stress) | 58.9% | — | **+1.4%** | 58.1% |
| fair−1 @1.95 | 55.4% | [42.4–67.7] | +7.9% | 51.3% |

**Critérios do relatório de expansão (mesma régua das 5 aprovadas):**

| Critério | Regra | LCP | Resultado |
|---|---|---|---|
| Candidata (mining) | hit fair+1 ≥ 58.1%, n ≥ 25, CI inferior ≥ 50% | 64.3%, n=56, CI low **51.2** | ✅ passa (margem de 1.2pp) |
| Piso stress | ROI > 0 na fair com odd travada 1.72 | **+1.4%** | ✅ passa (raspando) |
| Escada real | ROI > 0 na fair @1.83 e fair−1 @1.95 | +7.8% / +7.9% | ✅ passa |

**Por que teste e não operação cheia:** (a) no recorte abr–jul isolado (mesmo do mining 21/07) a LCP REPROVAVA — CI inferior 47.0 < 50; o pass vem de somar o split 1 (68.8%, n=16). O sinal existe nos dois períodos (62.5% e 68.8% — consistente, não é artefato de período), mas a aprovação é marginal. (b) hit 64.3% fica **abaixo de todas as 5 ligas aprovadas** (Prime 68.5 · LCKC 69.0 · NACL 69.4 · LRS 77.4 · EMEA 80.5) — entre CBLOL (63.4) e LCS (65.2) do benchmark. (c) zero dado do meta split 3 (começou hoje). Em compensação, a LCP tem o que nenhuma das 5 tinha garantido: **linha Pinnacle real** (a LRS morreu exatamente por falta de mercado).

### Por tipo de trigger — o edge é todo do 2peel

| Tipo | n | Hit fair+1 | CI95% | ROI @1.72 |
|---|---|---|---|---|
| **2peel** | 29 | **72.4%** | [54.3–85.3] | **+24.6%** |
| 1peel+flex | 27 | 55.6% | [37.3–72.4] | **−4.4%** |
| Milio no jogo | 13 | 92.3% (12/13) | [66.7–98.6] | +58.8% |

Mesmo padrão global (playbook split 3 já rebaixou 1peel+flex). Na LCP: **1peel+flex = skip total durante o teste** (nem com sinal extra — não tem base local que o sustente). Milio confirma o boost global, mas n=13 → 1k no teste, não 2k.

### Frequência do trigger (volume esperado)

| Período | Mapas | Trigger rate |
|---|---|---|
| Split 1 (jan–fev) | 98 | 11–22%/mês |
| Split 2 (abr–jun) | 97 | **36–47%/mês** (~17 triggers/mês) |
| Split 3 (jul, Swiss) | 4 | 0/4 — sem leitura |

Alerta: nas majors o patch de julho cortou o trigger pra 17%. Se replicar na LCP com ~16–18 mapas/semana no Swiss → **expectativa realista de 3–6 triggers/semana**.

## 4. Over janela Camille

- **LCP local: n=5 (3 em maio, 2 hoje), 5/5 over hit na fair** — CI [56.6–100], ROI +80% @1.80. **n<10 = não é base de dados.** Zero sinal contrário.
- A janela é do CHAMPION, não da liga — baseline global 67.3% (n=113, CI [58.2–75.2], BE 55.6%) é o que sustenta a operação.
- **Camille está no meta atual da LCP:** 0% dos mapas até abril, 6.4% em maio, **2 de 4 mapas hoje** (dia 1 do split 3). Nas majors, julho concentrou 81 dos 113 mapas da janela.
- Perfil de kills nível LCK + desvio alto não contradiz a janela; o green real de hoje (37 kills vs fair 28.5) é o 5º hit local.

Operar LCP dentro da janela global com as regras vigentes do playbook (linha ≤ fair ideal, fair+1 aceitável, fair+2 nunca; odd ≥ 1.80; 500–1k flat; 2k só vs Rell/Naut por decisão do CEO 22/07 — sem dado local sobre esse recorte). Contar os settles LCP separado pra trava de revisão.

## 5. Encaixe operacional — colide com a manhã de LPL

- **Split 3 (Swiss): 2 matches/dia — 09:00 UTC = 06:00 BRT e 11:30 UTC = 08:30 BRT.** Agenda: 25, 26, 30, 31/07, 01, 02, 06/08... (~qui–dom, 8 matches/semana, BO3 ≈ 16–18 mapas/semana).
- Histórico 2026 de horário de início (BRT): 03:00×22 · 05:00×14 · 06:00×23 · 08:00×15. **70% dos matches começam na faixa 05–10h BRT — a mesma janela da LPL (92%)**. É acúmulo de trabalho na manhã, não liga de horário novo.
- 8 times: SHG, TSW, PSG… (CFO, GAM, DFM, MVK, GZ, DCG completam). Round-robin pequeno — os matchups repetem rápido, stats por time estabilizam rápido no split.

## 6. O que NÃO dá pra afirmar

1. **Nada sobre o meta split 3 na LCP** — 4 mapas (hoje). O alerta de trigger-rate caindo à metade nas majors pode ou não replicar; primeiro checkpoint com ~2 semanas de Swiss.
2. **Over Camille LCP-específico** — n=5 é anedota; a operação se apoia 100% na janela global.
3. **Que a fair fórmula replica a linha Pinnacle da LCP** — não existe fair Pinnacle histórica da liga; toda a análise usa fair calculada (LOO). Comparação real: 1 dia (28.5 fórmula vs 27.5/30.5 Pinnacle). O CEO opera com a linha real, então o backtest é aproximação.
4. **ROI nas odds reais das casas** — usei as odds de referência do método (1.72/1.83/1.95/1.80); odd real média do CEO historicamente é ~1.75 (3pp a menos de margem).
5. **Milio 2k premium na LCP** — 12/13 simulado, 0 bets reais; segue 1k no teste.
6. **Formato Swiss** — playoffs/Swiss podem mudar drafts (times jogam pra sobreviver); o histórico 2026 é round-robin + playoffs, não Swiss.

## Próximos passos

1. Adicionar LCP (`113476371197627891`) ao `LEAGUE_IDS` de `lolesports-find-match.cjs` + briefing/cron (pré-requisito pro settle automático das bets LCP — a de hoje precisou de linkagem manual).
2. Fair Pinnacle da LCP entra na trava diária normal (Pinnacle abre linha → plano A da hierarquia).
3. Checkpoint em ~2 semanas ou 15 settles: trigger rate do Swiss + hit real → decide stake cheia, mantém teste ou corta.
