import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildTrackedRecordKey,
  isTrackedRecord,
  readTrackedRecords,
  toggleTrackedRecord,
} from './productRecordTrackStorage';

function mockSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  });
}

describe('productRecordTrackStorage', () => {
  beforeEach(() => {
    mockSessionStorage();
    sessionStorage.clear();
  });

  it('toggle 追踪与取消', () => {
    const added = toggleTrackedRecord({
      kind: 'requirement',
      productId: 'p1',
      recordId: 'r1',
      title: '海报绘制',
      recordNo: 'REQ-001',
    });
    expect(added).toBe(true);
    expect(isTrackedRecord('requirement', 'p1', 'r1')).toBe(true);
    expect(readTrackedRecords()).toHaveLength(1);
    const removed = toggleTrackedRecord({
      kind: 'requirement',
      productId: 'p1',
      recordId: 'r1',
      title: '海报绘制',
      recordNo: 'REQ-001',
    });
    expect(removed).toBe(false);
    expect(readTrackedRecords()).toHaveLength(0);
  });

  it('key 格式稳定', () => {
    expect(buildTrackedRecordKey('release', 'p1', 'rel1')).toBe('release:p1:rel1');
  });
});
