# Cron diário — apostas LoL

Captura **fair lines pré-jogo** das majors e analisa **resultados do dia anterior** automaticamente, sem PC ligado, via **GitHub Actions** (não precisa VPS).

## O que roda

Workflow idempotente: cada execução roda TODOS os jobs (capture → analyze → save → rebuild). Cron só varia as ligas que fazem sentido capturar pré-jogo no horário.

| Cron | UTC | BRT | Captura pré-jogo |
|------|-----|-----|-----|
| `30 6 * * *`  | 06:30 | 03:30 | LCK + LPL |
| `0 14 * * *`  | 14:00 | 11:00 | LEC + CBLOL |

Em ambos os horários: analisa jogos de ontem + hoje, salva no Supabase, rebuilda dashboard stats.

## Output

Arquivos JSON em `cron/cron-data/`, commitados no próprio repo:

- `YYYY-MM-DD-fair-pre.json` — fair lines pré-jogo dos jogos do dia
- `YYYY-MM-DD-results.json` — análise dos jogos do dia anterior (kills, 2-peel, Under hit)

## Setup (uma vez só)

### 1. Cria PAT no GitHub
- Vai em https://github.com/settings/personal-access-tokens/new
- "Repository access" → escolhe o repo `apostas-lol-data` (criado no passo 2)
- "Repository permissions" → **Contents: Read and write** (e nada mais)
- Generate, copia o `github_pat_...`

### 2. Cria o repo
No GitHub.com, cria repo novo `apostas-lol-data` (público, sem README).

### 3. Push inicial
Da pasta `vscode/apostas-lol/cron/`:

```bash
cd c:/meu-projeto/vscode/apostas-lol/cron
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/<seu_usuario>/apostas-lol-data.git
git push -u origin main
```

(GitHub vai pedir login → cola o PAT como password)

### 4. Confirmar workflow ativo
- Acessa `https://github.com/<seu_usuario>/apostas-lol-data/actions`
- Workflow "Apostas LoL — daily cron" deve aparecer
- Pode rodar manual via "Run workflow" pra testar

## Como ler os dados

Quando tu rodar a primeira bet do dia, o bot pode fazer `git pull` do repo
e ler os JSONs novos pra puxar fair lines + resultados auto-logged dos
jogos que tu não apostou.

## Troubleshooting

- **Workflow falha em "lolesports falhou"**: API às vezes está fora. Tenta de novo manual.
- **Schedule não dispara no horário exato**: GitHub Actions tem ~5-15min de delay. Não conta com precisão de minuto.
- **Falta dados de support pra LEC/CBLOL**: lolesports API live é bloqueada nessas — `analyze_yesterday.cjs` pega só após mapa terminar (deve funcionar quando roda às 03:50 do dia seguinte).
