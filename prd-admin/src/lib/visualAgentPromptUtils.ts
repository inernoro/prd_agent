import { ASPECT_OPTIONS } from '@/lib/imageAspectOptions';

const INLINE_IMAGE_RX = /^\[IMAGE([^\]]*)\]\s*/;
const INLINE_IMAGE_LEGACY_RX = /^\[IMAGE=([^\]|]+)(?:\|([^\]]+))?\]\s*/;
const SIZE_TOKEN_RE_SRC = String.raw`\(\s*@size\s*:\s*(\d{2,5}\s*[xX×＊*]\s*\d{2,5})\s*\)\s*`;
const SIZE_TOKEN_RE = new RegExp(SIZE_TOKEN_RE_SRC, 'g');

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseInlineImageKv(body: string): { src?: string; name?: string } {
  const out: Record<string, string> = {};
  const parts = String(body ?? '')
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim().toLowerCase();
    const v = p.slice(idx + 1).trim();
    if (!k || !v) continue;
    out[k] = safeDecodeURIComponent(v);
  }
  return { src: out.src, name: out.name };
}

export function extractInlineImageToken(raw: string): { src: string; name?: string; clean: string } | null {
  const s = String(raw ?? '');
  const m2 = INLINE_IMAGE_RX.exec(s);
  if (m2) {
    const body = String(m2[1] ?? '');
    const kv = parseInlineImageKv(body);
    const src = String(kv.src ?? '').trim();
    const name = String(kv.name ?? '').trim();
    const clean = s.slice(m2[0].length);
    if (!src) return null;
    return { src, name: name || undefined, clean };
  }
  const m1 = INLINE_IMAGE_LEGACY_RX.exec(s);
  if (!m1) return null;
  const src = String(m1[1] ?? '').trim();
  const nameEncoded = String(m1[2] ?? '').trim();
  const name = nameEncoded ? safeDecodeURIComponent(nameEncoded) : '';
  const clean = s.slice(m1[0].length);
  if (!src) return null;
  return { src, name: name || undefined, clean };
}

export function buildInlineImageToken(src: string, name?: string): string {
  const s = String(src ?? '').trim();
  if (!s) return '';
  if (s.startsWith('data:') || s.startsWith('blob:')) return '';
  const n = String(name ?? '').trim();
  const safeSrc = encodeURIComponent(s);
  const safeName = n ? encodeURIComponent(n) : '';
  return safeName ? `[IMAGE src=${safeSrc} name=${safeName}] ` : `[IMAGE src=${safeSrc}] `;
}

/**
 * 为多张图片构建内联图片标记
 * @param images 图片数组，每个包含 src 和可选的 name
 * @returns 多个 [IMAGE ...] 标记拼接的字符串
 */
export function buildMultipleInlineImageTokens(
  images: Array<{ src: string; name?: string }>
): string {
  if (!images || images.length === 0) return '';
  return images
    .map((img) => buildInlineImageToken(img.src, img.name))
    .filter(Boolean)
    .join('');
}

export function tryParseWxH(size: string | null | undefined): { w: number; h: number } | null {
  const s = String(size ?? '').trim();
  if (!s) return null;
  const m = /^(\d{2,5})\s*[xX×＊*]\s*(\d{2,5})$/.exec(s);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

export function extractSizeToken(raw: string): { size: string | null; cleanText: string } {
  const text = String(raw ?? '');
  if (!text) return { size: null, cleanText: '' };
  let lastSize: string | null = null;
  let cleanText = text;
  let m: RegExpExecArray | null;
  while ((m = SIZE_TOKEN_RE.exec(text))) {
    const sizeRaw = String(m?.[1] ?? '').trim();
    const parsed = tryParseWxH(sizeRaw);
    lastSize = parsed ? `${parsed.w}x${parsed.h}` : sizeRaw.replace(/\s+/g, '');
  }
  cleanText = text.replace(SIZE_TOKEN_RE, '').replace(/\s{2,}/g, ' ').trim();
  return { size: lastSize, cleanText };
}

export function parseInlinePrompt(raw: string): {
  text: string;
  size: string | null;
  inlineImage?: { src: string; name?: string };
} {
  const inline = extractInlineImageToken(raw);
  const inlineClean = inline ? inline.clean : String(raw ?? '');
  const sized = extractSizeToken(inlineClean);
  return {
    text: String(sized.cleanText ?? '').trim(),
    size: sized.size,
    inlineImage: inline ? { src: inline.src, name: inline.name } : undefined,
  };
}

function detectTierFromRefImage(w: number, h: number): '1k' | '2k' | '4k' {
  const area = w * h;
  if (area >= 8_000_000) return '4k';
  if (area >= 2_500_000) return '2k';
  return '1k';
}

export function computeRequestedSizeByRefRatio(ref: { w: number; h: number } | null | undefined): string | null {
  if (!ref || !ref.w || !ref.h) return null;
  const w0 = Math.max(1, Math.round(ref.w));
  const h0 = Math.max(1, Math.round(ref.h));
  const r = w0 / h0;
  if (!Number.isFinite(r) || r <= 0) return null;

  const tier = detectTierFromRefImage(w0, h0);

  const actualRatio = w0 / h0;
  let bestMatch: typeof ASPECT_OPTIONS[0] | null = null;
  let bestRatioDiff = Infinity;

  for (const opt of ASPECT_OPTIONS) {
    const [rw, rh] = opt.id.split(':').map(Number);
    if (!rw || !rh) continue;
    const optRatio = rw / rh;
    const diff = Math.abs(actualRatio - optRatio);
    if (diff / optRatio < 0.05 && diff < bestRatioDiff) {
      bestRatioDiff = diff;
      bestMatch = opt;
    }
  }

  if (bestMatch) {
    return tier === '1k' ? bestMatch.size1k : tier === '2k' ? bestMatch.size2k : bestMatch.size4k;
  }

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w0, h0);
  const a = Math.max(1, Math.round(w0 / g));
  const b = Math.max(1, Math.round(h0 / g));
  const ratioId = `${a}:${b}` as any;

  const exactMatch = ASPECT_OPTIONS.find((x) => x.id === ratioId);
  if (exactMatch) {
    return tier === '1k' ? exactMatch.size1k : tier === '2k' ? exactMatch.size2k : exactMatch.size4k;
  }

  let closestOpt: typeof ASPECT_OPTIONS[0] | null = null;
  let closestDiff = Infinity;
  for (const opt of ASPECT_OPTIONS) {
    const [rw, rh] = opt.id.split(':').map(Number);
    if (!rw || !rh) continue;
    const optRatio = rw / rh;
    const diff = Math.abs(r - optRatio);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestOpt = opt;
    }
  }

  if (closestOpt) {
    return tier === '1k' ? closestOpt.size1k : tier === '2k' ? closestOpt.size2k : closestOpt.size4k;
  }

  return tier === '1k' ? '1024x1024' : tier === '2k' ? '2048x2048' : '4096x4096';
}

export async function readImageSizeFromFile(file: File): Promise<{ w: number; h: number } | null> {
  try {
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!dataUrl) return null;
    return await readImageSizeFromSrc(dataUrl);
  } catch {
    return null;
  }
}

export async function readImageSizeFromSrc(src: string): Promise<{ w: number; h: number } | null> {
  try {
    const img = new Image();
    img.src = src;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('load image failed'));
    });
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  } catch {
    return null;
  }
}
