# Checkpoint de autorização — batch + Whale

Data da auditoria: 2026-08-14. Estado: **NÃO AUTORIZADO PARA PRODUÇÃO**.

## Evidência read-only de produção

- OpenAPI/PostgREST: `bet_upload_job_items`, `register_bet_upload_batch` e `register_canonical_bet` ausentes. A migration ainda não foi aplicada.
- Contagem final: 1.091 bets e 6 jobs (`processing=1`, `registered=1`, `rejected=4`).
- O job em `processing` possui claim e lease válidos, não tem `bet_id`/`finished_at` e estava com aproximadamente 51 minutos de lease restante.
- A contagem de bets mudou de 1.090 para 1.091 entre dois GETs. Há writer ativo; não existe janela segura de migration neste momento.
- Colunas exigidas pela migration: nenhuma ausente na inspeção REST.
- Assinaturas canônicas duplicadas: zero grupos.

## Backup local

- Snapshot final: `cron-data/migration-backups/bet-upload-batch-rest-20260814T093931Z/`
- Manifest SHA-256: `12ecd386a5d5b44ff09a357d59f0383b5aa4546fc34b55093cae7fc6cb613cf1`
- Todos os arquivos e artefatos do manifest tiveram tamanho e SHA-256 recalculados com sucesso.
- O diretório está ignorado pelo Git.
- Limitação: backup REST não é snapshot transacional. Antes da migration é obrigatório gerar backup PostgreSQL consistente com o script preparado, após drenar/pausar writers.

## Diff SQL exato preparado

- Arquivo: `migrations/2026-08-14-bet-upload-batch.sql`
- Tamanho: 24.781 bytes
- SHA-256: `e0bceb23c72931be6979367a042a0917716ce1c80431e4f2872f33f5a4c0852c`
- Cria uma tabela: `public.bet_upload_job_items`.
- Cria dois índices não únicos na tabela nova: `bet_upload_job_items_bet_idx` e `bet_upload_job_items_dedup_idx`.
- Cria/substitui cinco funções: `bet_upload_ticket_of`, `bet_upload_canonical_json`, `bet_upload_dedup_key`, `register_canonical_bet` e `register_bet_upload_batch`.
- Não altera/dropa `public.bets` e não cria índice único nela.
- Executa preflight antes do DDL e envolve toda a migration em uma transação.

## Rollback e pendências para autorização

- O rollback remove as cinco funções e a tabela nova em transação.
- O rollback aborta se `bet_upload_job_items` já contiver qualquer item de auditoria. Depois do primeiro batch, usar forward-fix/manual; não apagar auditoria.
- Ainda pendentes por falta de conexão PostgreSQL/`psql`: validar `extensions.digest(bytea,text)`, tipos `udt_name` exatos e executar o preflight SQL read-only.
- Condição mínima para nova autorização: writers/worker drenados, zero jobs `processing`, preflight PostgreSQL verde e backup PostgreSQL consistente concluído.

Nenhum commit, push, deploy, migration, RPC mutável, reprocessamento ou write em produção foi executado nesta preparação.
