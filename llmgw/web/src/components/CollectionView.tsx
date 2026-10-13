import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import { collectionPage } from '@/lib/collectionPaging';
import './CollectionView.css';

export function CollectionView<T>({ items, searchText, placeholder, children, pageSize = 10, emptyText = '没有匹配结果', className = '', filters = [], filterLabel = '清单状态筛选', allFilterLabel = '全部状态', afterToolbar }: {
  items: readonly T[];
  searchText: (item: T) => string;
  placeholder: string;
  children: (page: T[]) => ReactNode;
  pageSize?: number;
  emptyText?: string;
  className?: string;
  afterToolbar?: ReactNode;
  filterLabel?: string;
  allFilterLabel?: string;
  filters?: Array<{ value: string; label: string; matches: (item: T) => boolean }>;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedFilter = filters.find((item) => item.value === filter);
  const filtered = selectedFilter ? items.filter(selectedFilter.matches) : items;
  const result = collectionPage(filtered, query, searchText, page, pageSize);
  // 数据删除或刷新后立刻夹住页码；搜索、筛选和翻页都回到清单顶部。
  useEffect(() => { if (page !== result.current) setPage(result.current); }, [page, result.current]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [query, filter, result.current]);
  return (
    <div className={`lg-collection-view ${className}`}>
      <div className="lg-collection-toolbar">
        <input type="search" aria-label={placeholder} placeholder={placeholder} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        {filters.length ? <select aria-label={filterLabel} value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="">{allFilterLabel}</option>{filters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select> : null}
      </div>
      {afterToolbar}
      <div className="lg-collection-scroll" ref={scrollRef}>
        {result.total ? children(result.items) : <div className="lg-collection-empty">{emptyText}{query || filter ? <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setFilter(''); setPage(1); }}>清除筛选</Button> : null}</div>}
      </div>
      <footer className="lg-collection-pagination">
        <span>{result.total ? `${result.start + 1}–${Math.min(result.start + pageSize, result.total)}` : '0'} / {result.total}</span>
        <span className="lg-collection-spacer" />
        <span>第 {result.current} / {result.pages} 页</span>
        <Button size="sm" disabled={result.current <= 1} onClick={() => setPage(result.current - 1)}>上一页</Button>
        <Button size="sm" disabled={result.current >= result.pages} onClick={() => setPage(result.current + 1)}>下一页</Button>
      </footer>
    </div>
  );
}

/** 桌面并列、窄屏独立详情态。保持真实编辑表单内联在页面，不复制写入逻辑。 */
export function CollectionDetailPane({ title, identifier, onClose, children, tabs, icon }: { title: ReactNode; identifier?: string; onClose: () => void; children: ReactNode; tabs?: ReactNode; icon?: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <aside className="lg-collection-pane" aria-label="清单详情" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header className="lg-collection-pane-heading">{icon ? <span className="lg-collection-pane-icon">{icon}</span> : null}<div><h2>{title}</h2>{identifier ? <code>{identifier}</code> : null}</div><button ref={closeRef} type="button" className="lg-collection-close" aria-label="关闭详情" onClick={onClose}><X size={16} /></button></header>
    {tabs ? <div className="lg-collection-pane-tabs">{tabs}</div> : null}
    <div className="lg-collection-pane-body">{children}</div>
  </aside>;
}

/** 页签只切换现有内容，权限与写入回调由原页面负责。 */
export function CollectionPaneTab({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" aria-pressed={active} className="lg-collection-pane-tab" onClick={onClick}>{children}</button>;
}

export function CollectionFacts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return <dl className="lg-collection-facts">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
