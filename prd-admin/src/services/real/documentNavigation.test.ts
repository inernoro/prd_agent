import { describe, expect, it, vi } from 'vitest';
import { collectNavigationPages, type NavigationPage } from './documentNavigation';
import { fail, ok } from '@/types/api';
import type { DocumentEntry } from '../contracts/documentStore';

const entry = (id: string) => ({ id } as DocumentEntry);
const page = (items: string[], nextCursor: string | null): NavigationPage => ({
  items: items.map(entry), nextCursor, before: '2026-01-01T00:00:00Z', sharedEntryIds: items,
});

describe('目录增量读取', () => {
  it('完整消费游标、固定时间边界并按 id 去重', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok(page(['a', 'b'], 'b')))
      .mockResolvedValueOnce(ok(page(['b', 'c'], null)));
    const result = await collectNavigationPages(fetch);
    expect(fetch.mock.calls[1]).toEqual(['b', '2026-01-01T00:00:00Z']);
    expect(result.success && result.data.items.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(result.success && result.data.sharedEntryIds).toEqual(['a', 'b', 'c']);
  });
  it('下一页权限撤销时不返回部分目录', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok(page(['a'], 'a')))
      .mockResolvedValueOnce(fail('NOT_FOUND', '文档空间不存在'));
    expect((await collectNavigationPages(fetch)).success).toBe(false);
  });
  it('重复游标终止并报告未完整加载', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(page(['a'], 'a')));
    expect((await collectNavigationPages(fetch)).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('切换空间取消后丢弃在途响应', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); return ok(page(['a'], null)); });
    expect((await collectNavigationPages(fetch, controller.signal)).success).toBe(false);
  });
});
