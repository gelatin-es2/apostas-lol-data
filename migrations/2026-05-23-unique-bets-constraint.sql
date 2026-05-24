-- Migration: adiciona constraint de unicidade natural em bets
-- Criado em: 2026-05-23
-- Auditoria gerou 66 grupos duplicados (102 bets a deletar).
--
-- PASSO 1 (obrigatório antes de rodar esta migration):
--   Rodar o dedup retroativo via script:
--   node .claude/scripts/dedup-bets-execute.cjs --execute
--   Resultado esperado: 102 bets deletadas, 0 erros.
--
-- PASSO 2: Rodar esta migration no Supabase SQL Editor (ou via psql).
--   Só rodar APÓS dedup confirmado — a constraint falha se ainda houver duplicatas.
--
-- PASSO 3 (bookmaker normalization):
--   Rodar normalize-bookmakers.cjs --execute antes ou depois desta migration
--   (não afeta a constraint, que é case-sensitive no Postgres por default).
--   Para tornar o índice case-insensitive, usar lower() nas colunas — ver nota abaixo.
--
-- Nota sobre case:
--   Esta constraint é case-sensitive. Se "Pinnacle" e "pinnacle" existirem ao mesmo tempo,
--   a constraint NÃO as trata como duplicatas. Por isso o normalize-bookmakers deve ser
--   rodado ANTES desta migration para garantir que todos os valores estejam em lowercase.
--   O safeguard em supabase-save-bet.cjs já valida bookmaker lowercase antes de inserir.

-- Constraint pra evitar duplicação futura. Rodar APÓS dedup retroativo.
ALTER TABLE bets ADD CONSTRAINT bets_unique_natural_key
  UNIQUE (pick, bookmaker, stake, bet_datetime);

-- Comentário de auditoria (opcional, mas útil pra rastreabilidade):
COMMENT ON CONSTRAINT bets_unique_natural_key ON bets IS
  'Evita duplicatas por (pick + bookmaker + stake + bet_datetime). '
  'Implementado 2026-05-23 após auditoria que encontrou 66 grupos duplicados (102 bets). '
  'Causa raiz: insert-missed-bets sem upsert rodando múltiplas vezes.';
