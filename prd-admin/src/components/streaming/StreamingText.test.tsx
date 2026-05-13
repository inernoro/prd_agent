import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamingText } from './StreamingText';

describe('StreamingText maxTailChars (尾部窗口 + 绝对 offset key 不闪烁)', () => {
  function countTokenSpans(html: string): number {
    return (html.match(/streaming-u/g) || []).length;
  }

  it('text 短于 maxTailChars 时, 渲染全部 token span', () => {
    const html = renderToStaticMarkup(
      <StreamingText text="hello world" streaming maxTailChars={100} cursor={false} />,
    );
    // "hello" + "world" = 2 word spans (中间空格 ws 不算)
    expect(countTokenSpans(html)).toBe(2);
  });

  it('text 远大于 maxTailChars 时, span 数量被 cap 住 (防爆炸)', () => {
    // 10000 字符全英文 = ~1700 个词
    const longText = ('word '.repeat(2000)).trim();
    const html = renderToStaticMarkup(
      <StreamingText text={longText} streaming maxTailChars={100} cursor={false} />,
    );
    const count = countTokenSpans(html);
    // 100 字符尾部最多容纳 ~20 个 'word ' (每词5字符)
    // 应 << 1700 (假如未 cap 会渲染的数量)
    expect(count).toBeLessThan(50);
    expect(count).toBeGreaterThan(0);
  });

  it('text 远大于 maxTailChars 时, 输出带省略符 …', () => {
    const longText = 'a'.repeat(500);
    const html = renderToStaticMarkup(
      <StreamingText text={longText} streaming maxTailChars={100} cursor={false} />,
    );
    expect(html).toContain('…');
  });

  it('未传 maxTailChars 时, 全文 token 都渲染', () => {
    const text = 'word '.repeat(50).trim();
    const html = renderToStaticMarkup(
      <StreamingText text={text} streaming cursor={false} />,
    );
    expect(countTokenSpans(html)).toBe(50);
  });

  it('CJK 单字切分 + maxTailChars 配合', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const html = renderToStaticMarkup(
      <StreamingText text={text} streaming maxTailChars={10} cursor={false} />,
    );
    // 末尾 10 个 CJK 单字 → 10 个 span (省略符 '…' 在 ws 之外)
    const count = countTokenSpans(html);
    expect(count).toBeLessThanOrEqual(11);
    expect(count).toBeGreaterThan(5);
  });
});
