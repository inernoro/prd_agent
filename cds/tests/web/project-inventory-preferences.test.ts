import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProjectInventoryPreferences, writeProjectInventoryPreferences } from '../../web/src/lib/projectInventoryPreferences.js';

afterEach(() => vi.unstubAllGlobals());

describe('项目页显示偏好可恢复且不依赖浏览器存储可用', () => {
  it('刷新后恢复列表视图与置顶项目', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    expect(readProjectInventoryPreferences()).toEqual({ view: 'grid', pinnedProjectIds: [] });
    const selected = { view: 'list' as const, pinnedProjectIds: ['project-2', 'project-1'] };
    expect(writeProjectInventoryPreferences(selected)).toBe(true);
    expect(readProjectInventoryPreferences()).toEqual(selected);
  });

  it('损坏数据、非法视图与非法项目 ID 不会破坏列表', () => {
    let value = 'invalid-json';
    vi.stubGlobal('window', { localStorage: { getItem: () => value } });
    expect(readProjectInventoryPreferences()).toEqual({ view: 'grid', pinnedProjectIds: [] });
    value = JSON.stringify({ view: 'unknown', pinnedProjectIds: [null, 1, '', 'project-1', 'project-1'] });
    expect(readProjectInventoryPreferences()).toEqual({ view: 'grid', pinnedProjectIds: ['project-1'] });
  });

  it('浏览器拒绝存储时读写安全降级，调用方能提示仅本页有效', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage denied'); } });
    expect(readProjectInventoryPreferences()).toEqual({ view: 'grid', pinnedProjectIds: [] });
    expect(writeProjectInventoryPreferences({ view: 'list', pinnedProjectIds: ['project-1'] })).toBe(false);
  });
});
