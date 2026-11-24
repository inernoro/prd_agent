import { describe, expect, it, vi } from 'vitest';
import { avatarSourceToDataUrl, resolveGeneratedAvatarAsset } from '@/lib/avatarAi';

describe('avatarAi', () => {
  it('保留已有的图片 data URL，避免重复下载', async () => {
    const fetcher = vi.fn();
    const source = 'data:image/png;base64,aGVsbG8=';

    await expect(avatarSourceToDataUrl(source, fetcher)).resolves.toBe(source);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('使用无水印原图和资产摘要作为确认替换依据', () => {
    const result = resolveGeneratedAvatarAsset({
      index: 0,
      url: 'https://example.com/watermarked.png',
      originalUrl: 'https://example.com/original.png',
      originalSha256: 'A'.repeat(64),
    });

    expect(result).toEqual({
      previewUrl: 'https://example.com/original.png',
      assetSha256: 'a'.repeat(64),
    });
  });

  it('拒绝缺少资产摘要的生成结果，避免使用不可追溯的外链替换头像', () => {
    expect(() => resolveGeneratedAvatarAsset({ index: 0, url: 'https://example.com/avatar.png' }))
      .toThrow('没有返回可用的头像资产');
  });
});
