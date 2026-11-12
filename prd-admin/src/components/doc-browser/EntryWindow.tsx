import { useEffect, useState, type ReactNode } from 'react';

const PAGE_SIZE = 200;

/** 每个目录分别分页，限制同时挂载的行数；保留全部数据供搜索、排序与定位。 */
export function EntryWindow<T>({ items, entryId, focusIds, scope, children }: {
  items: T[];
  entryId: (item: T) => string | undefined;
  focusIds: Set<string>;
  scope: string;
  children: (item: T, index: number) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const focusIndex = items.findIndex(item => focusIds.has(entryId(item) ?? ''));
  useEffect(() => {
    if (focusIndex >= 0) setPage(Math.floor(focusIndex / PAGE_SIZE));
  }, [focusIndex, focusIds]);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const active = Math.min(page, pages - 1);
  const start = active * PAGE_SIZE;
  return <>
    {items.slice(start, start + PAGE_SIZE).map((item, index) => children(item, start + index))}
    {pages > 1 && <div data-entry-window={scope} className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-token-muted">
      <button type="button" disabled={active === 0} aria-label={`${scope}上一页条目`}
        className="px-2 py-2 disabled:opacity-40" onClick={() => setPage(active - 1)}>上一页</button>
      <span role="status">{start + 1}–{Math.min(start + PAGE_SIZE, items.length)} / {items.length}</span>
      <button type="button" disabled={active === pages - 1} aria-label={`${scope}下一页条目`}
        className="px-2 py-2 disabled:opacity-40" onClick={() => setPage(active + 1)}>下一页</button>
    </div>}
  </>;
}
