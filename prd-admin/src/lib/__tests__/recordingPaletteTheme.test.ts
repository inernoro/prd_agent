// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentThemeMode } from '../themeTransition';

const paletteCss = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../styles/recording-design-palette.css'),
  'utf8',
);

const DARK_PALETTE = { background: '#0b0d0f', card: '#15181b', text: '#edeeef' };
const LIGHT_PALETTE = { background: '#f5f5f2', card: '#ffffff', text: '#16181a' };

let style: HTMLStyleElement;
let fixture: HTMLDivElement;
let previousTheme: string | null;

function stubSystemTheme(prefersDark: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && prefersDark,
    media: query,
  })));
}

function readPalette(element: Element) {
  // 读取 CSSOM 层叠后生效的局部 token，而不是要求某个选择器字面存在。
  // jsdom 不解析 background:var(...)，所以不把背景色的空值当成通过。
  const computed = getComputedStyle(element);
  return {
    background: computed.getPropertyValue('--bg-primary').trim().toLowerCase(),
    card: computed.getPropertyValue('--bg-card').trim().toLowerCase(),
    text: computed.getPropertyValue('--text-primary').trim().toLowerCase(),
  };
}

function expectPalette(expected: typeof DARK_PALETTE) {
  const panels = fixture.querySelectorAll('.recording-design-palette');
  expect(panels).toHaveLength(2);
  panels.forEach((panel) => expect(readPalette(panel)).toEqual(expected));
}

beforeEach(() => {
  previousTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme');
  style = document.createElement('style');
  style.textContent = paletteCss;
  document.head.append(style);
  fixture = document.createElement('div');
  // 采集弹层经 portal 挂在壳外；处理/结果页可在壳内。两种位置都必须跟随根主题。
  fixture.innerHTML = '<main><section class="recording-design-palette"></section></main>'
    + '<aside class="recording-design-palette"></aside><div class="unrelated-panel"></div>';
  document.body.append(fixture);
});

afterEach(() => {
  style.remove();
  fixture.remove();
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', previousTheme);
  vi.unstubAllGlobals();
});

describe('录音局部调色板跟随真实全局主题协议', () => {
  it('默认根节点无 data-theme 时，壳内页面与壳外弹层都是深色', () => {
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expectPalette(DARK_PALETTE);
  });

  it('从浅色选择黑夜后，移除根属性即可切换录音面板，不写入 dark 属性', () => {
    applyDocumentThemeMode('light', '/document-store');
    expectPalette(LIGHT_PALETTE);

    expect(applyDocumentThemeMode('dark', '/document-store')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expectPalette(DARK_PALETTE);
  });

  it('显式白天不受系统深色影响，来回切换不残留旧局部皮肤', () => {
    stubSystemTheme(true);
    for (const mode of ['light', 'dark', 'light'] as const) {
      applyDocumentThemeMode(mode, '/document-store');
      expectPalette(mode === 'light' ? LIGHT_PALETTE : DARK_PALETTE);
    }
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it.each([true, false])('随系统解析 prefersDark=%s 后，局部皮肤与根主题一致', (prefersDark) => {
    stubSystemTheme(prefersDark);
    expect(applyDocumentThemeMode('system', '/document-store')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe(prefersDark ? null : 'light');
    expectPalette(prefersDark ? DARK_PALETTE : LIGHT_PALETTE);
  });

  it('系统偏好从明到暗变化后复用同一批面板，不需要重挂载', () => {
    for (const prefersDark of [false, true, false]) {
      stubSystemTheme(prefersDark);
      applyDocumentThemeMode('system', '/recording/result/example');
      expectPalette(prefersDark ? DARK_PALETTE : LIGHT_PALETTE);
    }
  });

  it.each(['light', 'dark'] as const)('%s 下不会把录音专属 token 写到根节点或普通面板', (mode) => {
    applyDocumentThemeMode(mode, '/document-store');
    expect(readPalette(document.documentElement)).toEqual({ background: '', card: '', text: '' });
    expect(readPalette(fixture.querySelector('.unrelated-panel')!)).toEqual({ background: '', card: '', text: '' });
  });
});
