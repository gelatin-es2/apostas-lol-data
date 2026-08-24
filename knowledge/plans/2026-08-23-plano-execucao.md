# Plano de execução — 2026-08-23

Origem: mineração de 4 eixos + investigação de defasagem de fair + investigação BR×internacional
(7 relatórios, todos em `knowledge/reports/2026-08-23-*`). Aprovação do Elvis: "pode executar"
(23/08). **Fase 2 NÃO está aprovada** — são regras de aposta, decisão dele item a item.

## Princípio que rege tudo aqui

Nada que já está em produção é desligado. O novo roda **em paralelo** e só substitui o antigo
depois de 1-2 semanas de comparação lado a lado com evidência. Escrita em banco só com backup
e em lote pequeno, validando entre etapas.

---

## FASE 1 — fair fresca (aprovada, em execução)

Problema medido: a fair que a operação usa tem **mediana de 30min e média de 117min de idade**
no apito (p90 6,5h, máx 18,5h). Duas causas somadas:
- cache Cloudflare de 905s no `guest.api.arcadia.pinnacle.com` (~20% do atraso)
- grade cega de 30min do `LolFairAutoCapture` (~80% do atraso)

### 1.1 Coletor no endpoint BR sem cache
- Endpoint: `https://sports2.pinnacle.bet.br/sports-service/sv/odds/events` (público, deslogado,
  HTTP 200, `cf-cache-status: DYNAMIC`, sem `Age`, sem `max-age`).
- Grava com `source='br-sports2'` na `odds_timeline` — **não sobrescreve** as linhas do coletor atual.
- Mesmo proxy SOCKS5 do `.env`, mesmo backoff, PARA em 403.
- ~8× mais barato: 1 request no lugar de 8-15.
- **Não promove nada.** Só coleta em paralelo.

### 1.2 Captura ancorada no apito
- Hoje: grade fixa de 30 em 30 min, cega ao calendário.
- Alvo: disparo extra ~30min e ~10min antes do início de cada jogo do dia.
- Sem aumentar volume total de requisição de forma relevante; sem acelerar; backoff mantido.
- A task atual (`LolFairAutoCapture`) **continua ligada** — o disparo novo é adicional.

### 1.3 Fix do parser em série ao vivo
- Bug: em série ao vivo o `.com` publica **3 sub-matchups de kills conflitantes ao mesmo tempo**;
  `parseRelatedMarkets` escolhe por ordem de chegada. Existe tiebreak por `version` para
  moneyline e spread, **não para `total`**.
- Contamina o eixo underkill livebet.
- Fix: aplicar o mesmo critério de desempate por `version` ao `total`.

### 1.4 Comparação (daqui a 1-2 semanas)
- Comparar fair `br-sports2` × fair `.com` × linha real do slip.
- Só promover a nova fonte se ela ganhar com evidência. Decisão final é do Elvis.

---

## FASE 2 — regras de aposta (NÃO APROVADA — decisão do Elvis, item a item)

| # | Regra proposta | Número que sustenta | Status |
|---|---|---|---|
| 2.1 | Mapa 2: usar fair da série **+0,8** (ou fair por mapa, que o dado novo permite) | +R$3.807 de perda evitada; corta 78% do volume do slot | aguarda |
| 2.2 | Conferir odd na Thunderpick quando a linha for igual; ≥0,05 melhor → migra | R$2.659 já perdidos; teto +R$13.745 | aguarda |
| 2.3 | VETO: under ao vivo fora do trigger | 31,4% hit, ROI −40,1% (n=35) | aguarda |
| 2.4 | BANDEIRA: under de m2 depois de m1 estourado (≥ fair+8) | 35,3% hit (n=34); −R$2.704 real | aguarda |
| 2.5 | Matar a variante map5 BO5 | n=18, 44,4%, −R$3.247; ~1 mapa a cada 90 | aguarda |
| 2.6 | Parar de decidir degrau de ladder (é ruído) | +1 linha = −R$81, sinal inverte entre metades | aguarda |

⛔ **Mortas, não re-propor:** "m2 fair+1,5" (custa R$3.715) · "~R$48k recuperáveis" (era
contrafactual de ROI) · "logar a coleta" (86 pares, 0 divergências).

---

## FASE 3 — higiene do banco (aprovada, em execução)

### 3.1 Marcar as 439 bets `SIMULATED`
- Auditoria de 08/08 achou e não marcou. **+R$51.230 de lucro fake** poluindo toda query
  que não filtra explicitamente.
- Backup antes. Lote pequeno. Validar contagem antes e depois. Nada é deletado — só marcado.

### 3.2 Religar o que parou em 15/08
- `link-odds-to-riot.cjs`: 94% das odds ao vivo (3.070 rows) sem `riot_game_id`. Não está no cron.
- `cron-data/*-results.json`: parou em 2026-08-15. Verificar se é o mesmo cron caído.

### 3.3 Flag `is_live` em `bets`
- Não existe hoje; as 35 bets ao vivo (+R$15.274) só foram achadas por grep em `notes`.
- Sem essa flag, análise de régua linha×fair **mente** (artefato já observado: "linha abaixo da
  fair acerta 80%", que era bet live em jogo lento).

### 3.4 Corrigir o `phase` enganoso
- `phase='live'` em `odds_timeline` é fase da **SÉRIE**, não do mapa
  (`capture_pinnacle_to_supabase.cjs:265`). Documentar e/ou derivar fase por mapa via
  `game_drafts.first_frame_utc`.

---

## Fora de escopo (decidido hoje, não reabrir sem dado novo)

- Conta logada / segunda conta / AdsPower na Pinnacle — não entrega odd diferente (provado),
  e colide com a regra do próprio Elvis ("nunca coletar logado") e com a disputa ativa na conta.
- Re-minerar padrão de draft — esgotado em 17/08.
- Trocar a fair pela Betby — empate técnico pré-jogo (n=25, t=1,00). Betby serve pro **livebet**
  (9,5× mais leituras in-play, vig 1,2pp menor), não pra substituir a fair.
