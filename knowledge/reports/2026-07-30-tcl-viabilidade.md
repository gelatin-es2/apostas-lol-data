# TCL — Viabilidade: Under = **SKIP** · Over Camille = **SKIP** (horário encaixa de verdade, mas a estatística reprova — e a liga está em Play-Ins com ~2 jogos/semana)

**Data:** 2026-07-30 · **Fonte:** `scripts/analysis/tcl-viability.cjs` → `audit-output/37-tcl-viability.json` (TCL leagueId `98767991343597634`, slug `turkiye-sampiyonluk-ligi`, região EMEA; histórico 2026 completo 2026-01-19 → 2026-07-29, 144 mapas válidos, fair leave-one-out dentro da liga, critérios idênticos ao relatório de expansão `2026-07-21-expansao-ligas-meta-julho.md`). Reuso: `00-universe-allregions.json` (86 mapas abr–jun já coletados), `18-multi-league-mining.json` (TCL já minerada em 21/07), `19-under-stress-line.json`, `29-polymarket-volume-2026.json`. `27-shen-under.json` não cobre TCL (só ligas operadas).

**Motivação do CEO:** "já é no mesmo horário de outras ligas que eu faço". Validado na seção 5 — o encaixe é REAL. Mas encaixe de horário é critério de conveniência, não de entrada: a estatística e o calendário é que decidem, e os dois dizem não.

---

## Vereditos

| Método | Veredito | Motivo em 1 linha |
|---|---|---|
| **Under (trigger peel)** | **SKIP** | Reprova o critério de entrada pela 2ª medição consecutiva (CI inferior 45.7 < 50) e o núcleo 2peel é NEGATIVO na liga (−2.8% ROI) |
| **Over janela Camille** | **SKIP** | Camille não existe no meta TCL: 1 mapa no ano inteiro (29/07) — e errou o over |
| Reavaliação | Quando o próximo split regular abrir calendário na API | re-rodar `node scripts/analysis/tcl-viability.cjs --fresh` (idempotente) |

Se o problema a resolver é volume de Under, a fila do set 26/07 já tem dona: **NACL é a reserva nº 1** (69.4%, CI [55.5–80.5], Polymarket US$129k/evento). A TCL não fura essa fila — está estatisticamente abaixo até da CBLOL (63.4%), a mais fraca das originais.

---

## 1. Perfil da liga — média de bloco EU, mas o MAIOR desvio de todo o benchmark

| Universo | n | Média | Mediana | Desvio | >27.5 | >30.5 |
|---|---|---|---|---|---|---|
| **TCL 2026 completo** | 144 | 31.0 | 29 | **11.7** | 54.9% | 44.4% |
| TCL jan–mar (winter) | 56 | 29.8 | 29 | 9.8 | 55.4% | 39.3% |
| TCL abr–jul | 88 | 31.7 | 29 | **12.7** | 54.5% | 47.7% |
| Prime League abr–jul | 153 | 34.4 | 34 | 10.4 | 71.9% | 60.8% |
| LES abr–jul | 90 | 31.0 | 29 | 9.5 | 57.8% | 46.7% |
| LFL abr–jul | 79 | 31.6 | 30 | 8.8 | 65.8% | 45.6% |

Kills médios no nível de LES/LFL, mas desvio 11.7–12.7 — pior que a LCP (9.4), que já era a recordista de caudas gordas. Na prática: mapa de 17 kills e mapa de 46 kills na mesma semana. Liga imprevisível mapa a mapa.

## 2. Calibração da fair fórmula — a pior do bloco (e aqui não tem Pinnacle pra salvar)

| Liga | n | Mediana \|kills−fair\| | Média \|kills−fair\| | Fallback |
|---|---|---|---|---|
| **TCL full 2026** | 144 | **7.5** | **9.0** | 1% |
| Prime League | 153 | 6.5 | 8.1 | 0% |
| LES | 90 | 6.5 | 7.1 | 0% |
| LFL | 79 | 6.5 | 7.3 | 0% |

Referência: majors ficam em 4.5–5.5 de mediana; LCP/LES em 5.5. A TCL erra a fair em 7.5 kills no mapa mediano — consequência direta do desvio 11.7. **Limitação estrutural:** TCL é EMEA/tier-2 = fair só por fórmula (sem Pinnacle histórica, hierarquia vigente). Ou seja, o método operaria na liga onde a régua é a menos confiável de todas as analisadas.

## 3. Under — reprova o critério de entrada (de novo)

Full 2026, mapas com trigger (n=41):

| Linha | Hit | CI95% | ROI realista | BE |
|---|---|---|---|---|
| fair+1 @1.72 | 61.0% (25/41) | **[45.7–74.3]** | +4.9% | 58.1% |
| fair @1.83 | 61.0% | [45.7–74.3] | +11.6% | 54.6% |
| fair @1.72 travada (piso stress) | 61.0% | — | +4.9% | 58.1% |
| fair−1 @1.95 | 58.5% | [43.4–72.2] | +14.1% | 51.3% |

| Critério | Regra | TCL | Resultado |
|---|---|---|---|
| Candidata (mining) | hit fair+1 ≥ 58.1%, n ≥ 25, CI inferior ≥ 50 | 61.0%, n=41, CI low **45.7** | ❌ **reprova** (4.3pp abaixo) |
| Piso stress | ROI > 0 na fair @1.72 travada | +4.9% | ✅ passa |
| Escada real | ROI > 0 na fair @1.83 e fair−1 @1.95 | +11.6% / +14.1% | ✅ passa |

É a 2ª medição que diz o mesmo: no mining de 21/07 a TCL já reprovava (63.2%, CI low 47.3, n=38, abr–jun). Somar o winter split (3 triggers) e julho não salvou — piorou pra 61.0 / 45.7. Benchmark: as 5 aprovadas na expansão ficaram entre 68.5 e 80.5; a LCP entrou como teste com 64.3 e CI low 51.2 **passando** os 3 critérios. A TCL passa 2 de 3 e falha justamente o principal.

### Por tipo de trigger — o padrão global está INVERTIDO na TCL

| Tipo | n | Hit fair+1 | CI95% | ROI @1.72 |
|---|---|---|---|---|
| **2peel** | 23 | **56.5%** | [36.8–74.4] | **−2.8%** |
| 1peel+flex | 18 | 66.7% | [43.7–83.7] | +14.7% |
| Milio no jogo | 11 | 81.8% (9/11) | [52.3–94.9] | +40.7% |

Nas ligas operadas o edge mora no 2peel e o 1peel+flex foi rebaixado. Na TCL é o contrário — e o núcleo do método (2peel) fica ABAIXO do breakeven. Célula 1peel+flex tem n=18 (<25, não sustenta nada sozinha). Milio confirma o boost global, mas 11 mapas é o mínimo aceitável de célula — não justifica um recorte tipo LCP numa liga que reprovou o critério geral E não tem liquidez confirmada.

### Frequência do trigger (volume que existiria)

| Período | Mapas | Trigger rate |
|---|---|---|
| Winter (jan–mar) | 56 | 0–6%/mês (3 triggers no split todo) |
| Abr–jun | 84 | 41–47%/mês (13–23 triggers/mês) |
| **Julho (Play-Ins)** | 4 | **0%** (0/4) |

O trigger praticamente não existia no winter, explodiu em abr–mai e zerou no patch atual (mesma seca das majors, 16% em julho). Sem leitura do meta atual — 4 mapas é anedota.

## 4. Over janela Camille — não tem janela porque não tem Camille

- **Camille sup na TCL 2026: 1 mapa em 144** (0 de jan a jun; 1 em 29/07, Team Phoenix no Play-Ins) — e foi red: 24 kills contra fair 31.5.
- Compare: na LCP a janela entrou porque a Camille CHEGOU no meta local (5 mapas e crescendo); na LES, 7 mapas só em julho. Na TCL não chegou. A janela é do champion, e o champion não é jogado lá.
- Se um dia aparecer draft TCL com Camille sup, a regra global tecnicamente cobre — mas com fair mal calibrada (seção 2) e sem linha confirmada nas casas, não há operação a fazer. n=1 = zero base.

## 5. Encaixe de horário — o CEO está CERTO, mas isso não muda o veredito

- **Inícios TCL 2026 (58 matches):** 11:30 BRT ×24 · 12:00 ×11 · 14:30 ×23 — **100% entre 11:30 e 14:30 BRT**, ter–sex. No bloco estrito 12–18h dá 58.6% só porque 41% dos jogos começam às 11:30 (meia hora antes do meio-dia).
- Bloco da tarde que ele já opera: Prime 99% no bloco (12–16h qua–qui) · LES 97% (12:00/15:00 qua–qui) · LFL 100% (13–17h qua–sex). **Sobreposição total** — TCL seria mais jogos no MESMO fluxo de atenção, não horário novo. O claim "é no mesmo horário" está confirmado.
- **Mas o calendário atual mata o argumento:** o split regular de verão acabou no início de junho. Desde 27/07 roda o **Play-Ins** — ~2 matches BO3/semana (qua–qui), chaves TBD até 13/08, com times de promoção (Shark Attack, Avella SU, Bushido Wildcats...). Volume real disponível: 4–7 mapas/semana de um recorte que não representa a liga. O split regular seguinte não tem calendário na API.
- Volume histórico do split regular, quando ativo: 4–6 matches/semana (~10–14 mapas) — parecido com LES/LFL.

## 6. Liquidez — Polymarket lista, casas ninguém confirmou (precedente KCL)

| Liga | Eventos 2026 | Volume total | Por evento |
|---|---|---|---|
| LES | 57 | US$8.8M | US$154k |
| Prime | 153 | US$15.3M | US$100k |
| **TCL** | **56** | **US$5.5M** | **US$98k** |
| LFL | 153 | US$15.0M | US$98k |

Polymarket lista TCL no mesmo nível de LFL/Prime — a liga não é deserto de mercado. Mas Polymarket é moneyline, não linha de kills. **Zero bets reais do CEO na TCL; linha de kills em Pinnacle/Thunderpick nunca foi vista na tela.** O precedente que manda aqui é a KCL: passou nos critérios estatísticos, a linha até existia — e morreu em 27/07 por mercado degenerado (Over travado em 1.40 fixo). Esse é o risco nº 1 de qualquer liga pequena, e na TCL nem chegamos a esse teste porque a estatística reprovou antes. Se um dia a TCL voltar aprovada, a 1ª missão seria a mesma da KCL: confirmar na tela que a linha de kills existe e que as odds não são degeneradas.

## 7. O que NÃO dá pra afirmar

1. **Nada sobre o meta/patch atual na TCL** — 4 mapas de Play-Ins em julho, 0 triggers. A reprovação vem do histórico; o presente é incógnita (mas incógnita não aprova liga).
2. **Quando e como volta o split regular** — a API só mostra Play-Ins até 13/08; formato e data do próximo split são desconhecidos.
3. **Que existe linha de kills da TCL nas casas** — Polymarket lista a liga (moneyline), mas linha de kills só a tela do CEO confirma. Nunca houve bet real lá.
4. **Milio 9/11 e 1peel+flex 66.7% (n=18)** — células pequenas demais pra sustentar recorte tipo LCP; ficam registradas pra re-olhar SE a liga voltar a ser candidata.
5. **ROI nas odds reais** — régua usa 1.72/1.83/1.95; odd real média do CEO é ~1.75–1.82 (3pp a menos de margem que o backtest).
6. **Fair fórmula vs linha real de casa na TCL** — nunca comparadas (não existe fair Pinnacle histórica da liga); a calibração ruim da seção 2 é contra a realidade dos kills, não contra a linha de mercado.
7. Detalhe de coleta: "Shark Attack" (time novo do Play-Ins) não está no cache do getTeams — 3 mapas de julho exibem o id cru no lugar do nome. Zero efeito nos números (julho não tem trigger nem entra em célula nenhuma).
8. Reconciliação com o mining 21/07: lá abr–jun dava 63.2% (24/38), aqui 60.5% (23/38) — 1 win de diferença porque a fair LOO agora inclui o winter split no histórico dos times. Direção idêntica nas duas medições: reprova.

## Próximos passos

1. **Nada a operar.** TCL fora do set; não entra nem como teste 1u (o critério de entrada existe exatamente pra isso — regime de stake vigente é 1u tudo / 2u Milio-Camille, sem stake por liga; teste se controla por checkpoint de settles, e aqui não há o que settlar).
2. Quando o próximo split regular da TCL aparecer na API: re-rodar `node scripts/analysis/tcl-viability.cjs --fresh` e reavaliar com o meta novo (especialmente se Camille chegar no meta de lá e se o 2peel local normalizar).
3. Se a semana seguir seca de volume Under no set atual: a conversa é NACL (reserva nº 1), não TCL.
