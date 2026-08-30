import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenSweepLoader } from './GenSweepLoader';

describe('GenSweepLoader', () => {
  it('未传屏幕尺寸时保持计时条和等待信息', () => {
    const html = renderToStaticMarkup(<GenSweepLoader createdAt={Date.now()} />);

    expect(html).toContain('data-testid="generation-progress-bar"');
    expect(html).toContain('已耗时');
    expect(html).toContain('预计 ~');
  });

  it.each([[200, 120], [300, 180], [240, 480], [600, 200]])('屏幕尺寸 %s×%s 显示计时条', (screenW, screenH) => {
    const html = renderToStaticMarkup(<GenSweepLoader screenW={screenW} screenH={screenH} />);
    expect(html).toContain('data-testid="generation-progress-bar"');
  });

  it.each([[199, 120], [200, 119], [50, 50], [600, 80], [0, 0]])('屏幕尺寸 %s×%s 只保留流光防止标签遮挡', (screenW, screenH) => {
    const html = renderToStaticMarkup(<GenSweepLoader screenW={screenW} screenH={screenH} />);
    expect(html).not.toContain('data-testid="generation-progress-bar"');
    expect(html).toContain('gen-sweep__glare');
  });
});
