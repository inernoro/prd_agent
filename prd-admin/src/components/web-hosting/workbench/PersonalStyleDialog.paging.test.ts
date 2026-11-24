import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import { appendSitePage, firstSitePage, hasMoreSitePages, type SitePickerState } from './personalStyleModel';

function site(id: string, over: Partial<HostedSite> = {}): HostedSite {
  return { id, title: id, ownerUserId: 'u1', sourceType: 'upload', entryFile: 'index.html', ...over } as HostedSite;
}
const ok = (ids: string[], total: number) => ({ success: true as const, data: { items: ids.map((id) => site(id)), total } });

describe('我的风格：网页选择器分页', () => {
  it('第一页回来后知道还有没有下一页', () => {
    const state = firstSitePage('', ok(['a', 'b'], 5), 'u1');
    expect(state).toMatchObject({ status: 'ready', scanned: 2, total: 5 });
    expect(hasMoreSitePages(state)).toBe(true);
    expect(hasMoreSitePages(firstSitePage('', ok(['a'], 1), 'u1'))).toBe(false);
  });

  it('继续加载按已看过的条数往后接，去重，看完就没有下一页', () => {
    const first = firstSitePage('复盘', ok(['a', 'b'], 3), 'u1');
    const next = appendSitePage(first, { query: '复盘', skip: 2 }, ok(['b', 'c'], 3), 'u1');
    expect(next.status === 'ready' && next.items.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(hasMoreSitePages(next)).toBe(false);
  });

  it('迟到的翻页响应：搜索词已变或起点对不上就原样丢弃', () => {
    const current: SitePickerState = firstSitePage('B', ok(['b1', 'b2'], 10), 'u1');
    expect(appendSitePage(current, { query: 'A', skip: 2 }, ok(['a3'], 10), 'u1')).toBe(current);
    expect(appendSitePage(current, { query: 'B', skip: 50 }, ok(['b3'], 10), 'u1')).toBe(current);
  });

  it('翻页失败只收起加载态，不丢已有列表；第一页失败给出可读原因', () => {
    const loading = { ...(firstSitePage('', ok(['a'], 5), 'u1') as Extract<SitePickerState, { status: 'ready' }>), loadingMore: true };
    const after = appendSitePage(loading, { query: '', skip: 1 }, { success: false }, 'u1');
    expect(after).toMatchObject({ status: 'ready', loadingMore: false, scanned: 1 });
    expect(firstSitePage('', { success: false, error: { message: '读不到' } }, 'u1')).toEqual({ status: 'failed', message: '读不到' });
  });
});

// 接线守卫：对话框把分页交给上面这几个纯函数，而不是自己另写一套。
describe('对话框接线', () => {
  const dialog = readFileSync(path.resolve(__dirname, 'PersonalStyleDialog.tsx'), 'utf8');
  it('第一页、继续加载、是否还有下一页都走共享判定', () => {
    expect(dialog).toContain('firstSitePage(');
    expect(dialog).toContain('appendSitePage(');
    expect(dialog).toContain('hasMoreSitePages(');
  });
});
