import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Search, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { copyWithFeedback } from '@/lib/clipboard';
import { getCollectionContexts, getCollectionContextDocuments, getCollectionContextLinks,
  type CollectionContext, type CollectionContextPage, type CollectionHistoryItem } from '@/services/real/hostedCollections';
import { getRelatedDocuments, type RelatedDocument, type RelatedDocuments } from '@/services/real/relatedDocuments';
import { RelatedDocumentContent } from './RelatedDocumentContent';

type DocumentActions = {
  onClose: () => void; onNavigate?: (item: RelatedDocument) => void; onTagEdit: (item: RelatedDocument) => void;
  onManage: (data: RelatedDocuments) => void; onPermissions: (data: RelatedDocuments) => void;
};

/** 合集是选择上下文，右侧始终是该上下文的文档；只有一组时省去选择栏。 */
export function CollectionContextPanel({ siteId, onSplitChange, ...actions }: DocumentActions & { siteId: string; onSplitChange: (split: boolean) => void }) {
  const [search, setSearch] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<CollectionContextPage | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (search.trim() === keyword) return;
    const timer = setTimeout(() => { setKeyword(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search, keyword]);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void getCollectionContexts(siteId, page, keyword).then(response => {
      if (!alive) return;
      if (response.success) {
        setResult(response.data);
        setSelectedId(current => response.data.items.some(item => item.id === current) ? current : response.data.items[0]?.id ?? '');
      } else setError(response.error?.message || '合集暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('合集暂时无法读取，请检查网络后重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [siteId, page, keyword, reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setReload(value => value + 1); };
    window.addEventListener('focus', refresh); window.addEventListener('hosted-comments-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('hosted-comments-changed', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const selected = result?.items.find(item => item.id === selectedId);
  const split = (result?.totalContexts ?? 0) > 1;
  useEffect(() => { onSplitChange(split); }, [split, onSplitChange]);
  const pending = loading || search.trim() !== keyword;
  const clear = () => { setSearch(''); setKeyword(''); setPage(1); };
  if (error) return <div className="related-empty" role="alert">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div>;
  if (!result) return <div className="related-empty" role="status"><MapSpinner size={20} />正在读取文档所属合集…</div>;
  return <div className={`collection-context-layout ${split ? 'is-split' : 'is-single'}`} data-collection-layout={split ? 'split' : 'single'} style={{ minHeight: 0, height: split ? 'min(600px, calc(100dvh - 64px))' : undefined }}>
    {split && <aside className="collection-context-sidebar" aria-label="所属合集">
      <header><strong>所属合集</strong><span>{result.totalContexts} 个</span></header>
      <label className="collection-context-search"><Search size={14} aria-hidden /><input aria-label="搜索所属合集" placeholder="搜索合集或链接尾码" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} />
        {search && <button type="button" aria-label="清除合集搜索" onClick={clear}><X size={13} /></button>}
      </label>
      <nav className="collection-context-list" aria-label="选择合集" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {pending ? <div className="related-empty" role="status"><MapSpinner size={16} />正在查找…</div>
          : result.items.map(context => <section className={`collection-context-entry ${context.id === selectedId ? 'is-selected' : ''}`} key={context.id}>
            <button type="button" className="collection-context-select" aria-pressed={context.id === selectedId} onClick={() => setSelectedId(context.id)}>
              <strong title={context.title}>{context.title}</strong><span>{context.memberCount} 份文档{context.legacyShareId ? ' · 历史合集' : ''}</span>
            </button>
            <CollectionLinks siteId={siteId} context={context} selected={context.id === selectedId} />
          </section>)}
        {!pending && !result.items.length && <div className="collection-context-empty">没有找到匹配合集。<button type="button" onClick={clear}>查看全部合集</button></div>}
      </nav>
      <footer><span>{pending ? '正在查找…' : `共 ${result.total} 个合集`}</span>
        {result.total > result.pageSize && <nav className="related-pagination" aria-label="合集分页">
          <button type="button" disabled={pending || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(result.total / result.pageSize))}</span>
          <button type="button" disabled={pending || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>下一页</button>
        </nav>}
      </footer>
    </aside>}
    <div className="collection-context-documents" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {pending ? <div className="related-empty" role="status"><MapSpinner size={20} />正在读取合集…</div>
        : selected || result.totalContexts === 0 ? <ContextDocuments key={`${siteId}:${selected?.id ?? 'related'}:${reload}`} siteId={siteId} context={selected} split={split} {...actions} />
          : <div className="related-empty">选择左侧合集查看文档。</div>}
    </div>
  </div>;
}

function ContextDocuments({ siteId, context, split, ...actions }: DocumentActions & { siteId: string; context?: CollectionContext; split: boolean }) {
  const [data, setData] = useState<RelatedDocuments | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const contextId = context?.id;
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setData(null);
    const request = contextId ? getCollectionContextDocuments(siteId, contextId) : getRelatedDocuments(siteId);
    void request.then(response => {
      if (!alive) return;
      if (response.success) setData(response.data); else setError(response.error?.message || '文档暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('文档暂时无法读取，请检查网络后重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [siteId, contextId, reload]);
  return <RelatedDocumentContent siteId={siteId} data={data} loading={loading} error={error} heading={context?.title ?? '关联文档'}
    links={context && !split ? <div className="collection-context-single-link"><CollectionLinks siteId={siteId} context={context} selected /></div> : undefined}
    onReload={() => setReload(value => value + 1)} onManage={() => { if (data) actions.onManage(data); }} onPermissions={() => { if (data) actions.onPermissions(data); }}
    onTagEdit={actions.onTagEdit} onClose={actions.onClose} onNavigate={actions.onNavigate} />;
}

function CollectionLinks({ siteId, context, selected }: { siteId: string; context: CollectionContext; selected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: CollectionHistoryItem[]; total: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!selected || !expanded) return;
    let alive = true; setLoading(true); setError(''); setResult(null);
    void getCollectionContextLinks(siteId, context.id, page).then(response => {
      if (!alive) return;
      if (response.success) setResult(response.data); else setError(response.error?.message || '链接暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('链接暂时无法读取，请重试。'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [siteId, context.id, selected, expanded, page, reload]);
  return <div className="collection-context-links" aria-label={`${context.title}的分享链接`}>
    {expanded && selected ? <>
      {loading ? <span role="status"><MapSpinner size={12} />正在读取链接…</span> : error ? <span role="alert">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></span>
        : result?.items.map(link => <CollectionLink key={link.id} link={link} />)}
      {result && result.total > result.pageSize && <nav className="related-pagination" aria-label="分享链接分页">
        <button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {Math.ceil(result.total / result.pageSize)}</span>
        <button type="button" disabled={loading || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>下一页</button>
      </nav>}
    </> : context.primaryLink ? <CollectionLink link={context.primaryLink} /> : <span className="collection-context-unshared">暂无包含此文档的分享链接</span>}
    {selected && context.shareCount > 1 && <button type="button" className="collection-context-more" onClick={() => setExpanded(value => !value)}>{expanded ? '收起链接' : `查看全部 ${context.shareCount} 条链接`}</button>}
  </div>;
}

function CollectionLink({ link }: { link: CollectionHistoryItem }) {
  const copy = () => copyWithFeedback(new URL(link.shareUrl, window.location.origin).href, { successMessage: '原链接已复制', label: '原链接' });
  return <div className="collection-context-link">
    <div>{link.isActive ? <a href={link.shareUrl} target="_blank" rel="noopener noreferrer" title="打开原合集分享"><code>{link.shareUrl}</code><ExternalLink size={11} aria-hidden /></a>
      : <code title={link.shareUrl}>{link.shareUrl}</code>}
      <button type="button" title="复制原链接" aria-label={`复制原链接：${link.shareUrl}`} onClick={() => void copy()}><Copy size={12} /></button>
    </div><small>{link.statusLabel}{link.accessLevel === 'password' ? ' · 密码保护' : ''} · <time dateTime={link.createdAt}>{new Date(link.createdAt).toLocaleDateString('zh-CN')}</time></small>
  </div>;
}
