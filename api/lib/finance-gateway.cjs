'use strict';

// Gateway REST -> Supabase pras 2 tabelas de financas. Molde de createSupabaseGateway em
// api/bets/register.js, mas reutiliza dali so o que e generico (ownerIdFromEnv,
// parseResponse) — nao a factory inteira, porque tabela/bucket/colunas sao outros.
const { ownerIdFromEnv, parseResponse } = require('../bets/register.js');

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} nao configurada`);
  return value;
}

function headers(secret, extra = {}) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, ...extra };
}

const TRANSACTION_SELECT = 'id,job_id,source,institution,account_label,occurred_on,ref_month,description,'
  + 'merchant,amount,category,category_source,ignore_in_totals,installment_current,installment_total,'
  + 'notes,created_at,updated_at';

// summarizeFinance (api/lib/finance-summary.cjs) so le estes 8 campos — selecionar so
// eles reduz payload/banda numa query que pode trazer milhares de linhas (janela de
// 6 meses inteira).
const SUMMARY_TRANSACTION_SELECT = 'id,ref_month,amount,ignore_in_totals,source,category,merchant,description';

function createFinanceGateway(fetchImpl = fetch) {
  const url = env('SUPABASE_URL').replace(/\/$/, '');
  const secret = env('SUPABASE_SECRET_KEY');
  return {
    ownerId: ownerIdFromEnv(),

    async findJobByHash(hash) {
      const response = await fetchImpl(`${url}/rest/v1/finance_upload_jobs?ingestion_hash=eq.${encodeURIComponent(hash)}&select=*&limit=1`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },

    async getJobForOwner(id, ownerId) {
      const response = await fetchImpl(`${url}/rest/v1/finance_upload_jobs?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=id,status,note,error_code,error_message,result,created_at,purge_after,image_deleted_at,updated_at&limit=1`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },

    async uploadImage(storagePath, buffer, mimeType) {
      const response = await fetchImpl(`${url}/storage/v1/object/finance-uploads/${storagePath}`, {
        method: 'POST',
        headers: headers(secret, { 'Content-Type': mimeType, 'x-upsert': 'false' }),
        body: buffer,
      });
      await parseResponse(response);
    },

    async deleteImage(storagePath) {
      const response = await fetchImpl(`${url}/storage/v1/object/finance-uploads/${storagePath}`, { method: 'DELETE', headers: headers(secret) });
      await parseResponse(response);
    },

    // enqueueBetUpload (generico) monta o job com a chave "description" — a tabela de
    // financas usa a coluna "note". Renomeia aqui, na borda com o Supabase, sem alterar
    // register-bet.cjs nem o contrato do enqueue.
    async createJob(job) {
      const { description, ...rest } = job;
      const payload = { ...rest, note: description ?? null };
      const response = await fetchImpl(`${url}/rest/v1/finance_upload_jobs`, {
        method: 'POST',
        headers: headers(secret, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(payload),
      });
      const rows = await parseResponse(response);
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Fila nao retornou exatamente um job');
      return rows[0];
    },

    // Pagina de 1000 em 1000 (limite do PostgREST) ate a pagina voltar menor que o
    // tamanho pedido — sinal de que acabou.
    async listTransactionsForMonths(ownerId, fromMonth, toMonth) {
      const pageSize = 1000;
      let offset = 0;
      const all = [];
      for (;;) {
        const response = await fetchImpl(`${url}/rest/v1/finance_transactions?owner_id=eq.${encodeURIComponent(ownerId)}&ref_month=gte.${encodeURIComponent(fromMonth)}&ref_month=lte.${encodeURIComponent(toMonth)}&select=${SUMMARY_TRANSACTION_SELECT}&order=occurred_on.asc&limit=${pageSize}&offset=${offset}`, { headers: headers(secret) });
        const rows = await parseResponse(response);
        const page = Array.isArray(rows) ? rows : [];
        all.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      return all;
    },

    // Sem `Prefer: count=exact` (evita o count(*) completo da tabela a cada pagina).
    // `total` vira `offset + items.length` quando a pagina voltou incompleta (sinal de
    // que acabou) e `null` quando voltou cheia (nao da pra saber se tem mais sem contar).
    async queryTransactions(ownerId, { month, source, category, q, limit, offset }) {
      let query = `owner_id=eq.${encodeURIComponent(ownerId)}`;
      if (month) query += `&ref_month=eq.${encodeURIComponent(month)}`;
      if (source) query += `&source=eq.${encodeURIComponent(source)}`;
      if (category) query += `&category=eq.${encodeURIComponent(category)}`;
      if (q) query += `&or=(description.ilike.*${encodeURIComponent(q)}*,merchant.ilike.*${encodeURIComponent(q)}*)`;
      query += `&select=${TRANSACTION_SELECT}&order=occurred_on.desc,created_at.desc&limit=${limit}&offset=${offset}`;
      const response = await fetchImpl(`${url}/rest/v1/finance_transactions?${query}`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      const items = rows || [];
      const total = items.length < limit ? offset + items.length : null;
      return { items, total };
    },

    async updateTransaction(id, ownerId, patch) {
      const response = await fetchImpl(`${url}/rest/v1/finance_transactions?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=${TRANSACTION_SELECT}`, {
        method: 'PATCH',
        headers: headers(secret, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(patch),
      });
      const rows = await parseResponse(response);
      return rows?.[0] || null;
    },

    async deleteTransaction(id, ownerId) {
      const response = await fetchImpl(`${url}/rest/v1/finance_transactions?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, {
        method: 'DELETE',
        headers: headers(secret, { Prefer: 'return=representation' }),
      });
      const rows = await parseResponse(response);
      return Array.isArray(rows) ? rows.length : 0;
    },

    // Documentos exibidos no mes: os que ja fecharam extraindo esse ref_month (registered)
    // UNIDO aos que ainda nao terminaram (fila/rejeitado/erro) nos ultimos 30 dias — senao
    // um job travado na fila nunca aparece em lugar nenhum da UI.
    async listDocuments(ownerId, month, sinceIso) {
      const orFilter = `(result->>ref_month.eq.${encodeURIComponent(month)},and(status.neq.registered,created_at.gte.${encodeURIComponent(sinceIso)}))`;
      const response = await fetchImpl(`${url}/rest/v1/finance_upload_jobs?owner_id=eq.${encodeURIComponent(ownerId)}&select=id,status,note,result,error_code,error_message,created_at&or=${orFilter}&order=created_at.desc&limit=50`, { headers: headers(secret) });
      const rows = await parseResponse(response);
      return Array.isArray(rows) ? rows : [];
    },
  };
}

module.exports = { createFinanceGateway };
