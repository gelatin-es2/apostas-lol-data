# Dashboard — diagnóstico de UX + plano de reforma

**Data:** 2026-07-30
**Alvo:** `dashboard/index.html` (2.680 linhas, 124 KB, arquivo único) → https://apostas-lol-dashboard.vercel.app/
**Queixa do CEO:** "muito ruim de visualizar, muito número, preciso de mais organização e clareza"

---

## 1. Diagnóstico — por que parece uma parede de números

### 1.1 Zero gráficos. Literalmente.

`grep -c "canvas|<svg|chart"` → **0 ocorrências**. Todo dado do site é texto dentro de um card. Um dashboard de apostas sem **curva de banca** é o equivalente a operar sem extrato — não dá pra ver se está em drawdown, em recuperação ou em máxima histórica. É a falha #1.

### 1.2 Um único componente visual carrega 8 conceitos diferentes

A classe `.day` (card cinza, label à esquerda, número à direita) é reusada para:

| Uso | Onde |
|-----|------|
| Por mês | Planilha, Under, Over Kill |
| Por dia | Planilha, Under, Over Kill |
| Lucro por suporte | Planilha |
| Lucro por liga | Planilha |
| Lucro por time | Planilha |
| Hit por trigger / liga / time / sup / boneco / mapa | Banco de dados, Milio, Split 1 |

Consequência: **nada tem hierarquia**. O lucro do mês tem exatamente o mesmo peso visual que o hit rate de um campeão com n=1. O olho não tem onde pousar.

### 1.3 Rankings sem limite e sem mínimo de amostra

`renderByTeam()` (linha 1565) ordena e imprime **todos** os times — sem `.slice()`, sem filtro de n mínimo. Volume real hoje, do `dashboard_stats.json`:

| Dimensão | Entradas |
|----------|----------|
| Times | **68** |
| Campeões | **56** |
| Ligas | 7 |
| Suportes | 7 |

Só a aba **Banco de dados** renderiza ~130 cards de ranking em sequência vertical. A aba **Planilha** soma "por dia" (dezenas) + "por time" (68) + liga + suporte. Rolagem estimada: 3.000–5.000 px por aba.

Pior: sem `n` mínimo, um time com 1 aposta e 100% hit aparece **acima** de um time com 30 apostas e 68% hit. O ranking mente.

### 1.4 Seis abas, três estruturas repetidas

- `Planilha` / `Método Under` / `Over Kill` → estrutura **idêntica** (KPIs → mês → dia → lista de apostas). São três recortes do mesmo dado, não três telas.
- `Banco de dados` / `Método Milio` / `Split 1` → estrutura **idêntica** (controles Δ/odd/stake → 5-6 grids "hit por X").

O CEO precisa lembrar em qual aba está para saber o que os números significam. Não há título de contexto persistente.

### 1.5 Real e simulado se parecem demais

Card "Lucro total: +R$ 16.705" (dinheiro real) e card "Profit teórico: +R$ 24.300" (backtest) usam **o mesmo componente, mesma cor, mesma tipografia**. Isso já foi origem de bug recorrente no projeto (invariante hit-simulado vs PnL-real). Visualmente, é uma armadilha.

### 1.6 Cards sobrecarregados

Exemplo real do card "Hit rate", linha 1191-1193 — **cinco números num card só**:

> **62,3%**
> 45W / 28L mapas · 58,9% por bet · 73 bets/73 mapas

Ninguém lê isso de relance. O card deveria ter 1 número herói + no máximo 1 linha de contexto.

### 1.7 Ergonomia

- **Filtros não são sticky.** Rola 3.000 px e não lembra mais que o filtro é "Split 3 + só 2peel + LCK".
- **Estado não vai pra URL.** Não dá pra salvar/compartilhar uma visão filtrada; F5 reseta tudo.
- **Filtros duplicados por aba** (`trkPeriod`, `underPeriod`, `overPeriod`, `anPeriod`) — trocar o período exige repetir em cada aba.
- **`maximum-scale=1` no viewport** (linha 5) — bloqueia zoom no celular. Ruim de acessibilidade e ruim pra quem quer ampliar um número.
- **Mobile:** grids `auto-fit minmax(220px)` viram 1 coluna → os 68 cards de time viram 68 telas de scroll.

### 1.8 Código como bloqueio

- 1 arquivo, 2.680 linhas, HTML + CSS + JS juntos.
- **72 atributos `style=` inline** — os blocos de filtro são o mesmo CSS copiado 5 vezes.
- **3 funções `aggBy()` e 3 `renderList()`** com assinaturas diferentes (linhas 2304, 2466, 2626).

Isso não é observação de pureza técnica: **toda mudança visual precisa ser feita de 3 a 6 vezes**, o que é exatamente por que o visual nunca evoluiu.

---

## 2. O que o dashboard deveria responder (e hoje não responde)

Ao abrir o site, as perguntas reais são:

1. **Como estou?** → banca acumulada, ROI, drawdown atual
2. **Tem aposta pendente?** → hoje enterrado no meio da lista
3. **O método está funcionando ou é variância?** → hit vs breakeven ao longo do tempo
4. **Onde ganho e onde perco dinheiro?** → só os extremos, não os 68 times
5. **O que evitar hoje?** → stack/avoid já existe no Milio, mas escondido na 5ª aba

Hoje o site responde a #4 (mal, sem filtro de amostra) e ignora #1, #2, #3, #5.

---

## 3. Plano — 3 fases

### FASE 1 — Impacto máximo, risco baixo (1 sessão)

**1.1 Nova aba inicial "Hoje"** — vira a landing, no lugar de Planilha
- 4 KPIs grandes: Banca acumulada · Lucro do split · ROI · Hit vs BE
- **Curva de banca acumulada** (line chart SVG) — o gráfico que falta
- Bloco "Pendentes" no topo, só aparece se houver
- 3 alertas automáticos: drawdown > X, streak de reds, liga fora do critério

**1.2 Top-N nos rankings + mínimo de amostra**
- Times: **top 8 + bottom 5**, com `n ≥ 5`; botão "ver todos os 68" expande
- Campeões: `n ≥ 6` (já existe esse critério no Split 1, só não é aplicado nas outras abas)
- "Por dia": vira gráfico de barras; os cards individuais ficam no expandir

**1.3 Filtros sticky**
- Barra de filtro gruda no topo ao rolar, mostrando o recorte ativo em texto ("Split 3 · 2peel · LCK")

**1.4 Selo de simulação**
- Todo bloco de dado teórico ganha fundo/borda distintos + selo `SIMULAÇÃO — não é dinheiro real`
- Cor de dinheiro real reservada exclusivamente pra PnL real

**Ganho esperado:** o CEO abre o site e em 3 segundos sabe onde está, sem rolar.

---

### FASE 2 — Gráficos e consolidação de abas (1-2 sessões)

**2.1 Gráficos no lugar dos grids de card**

| Pergunta | Hoje | Vira |
|----------|------|------|
| Evolução da banca | não existe | linha acumulada |
| Lucro por mês/dia | 30+ cards | barras (verde/vermelho) |
| Ranking liga/time/sup | 68 cards | barras horizontais top-N |
| Hit vs breakeven | número solto | barra com linha de referência no BE |
| Sensibilidade Δ | trocar o select 9x | mini-gráfico dos 9 Δ de uma vez |

Implementação: **SVG inline, sem biblioteca externa**. O site é HTML estático sem build step; adicionar Chart.js via CDN acrescenta ~200 KB e uma dependência de rede. Um helper próprio de ~150 linhas cobre linha + barra + barra horizontal, com controle total de cor e tema.

**2.2 Consolidar 6 abas → 3**

| Nova aba | Absorve | Como |
|----------|---------|------|
| **Hoje** | (nova) | landing |
| **Resultado** | Planilha + Método Under + Over Kill | vira filtro *"escopo: tudo / método / over kill"*, não aba |
| **Laboratório** | Banco de dados + Milio + Split 1 | sub-abas internas; controles Δ/odd/stake compartilhados |

**2.3 Cards limpos**
- 1 número herói + 1 linha de contexto. Máximo.
- Detalhe completo vai pra tooltip no hover.

---

### FASE 3 — Base técnica e mobile (1 sessão)

**3.1 Quebrar o arquivo** (sem build step, só ES modules — já usa `type="module"`)
```
dashboard/
  index.html      → só markup
  css/styles.css  → tokens + componentes (mata os 72 inline styles)
  js/data.js      → fetch Supabase + raw.github
  js/charts.js    → helpers SVG
  js/render.js    → componentes de UI
  js/app.js       → estado + roteamento de aba
```
Unificar as 3 `aggBy()` e as 3 `renderList()` em uma de cada.

**3.2 Estado na URL** — `?tab=resultado&period=split3&trigger=2peel&league=LCK`. Salvável, compartilhável, sobrevive a F5.

**3.3 Mobile**
- Remover `maximum-scale=1` (destrava o zoom)
- KPIs em 2×2 em vez de 1 coluna
- Rankings viram tabela compacta com scroll horizontal próprio
- Gráficos responsivos por `viewBox`

**Risco de deploy:** nulo em fase 1-2 (só HTML/CSS/JS de front). Fase 3 mexe em caminhos de arquivo — validar que o Vercel com `Root Directory = dashboard/` serve os subdiretórios (serve, mas confirmar em preview antes do merge). URLs de dados continuam absolutas `raw.githubusercontent.com` — **nunca relativas**, conforme lição de 2026-05-07.

---

## 4. Métricas que faltam (candidatas à Fase 1/2)

| Métrica | Por que importa |
|---------|-----------------|
| **Curva de banca** | única forma de ver drawdown vs máxima histórica |
| **Drawdown máximo + atual** | separa "método quebrou" de "variância normal" |
| **Streak atual** | contexto emocional na hora de decidir stake |
| **ROI por unidade de stake** | 1u vs 2u (Milio/Camille) — hoje não dá pra isolar |
| **Volume por dia vs média** | detecta dia de sobre-operação |
| **Hit por faixa de Δ real** | quanto de margem a fair está entregando de fato |

---

## 5. Ordem de execução recomendada

1. **Fase 1** completa → deploy → CEO usa 2-3 dias → feedback
2. Ajustar com base no uso real antes de partir pra Fase 2
3. Fase 3 por último — é enabler, não é visível pro usuário

Não fazer as três de uma vez. Fase 1 sozinha já resolve ~70% da queixa ("muito número, sem organização").
