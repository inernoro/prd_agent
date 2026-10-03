import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCornerClearance, CLEARANCE_VAR, CORNER_CLEARANCE } from '../cornerClearance';

// 测试环境没有 DOM：用一个只实现 style.setProperty / removeProperty 的最小替身，真跑声明逻辑
const props = new Map<string, string>();
const original = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  props.clear();
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k),
      },
    },
  };
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = original;
});

describe('右下角主操作按钮的让位声明', () => {
  it('挂载时声明占位，卸载后撤销', () => {
    const release = claimCornerClearance();
    expect(props.get(CLEARANCE_VAR)).toBe(CORNER_CLEARANCE);
    release();
    expect(props.has(CLEARANCE_VAR)).toBe(false);
  });

  it('两个按钮同时挂载时，先卸载的那个不能把声明撤掉', () => {
    const a = claimCornerClearance();
    const b = claimCornerClearance();
    a();
    expect(props.get(CLEARANCE_VAR)).toBe(CORNER_CLEARANCE);
    b();
    expect(props.has(CLEARANCE_VAR)).toBe(false);
  });

  it('同一个撤销函数调两次，不会把另一个按钮的声明一起减掉', () => {
    const a = claimCornerClearance();
    const b = claimCornerClearance();
    a();
    a();
    expect(props.get(CLEARANCE_VAR)).toBe(CORNER_CLEARANCE);
    b();
    expect(props.has(CLEARANCE_VAR)).toBe(false);
  });
});
