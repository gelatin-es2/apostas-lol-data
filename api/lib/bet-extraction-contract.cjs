'use strict';

const crypto = require('crypto');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const ALLOWED_IMAGES = {
  'image/png': { extension: 'png', signature: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  'image/jpeg': { extension: 'jpg', signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { extension: 'webp', signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

class RegistrationError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
    this.status = status;
  }
}

function parseImageDataUrl(value) {
  if (typeof value !== 'string') {
    throw new RegistrationError('invalid_image', 'Envie uma imagem PNG, JPEG ou WebP.', 400);
  }
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new RegistrationError('invalid_image', 'Imagem inválida. Use PNG, JPEG ou WebP.', 400);
  const [, mimeType, encoded] = match;
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !ALLOWED_IMAGES[mimeType].signature(buffer)) {
    throw new RegistrationError('invalid_image', 'A imagem precisa ser válida e ter no máximo 3 MB.', 400);
  }
  const canonicalBase64 = buffer.toString('base64');
  if (canonicalBase64.replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new RegistrationError('invalid_image', 'Conteúdo base64 inválido.', 400);
  }
  return {
    buffer,
    mimeType,
    extension: ALLOWED_IMAGES[mimeType].extension,
    dataUrl: `data:${mimeType};base64,${canonicalBase64}`,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function sanitizeDescription(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new RegistrationError('invalid_description', 'A informacao extra precisa ser texto.', 400);
  }
  const sanitized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!sanitized) return null;
  if ([...sanitized].length > MAX_DESCRIPTION_LENGTH) {
    throw new RegistrationError('invalid_description', `A informacao extra pode ter no maximo ${MAX_DESCRIPTION_LENGTH} caracteres.`, 400);
  }
  return sanitized;
}

module.exports = { MAX_DESCRIPTION_LENGTH, MAX_IMAGE_BYTES, RegistrationError, parseImageDataUrl, sanitizeDescription };
