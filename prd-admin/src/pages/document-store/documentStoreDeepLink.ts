export interface DocumentStoreDeepLink {
  storeId: string | null;
  entryId: string | null;
}

export const QUICK_RECORD_QUERY_PARAM = 'quickRecord';

export function hasQuickRecordRequest(search: string): boolean {
  return new URLSearchParams(search).get(QUICK_RECORD_QUERY_PARAM) === '1';
}

export function withoutQuickRecordRequest(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(QUICK_RECORD_QUERY_PARAM);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * `tab` 是列表页的一次性导航意图。进入具体知识库后只能消费它本身，不能顺带
 * 删除 `store` / `entry`，否则刷新详情页时会与 history 状态恢复互相改写 URL。
 */
export function withoutDocumentStoreTabRequest(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('tab');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function parseDocumentStoreDeepLink(search: string): DocumentStoreDeepLink {
  const params = new URLSearchParams(search);
  const storeId = params.get('store');
  return {
    storeId,
    entryId: storeId ? params.get('entry') : null,
  };
}

export function withDocumentStoreEntry(
  search: string,
  storeId: string,
  entryId: string | null | undefined,
): string {
  const params = new URLSearchParams(search);
  params.set('store', storeId);
  if (entryId) params.set('entry', entryId);
  else params.delete('entry');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function withoutOrphanedDocumentStoreEntry(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has('store')) params.delete('entry');
  const query = params.toString();
  return query ? `?${query}` : '';
}
