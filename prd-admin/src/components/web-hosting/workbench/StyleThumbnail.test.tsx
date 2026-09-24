import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_FRAME_REGISTRY,
  SAMPLE_UNAVAILABLE_TEXT,
  StyleThumbnail,
  sampleFailureText,
  sampleScale,
} from './StyleThumbnail';

describe('StyleThumbnail 缩放：固定画布渲染，再按容器宽度缩', () => {
  it('网页样张按 1200x760 画布，封面按 16:9 的 1280x720', () => {
    expect(SAMPLE_FRAME_REGISTRY.page).toEqual({ width: 1200, height: 760 });
    expect(SAMPLE_FRAME_REGISTRY.slides.width / SAMPLE_FRAME_REGISTRY.slides.height).toBeCloseTo(16 / 9);
  });

  it('缩放比 = 容器宽 / 画布宽；量不到宽度时按该档兜底宽度', () => {
    expect(sampleScale(300, 'page', 'thumb')).toBeCloseTo(0.25);
    expect(sampleScale(640, 'slides', 'preview')).toBeCloseTo(0.5);
    expect(sampleScale(0, 'page', 'thumb')).toBeCloseTo(240 / 1200);
    expect(sampleScale(0, 'page', 'preview')).toBeCloseTo(640 / 1200);
  });
});

describe('StyleThumbnail 状态：取回前是样张形状的骨架，没有样张就说清楚', () => {
  it('首帧（还没进入视口）渲染骨架，不出现 iframe', () => {
    const html = renderToStaticMarkup(<StyleThumbnail designSystemId="editorial" title="标题" />);
    expect(html).toContain('样张加载中');
    expect(html).toContain('data-sample-state="idle"');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('aspect-ratio:1200 / 760');
  });

  it('设计系统不在目录里时不取样张、不拿别的风格顶替，直接说明原因', () => {
    const html = renderToStaticMarkup(<StyleThumbnail designSystemId={null} />);
    expect(html).toContain(SAMPLE_UNAVAILABLE_TEXT);
    expect(html).toContain('data-sample-state="unavailable"');
    expect(html).not.toContain('样张加载中');
  });

  it('失败文案带上人话原因；拿不到原因时也给出下一步', () => {
    expect(sampleFailureText(new Error('网络连接异常，请检查网络后重试。')))
      .toBe('样张没加载出来：网络连接异常，请检查网络后重试。');
    expect(sampleFailureText('boom')).toBe('样张没加载出来：请稍后重试。');
    expect(sampleFailureText(new Error('   '))).toBe('样张没加载出来：请稍后重试。');
  });

  it('组件源码里颜色只走 token（双皮肤棘轮之外的直接断言）', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./StyleThumbnail.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).toContain('sandbox=""');
    expect(source).toContain('srcDoc={state.html}');
  });
});

describe('StyleThumbnail 预览区铺满', () => {
  it('fill 模式不锁横向比例、占满父容器高度', () => {
    // 2026-09-24 手机验收：预览页签里样张缩成一小条，下面大片留白。
    const html = renderToStaticMarkup(<StyleThumbnail designSystemId="editorial" fit="fill" />);
    expect(html).not.toContain('aspect-ratio');
    expect(html).toContain('h-full');
  });

  it('默认仍是等比缩略图', () => {
    const html = renderToStaticMarkup(<StyleThumbnail designSystemId="editorial" />);
    expect(html).toContain('aspect-ratio:1200 / 760');
  });
});
