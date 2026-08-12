import { toast } from '@/lib/toast';
import { apiDownload } from '@/services/real/apiClient';

function filenameSafe(value: string) {
  return String(value || 'image')
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .replaceAll(':', '-')
    .replaceAll('*', '-')
    .replaceAll('?', '-')
    .replaceAll('"', '-')
    .replaceAll('<', '-')
    .replaceAll('>', '-')
    .replaceAll('|', '-')
    .slice(0, 80) || 'image';
}

function extensionForMime(mime: string) {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/avif') return '.avif';
  if (normalized === 'image/svg+xml') return '.svg';
  return '.png';
}

/**
 * 下载视觉创作生成图。
 * 对象存储图片通常与管理端跨域，浏览器会忽略跨域链接上的 download 属性。
 */
export async function downloadGeneratedImage(src: string, filename: string) {
  const source = String(src || '').trim();
  if (!source) return;

  try {
    const isRemote = /^https?:\/\//i.test(source);
    const blob = isRemote
      ? (await apiDownload(
          `/api/visual-agent/image-gen/download?url=${encodeURIComponent(source)}`,
          `${filenameSafe(filename)}.png`,
        )).blob
      : await fetch(source).then((response) => {
          if (!response.ok) throw new Error('download failed');
          return response.blob();
        });
    if (!blob.type.toLowerCase().startsWith('image/')) throw new Error('invalid image response');
    const blobUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `${filenameSafe(filename)}${extensionForMime(blob.type)}`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    }
  } catch {
    toast.error('下载图片失败', '请稍后重试；图片仍保留在当前作品中。');
  }
}
