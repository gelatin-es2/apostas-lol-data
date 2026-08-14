import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTER_MAX_DECODED_BYTES,
  composeRegisterImages,
  computeCompositeLayout,
  decodedDataUrlBytes,
  removeRegisterImageAt,
  validateRegisterImageFiles,
} from '../../dashboard/register-image-composer.mjs';

function imageDataUrl(byte, size = 24) {
  return `data:image/png;base64,${Buffer.alloc(size, byte).toString('base64')}`;
}

function fakeCanvas(width, height, draws) {
  return {
    width,
    height,
    getContext() {
      return {
        fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
        textAlign: '', textBaseline: '', font: '',
        fillRect() {},
        fillText() {},
        drawImage(image, x, y, drawWidth, drawHeight) {
          draws.push({ id: image.id, x, y, width: drawWidth, height: drawHeight });
        },
      };
    },
  };
}

test('seleção preserva ordem, aceita Ctrl+V repetido e limita a 2 imagens', () => {
  const first = { name: 'primeiro.png', type: 'image/png', size: 100 };
  const second = { name: 'segundo.webp', type: 'image/webp', size: 200 };
  assert.deepEqual(validateRegisterImageFiles([first, second]), [first, second]);
  assert.deepEqual(validateRegisterImageFiles([second], 1), [second]);
  assert.throws(() => validateRegisterImageFiles([first], 2), (error) => error.code === 'too_many_images');
  assert.throws(
    () => validateRegisterImageFiles([{ type: 'image/gif', size: 20 }]),
    (error) => error.code === 'invalid_image',
  );
  assert.throws(
    () => validateRegisterImageFiles([{ type: 'image/jpeg', size: REGISTER_MAX_DECODED_BYTES + 1 }]),
    (error) => error.code === 'invalid_image',
  );
});

test('remoção mantém a ordem relativa dos previews restantes', () => {
  const images = [{ id: 'primeiro' }, { id: 'segundo' }];
  assert.deepEqual(removeRegisterImageAt(images, 0), [{ id: 'segundo' }]);
  assert.deepEqual(removeRegisterImageAt(images, 1), [{ id: 'primeiro' }]);
  assert.deepEqual(images, [{ id: 'primeiro' }, { id: 'segundo' }]);
});

test('uma imagem preserva exatamente o data URL e os bytes atuais', async () => {
  const dataUrl = imageDataUrl(7, 321);
  assert.equal(decodedDataUrlBytes(dataUrl), 321);
  assert.equal(await composeRegisterImages([{ dataUrl }]), dataUrl);
});

test('layout empilha os dois painéis na ordem e respeita limites de canvas', () => {
  const normal = computeCompositeLayout([{ width: 100, height: 200 }, { width: 80, height: 50 }]);
  assert.equal(normal.width, 100);
  assert.deepEqual(normal.panels, [{ width: 100, height: 200 }, { width: 80, height: 50 }]);
  assert.equal(normal.height, 200 + normal.separatorHeight + 50);
  const huge = computeCompositeLayout([{ width: 12000, height: 18000 }, { width: 9000, height: 16000 }]);
  assert.ok(huge.width <= 4096);
  assert.ok(huge.height <= 8192);
  assert.ok(huge.width * huge.height <= 28 * 1024 * 1024);
});

test('duas imagens viram um WebP único <=3 MB com separador e ordem visual', async () => {
  const draws = [];
  const attempts = [];
  const firstUrl = imageDataUrl(1);
  const secondUrl = imageDataUrl(2);
  const output = await composeRegisterImages([{ dataUrl: firstUrl }, { dataUrl: secondUrl }], {
    async loadImage(dataUrl) {
      return dataUrl === firstUrl
        ? { image: { id: 'primeiro' }, width: 800, height: 1200 }
        : { image: { id: 'segundo' }, width: 800, height: 900 };
    },
    createCanvas: (width, height) => fakeCanvas(width, height, draws),
    async encodeCanvas(canvas, quality) {
      attempts.push({ width: canvas.width, height: canvas.height, quality });
      const size = attempts.length < 4 ? REGISTER_MAX_DECODED_BYTES + 1 : 120;
      return { size, type: 'image/webp' };
    },
    async blobToDataUrl(blob) {
      return `data:image/webp;base64,${Buffer.alloc(blob.size).toString('base64')}`;
    },
  });
  assert.equal(decodedDataUrlBytes(output), 120);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts.map(({ quality }) => quality), [0.95, 0.90, 0.85, 0.92]);
  const finalDraws = draws.slice(-2);
  assert.deepEqual(finalDraws.map(({ id }) => id), ['primeiro', 'segundo']);
  assert.ok(finalDraws[1].y > finalDraws[0].height, 'segundo painel deve vir após a faixa separadora');
});

test('composição falha claramente antes de upload quando 3 MB são impossíveis', async () => {
  const dataUrl = imageDataUrl(3);
  await assert.rejects(() => composeRegisterImages([{ dataUrl }, { dataUrl }], {
    async loadImage() { return { image: {}, width: 5000, height: 9000 }; },
    createCanvas: (width, height) => fakeCanvas(width, height, []),
    async encodeCanvas() { return { size: REGISTER_MAX_DECODED_BYTES + 1, type: 'image/webp' }; },
  }), (error) => error.code === 'composite_too_large' && /3 MB/.test(error.message));
});
