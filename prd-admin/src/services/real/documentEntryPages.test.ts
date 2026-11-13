import { describe, expect, it } from 'vitest';
import { collectDocumentEntryPages, type DocumentEntryPage } from './documentEntryPages';
import { fail, ok } from '@/types/api';
import type { DocumentEntry } from '@/services/contracts/documentStore';
const entry = (id: string) => ({ id } as DocumentEntry);
describe('文档游标遍历', () => {
  it.each([200, 1000, 5000])('完整遍历 %i 条，并合并每页分享标记', async count => {
    const first: DocumentEntryPage[] = [];
    const visited: (string | undefined)[] = [];
    const result = await collectDocumentEntryPages(async cursor => {
      visited.push(cursor);
      const start = Number(cursor ?? 0);
      const end = Math.min(start + 500, count);
      return ok({ items: Array.from({ length: end - start }, (_, n) => entry(String(n + start))),
        total: count, nextCursor: end < count ? String(end) : null, sharedEntryIds: [String(end - 1)] });
    }, page => first.push(page));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new Set(result.data.items.map(e => e.id)).size).toBe(count);
    expect(result.data.items.at(-1)?.id).toBe(String(count - 1));
    expect(result.data.sharedEntryIds).toHaveLength(Math.ceil(count / 500));
    expect(visited).toHaveLength(Math.ceil(count / 500));
    expect(first).toHaveLength(1);
  });
  it('重复条目去重，不用变化的 total 提前停止', async () => {
    let calls = 0;
    const result = await collectDocumentEntryPages(async cursor => {
      calls++;
      return ok(cursor ? { items: [entry('a'), entry('b')], total: 0 } :
        { items: [entry('a')], total: 1, nextCursor: 'next' });
    });
    expect(calls).toBe(2);
    expect(result.success && result.data.items.map(e => e.id)).toEqual(['a', 'b']);
  });
  it('后续页失败或游标停滞时，不能把部分列表当完整结果', async () => {
    const failed = await collectDocumentEntryPages(async cursor => cursor ? fail('UNAUTHORIZED', '已失去访问权') :
      ok({ items: [entry('a')], total: 2, nextCursor: 'next' }));
    expect(failed.success).toBe(false);
    const stalled = await collectDocumentEntryPages(async () => ok({ items: [entry('a')], total: 2, nextCursor: 'same' }));
    expect(stalled.success).toBe(false);
  });
});
