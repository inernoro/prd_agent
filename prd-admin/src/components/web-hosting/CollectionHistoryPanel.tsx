import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Search, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getCollectionHistory, type CollectionHistoryItem } from '@/services/real/hostedCollections';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';

/** 复用文档关系浮层；搜索和分页由服务器执行，每条记录保留原分享凭证。 */
export function CollectionHistoryPanel({ siteId }: { siteId: string }) {
  const token = useAuthStore(state => state.token);
  const [search, setSearch] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ token: string | null; siteId: string; keyword: string; page: number; items: CollectionHistoryItem[]; total: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const result = loaded?.token === token && loaded.siteId === siteId && loaded.page === page && loaded.keyword === keyword ? loaded : null;
  const pending = loading || search.trim() !== keyword || (!result && !error);
  useEffect(() => {
    if (search.trim() === keyword) return;
    const timer = setTimeout(() => { setKeyword(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search, keyword]);
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setLoaded(null);
    void getCollectionHistory(siteId, page, keyword).then(response => {
      if (!alive) return;
      if (response.success) setLoaded({ ...response.data, token, siteId, keyword });
      else setError(response.error?.message || '合集历史暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('合集历史暂时无法读取，请检查网络后重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [siteId, page, keyword, token, reload]);
  const clear = () => { setSearch(''); setKeyword(''); setPage(1); searchRef.current?.focus(); };
  const copy = async (item: CollectionHistoryItem) => {
    try { await navigator.clipboard.writeText(new URL(item.shareUrl, window.location.origin).href); toast.success('原链接已复制'); }
    catch { toast.error('未能复制链接', '请重试，或在有效的合集名称上选择复制链接地址。'); }
  };
  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : page;
  return <section className="collection-history-panel" aria-label="合集分享列表" style={{ height: 'min(440px, 60dvh)', minHeight: 0 }}>
    <div className="collection-history-tools"><label className="collection-history-search"><Search size={14} aria-hidden />
      <input ref={searchRef} aria-label="搜索合集分享" placeholder="搜索合集名称或链接尾码" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} />
      {search && <button type="button" onClick={clear} aria-label="清除合集搜索"><X size={13} /></button>}
    </label><span>{pending ? '正在查找…' : result ? `共 ${result.total} 条分享记录` : '读取未完成'}</span></div>
    <div className="collection-history-records" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
      {pending ? <div className="related-empty" role="status"><MapSpinner size={16} />正在读取合集分享…</div>
        : error ? <div className="related-empty" role="alert"><span>{error}</span><button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div>
          : result?.items.length ? result.items.map(item => <div key={item.id} className="collection-history-record">
            <div className="collection-history-record-content">
              {item.isActive ? <a href={item.shareUrl} title={item.title} target="_blank" rel="noopener noreferrer"><span>{item.title}</span><ExternalLink size={12} aria-hidden /></a> : <strong title={item.title}>{item.title}</strong>}
              <div className="collection-history-record-meta"><span>{item.statusLabel}</span><span>{item.memberCount} 份文档</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>{item.accessLevel === 'password' && <span>密码保护</span>}</div>
              <code className="collection-history-address" title={item.shareUrl}>{item.shareUrl}</code>
            </div><button type="button" className="collection-history-copy" aria-label={`复制原链接：${item.title}`} title="复制原链接" onClick={() => void copy(item)}><Copy size={14} aria-hidden /></button>
          </div>) : <div className="collection-history-empty"><p>{keyword ? '没有找到匹配的合集分享。' : '还没有包含此文档的合集分享。'}</p>{keyword && <button type="button" onClick={clear}>清除搜索，查看全部记录</button>}</div>}
    </div>
    <footer className="collection-history-footer"><span>本人创建的分享快照 · 原链接直接打开</span>
      {result && result.total > result.pageSize && <nav className="related-pagination" aria-label="合集分享分页"><button type="button" disabled={pending || page === 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {pageCount}</span><button type="button" disabled={pending || page >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button></nav>}
    </footer>
  </section>;
}
