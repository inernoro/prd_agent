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
