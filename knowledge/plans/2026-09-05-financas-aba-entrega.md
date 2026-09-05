# Aba "Finanças" — entrega e runbook (2026-09-05)

Finanças pessoais dentro do dashboard: foto da fatura do cartão / extrato bancário → fila → worker local (Claude Code headless) → transações no Supabase → resumo mensal, gastos por categoria e lista editável. Espelho do pipeline "Registrar bet", com tabelas, API, prompt e worker próprios. **Nada do pipeline de bets foi alterado**, exceto o cookie de acesso (abaixo).

## Privacidade (decisão fechada)

- Site e repo são públicos. Dados financeiros só saem por `/api/finance/*` (funções Vercel com `SUPABASE_SECRET_KEY`), atrás do MESMO código de acesso do upload de bets.
- Tabelas `finance_upload_jobs` e `finance_transactions`: RLS ligada, zero grant pra `anon`/`authenticated`, sem policy — só o `service_role` lê/escreve. Bucket `finance-uploads` privado, sem policy em `storage.objects`.
- O front NUNCA usa o client Supabase público pra finanças (teste `finance-ui.test.cjs` garante).
- Cookie `bet_upload_session` passou a **v2 com `Path=/api`** (antes `/api/bets`). O login apaga o cookie legado; `GET /api/bets/access` devolve `scope: 'api' | 'bets'` e a aba Finanças só se considera liberada com `scope === 'api'` (cookie antigo → pede o código de novo, uma vez).

## Peças

| Camada | Arquivos |
|---|---|
| Contrato | `api/lib/finance-categories.cjs` (= `dashboard/finance-categories.mjs`, 18 categorias fixas), `api/lib/finance-error-codes.cjs` |
| Banco | `migrations/2026-09-04-finance.sql` (+ `.rollback.sql`) — 2 tabelas, RPCs `claim_finance_upload_job` / `finish_finance_upload_job`, bucket |
| API | `api/finance/upload.js` (POST enfileira · GET status), `api/finance/summary.js`, `api/finance/transactions.js` (GET/PATCH/DELETE); libs `api/lib/finance-*.cjs` |
| Worker | `scripts/finance-upload-watcher.cjs` (compõe `bet-upload-watcher.cjs`), `scripts/finance-upload-jobs.cjs` (CLI), `scripts/finance-upload-worker-prompt.txt`, `scripts/run-finance-upload-watcher-hidden.vbs` / `.cmd`, `tools/install-finance-upload-watcher.ps1` / `uninstall-…` |
| Front | `dashboard/index.html` (aba `financas`), `dashboard/finance-image-resize.mjs` (foto → ≤ 3 MB no navegador) |
| Testes | `api/tests/finance-*.test.{cjs,mjs}` — `node --test "api/tests/*.test.cjs" "api/tests/*.test.mjs"` |

Regras de dado: valor NEGATIVO = saída, POSITIVO = entrada. Cartão entra no mês de REFERÊNCIA da fatura; conta no mês do lançamento. `pagamento_fatura` nasce com `ignore_in_totals = true` (evita contar 2x); trocar a categoria no site reaplica a regra. Dedup por `(owner_id, dedup_key)` — reenviar a mesma foto ou a mesma linha não duplica. Foto purgada do Storage após 14 dias (transações ficam).

## Runbook de ativação (ordem)

1. **Migration (Elvis, SQL Editor, aba nova):** colar `migrations/2026-09-04-finance.sql` inteiro e rodar. O `select` final deve mostrar `jobs_table`, `tx_table`, `claim_fn`, `finish_fn` preenchidos, `bucket_privado = 1`, `rls_tx = true`, `anon_le_tx = false`, `auth_le_tx = false`, `anon_finish = false`. Rollback: `migrations/2026-09-04-finance.rollback.sql` (apaga TODAS as transações extraídas).
2. **Push (com aprovação):** `git push origin feat/financas:main` a partir do worktree `apostas-lol-data-financas` → Vercel deploya em ~1 min. Nenhuma env nova na Vercel (reusa `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `BET_UPLOAD_ACCESS_CODE`, `BET_UPLOAD_SESSION_SECRET`, `BET_UPLOAD_OWNER_ID`).
3. **Worker no PC:** copiar pro workspace vivo `C:\Users\Elvis\projects\apostas-lol-data\` (é de lá que as tarefas rodam): `scripts/finance-upload-jobs.cjs`, `scripts/finance-upload-watcher.cjs`, `scripts/finance-upload-worker-prompt.txt`, `scripts/run-finance-upload-watcher-hidden.vbs`, `scripts/run-finance-upload-watcher.cmd`, `api/lib/finance-categories.cjs`, `api/lib/finance-error-codes.cjs`, `api/lib/finance-extract-contract.cjs`, `tools/install-finance-upload-watcher.ps1`, `tools/uninstall-finance-upload-watcher.ps1`. Depois `powershell -ExecutionPolicy Bypass -File tools\install-finance-upload-watcher.ps1` → tarefa `ApostasLoL-FinanceUploadWatcher` (1/min). A seco: `node scripts/finance-upload-jobs.cjs list` → `[]`; `node scripts/finance-upload-watcher.cjs --once` → `{"idle":true,...}`.
4. **E2E:** no celular, aba Finanças → código → "+ Foto" → fatura real → bolhas "na fila" → "lendo" → "Fatura X · Set/2026: N novas…" em até ~5 min → KPIs/categorias/lista. Reenviar a mesma foto → "já recebida". Conferir `select count(*) from finance_transactions`.
5. **Segurança externa:** `GET https://<supabase>/rest/v1/finance_transactions?select=id` com a chave publishable → `permission denied`; `POST /api/finance/upload` sem Origin → 403; com Origin e sem cookie → 401.

## Operação

- Logs do worker: `cron-data\finance-upload-work\logs\worker-AAAA-MM-DD.log` (14 dias). Fila: tabela `finance_upload_jobs` (`status`, `attempts`, `error_code`). Job que falha 3x vira `error` com `max_attempts_exceeded`.
- Desligar: `tools\uninstall-finance-upload-watcher.ps1` (só desabilita a tarefa).
- Rejeições mostradas no site: `unreadable_image` (foto ruim), `unsupported_document` (não é fatura/extrato), `extraction_failed` (resto).
- Limite conhecido: foto mandada com o PC desligado espera na fila até ligar (igual bets). Dois `claude -p` (bets + finanças) podem rodar juntos; se bater limite de uso com frequência, trocar o trigger de finanças pra 2 min no `.ps1`.

## Dívida técnica (não feita de propósito — exige mexer no pipeline de bets em produção)

Parametrizar `createJobClient` / `createSupabaseGateway` / `send` / `sanitizeItemError` / installers `.ps1` e wrappers `.vbs` em vez de espelhar; extrair o gate HTTP de `api/bets/register.js` pra um lib compartilhado; `runWatcherCycle` com payload de dead-letter neutro (hoje o client de finanças descarta `p_bet_id`); estado de acesso único pras duas abas. Fazer numa rodada própria, com o pipeline de bets parado e testado.

Plano completo com contratos: `~/.claude/plans/keen-hugging-moler.md` (S1–S9 + S8b revisão de código).
