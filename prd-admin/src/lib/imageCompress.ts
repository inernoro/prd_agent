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

/**
 * 视觉创作画布上传专用压缩参数。
 * 画布卡顿的真凶是「像素尺寸」而非「文件体积」——一张 4000x4000 的图哪怕只有 3MB，
 * 解码进浏览器位图缓存也要 ~64MB。所以这里按最长边封顶来缩，而不是只看 byte。
 */
export const CANVAS_UPLOAD_MAX_DIMENSION = 2560;
export const CANVAS_UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // 留足后端 15MB 上限的余量

/**
 * 上传到视觉创作画布前的图片压缩：把最长边缩到 maxDimension 以内，体积控制在 maxBytes 以内。
 * - 已在尺寸/体积阈值内且是浏览器友好格式的图片：原样返回，不重新编码。
 * - GIF：跳过（动图，canvas 重绘会丢动画）。
 * - 解码失败 / 浏览器不支持 canvas：放行原图，交由后端兜底，不阻断上传。
 */
export async function compressImageForCanvas(
  file: File,
  opts?: { maxDimension?: number; maxBytes?: number },
): Promise<{ file: File; compressed: boolean }> {
  const maxDimension = opts?.maxDimension ?? CANVAS_UPLOAD_MAX_DIMENSION;
  const maxBytes = opts?.maxBytes ?? CANVAS_UPLOAD_MAX_BYTES;

  // 动图保持原样：canvas 重绘会把多帧拍扁成单帧
  if (file.type === 'image/gif') return { file, compressed: false };

  let image: HTMLImageElement;
  try {
    image = await loadImage(file);
  } catch {
    // 解码失败不阻断上传，放行原图由后端兜底
    return { file, compressed: false };
  }

  const maxEdge = Math.max(image.width, image.height);
  const webFriendly = file.type === 'image/jpeg' || file.type === 'image/webp' || file.type === 'image/png';
  // 尺寸和体积都达标且格式友好：无需重新编码
  if (maxEdge <= maxDimension && file.size <= maxBytes && webFriendly) {
    return { file, compressed: false };
  }

  const baseScale = maxEdge > 0 ? Math.min(1, maxDimension / maxEdge) : 1;
  // 原图是 jpeg 就保持 jpeg；否则优先 webp（保留透明通道），兜底 jpeg
  const outputMimeTypes = file.type === 'image/jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg'];

  let bestBlob: Blob | null = null;
  for (let scale = baseScale; scale >= baseScale * MIN_COMPRESS_SCALE; scale *= SCALE_REDUCE_FACTOR) {
    const width = Math.max(1, Math.floor(image.width * scale));
    const height = Math.max(1, Math.floor(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file, compressed: false };

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

  // 收尾兜底：缩到下限仍超 maxBytes。
  // 关键：只要尺寸被缩过（baseScale < 1，即原图最长边超过 maxDimension），bestBlob 的像素尺寸
  // 必 ≤ maxDimension（循环内所有 scale ≤ baseScale）。此时即使字节比原图还大也必须返回——
  // 画布卡顿由解码后的位图像素尺寸决定，封顶尺寸才是目的；返回原图会让大尺寸图漏过封顶继续卡。
  const dimensionWasReduced = baseScale < 1;
  if (bestBlob && (dimensionWasReduced || bestBlob.size < file.size)) {
    return { file: buildOutputFile(bestBlob, file), compressed: true };
  }
  return { file, compressed: false };
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
