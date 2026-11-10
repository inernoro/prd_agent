import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ImageQuickEditInput } from './ImageQuickEditInput';

describe('ImageQuickEditInput', () => {
  it('使用中文可访问名称与恢复提示', () => {
    const html = renderToStaticMarkup(<ImageQuickEditInput onSubmit={vi.fn()} />);

    expect(html).toContain('aria-label="快捷编辑描述"');
    expect(html).toContain('placeholder="描述要如何调整这张图"');
    expect(html).not.toContain('Describe your edit here');
  });
});
