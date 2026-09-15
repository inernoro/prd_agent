import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAspectRatio, type SizesByResolution } from '../imageAspectOptions';

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 后端真实返回过的一档：16:9 走的是 1344x768，它不在静态 ASPECT_OPTIONS 里。 */
const CATALOG: SizesByResolution = {
  '1k': [
    { size: '1024x1024', aspectRatio: '1:1' },
    { size: '1344x768', aspectRatio: '16:9' },
  ],
  '2k': [{ size: '2048x1152', aspectRatio: '16:9' }],
  '4k': [],
};

describe('当前尺寸对应的比例', () => {
  it('【关键】后端目录里的尺寸，认目录说的比例', () => {
    // 这条就是那个 bug：1344x768 不在静态表里，只认静态表就会判成 1:1，
    // 用户选的 16:9 在换分辨率档时被静默改成方图（Codex PR #1476 P2）。
    expect(resolveAspectRatio('1344x768', CATALOG)).toBe('16:9');
    expect(resolveAspectRatio('2048x1152', CATALOG)).toBe('16:9');
  });

  it('大小写与空格不影响命中', () => {
    expect(resolveAspectRatio('  1344X768 ', CATALOG)).toBe('16:9');
  });

  it('目录里没有的尺寸退静态表', () => {
    // 静态表认得 1024x1024，目录传不传都该是 1:1。
    expect(resolveAspectRatio('1024x1024', null)).toBe('1:1');
    expect(resolveAspectRatio('1344x768', null), '静态表认不出来才落 1:1').toBe('1:1');
  });

  it('两边都认不出来才落 1:1，且不炸', () => {
    expect(resolveAspectRatio('', null)).toBe('1:1');
    expect(resolveAspectRatio('乱七八糟', CATALOG)).toBe('1:1');
  });

  it('目录优先于静态表：同一个尺寸两边说法不同时听目录的', () => {
    // 顺序错了这条就红。后端才是权威，静态表只是兜底。
    const odd: SizesByResolution = { '1k': [{ size: '1024x1024', aspectRatio: '4:3' }], '2k': [], '4k': [] };
    expect(resolveAspectRatio('1024x1024', odd)).toBe('4:3');
  });
});

describe('【关键】这个判断只留一份（形状 3 守卫）', () => {
  // 同一个「先查目录再退静态表」原来有三份：编辑器、ImageSizePicker、SizePickerPanel，
  // 前两份对、第三份漏了前半句，那就是这次的 bug。收敛之后不许再各写各的。
  it.each([
    'src/components/visual-agent/SizePickerPanel.tsx',
    'src/components/ui/ImageSizePicker.tsx',
  ])('%s 走共享判定', (rel) => {
    const src = read(rel);
    expect(src).toContain('resolveAspectRatio(');
    // 关键是不许再出现「只认静态表」的那个写法——它正是 bug 本身。
    expect(src, '不许再退回只认静态表的写法').not.toMatch(/detectAspectFromSize\([^)]*\)\s*(\?\?|\|\|)\s*'1:1'/);
  });
});
