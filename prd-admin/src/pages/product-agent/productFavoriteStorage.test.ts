import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFavoriteProductIds, toggleFavoriteProductId } from './productFavoriteStorage';

describe('productFavoriteStorage', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { Object.keys(store).forEach((key) => { delete store[key]; }); },
      key: () => null,
      get length() { return Object.keys(store).length; },
    });
  });

  it('toggles favorite ids', () => {
    expect(toggleFavoriteProductId('p1')).toBe(true);
    expect(readFavoriteProductIds().has('p1')).toBe(true);
    expect(toggleFavoriteProductId('p1')).toBe(false);
    expect(readFavoriteProductIds().has('p1')).toBe(false);
  });
});
