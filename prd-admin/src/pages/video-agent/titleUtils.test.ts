import { describe, expect, it } from 'vitest';
import { resolveVideoTitle, sanitizeVideoTitle } from './titleUtils';

describe('video title display', () => {
  it('removes legacy OCR markdown from restored project titles', () => {
    const raw = '<!-- 这是一张图片，ocr 内容为： --> ![](https://cdn.example.com/ocr.png)';

    expect(sanitizeVideoTitle(raw)).toBe('');
    expect(resolveVideoTitle(raw, '2026-07-16T08:30:00Z')).toContain('视频草稿');
  });
});
