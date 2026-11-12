import { apiRequest } from './apiClient';
import type { DocumentEntry } from '../contracts/documentStore';
import { fail, ok, type ApiResponse } from '@/types/api';

export type NavigationPage = {
  items: DocumentEntry[];
  before: string;
  nextCursor: string | null;
  sharedEntryIds: string[];
};

/** 只发布完整结果；失败、取消或不前进的游标不能伪装成完整目录。 */
export async function collectNavigationPages(
  fetchPage: (cursor?: string, before?: string) => Promise<ApiResponse<NavigationPage>>,
  signal?: AbortSignal,
): Promise<ApiResponse<{ items: DocumentEntry[]; sharedEntryIds: string[] }>> {
  const entries = new Map<string, DocumentEntry>();
  const shared = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let before: string | undefined;
  do {
    if (signal?.aborted) return fail('CANCELLED', '加载已取消');
    const response = await fetchPage(cursor, before);
    if (!response.success) return response;
    if (signal?.aborted) return fail('CANCELLED', '加载已取消');
    const page = response.data;
    before ??= page.before;
    for (const entry of page.items) entries.set(entry.id, entry);
    for (const id of page.sharedEntryIds) shared.add(id);
    cursor = page.nextCursor ?? undefined;
    if (cursor && (cursors.has(cursor) || page.items.length === 0))
      return fail('INVALID_CURSOR', '目录未加载完整，请刷新重试');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return ok({ items: [...entries.values()], sharedEntryIds: [...shared] });
}

export function loadDocumentNavigation(
  storeId: string, options: { keyword?: string; searchContent?: boolean; signal?: AbortSignal } = {},
) {
  return collectNavigationPages((cursor, before) => {
    const params = new URLSearchParams({ pageSize: '500' });
    if (cursor) params.set('afterId', cursor);
    if (before) params.set('before', before);
    if (options.keyword) params.set('keyword', options.keyword);
    if (options.searchContent) params.set('searchContent', 'true');
    return apiRequest<NavigationPage>(`/api/document-store/stores/${encodeURIComponent(storeId)}/navigation?${params}`, {
      method: 'GET', signal: options.signal,
    });
  }, options.signal);
}
