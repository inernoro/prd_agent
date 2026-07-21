import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_CONFIG } from '@/types/theme';
import { applyThemeToDOM, clearThemeFromDOM } from '../themeApplier';

describe('themeApplier', () => {
  beforeEach(() => {
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as DOMStringMap,
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
        getPropertyValue: (key: string) => properties.get(key) ?? '',
      },
    } as unknown as HTMLElement;

    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  });

  afterEach(() => {
    clearThemeFromDOM();
    vi.unstubAllGlobals();
  });

  it('只设置主题语义属性，并清理旧版内联颜色变量', () => {
    const root = document.documentElement;
    root.style.setProperty('--bg-base', '#000000');
    root.style.setProperty('--glass-bg-start', 'rgba(0, 0, 0, 0.5)');

    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, material: 'solid' });

    expect(root.dataset.material).toBe('solid');
    expect(root.style.getPropertyValue('--bg-base')).toBe('');
    expect(root.style.getPropertyValue('--glass-bg-start')).toBe('');
  });

  it('材质切换只改变 data-material，不向组件注入另一套颜色', () => {
    const root = document.documentElement;

    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, material: 'glass' });

    expect(root.dataset.material).toBe('glass');
    expect(root.style.getPropertyValue('--bg-base')).toBe('');
    expect(root.style.getPropertyValue('--glass-bg-start')).toBe('');
  });
});
