import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { THEME_MODE_OPTIONS, THEME_MODE_ORDER, THEME_MODE_REGISTRY } from '../themeModeRegistry';
import { resolveThemeMode } from '@/stores/mobileThemeStore';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const srcDirectory = path.resolve(testDirectory, '../..');
const read = (relative: string) => readFileSync(path.resolve(srcDirectory, relative), 'utf8');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// 本套件跑在 node 环境（仓库没配 jsdom），所以要连 window 一起造 ——
// 只 stub matchMedia 的话 `typeof window === 'undefined'` 那条兜底会先命中，
// 用例会假绿（两个方向都返回 dark，而 dark 恰好是其中一个期望值）。
function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: query.includes('dark') ? prefersDark : !prefersDark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('外观偏好注册表', () => {
  it('横排就是白天 / 黑夜 / 随系统三项，顺序固定', () => {
    expect(THEME_MODE_ORDER).toEqual(['light', 'dark', 'system']);
    expect(THEME_MODE_OPTIONS.map((o) => o.label)).toEqual(['白天', '黑夜', '随系统']);
  });

  it('三项各自带图标，且图标互不相同（太阳 / 月亮 / 电脑）', () => {
    const icons = THEME_MODE_OPTIONS.map((o) => o.icon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(3);
    // 断言的是「装配结果」而不是源码里出现过这几个名字：图标对调、三项都赋同一个，
    // 光扫 import 是发现不了的。
    expect(THEME_MODE_REGISTRY.light.icon.displayName ?? THEME_MODE_REGISTRY.light.icon.name).toMatch(/Sun/i);
    expect(THEME_MODE_REGISTRY.dark.icon.displayName ?? THEME_MODE_REGISTRY.dark.icon.name).toMatch(/Moon/i);
    expect(THEME_MODE_REGISTRY.system.icon.displayName ?? THEME_MODE_REGISTRY.system.icon.name).toMatch(/Monitor/i);
  });
});

describe('随系统的解析', () => {
  it('系统偏暗时 system 解析成 dark', () => {
    stubMatchMedia(true);
    expect(resolveThemeMode('system')).toBe('dark');
  });

  it('系统偏亮时 system 解析成 light', () => {
    stubMatchMedia(false);
    expect(resolveThemeMode('system')).toBe('light');
  });

  it('用户显式选了白天/黑夜就不看系统', () => {
    stubMatchMedia(true);
    expect(resolveThemeMode('light')).toBe('light');
    stubMatchMedia(false);
    expect(resolveThemeMode('dark')).toBe('dark');
  });
});

describe('三处外观入口都走同一份注册表', () => {
  // 这三处历史上各写一份 OPTIONS 数组。谁再抄一份，选了「随系统」后那一处会三个都不高亮，
  // 而且不会有任何测试红 —— 所以这条守卫盯的是「有没有人在用注册表」。
  it.each([
    ['侧栏用户菜单', 'layouts/AppShell.tsx'],
    ['设置-皮肤设置', 'pages/settings/ThemeSkinEditor.tsx'],
    ['周报 Agent 工具条', 'pages/report-agent/components/ThemeControl.tsx'],
  ])('%s 消费 THEME_MODE_OPTIONS', (_name, relative) => {
    expect(read(relative)).toContain('THEME_MODE_OPTIONS');
  });

  it('落 DOM 的那一步先过 resolveThemeMode，不把 system 直接当值用', () => {
    expect(read('lib/themeTransition.ts')).toContain("resolveThemeMode(mode) === 'light'");
  });
});

describe('拿明暗做分支的地方不许直接比较偏好（否则「随系统」下选错皮肤）', () => {
  // 加 'system' 这一档的涟漪：这两处原本写 `themeMode === 'dark'` / `themeMode === 'light'`，
  // 偏好是 'system' 时永远判 false —— DOM 已经暗了，组件却按浅色渲染，且 tsc 全绿。
  it.each([
    ['移动端首页皮肤', 'pages/MobileHomePage.tsx'],
    ['分享阅读页主题钮', 'pages/library/LibraryShareViewPage.tsx'],
  ])('%s 用 useResolvedThemeMode', (_name, relative) => {
    const source = read(relative);
    expect(source).toContain('useResolvedThemeMode');
    expect(source).not.toMatch(/themeMode === '(dark|light)'/);
  });
});

describe('AppShell 之外的独立全屏页必须走共享 hook 落主题', () => {
  // 这些页面不在 AppShell 里，各自写 effect 时都漏了同一件事：偏好是 'system' 时
  // store 里的 mode 不变，只把 mode 放进 deps 的 effect 不会重跑，DOM 停在旧主题。
  // 收敛成 useApplyDocumentTheme 之后，这条守卫防止下一个独立页再抄一份错的。
  const ALLOWED_CALLERS = [
    'hooks/useApplyDocumentTheme.ts', // 唯一实现
    'layouts/AppShell.tsx',           // 壳层自己要管 data-theme 的所有权，单独一份
    'lib/themeTransition.ts',         // 定义处
  ];

  it('applyDocumentThemeMode 只允许在唯一实现与壳层里被调用', () => {
    const offenders = listSourceFiles(srcDirectory)
      .filter((file) => !file.includes('__tests__') && !file.endsWith('.test.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('applyDocumentThemeMode('))
      .map((file) => path.relative(srcDirectory, file).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED_CALLERS.includes(rel));

    expect(offenders).toEqual([]);
  });

  it.each([
    ['分享阅读页', 'pages/library/LibraryShareViewPage.tsx'],
    ['数据同步授权页', 'pages/data-sync/DataSyncAuthorizePage.tsx'],
    ['数据同步回调页', 'pages/data-sync/DataSyncCallbackPage.tsx'],
  ])('%s 用 useApplyDocumentTheme', (_name, relative) => {
    expect(read(relative)).toContain('useApplyDocumentTheme(');
  });

  it('hook 与壳层都把解析后的明暗放进了 effect deps', () => {
    expect(read('hooks/useApplyDocumentTheme.ts')).toContain('[mode, resolved, pathname]');
    expect(read('layouts/AppShell.tsx')).toContain('[mobileThemeMode, resolvedThemeMode, location.pathname]');
  });
});
