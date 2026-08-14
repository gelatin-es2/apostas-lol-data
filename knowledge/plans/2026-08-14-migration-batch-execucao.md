# Migration batch + Whale — como aplicar (14/08/2026)

**Status:** pronta pra aplicar. Autorizada pelo pedido do Elvis em 14/08 ("termina o negócio de registrar bet no meu site"). Falta só a execução no banco, que depende de acesso que a máquina não tem (sem `psql`, sem `SUPABASE_DB_URL`, sem token do CLI).

## O que ela faz (em uma frase)

Cria **1 tabela nova** (`bet_upload_job_items`, auditoria de itens por job) e **5 funções** (registro canônico + batch transacional de 1-10 apostas por print) — **não altera nem apaga nada em `bets`**, roda tudo em uma transação única.

## Pré-condições — verificadas em 14/08 ~10:53 UTC

| Checagem | Resultado |
|---|---|
| Fila de jobs | 0 queued, 0 processing (janela limpa) |
| Worker/automatações | task Agendador desabilitada + automação Codex pausada |
| Backup REST fresco | `cron-data/migration-backups/bet-upload-batch-rest-20260814T105321Z/` — 1.091 bets, 7 jobs, manifest sha256 `e7a05de3…2fb18c0` |
| Integridade dos 7 artefatos | SHA-256 conferido contra o manifest — todos OK |
| Assinaturas duplicadas em bets | 0 grupos |

Limitação conhecida: backup REST não é snapshot transacional (o runbook original pedia `pg_dump`, que exige a connection string). Aceitável aqui porque a migration é **só aditiva** — o rollback (`2026-08-14-bet-upload-batch.rollback.sql`) desfaz tudo enquanto não houver item de auditoria gravado.

## Caminho A — SQL Editor do Supabase (recomendado, ~3 min)

No painel do Supabase → **SQL Editor**, rodar nesta ordem (um arquivo por vez, copiar/colar o conteúdo inteiro):

1. `migrations/2026-08-14-bet-upload-batch.preflight.sql` — **read-only**. Esperado: primeira query mostra database/versão; a segunda (`findings`) deve retornar **0 linhas**. Se vier linha, PARAR e me mostrar.
2. `migrations/2026-08-14-bet-upload-batch.sql` — a migration em si. Rodar **uma vez**. Esperado: sucesso sem erro (ela mesma re-executa o preflight e aborta sozinha se algo estiver errado).
3. `migrations/2026-08-14-bet-upload-batch.postflight.sql` e depois `...postflight-summary.sql` — read-only, conferem se tudo foi criado. Esperado: sem achado de erro.
4. Me avisar ("migration aplicada") — daí eu valido por fora, religo o worker e rodo o canário.

**Rollback** (se precisar): `migrations/2026-08-14-bet-upload-batch.rollback.sql` no mesmo editor. Ele se recusa a rodar se já existir auditoria em `bet_upload_job_items` (proteção proposital).

## Caminho B — me dar a connection string (melhor pro futuro)

Painel Supabase → Settings → Database → **Connection string (URI)**. Definir como variável de ambiente de usuário do Windows chamada `SUPABASE_DB_URL` (não colar no chat!) e me dizer "aplica a migration". Com isso eu instalo o client PostgreSQL e executo o runbook completo (pg_dump consistente + preflight + migration + postflight), e qualquer migration futura deixa de depender de copy/paste teu.

⚠️ Se a connection string for colada no chat por engano: trocar a senha do banco em seguida (Settings → Database → Reset password).

## Depois da migration (meu lado, já preparado)

1. Postflight de validação por REST (funções/tabela visíveis no PostgREST).
2. Commit + push do worktree deploy → Vercel deploya site + API novos.
3. Sincronizar `supabase-save-bet.cjs`/`normalize-bookmakers.cjs` no repo do chat (writer legado passa a usar o registro canônico — exigência do manifest: "deploy worker and legacy writer together").
4. Religar a task `ApostasLoL-BetUploadWatcher` (worker novo: Claude Code headless no lugar do Codex).
5. Canário: enviar imagem que NÃO é aposta → deve ser rejeitada com mensagem correta (testa o pipeline inteiro sem gravar bet). O caminho "registrada" valida no primeiro print real.
