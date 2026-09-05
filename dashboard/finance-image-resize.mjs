// Redimensiona a foto da fatura/extrato no navegador antes de enviar pra
// /api/finance/upload — o body da Vercel corta em 4,5 MB e 3 MB em base64
// já usa ~4 MB, então o navegador precisa garantir <=3 MB decodificados
// (mesmo limite de dashboard/register-image-composer.mjs, contrato próprio
// aqui: finanças manda 1 foto por vez, nunca compõe 2 prints).
export const FINANCE_MAX_SIDE = 2000;
export const FINANCE_MAX_BYTES = 3 * 1024 * 1024;
export const FINANCE_ALLOWED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

// [escala relativa ao tamanho já ajustado a FINANCE_MAX_SIDE, qualidade JPEG].
// As 3 primeiras rodadas só reduzem qualidade (a maior parte das fotos de
// celular cabe assim); as 3 últimas somam um corte de resolução pras fotos
// muito detalhadas (fatura extensa, várias colunas de texto).
export const FINANCE_QUALITY_LADDER = Object.freeze([
  [1, 0.85], [1, 0.78], [1, 0.70],
  [0.85, 0.80], [0.75, 0.78], [0.6, 0.75],
]);

const FINANCE_UNSUPPORTED_MESSAGE = 'Tire a foto em JPEG (iPhone: Ajustes > Câmera > Formatos > Mais compatível).';
const FINANCE_TOO_LARGE_MESSAGE = 'Não consegui reduzir a foto para caber em 3 MB. Tire outra com menos zoom ou boa iluminação.';

export class FinanceImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinanceImageError';
    this.code = code;
  }
}

// Assinaturas reais dos 3 tipos aceitos — confere os bytes, não o `file.type`
// declarado pelo navegador/SO. Export de fatura pelo WhatsApp é o caso comum:
// vira ".png" na Galeria mesmo sendo JPEG por dentro.
const FINANCE_SIGNATURES = Object.freeze({
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
});

function matchesBytes(header, signature) {
  if (header.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (header[i] !== signature[i]) return false;
  }
  return true;
}

// WebP não tem prefixo contíguo: 'RIFF' nos 4 primeiros bytes, tamanho no
// meio, 'WEBP' nos bytes 8-11.
function isRiffWebp(header) {
  if (header.length < 12) return false;
  const riff = String.fromCharCode(...header.slice(0, 4));
  const webp = String.fromCharCode(...header.slice(8, 12));
  return riff === 'RIFF' && webp === 'WEBP';
}

// Fator de escala (<=1) pra o lado mais longo caber em maxSide. Nunca amplia
// foto pequena — se já cabe, devolve 1.
export function computeResizeScale(width, height, maxSide = FINANCE_MAX_SIDE) {
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return Math.min(1, maxSide / longest);
}

export function decodedDataUrlBytes(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new FinanceImageError('unsupported_image', 'Não consegui preparar a foto para envio.');
  const payload = match[1];
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

// FileReader aceita File e Blob igual — 1 função só serve os dois usos
// (arquivo original no passthrough, blob do canvas no reencode).
function readAsDataUrl(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });
}

// Primeiros 12 bytes bastam pra cobrir a assinatura dos 3 tipos aceitos
// (PNG 8 bytes, JPEG 3 bytes, WebP RIFF/WEBP nos bytes 0-3 e 8-11).
function readFileHeaderBytes(file) {
  return file.slice(0, 12).arrayBuffer();
}

// Confere se os bytes reais do arquivo batem com o `file.type` declarado.
// Só entra em jogo quando o tipo já é um dos 3 aceitos (chamado depois do
// filtro de tipo/tamanho/lado) — arquivo com assinatura divergente cai pro
// caminho de reencode, que decodifica pelo conteúdo real e sempre gera um
// JPEG válido, então corrige o mimetype errado de graça.
async function matchesDeclaredType(file, readHeaderBytes) {
  let header;
  try {
    header = new Uint8Array(await readHeaderBytes(file));
  } catch {
    return false;
  }
  if (file.type === 'image/webp') return isRiffWebp(header);
  const signature = FINANCE_SIGNATURES[file.type];
  return signature ? matchesBytes(header, signature) : false;
}

// `imageOrientation: 'from-image'` respeita o EXIF de rotação do celular na
// decodificação — sem isso foto tirada na vertical vem deitada no canvas.
// Fallback via <img> cobre navegador sem createImageBitmap (raro) ou HEIC
// que ele recusa decodificar (nesse caso o <img> também falha — o catch de
// quem chama vira `unsupported_image`, é o comportamento certo).
async function loadBrowserImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { width: bitmap.width, height: bitmap.height, source: bitmap };
    } catch {
      // cai no fallback abaixo
    }
  }
  const dataUrl = await readAsDataUrl(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, source: image });
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

// Reencode sempre em JPEG: descarta EXIF/GPS de propósito (a orientação já
// foi aplicada na decodificação acima, então não perde nada visual).
function encodeBrowserCanvas(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))), 'image/jpeg', quality);
  });
}

// Prepara 1 foto pra /api/finance/upload. Passthrough sem tocar em canvas
// quando já cabe (tipo permitido + <=3 MB + lado <=2000 + assinatura de bytes
// bate com o `file.type` declarado) — preserva os bytes originais e evita
// reencode desnecessário. Senão, reduz resolução/qualidade pela escada até
// caber; se nenhuma rodada couber, `image_too_large`. `dependencies` permite
// injetar loadImage/createCanvas/encodeCanvas/blobToDataUrl/fileToDataUrl/
// readHeaderBytes pra testar sem DOM real (browser).
export async function prepareFinanceImage(file, dependencies = {}) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) {
    throw new FinanceImageError('unsupported_image', FINANCE_UNSUPPORTED_MESSAGE);
  }

  const loadImage = dependencies.loadImage || loadBrowserImage;
  const createCanvas = dependencies.createCanvas || browserCanvas;
  const encodeCanvas = dependencies.encodeCanvas || encodeBrowserCanvas;
  const blobToDataUrl = dependencies.blobToDataUrl || readAsDataUrl;
  const fileToDataUrl = dependencies.fileToDataUrl || readAsDataUrl;
  const readHeaderBytes = dependencies.readHeaderBytes || readFileHeaderBytes;

  let decoded;
  try {
    decoded = await loadImage(file);
  } catch {
    throw new FinanceImageError('unsupported_image', FINANCE_UNSUPPORTED_MESSAGE);
  }
  const width = Number(decoded?.width);
  const height = Number(decoded?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new FinanceImageError('unsupported_image', FINANCE_UNSUPPORTED_MESSAGE);
  }

  const mimeType = typeof file.type === 'string' ? file.type : '';
  const longestSide = Math.max(width, height);
  // Assinatura só é conferida quando as outras 3 condições já bateram —
  // arquivo grande demais/tipo não suportado vai reencodar de qualquer jeito,
  // não vale a leitura extra dos 12 bytes.
  const eligibleForPassthrough = FINANCE_ALLOWED_IMAGE_TYPES.includes(mimeType)
    && file.size <= FINANCE_MAX_BYTES
    && longestSide <= FINANCE_MAX_SIDE;
  const passthrough = eligibleForPassthrough && (await matchesDeclaredType(file, readHeaderBytes));

  if (passthrough) {
    const dataUrl = await fileToDataUrl(file);
    return { dataUrl, width, height, bytes: decodedDataUrlBytes(dataUrl), resized: false };
  }

  const fitScale = computeResizeScale(width, height, FINANCE_MAX_SIDE);
  const source = decoded.source;
  for (const [rungScale, quality] of FINANCE_QUALITY_LADDER) {
    const scale = fitScale * rungScale;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(targetWidth, targetHeight);
    const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (context && source) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, targetWidth, targetHeight);
    }
    let blob;
    try {
      blob = await encodeCanvas(canvas, quality);
    } catch {
      continue;
    }
    if (blob?.size > 0 && blob.size <= FINANCE_MAX_BYTES) {
      const dataUrl = await blobToDataUrl(blob);
      return { dataUrl, width: targetWidth, height: targetHeight, bytes: decodedDataUrlBytes(dataUrl), resized: true };
    }
  }
  throw new FinanceImageError('image_too_large', FINANCE_TOO_LARGE_MESSAGE);
}
