/** 先检索完整集合再切页，不能把当前页当成全部搜索范围。 */
export function collectionPage<T>(items: readonly T[], query: string, searchText: (item: T) => string, page: number, pageSize: number) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? items.filter((item) => searchText(item).toLocaleLowerCase().includes(needle)) : [...items];
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  const start = (current - 1) * size;
  return { items: filtered.slice(start, start + size), total: filtered.length, pages, current, start };
}
