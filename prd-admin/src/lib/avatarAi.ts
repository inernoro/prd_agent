import type { ImageGenImage } from '@/services/contracts/imageGen';

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export const AVATAR_AI_PROMPT_PRESETS = [
  '保留五官特征，改成简洁的职业头像',
  '保留人物特征，改成细腻的手绘插画风格',
  '保留人物和服装，只把背景改成干净的浅色背景',
] as const;

function assertImageBlob(blob: Blob): void {
  if (!blob.type.toLowerCase().startsWith('image/')) {
    throw new Error('头像图片格式不受支持');
  }
  if (blob.size <= 0) throw new Error('头像图片内容为空');
  if (blob.size > MAX_REFERENCE_BYTES) throw new Error('头像图片过大，最大支持 10MB');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取当前头像失败'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(blob);
  });
}

export async function avatarSourceToDataUrl(
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const source = sourceUrl.trim();
  if (!source) throw new Error('当前头像不可用，请先上传一张头像');
  if (source.startsWith('data:image/')) return source;

  const response = await fetcher(source);
  if (!response.ok) throw new Error('读取当前头像失败');
  const blob = await response.blob();
  assertImageBlob(blob);
  return await blobToDataUrl(blob);
}

export function resolveGeneratedAvatarAsset(image: ImageGenImage | null | undefined): {
  previewUrl: string;
  assetSha256: string;
} {
  const previewUrl = image?.originalUrl?.trim() || image?.url?.trim() || '';
  const assetSha256 = image?.originalSha256?.trim().toLowerCase() || '';
  if (!previewUrl || !assetSha256) {
    throw new Error('图片生成结束，但没有返回可用的头像资产');
  }
  return { previewUrl, assetSha256 };
}
