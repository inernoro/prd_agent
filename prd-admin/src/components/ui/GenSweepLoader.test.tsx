import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GenSweepLoader } from './GenSweepLoader';

describe('GenSweepLoader', () => {
  it('普通生图和 Frame 等待态都接入共享的可见区域定位', () => {
    const loader = readFileSync(new URL('./GenSweepLoader.tsx', import.meta.url), 'utf8');
    const canvas = readFileSync(new URL('../../pages/ai-chat/AdvancedVisualAgentTab.tsx', import.meta.url), 'utf8');
    expect(loader).toMatch(/generationProgressPlacement\(rect,/);
    const usages = canvas.match(/<GenSweepLoader\b[^>]*\/>/g) ?? [];
    expect(usages).toHaveLength(2);
    for (const usage of usages) expect(usage).toContain('viewportRef={stageRef}');
  });

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
