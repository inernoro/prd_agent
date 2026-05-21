/**
 * 封面图上传前的客户端压缩。
 *
 * 目标：用户原图无论多大，前端先 resize 到不超过 1280×720（16:9）+ 转 webp，
 * 再上传，省带宽 + 减后端处理压力。
 *
 * 调用方仍保留原始 File（用于「移除封面」等场景），仅上传 path 走压缩后版本。
 */

export interface ResizeResult {
  /** 压缩后的可上传 File（mime = image/webp） */
  file: File;
  /** 原始字节数（提示用） */
  originalBytes: number;
  /** 压缩后字节数 */
  resizedBytes: number;
  /** 实际输出尺寸 */
  width: number;
  height: number;
}

const MAX_W = 1280;
const MAX_H = 720;
const QUALITY = 0.82;

/**
 * 用 ImageBitmap + Canvas 等比缩放。Safari 14+ 全支持。
 * 不裁切比例 —— 16:9 由用户拖动裁切框决定（本函数只压尺寸，不强制比例）。
 */
export async function resizeCoverImage(file: File): Promise<ResizeResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('非图片文件');
  }
  const originalBytes = file.size;

  // GIF 直接保留：动图过 canvas 会变成静态首帧
  if (file.type === 'image/gif') {
    return {
      file,
      originalBytes,
      resizedBytes: originalBytes,
      width: 0,
      height: 0,
    };
  }

  const bitmap = await createImageBitmap(file);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // 已经在尺寸范围内 + 文件不大 → 不动
  const inLimit = srcW <= MAX_W && srcH <= MAX_H;
  if (inLimit && originalBytes <= 400 * 1024) {
    bitmap.close?.();
    return { file, originalBytes, resizedBytes: originalBytes, width: srcW, height: srcH };
  }

  const scale = Math.min(MAX_W / srcW, MAX_H / srcH, 1);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('压缩失败'))),
      'image/webp',
      QUALITY,
    );
  });

  // 极端情况：压完反而比原图大（小尺寸 PNG），回退用原图
  if (blob.size >= originalBytes && inLimit) {
    return { file, originalBytes, resizedBytes: originalBytes, width: srcW, height: srcH };
  }

  const renamed = file.name.replace(/\.[^.]+$/, '.webp');
  return {
    file: new File([blob], renamed, { type: 'image/webp' }),
    originalBytes,
    resizedBytes: blob.size,
    width: w,
    height: h,
  };
}
