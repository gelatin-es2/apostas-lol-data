-- ROLLBACK de migrations/2026-09-04-finance.sql — 2026-09-04
-- Rodar no SQL Editor do painel Supabase.
--
-- ATENCAO: isto APAGA TODAS as transacoes financeiras ja extraidas (tabela
-- finance_transactions inteira), a fila de upload (finance_upload_jobs) e todas as
-- fotos de fatura/extrato no bucket finance-uploads. Nao ha como desfazer depois de
-- rodar. Nao mexe em public.bets nem em nenhuma tabela/RPC do pipeline de apostas
-- (pipelines separados).

begin;

drop function if exists public.finish_finance_upload_job(uuid, uuid, text, text, text, jsonb);
drop function if exists public.claim_finance_upload_job(text, integer);
drop table if exists public.finance_transactions;
drop table if exists public.finance_upload_jobs;

delete from storage.objects where bucket_id = 'finance-uploads';
delete from storage.buckets where id = 'finance-uploads';

commit;
