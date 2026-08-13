'use strict';

const { parseImageDataUrl, RegistrationError, sanitizeDescription } = require('./bet-extraction-contract.cjs');

async function enqueueBetUpload(input, deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('deps são obrigatórias');
  const ownerId = typeof input?.ownerId === 'string' ? input.ownerId.trim() : '';
  if (!ownerId) throw new RegistrationError('owner_unavailable', 'Registro indisponivel.', 503);

  const image = parseImageDataUrl(input.imageDataUrl);
  const description = sanitizeDescription(input.description);
  const existing = await deps.findJobByHash(image.hash);
  if (existing) {
    if (existing.owner_id !== ownerId) {
      throw new RegistrationError('duplicate_image', 'Esta imagem ja foi enviada por outra conta.', 409);
    }
    return { ok: true, duplicate: true, job: existing };
  }

  const storagePath = `${ownerId}/${image.hash}.${image.extension}`;
  let uploaded = false;
  try {
    await deps.uploadImage(storagePath, image.buffer, image.mimeType);
    uploaded = true;
    const job = await deps.createJob({
      owner_id: ownerId,
      ingestion_hash: image.hash,
      storage_path: storagePath,
      mime_type: image.mimeType,
      description,
      status: 'queued',
    });
    return { ok: true, duplicate: false, job };
  } catch (error) {
    if (error?.code === '23505' || !uploaded) {
      const raced = await deps.findJobByHash(image.hash);
      if (raced) {
        // O vencedor da corrida pode apontar para o mesmo objeto. Nesse caso,
        // removê-lo apagaria a imagem do job que foi persistido.
        if (raced.owner_id !== ownerId) {
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
