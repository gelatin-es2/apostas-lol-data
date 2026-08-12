'use strict';

const { parseImageDataUrl, RegistrationError } = require('./bet-extraction-contract.cjs');

async function enqueueBetUpload(input, deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('deps são obrigatórias');
  const token = typeof input?.token === 'string' ? input.token.trim() : '';
  if (!token) throw new RegistrationError('unauthorized', 'Entre com seu e-mail para enviar.', 401);
  const user = await deps.authenticate(token);
  if (!user?.id || !user?.email) throw new RegistrationError('forbidden', 'Usuário não autorizado.', 403);

  const image = parseImageDataUrl(input.imageDataUrl);
  const existing = await deps.findJobByHash(image.hash);
  if (existing) {
    if (existing.owner_id !== user.id) {
      throw new RegistrationError('duplicate_image', 'Esta imagem ja foi enviada por outra conta.', 409);
    }
    return { ok: true, duplicate: true, job: existing };
  }

  const storagePath = `${user.id}/${image.hash}.${image.extension}`;
  let uploaded = false;
  try {
    await deps.uploadImage(storagePath, image.buffer, image.mimeType);
    uploaded = true;
    const job = await deps.createJob({
      owner_id: user.id,
      ingestion_hash: image.hash,
      storage_path: storagePath,
      mime_type: image.mimeType,
      status: 'queued',
    });
    return { ok: true, duplicate: false, job };
  } catch (error) {
    if (error?.code === '23505' || !uploaded) {
      const raced = await deps.findJobByHash(image.hash);
      if (raced) {
        // O vencedor da corrida pode apontar para o mesmo objeto. Nesse caso,
        // removê-lo apagaria a imagem do job que foi persistido.
        if (raced.owner_id !== user.id) {
          if (uploaded) await deps.deleteImage(storagePath).catch(() => {});
          throw new RegistrationError('duplicate_image', 'Esta imagem ja foi enviada por outra conta.', 409);
        }
        return { ok: true, duplicate: true, job: raced };
      }
    }
    if (uploaded) await deps.deleteImage(storagePath).catch(() => {});
    throw error;
  }
}

module.exports = { enqueueBetUpload };
