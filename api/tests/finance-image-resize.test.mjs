import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINANCE_MAX_BYTES,
  FINANCE_QUALITY_LADDER,
  computeResizeScale,
  decodedDataUrlBytes,
  prepareFinanceImage,
} from '../../dashboard/finance-image-resize.mjs';

function imageDataUrl(byte, size) {
  return `data:image/jpeg;base64,${Buffer.alloc(size, byte).toString('base64')}`;
}

function fakeCanvas(width, height) {
  return {
    width,
    height,
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: '',
        drawImage() {},
      };
    },
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];

function headerBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

function webpHeaderBuffer() {
  const bytes = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];
  return headerBuffer(bytes);
}

test('computeResizeScale reduz pro lado mais longo caber em maxSide, nunca amplia', () => {
  assert.equal(computeResizeScale(4000, 3000), 0.5);
  assert.equal(computeResizeScale(1200, 800, 2000), 1);
  assert.equal(computeResizeScale(0, 0), 1);
});

test('decodedDataUrlBytes calcula bytes reais do base64', () => {
  assert.equal(decodedDataUrlBytes(imageDataUrl(1, 321)), 321);
  assert.throws(() => decodedDataUrlBytes('data:text/plain;base64,abc'), (error) => error.code === 'unsupported_image');
});

test('foto pequena com assinatura batendo passa direto (sem canvas) e preserva os bytes originais', async () => {
  const file = { type: 'image/png', size: 200 * 1024 };
  const originalDataUrl = imageDataUrl(9, file.size);
  const result = await prepareFinanceImage(file, {
    async loadImage() { return { width: 1200, height: 800, source: {} }; },
    async fileToDataUrl() { return originalDataUrl; },
    async readHeaderBytes() { return headerBuffer(PNG_SIGNATURE); },
  });
  assert.equal(result.resized, false);
  assert.equal(result.dataUrl, originalDataUrl);
  assert.equal(result.width, 1200);
  assert.equal(result.height, 800);
  assert.equal(result.bytes, file.size);
});

test('WebP com assinatura RIFF/WEBP batendo também passa direto', async () => {
  const file = { type: 'image/webp', size: 100 * 1024 };
  const originalDataUrl = `data:image/webp;base64,${Buffer.alloc(file.size, 5).toString('base64')}`;
  const result = await prepareFinanceImage(file, {
    async loadImage() { return { width: 800, height: 600, source: {} }; },
    async fileToDataUrl() { return originalDataUrl; },
    async readHeaderBytes() { return webpHeaderBuffer(); },
  });
  assert.equal(result.resized, false);
  assert.equal(result.dataUrl, originalDataUrl);
});

test('arquivo .png que é JPEG por dentro (assinatura divergente) cai pro reencode em vez do passthrough', async () => {
  const file = { type: 'image/png', size: 200 * 1024 };
  const attempts = [];
  const result = await prepareFinanceImage(file, {
    async loadImage() { return { width: 1200, height: 800, source: {} }; },
    async readHeaderBytes() { return headerBuffer(JPEG_SIGNATURE); },
    createCanvas: fakeCanvas,
    async encodeCanvas(canvas, quality) {
      attempts.push(quality);
      return { size: 400 * 1024, type: 'image/jpeg' };
    },
    async blobToDataUrl(blob) { return imageDataUrl(3, blob.size); },
    async fileToDataUrl() { throw new Error('não deveria fazer passthrough com assinatura divergente'); },
  });
  assert.equal(result.resized, true);
  assert.equal(attempts.length, 1, 'primeiro degrau da escada já deveria caber');
  assert.equal(result.width, 1200);
  assert.equal(result.height, 800);
});

test('falha ao ler os bytes do cabeçalho (ex: sem File.slice) nunca faz passthrough', async () => {
  const file = { type: 'image/png', size: 200 * 1024 };
  const result = await prepareFinanceImage(file, {
    async loadImage() { return { width: 1200, height: 800, source: {} }; },
    async readHeaderBytes() { throw new Error('sem slice'); },
    createCanvas: fakeCanvas,
    async encodeCanvas() { return { size: 400 * 1024, type: 'image/jpeg' }; },
    async blobToDataUrl(blob) { return imageDataUrl(4, blob.size); },
  });
  assert.equal(result.resized, true);
});

test('foto grande (4000x3000, 6 MB) é reduzida a 2000x1500 e percorre a escada de qualidade', async () => {
  const file = { type: 'image/jpeg', size: 6 * 1024 * 1024 };
  const attempts = [];
  const result = await prepareFinanceImage(file, {
    async loadImage() { return { width: 4000, height: 3000, source: {} }; },
    createCanvas: fakeCanvas,
    async encodeCanvas(canvas, quality) {
      attempts.push({ width: canvas.width, height: canvas.height, quality });
      const size = attempts.length < 4 ? FINANCE_MAX_BYTES + 1 : 512;
      return { size, type: 'image/jpeg' };
    },
    async blobToDataUrl(blob) { return imageDataUrl(2, blob.size); },
  });
  assert.equal(result.resized, true);
  assert.deepEqual(attempts.map((a) => a.quality), FINANCE_QUALITY_LADDER.slice(0, 4).map(([, q]) => q));
  assert.deepEqual(
    attempts.slice(0, 3).map((a) => [a.width, a.height]),
    [[2000, 1500], [2000, 1500], [2000, 1500]],
  );
  // 4º degrau da escada: [0.85, 0.80] sobre o já reduzido a 2000x1500.
  assert.deepEqual([attempts[3].width, attempts[3].height], [1700, 1275]);
  assert.equal(result.width, 1700);
  assert.equal(result.height, 1275);
  assert.equal(result.bytes, 512);
});

test('quando nenhuma rodada da escada cabe em 3 MB, falha com image_too_large', async () => {
  const file = { type: 'image/jpeg', size: 6 * 1024 * 1024 };
  await assert.rejects(() => prepareFinanceImage(file, {
    async loadImage() { return { width: 4000, height: 3000, source: {} }; },
    createCanvas: fakeCanvas,
    async encodeCanvas() { return { size: FINANCE_MAX_BYTES + 1, type: 'image/jpeg' }; },
  }), (error) => error.code === 'image_too_large' && /3 MB/.test(error.message));
});

test('HEIC ou foto não decodificável falha com unsupported_image e dica de formato', async () => {
  const file = { type: '', size: 4 * 1024 * 1024 };
  await assert.rejects(() => prepareFinanceImage(file, {
    async loadImage() { throw new Error('decode failed'); },
  }), (error) => error.code === 'unsupported_image' && /JPEG/.test(error.message));
});
