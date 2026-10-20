import { describe, expect, it } from 'vitest';
import { fail, ok } from '@/types/api';
import { loadProductVersionList, mergeVersionListSnapshot } from './productVersionList';

describe('version list loading through existing product-scoped APIs', () => {
  it('publishes a fast product before a slow product finishes, using immutable snapshots', async () => {
    type Row = { id: string; productId: string; updatedAt: string };
    let resolveSlow!: (value: ReturnType<typeof ok<{ items: Row[] }>>) => void;
    const slow = new Promise<ReturnType<typeof ok<{ items: Row[] }>>>((resolve) => { resolveSlow = resolve; });
    const snapshots: Row[][] = [];
    let finished = false;
    const request = loadProductVersionList(['slow', 'fast'], (id) => id === 'slow' ? slow : Promise.resolve(ok({ items: [{ id, productId: id, updatedAt: '2026-10-20' }] })), {
      isCurrent: () => true, onProgress: () => undefined, onItems: (items) => snapshots.push(items),
    }).then((result) => { finished = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect(snapshots[0].map((item) => item.id)).toEqual(['fast']);
    resolveSlow(ok({ items: [{ id: 'slow', productId: 'slow', updatedAt: '2026-10-19' }] }));
    const result = await request;
    expect(result.items).toHaveLength(2);
    expect(snapshots[0]).toHaveLength(1);
  });

  it('ignores a late response after the view has expired', async () => {
    let current = true;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const snapshots: unknown[] = [];
    const request = loadProductVersionList(['old'], async (productId) => {
      await wait;
      return ok({ items: [{ id: 'old', productId, updatedAt: '' }] });
    }, { isCurrent: () => current, onProgress: () => undefined, onItems: (items) => snapshots.push(items) });
    current = false;
    release();
    await request;
    expect(snapshots).toEqual([]);
  });

  it('keeps prior rows during a same-scope refresh and replaces matching ids without duplicates', () => {
    expect(mergeVersionListSnapshot([{ id: 'old', updatedAt: '1' }, { id: 'same', updatedAt: '2' }], [{ id: 'same', updatedAt: '3' }])).toEqual([
      { id: 'same', updatedAt: '3' }, { id: 'old', updatedAt: '1' },
    ]);
  });

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
