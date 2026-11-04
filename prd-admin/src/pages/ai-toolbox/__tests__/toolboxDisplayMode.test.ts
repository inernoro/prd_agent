import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOLBOX_DISPLAY_MODE,
  normalizeToolboxDisplayMode,
  readToolboxDisplayMode,
  writeToolboxDisplayMode,
} from '../toolboxDisplayMode';

describe('百宝箱展示方式偏好', () => {
  it('默认使用画廊模式', () => {
    expect(DEFAULT_TOOLBOX_DISPLAY_MODE).toBe('compact');
    expect(normalizeToolboxDisplayMode(null)).toBe('compact');
    expect(normalizeToolboxDisplayMode('unknown')).toBe('compact');
  });

  it.each(['compact', 'list'] as const)('保留合法模式 %s', (mode) => {
    expect(normalizeToolboxDisplayMode(mode)).toBe(mode);
  });

  it.each(['standard', 'showcase'])('旧偏好 %s 迁移到画廊模式', (value) => {
    expect(readToolboxDisplayMode({ getItem: () => value })).toBe('compact');
  });

  it('读取失败时安全回退到紧凑模式', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    };

    expect(readToolboxDisplayMode(storage)).toBe('compact');
  });

  it('写入展示偏好，写入失败时不影响页面', () => {
    const setItem = vi.fn();
    writeToolboxDisplayMode({ setItem }, 'list');
    expect(setItem).toHaveBeenCalledWith('ai-toolbox.pref.displayMode', 'list');

    expect(() =>
      writeToolboxDisplayMode(
        { setItem: () => { throw new Error('storage unavailable'); } },
        'compact',
      )
    ).not.toThrow();
  });
});
