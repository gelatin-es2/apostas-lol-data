export const REGISTER_MAX_IMAGES = 2;
export const REGISTER_MAX_DECODED_BYTES = 3 * 1024 * 1024;
export const REGISTER_ALLOWED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

const MAX_CANVAS_WIDTH = 4096;
const MAX_CANVAS_HEIGHT = 8192;
const MAX_CANVAS_PIXELS = 28 * 1024 * 1024;
const BASE_SEPARATOR_HEIGHT = 36;
const COMPRESSION_CANDIDATES = Object.freeze([
  [1, 0.95], [1, 0.90], [1, 0.85],
  [0.90, 0.92], [0.90, 0.86],
  [0.80, 0.92], [0.80, 0.86],
  [0.70, 0.92], [0.70, 0.84],
  [0.60, 0.90], [0.60, 0.82],
  [0.50, 0.88], [0.40, 0.85], [0.30, 0.80],
]);

export class RegisterImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegisterImageError';
    this.code = code;
  }
}

export function validateRegisterImageFiles(files, existingCount = 0) {
  const selected = Array.from(files || []);
  if (!selected.length) return selected;
  if (existingCount + selected.length > REGISTER_MAX_IMAGES) {
    throw new RegisterImageError('too_many_images', 'Você pode enviar no máximo 2 prints por mensagem.');
  }
  for (const file of selected) {
    if (!REGISTER_ALLOWED_IMAGE_TYPES.includes(file?.type) || !Number.isFinite(file?.size)
        || file.size <= 0 || file.size > REGISTER_MAX_DECODED_BYTES) {
      throw new RegisterImageError('invalid_image', 'Use PNG, JPEG ou WebP com no máximo 3 MB por print.');
    }
  }
  return selected;
}

export function removeRegisterImageAt(images, index) {
  return images.filter((_, itemIndex) => itemIndex !== index);
}

export function decodedDataUrlBytes(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new RegisterImageError('invalid_image', 'Não consegui preparar o print para envio.');
  const payload = match[1];
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

export function computeCompositeLayout(images, candidateScale = 1) {
  if (!Array.isArray(images) || images.length !== 2) {
    throw new RegisterImageError('invalid_image_count', 'A composição exige exatamente 2 prints.');
  }
  const dimensions = images.map(({ width, height }) => ({
    width: Number(width),
    height: Number(height),
  }));
  if (dimensions.some(({ width, height }) => !Number.isFinite(width) || !Number.isFinite(height)
      || width < 1 || height < 1)) {
    throw new RegisterImageError('invalid_image', 'Não consegui identificar o tamanho de um dos prints.');
  }
  const rawWidth = Math.max(...dimensions.map(({ width }) => width));
  const rawImagesHeight = dimensions.reduce((sum, { height }) => sum + height, 0);
  const rawHeight = rawImagesHeight + BASE_SEPARATOR_HEIGHT;
  const fitScale = Math.min(
    1,
    MAX_CANVAS_WIDTH / rawWidth,
    (MAX_CANVAS_HEIGHT - BASE_SEPARATOR_HEIGHT) / rawImagesHeight,
    Math.sqrt(MAX_CANVAS_PIXELS / (rawWidth * rawHeight)),
  );
  const scale = fitScale * candidateScale;
  const panels = dimensions.map(({ width, height }) => ({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }));
  const separatorHeight = Math.max(18, Math.round(BASE_SEPARATOR_HEIGHT * scale));
  const width = Math.max(...panels.map((panel) => panel.width));
  const height = panels.reduce((sum, panel) => sum + panel.height, separatorHeight);
  return { width, height, panels, separatorHeight, scale };
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadBrowserImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function browserCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas encode failed')), type, quality);
  });
}

async function encodeBrowserCanvas(canvas, quality) {
  try {
    const webp = await toBlob(canvas, 'image/webp', quality);
    if (webp.type === 'image/webp') return webp;
  } catch {}
  return toBlob(canvas, 'image/jpeg', quality);
}

function drawComposite(canvas, decoded, layout) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new RegisterImageError('composite_failed', 'Este navegador não conseguiu juntar os prints.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, layout.width, layout.height);
  let y = 0;
  decoded.forEach((source, index) => {
    const panel = layout.panels[index];
    const x = Math.floor((layout.width - panel.width) / 2);
    context.drawImage(source.image, x, y, panel.width, panel.height);
    y += panel.height;
    if (index === 0) {
      context.fillStyle = '#111827';
      context.fillRect(0, y, layout.width, layout.separatorHeight);
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `700 ${Math.max(11, Math.min(16, Math.floor(layout.separatorHeight * 0.38)))}px sans-serif`;
      context.fillText('FIM DO PRINT 1  •  INÍCIO DO PRINT 2', layout.width / 2, y + layout.separatorHeight / 2);
      y += layout.separatorHeight;
    }
  });
}

export async function composeRegisterImages(entries, dependencies = {}) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > REGISTER_MAX_IMAGES) {
    throw new RegisterImageError('invalid_image_count', 'Selecione 1 ou 2 prints.');
  }
  for (const entry of entries) decodedDataUrlBytes(entry?.dataUrl);
  if (entries.length === 1) {
    if (decodedDataUrlBytes(entries[0].dataUrl) > REGISTER_MAX_DECODED_BYTES) {
      throw new RegisterImageError('invalid_image', 'O print precisa ter no máximo 3 MB.');
    }
    return entries[0].dataUrl;
  }

  const loadImage = dependencies.loadImage || loadBrowserImage;
  const createCanvas = dependencies.createCanvas || browserCanvas;
  const encodeCanvas = dependencies.encodeCanvas || encodeBrowserCanvas;
  const blobToDataUrl = dependencies.blobToDataUrl || readBlobAsDataUrl;
  let decoded;
  try {
    decoded = await Promise.all(entries.map((entry) => loadImage(entry.dataUrl)));
  } catch {
    throw new RegisterImageError('invalid_image', 'Não consegui abrir um dos prints. Tente outra imagem.');
  }

  for (const [candidateScale, quality] of COMPRESSION_CANDIDATES) {
    const layout = computeCompositeLayout(decoded, candidateScale);
    const canvas = createCanvas(layout.width, layout.height);
    drawComposite(canvas, decoded, layout);
    let blob;
    try {
      blob = await encodeCanvas(canvas, quality);
    } catch {
      continue;
    }
    if (blob?.size > 0 && blob.size <= REGISTER_MAX_DECODED_BYTES
        && ['image/webp', 'image/jpeg'].includes(blob.type)) {
      const dataUrl = await blobToDataUrl(blob);
      if (decodedDataUrlBytes(dataUrl) !== blob.size) {
        throw new RegisterImageError('composite_failed', 'A imagem composta ficou inconsistente. Tente novamente.');
      }
      return dataUrl;
    }
  }
  throw new RegisterImageError(
    'composite_too_large',
    'Não foi possível juntar os 2 prints em até 3 MB sem perder legibilidade. Recorte áreas vazias e tente novamente.',
  );
}
