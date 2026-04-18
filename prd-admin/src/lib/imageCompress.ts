/**
 * 通用图片压缩工具
 * 提取自 ReportEditor，供周报编辑器、日常记录粘贴图片等场景共享。
 */

export const MAX_RICH_TEXT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_COMPRESS_DIMENSION = 4096;
const MIN_COMPRESS_SCALE = 0.4;
const SCALE_REDUCE_FACTOR = 0.86;
const MIN_COMPRESS_QUALITY = 0.4;
const QUALITY_REDUCE_STEP = 0.08;
export const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)]+)\)/;

export function hasMarkdownImage(content: string): boolean {
  return MARKDOWN_IMAGE_REGEX.test(content);
}

function inferExtFromMime(mime: string): string {
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

async function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片解码失败，请重试'));
    };
    img.src = objectUrl;
  });
}

function buildOutputFile(blob: Blob, originFile: File): File {
  const mimeType = blob.type || 'image/jpeg';
  const ext = inferExtFromMime(mimeType);
  const rawName = (originFile.name || '').trim();
  const baseName = rawName ? rawName.replace(/\.[^/.]+$/, '') : `pasted-image-${Date.now()}`;
  return new File([blob], `${baseName}.${ext}`, { type: mimeType, lastModified: Date.now() });
}

export async function compressImageToLimit(file: File, maxBytes: number): Promise<{ file: File; compressed: boolean }> {
  if (file.size <= maxBytes) return { file, compressed: false };

  const image = await loadImage(file);
  const ratio = image.width > 0 && image.height > 0
    ? Math.min(1, MAX_COMPRESS_DIMENSION / Math.max(image.width, image.height))
    : 1;

  let bestBlob: Blob | null = null;
  const outputMimeTypes = file.type === 'image/jpeg' || file.type === 'image/webp'
    ? [file.type, 'image/jpeg']
    : ['image/webp', 'image/jpeg'];

  for (let scale = ratio; scale >= MIN_COMPRESS_SCALE; scale *= SCALE_REDUCE_FACTOR) {
    const width = Math.max(1, Math.floor(image.width * scale));
    const height = Math.max(1, Math.floor(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片压缩，请更换浏览器重试');

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    for (const mimeType of outputMimeTypes) {
      for (let quality = 0.92; quality >= MIN_COMPRESS_QUALITY; quality -= QUALITY_REDUCE_STEP) {
        const blob = await toBlob(canvas, mimeType, quality);
        if (!blob) continue;
        if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
        if (blob.size <= maxBytes) {
          return { file: buildOutputFile(blob, file), compressed: true };
        }
      }
    }
  }

  if (bestBlob && bestBlob.size <= maxBytes) {
    return { file: buildOutputFile(bestBlob, file), compressed: true };
  }

  throw new Error('图片压缩后仍超过 5MB，请裁剪后重试');
}
