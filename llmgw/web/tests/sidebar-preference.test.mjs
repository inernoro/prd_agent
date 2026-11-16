import test from 'node:test';
import assert from 'node:assert/strict';
import { readSidebarCollapsed, saveSidebarCollapsed } from '../src/lib/sidebarPreference.ts';

test('菜单默认为图标栏，展开偏好可恢复，存储不可用时仍可进入', () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    assert.equal(readSidebarCollapsed(), true);
    saveSidebarCollapsed(false);
    assert.equal(readSidebarCollapsed(), false);
    saveSidebarCollapsed(true);
    assert.equal(readSidebarCollapsed(), true);
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readSidebarCollapsed(), true);
    assert.doesNotThrow(() => saveSidebarCollapsed(false));
  } finally { globalThis.localStorage = previous; }
});
