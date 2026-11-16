import { describe, expect, it } from 'vitest';
import { collectDocumentEntryPages, recordDocumentEntryChanges, reconcileDocumentEntries, type DocumentEntryPage } from './documentEntryPages';
import { fail, ok } from '@/types/api';
import type { DocumentEntry } from '@/services/contracts/documentStore';
const entry = (id: string) => ({ id } as DocumentEntry);
describe('文档游标遍历', () => {
  it('补齐过程中创建、修改和删除的条目不被旧的目录页覆盖', () => {
    const a = entry('a'), b = entry('b'), c = entry('c'), added = entry('new');
    const edited = { ...a, title: '修改后的标题' };
    const changes = new Map<string, DocumentEntry | null>();
    recordDocumentEntryChanges(changes, [a, b], [edited, added]);
    expect(reconcileDocumentEntries([a, b, c], changes)).toEqual([edited, c, added]);
    // 后续由轮询带入的条目被删除，也不能在最后的旧页回执中复活。
    recordDocumentEntryChanges(changes, [edited, c, added], [edited, added]);
    expect(reconcileDocumentEntries([a, b, c], changes)).toEqual([edited, added]);
  });
  it('200条状态轮询只合并返回项，不能截掉已补齐的5000条目录', () => {
    const full = Array.from({ length: 5000 }, (_, n) => entry(String(n)));
    const polled = full.slice(0, 200).map(e => ({ ...e, title: '归档已完成' }));
    const updated = reconcileDocumentEntries(full, new Map(polled.map(e => [e.id, e])));
    expect(updated).toHaveLength(5000);
    expect(updated[0].title).toBe('归档已完成');
    expect(updated[4999]).toBe(full[4999]);
  });
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
  it('传递每页的当前写权限，续页失去写权限时不保留首批授权', async () => {
    const first: DocumentEntryPage[] = [];
    const result = await collectDocumentEntryPages(async cursor => ok(cursor
      ? { items: [entry('b')], total: 2, canWrite: false }
      : { items: [entry('a')], total: 2, canWrite: true, nextCursor: 'next' }), page => first.push(page));
    expect(first[0].canWrite).toBe(true);
    expect(result.success && result.data.canWrite).toBe(false);
  });
});
