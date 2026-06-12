import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFavoriteProductIds, toggleFavoriteProductId } from './productFavoriteStorage';

describe('productFavoriteStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      store: {} as Record<string, string>,
      getItem(key: string) { return this.store[key] ?? null; },
      setItem(key: string, value: string) { this.store[key] = value; },
    });
  });

  it('toggles favorite ids', () => {
    expect(toggleFavoriteProductId('p1')).toBe(true);
    expect(readFavoriteProductIds().has('p1')).toBe(true);
    expect(toggleFavoriteProductId('p1')).toBe(false);
    expect(readFavoriteProductIds().has('p1')).toBe(false);
  });
});
