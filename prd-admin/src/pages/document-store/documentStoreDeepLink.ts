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
 * `record=1`：带着 `store=` 一起进来时，直接在**那个库**里开录音。
 *
 * 与 `quickRecord=1` 的区别：后者是「随便找个快捷库来录」，会去创建/复用快捷知识库；
 * 这个是「就录进我正开着的这个库」——结果页左栏那颗「新录音」（设计稿 D1/D2）要的正是它，
 * 用户在某个库的录音结果页上点它，不该被扔进另一个库。
 */
export const RECORD_IN_STORE_QUERY_PARAM = 'record';

export function hasRecordInStoreRequest(search: string): boolean {
  return new URLSearchParams(search).get(RECORD_IN_STORE_QUERY_PARAM) === '1';
}

export function withoutRecordInStoreRequest(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(RECORD_IN_STORE_QUERY_PARAM);
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
