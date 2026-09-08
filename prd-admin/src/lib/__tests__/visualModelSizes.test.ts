import { describe, expect, it } from 'vitest';
import {
  flattenSizes,
  hasAnySize,
  normalizeSizesByResolution,
  reconcileSize,
} from '../visualModelSizes';

const S = (list: Array<[string, string]>) => list.map(([size, aspectRatio]) => ({ size, aspectRatio }));

describe('normalizeSizesByResolution', () => {
  it('缺档、脏数据都归一成三档，不抛', () => {
    const out = normalizeSizesByResolution({ '1k': [{ size: '1024x1024', aspectRatio: '1:1' }, { size: '' }, null], '4k': 'nope' });
    expect(out['1k']).toEqual([{ size: '1024x1024', aspectRatio: '1:1' }]);
    expect(out['2k']).toEqual([]);
    expect(out['4k']).toEqual([]);
  });

  it('传 undefined 也给一个完整形状', () => {
    expect(normalizeSizesByResolution(undefined)).toEqual({ '1k': [], '2k': [], '4k': [] });
  });
});

describe('hasAnySize / flattenSizes', () => {
  it('三档全空 = 没有可用数据', () => {
    expect(hasAnySize({ '1k': [], '2k': [], '4k': [] })).toBe(false);
    expect(hasAnySize(null)).toBe(false);
  });

  it('拍平按 1k → 2k → 4k 的顺序', () => {
    const sizes = { '1k': S([['a', '']]), '2k': S([['b', '']]), '4k': S([['c', '']]) };
    expect(flattenSizes(sizes).map((o) => o.size)).toEqual(['a', 'b', 'c']);
  });
});

describe('reconcileSize', () => {
  const sizes = {
    '1k': S([['1024x1024', '1:1'], ['1344x768', '16:9'], ['768x1344', '9:16']]),
    '2k': S([['2048x2048', '1:1']]),
    '4k': S([]),
  };

  it('当前尺寸被支持 → 不动（返回 null）', () => {
    expect(reconcileSize('1344x768', sizes)).toBeNull();
    expect(reconcileSize('1344X768', sizes)).toBeNull();
  });

  it('没有可用数据 → 不动，绝不乱改', () => {
    // 拿不到就说拿不到：适配器没命中时静默把用户的尺寸改掉，是最难排查的一类改写。
    expect(reconcileSize('1920x1080', null)).toBeNull();
    expect(reconcileSize('1920x1080', { '1k': [], '2k': [], '4k': [] })).toBeNull();
  });

  it('【关键】不支持时按比例优先，而不是按面积', () => {
    // 这个 fixture 是**特意造得让两种实现给出不同答案**的：
    // 1920x1080 面积恰好 2073600，和 1:1 的 1440x1440 一模一样，
    // 而 16:9 的 1344x768 面积差得远。按面积排会选方图，按比例排才选宽屏。
    // 上一版 fixture 里面积最近的恰好也是 16:9，那条用例两种实现都绿，区分不了——
    // 一个不会红的用例比没有用例更糟。
    const tricky = {
      '1k': S([['1440x1440', '1:1'], ['1344x768', '16:9']]),
      '2k': S([]),
      '4k': S([]),
    };
    expect(reconcileSize('1920x1080', tricky)).toBe('1344x768');
  });

  it('比例打平时保住清晰度档位（比面积）', () => {
    const square = { '1k': S([['1024x1024', '1:1']]), '2k': S([['2048x2048', '1:1']]), '4k': S([]) };
    expect(reconcileSize('4096x4096', square)).toBe('2048x2048');
    expect(reconcileSize('512x512', square)).toBe('1024x1024');
  });

  it('竖版不会被纠正成横版', () => {
    expect(reconcileSize('1080x1920', sizes)).toBe('768x1344');
  });

  it('当前尺寸解析不出来 → 退第一个可用值，不崩', () => {
    expect(reconcileSize('auto', sizes)).toBe('1024x1024');
    expect(reconcileSize('', sizes)).toBe('1024x1024');
  });
});
