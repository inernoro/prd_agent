import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenSweepLoader } from './GenSweepLoader';

describe('GenSweepLoader', () => {
  it('有参考图时渲染朦胧预览、点阵与可读状态', () => {
    const html = renderToStaticMarkup(
      <GenSweepLoader createdAt={Date.now()} previewSrc="https://example.com/reference.webp" />,
    );

    expect(html).toContain('src="https://example.com/reference.webp"');
    expect(html).toContain('gen-sweep__preview');
    expect(html).toContain('gen-sweep__dots');
    expect(html).toContain('正在生成');
    expect(html).toContain('role="status"');
  });

  it('纯文生图使用环境底稿，不渲染虚假的预览图片', () => {
    const html = renderToStaticMarkup(<GenSweepLoader createdAt={Date.now()} />);

    expect(html).toContain('gen-sweep__ambient');
    expect(html).not.toContain('gen-sweep__preview');
    expect(html).toContain('gen-sweep__track');
  });
});
