// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VersionAppearance } from './VersionAppearance';

it('默认浅色，保存切换结果，并在离开版本页时恢复原外观', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  const host = document.createElement('div');
  const component = createRoot(host);
  try {
    await act(async () => component.render(<VersionAppearance />));
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(root.getAttribute('data-theme')).toBe('light');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(JSON.parse(localStorage.getItem('map-product-version-appearance') ?? '{}').state.mode).toBe('dark');

    await act(async () => toggle.click());
    expect(root.getAttribute('data-theme')).toBe('light');
  } finally {
    await act(async () => component.unmount());
    localStorage.removeItem('map-product-version-appearance');
    vi.unstubAllGlobals();
  }
  expect(root.hasAttribute('data-theme')).toBe(false);
});
