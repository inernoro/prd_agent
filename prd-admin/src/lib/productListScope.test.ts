import { describe, expect, it } from 'vitest';
import { productListPath } from './productListScope';

describe('one product list with an optional product filter', () => {
  it('defaults to the same all-products route', () => {
    expect(productListPath('versions')).toBe('/product-agent?section=versions');
    expect(productListPath('requirements')).toBe('/product-agent?section=requirements');
  });

  it('carries the selected product without creating another list route', () => {
    const path = productListPath('requirements', 'product A');
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('section')).toBe('requirements');
    expect(params.get('productId')).toBe('product A');
    expect(path).not.toContain('/p/');
  });

  it('keeps the version tab and an explicit application action on old links', () => {
    const source = new URLSearchParams('tab=versions&versionTab=initiation&versionAction=apply');
    const params = new URLSearchParams(productListPath('versions', 'p1', source).split('?')[1]);
    expect(params.get('productId')).toBe('p1');
    expect(params.get('versionTab')).toBe('initiation');
    expect(params.get('versionAction')).toBe('apply');
    expect(params.has('tab')).toBe(false);
  });
});
