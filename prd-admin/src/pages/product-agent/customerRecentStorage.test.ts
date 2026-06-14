import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readRecentCustomerIds, touchRecentCustomerIds } from './customerRecentStorage';

describe('customerRecentStorage', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    });
  });

  it('touch 后最近客户置顶且去重', () => {
    touchRecentCustomerIds(['c1', 'c2']);
    touchRecentCustomerIds(['c3', 'c1']);
    expect(readRecentCustomerIds()).toEqual(['c3', 'c1', 'c2']);
  });
});
