# Análise — Captura Pinnacle 100% automática (24/7) + captura live

**Data:** 2026-08-04 · **Status:** análise aprovada pelo rito (pesquisa → design → crítica adversarial). Aguardando decisão do Elvis pra implementar.

---

## Resposta curta às 2 perguntas

**1. Dá pra rodar sem o PC ligado?** Dá, de graça, usando o que já existe: GitHub Actions do próprio repo (público = minutos ilimitados) gravando no Supabase. Evidência forte de que funciona: outro projeto rodou scraper da MESMA guest API da Pinnacle em GitHub Actions a cada 10min por ~2 meses (9.425 execuções, maio–julho/2026) sem nunca ser bloqueado.

**2. Dá pra rodar bem mais vezes, inclusive durante o jogo?** Dá — e o dado live é rico. Probe feito hoje (04/08) durante jogo real: a Pinnacle mantém mercado live de kills do mapa em andamento com ladder completo (ex.: 32.5–38.5), team totals, spread e moneyline, repricing em menos de 60s (linha subiu 35.5 → 37.5 entre dois polls de 30s conforme kills aconteciam). Polling de 60s captura a timeline inteira. Ressalva observada ao vivo: o mercado live às vezes fica **suspenso** (jogo LFL aos 7min de jogo: matchup live existia, mas sem odds) — a timeline vai ter buracos naturais, isso é o mercado, não bug.

---

## Evidências principais (pesquisa 04/08/2026)

| Fato | Evidência |
|---|---|
| GitHub Actions passa no WAF da Pinnacle | Probe documentado (mai/2026): VPS Hetzner = 403 Cloudflare; runner GitHub (Azure) = 200 com JSON. Repo `alexfsong/promo-tool`, run verificado via `gh` |
| Operação sustentada em Actions é viável | 9.425 runs a cada 10min sem bloqueio da Pinnacle (parou por inatividade do GitHub, não por ban) |
| Rate limit | Sem número oficial. Comunidade opera ~5 req/s sustentado com gap de 200ms. Nosso volume projetado: ~1.900 req/dia ≈ **1,3 req/min** — duas ordens de grandeza abaixo |
| Mercado live de kills existe | Probe próprio hoje: ladder completo + repricing sub-minuto durante mapa. Mercados live vêm num SUB-matchup (`isLive`, `parentId` → matchup pré-jogo) |
| Game clock NÃO vem da Pinnacle | Timeline nasce só com timestamp UTC; tempo de jogo e kill count entram depois via livestats da Riot (backfill) + âncora `first_seen_live_at` |
| Supabase tem folga | Banco atual <20MB de 500MB. Timeline projetada: ~45MB/mês bruto, estado estável ~200–300MB com retenção de 90 dias |
| Riscos de bloqueio | Guest API é ToS-grey (API oficial fechou pro público em jul/2025). 137 repos públicos usam há anos, zero relato de enforcement. Fallback pronto: Proxy-Cheap BR (~US$2/mês), patch de ~5 linhas |

---

## Arquitetura recomendada

**GitHub Actions (3 workflows) + Supabase como banco da timeline.** Já corrigida pelos 3 furos que a crítica adversarial achou (heartbeat, alarme externo, janela de dispatch).

```
┌────────────────────────── GitHub Actions (repo público, R$0) ──────────────────────────┐
│                                                                                        │
│  baseline.yml (cron a cada 30min, minutos deslocados '7,37')                           │
│    → captura pré-jogo de TODAS as ligas LoL (mesma lógica do script atual)             │
│    → grava odds_timeline + closing_lines no Supabase                                   │
│    → mantém o consolidado JSON diário commitado (compatibilidade modo sombra)          │
│    → se jogo em <120min OU matchup live: dispara o live.yml                            │
│                                                                                        │
│  live.yml (job contínuo de até ~5h30, loop interno de 60s — imune ao jitter do cron)   │
│    → cadência de 1min REAL durante janela de jogos                                     │
│    → grava tudo a cada iteração (linha, ladder, team totals, ML, mapa corrente)        │
│    → grava first_seen_live_at por mapa (âncora de início independente da Riot)         │
│    → sai após 30min sem jogo; se vive 5h30 e ainda tem jogo, redispara a si mesmo      │
│                                                                                        │
│  watchdog.yml (cron horário)                                                           │
│    → lê a tabela capture_runs (heartbeat — TODA execução grava, mesmo sem mudança)     │
│    → captura parada >75min com agenda ativa → redispara + falha de propósito (e-mail)  │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                    Supabase (existente): odds_timeline · closing_lines · capture_runs
                                          │
                                          ▼
              Dead-man switch EXTERNO (healthchecks.io free): ping a cada run;
              se o GitHub inteiro morrer (auto-disable 60d, flag ToS), alerta chega mesmo assim
```

**Por que não as alternativas:**
- **Supabase Edge Functions + pg_cron**: exigiria reescrever o coletor em Deno, timeout de ~5s na chamada via pg_net, sem caminho pra proxy residencial, e acopla coleta + banco no mesmo ponto de falha.
- **Cloudflare Workers**: 10ms de CPU no free é apertado pro JSON do ladder, e não suporta proxy → sem fallback se a Pinnacle bloquear.
- **Oracle Always Free**: relatos de encerramento abrupto de conta idle — fere "manutenção mínima".

## Detalhes do design

### Tabelas novas (Supabase)

- **`odds_timeline`** — 1 row por (série, mapa, leitura que mudou). Campos: timestamp, fase (`pre`/`live`), mapa, linha principal + odds + juice, ladder completo (jsonb), team totals, spread, moneyline, `market_version` (campo `version` da Pinnacle = detector de mudança), `riot_game_id`/`game_clock_s` (preenchidos depois via livestats). Delta-gating: leitura idêntica à anterior não grava (madrugada parada ≈ zero rows). Conflitos de dedup são **logados**, nunca descartados calados.
- **`closing_lines`** — 1 row por série+mapa, upsert da última leitura pré-jogo. **Inclui mapas 2+** (última leitura antes do `first_seen_live_at` daquele mapa) — CLV de bet em mapa 2/3 sai de query direta. Guard contra contaminação por leitura pós-início.
- **`capture_runs`** — heartbeat: 1 row por execução com matchups vistos, rows gravadas, erros. É o sensor do watchdog (a timeline não serve pra isso: mercado quieto ≈ zero rows ≠ coleta morta) e de quebra mede a taxa real de skip do scheduler.

### Regras de captura
- Requests **sempre seriais** (nunca concorrentes — houve relato real de ban por concorrência), gap 300ms + jitter, retry 3x em 503/429 com backoff honrando `Retry-After` (a API caiu 3x hoje de manhã — retry resolve).
- Nomes de time normalizados no write com o mapa de aliases canônicos do projeto (senão o CLV automático nasce quebrado — problema já conhecido).
- Nunca logar headers/keys (repo público, logs visíveis).
- Snapshots por rodada param de ir pro git; Supabase vira a fonte da timeline. Consolidado diário JSON continua (modo sombra intacto).

### O que a análise live futura vai poder fazer
Cada row live tem timestamp UTC preciso. Backfill offline casa com `feed.lolesports.com/livestats` (que o projeto já usa) → cada leitura de odds ganha tempo de jogo + kill count naquele momento. Aí "passou 3min / 5min / 10min" vira **query**, não lógica de captura: reação do mercado a first blood, velocidade de reprice, CLV live, tudo em cima da mesma tabela. Ligas onde o livestats falha (LPL é notório) ficam com a âncora `first_seen_live_at` como aproximação.

### Volume e custo
- ~1.900 requests/dia à Pinnacle (1,3/min médio) — irrelevante pro que a comunidade opera.
- ~800–1.200 rows/dia ≈ 45MB/mês; retenção poda o jsonb pesado aos 90 dias (série da linha principal fica pra sempre). Alerta se a tabela passar de 300MB.
- Custo: **R$0**. Fallback proxy: ~US$2/mês só se aparecer 403.

## Plano B (por escrito, com gatilhos objetivos)

VPS barato (~R$12/mês, IONOS/RackNerd): mesmo coletor, mesmo schema, só muda onde roda — cadência livre até sub-minuto, zero ToS cinza. **Migrar se:** (1) 2 closing lines perdidas numa semana; (2) furo live >10min em jogo com bet; (3) primeiro 403 que o proxy não resolva; (4) qualquer aviso do GitHub sobre uso de Actions.

## Riscos aceitos

- **Jitter do scheduler** (delay real observado neste repo: até 1h47) → por isso o live é job contínuo disparado com 120min de antecedência, não cron; watchdog + heartbeat cobrem furo.
- **ToS-grey duplo** (Actions rodando polling + guest API não sancionada) → volume solo, padrão git-scraping tolerado há anos; plano B executável em <1 dia.
- **PAT fine-grained expira** (necessário pro dispatch entre workflows) → lembrete de renovação no rito de domingo + checagem mensal do estado dos workflows.
- **Suspensões do mercado live** → buracos na timeline são dado ("mercado suspenso"), não erro.

## Migração (ordem)

1. DDL das 3 tabelas no SQL editor do Supabase (RLS on, sem policy pública)
2. PAT fine-grained (só este repo, Actions read/write) como secret `GH_DISPATCH_TOKEN`
3. Refatorar coletor: core vira lib compartilhada (retry + writer Supabase + delta-gating); modo local atual vira fallback
4. Criar os 3 workflows + conta healthchecks.io (free) com ping
5. Disparar manual e validar com evidência (rows no banco, closing correta, consolidado idêntico ao local)
6. **Rodar 3–7 dias em paralelo com o Task Scheduler do PC** (`source` distingue `gha-*` de `pc-legacy`); medir taxa real de skip com `gh run list`
7. Validar 1 dia com jogo live de ponta a ponta (timeline de 60s com linha subindo conforme kills)
8. Desligar a task do PC (script local fica como fallback manual)
9. Depois, sem pressa: backfill riot_game_id/game_clock + step de retenção no daily-cron

---

*Fontes completas da pesquisa (URLs de repos, probes, docs) no output do workflow de análise desta sessão. Probes próprios de 04/08: mercado live confirmado com repricing sub-minuto; suspensão early-game observada; 8 requests em 2min todos 200 de IP residencial BR.*
