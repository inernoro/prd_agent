import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenSweepLoader } from './GenSweepLoader';

describe('GenSweepLoader', () => {
  it('进度条按宿主宽度收缩且不使用画布反向缩放', () => {
    const html = renderToStaticMarkup(<GenSweepLoader createdAt={Date.now()} />);

    expect(html).toContain('data-testid="generation-progress-bar"');
    expect(html).toContain('max-width:calc(100% - 16px)');
    expect(html).toContain('transform:translateX(-50%)');
    expect(html).not.toContain('scale(var(--invZoom))');
  });
});
