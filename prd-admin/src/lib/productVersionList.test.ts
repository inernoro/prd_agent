import { describe, expect, it } from 'vitest';
import { fail, ok } from '@/types/api';
import { loadProductVersionList } from './productVersionList';

describe('version list loading through existing product-scoped APIs', () => {
  it('deduplicates products, caps concurrency at four and preserves each row product', async () => {
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    const result = await loadProductVersionList(['p1', 'p2', 'p3', 'p4', 'p5', 'p1'], async (productId) => {
      calls.push(productId);
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active -= 1;
      return ok({ items: [{ id: productId, productId, updatedAt: productId }] });
    }, { isCurrent: () => true, onProgress: () => undefined });
    expect(maximum).toBeLessThanOrEqual(4);
    expect(calls).toHaveLength(5);
    expect(result.items.map((item) => item.productId)).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
    expect(result.failedProductIds).toEqual([]);
  });

  it('reports incomplete data instead of treating a failed product as an empty list', async () => {
    const result = await loadProductVersionList(['p1'], async () => fail('NETWORK_ERROR', '连接中断'), {
      isCurrent: () => true, onProgress: () => undefined,
    });
    expect(result.failedProductIds).toEqual(['p1']);
    expect(result.items).toEqual([]);
  });

  it('does not dispatch requests for an expired view', async () => {
    let calls = 0;
    await loadProductVersionList(['p1'], async (productId) => {
      calls += 1;
      return ok({ items: [{ id: 'i1', productId, updatedAt: '' }] });
    }, { isCurrent: () => false, onProgress: () => undefined });
    expect(calls).toBe(0);
  });
});
