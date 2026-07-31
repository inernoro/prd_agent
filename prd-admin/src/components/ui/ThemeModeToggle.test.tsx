import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThemeModeToggle } from './ThemeModeToggle';

describe('ThemeModeToggle', () => {
  it('在深色状态提供明确的浅色切换动作', () => {
    const html = renderToStaticMarkup(<ThemeModeToggle mode="dark" onToggle={vi.fn()} />);

    expect(html).toContain('aria-label="切换到浅色外观"');
    expect(html).toContain('title="切换到浅色外观"');
    expect(html).toContain('>深色</span>');
  });

  it('在浅色状态提供明确的深色切换动作', () => {
    const html = renderToStaticMarkup(<ThemeModeToggle mode="light" onToggle={vi.fn()} />);

    expect(html).toContain('aria-label="切换到深色外观"');
    expect(html).toContain('title="切换到深色外观"');
    expect(html).toContain('>浅色</span>');
  });
});

// 2026-07-31 用户反馈：分享阅读页顶栏里主题钮是方块、旁边「返回知识库」是 36px 药丸，
// 一高一矮看着大小不一。inline 形态必须与同行按钮同高。
describe('ThemeModeToggle inline 形态', () => {
  it('inline 形态是 36px 高的横向药丸，图标与文字同行', () => {
    const html = renderToStaticMarkup(<ThemeModeToggle mode="dark" onToggle={vi.fn()} variant="inline" />);

    expect(html).toContain('min-height:36px');
    expect(html).toContain('>深色</span>');
    // 不再是「图标在上文字在下」的方块（stacked 用 flex-col + w-14）
    expect(html).not.toContain('flex-col');
    expect(html).not.toContain('w-14');
  });

  it('默认 stacked 形态保持原样，侧栏控件区不受影响', () => {
    const html = renderToStaticMarkup(<ThemeModeToggle mode="dark" onToggle={vi.fn()} />);
    expect(html).toContain('flex-col');
    expect(html).toContain('w-14');
  });
});
