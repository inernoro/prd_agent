import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeMediaQuery } from '../mediaQuerySubscribe';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const srcDirectory = path.resolve(testDirectory, '../..');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeMediaQuery', () => {
  it('现代浏览器走 addEventListener，并能取消订阅', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: add, removeEventListener: remove }),
    });

    const onChange = () => {};
    const unsubscribe = subscribeMediaQuery('(prefers-color-scheme: dark)', onChange);
    expect(add).toHaveBeenCalledWith('change', onChange);

    unsubscribe();
    expect(remove).toHaveBeenCalledWith('change', onChange);
  });

  it('老旧 Safari（只有 addListener）不抛，改走 addListener/removeListener', () => {
    const addLegacy = vi.fn();
    const removeLegacy = vi.fn();
    // Safari < 14 的 MediaQueryList：没有 addEventListener 这个属性
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addListener: addLegacy, removeListener: removeLegacy }),
    });

    const onChange = () => {};
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeMediaQuery('(prefers-color-scheme: dark)', onChange);
    }).not.toThrow();
    expect(addLegacy).toHaveBeenCalledWith(onChange);

    unsubscribe?.();
    expect(removeLegacy).toHaveBeenCalledWith(onChange);
  });

  it('两个 API 都没有时不抛（极端老环境），取消订阅也安全', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeMediaQuery('(prefers-color-scheme: dark)', () => {});
    }).not.toThrow();
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it('拿不到 matchMedia（SSR）时返回空取消函数', () => {
    vi.stubGlobal('window', {});
    expect(() => subscribeMediaQuery('(prefers-color-scheme: dark)', () => {})()).not.toThrow();
  });
});

describe('老旧 Safari 回退不许再抄第五份', () => {
  // 本仓库此前已有三处各写一份回退，第四处（外观「随系统」）漏写就直接踩中
  // 「addEventListener is not a function」。这条是棘轮：只许减不许增。
  const KNOWN_LEGACY_COPIES = [
    'lib/mediaQuerySubscribe.ts',        // 唯一实现，新代码都该用它
    'lib/useReducedMotion.ts',           // 存量，未迁移
    'stores/themeStore.ts',              // 存量，未迁移
    'hooks/usePrefersReducedMotion.ts',  // 存量，未迁移
  ];

  it('自己写 addListener 回退的文件不超出已知清单', () => {
    const offenders = listSourceFiles(srcDirectory)
      .filter((file) => !file.includes('__tests__') && !file.endsWith('.test.ts'))
      .filter((file) => /\.addListener\s*[?(]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDirectory, file).split(path.sep).join('/'))
      .filter((rel) => !KNOWN_LEGACY_COPIES.includes(rel));

    expect(offenders).toEqual([]);
  });

  it('「随系统」的订阅走共享实现，不自己 addEventListener', () => {
    const store = readFileSync(path.resolve(srcDirectory, 'stores/mobileThemeStore.ts'), 'utf8');
    expect(store).toContain('subscribeMediaQuery(SYSTEM_DARK_QUERY');
    // 只认真正的调用；注释里提到这个名字（解释为什么不能直接用它）不该判红。
    expect(store).not.toMatch(/\.addEventListener\s*\(/);
  });
});
