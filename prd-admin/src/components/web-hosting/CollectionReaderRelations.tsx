import { useEffect, useState } from 'react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getRelatedDocuments, type RelatedDocument, type RelatedDocuments } from '@/services/real/relatedDocuments';
import { getCollectionContexts, type CollectionContextPage } from '@/services/real/hostedCollections';
import type { CollectionReaderScope } from './HostedCollectionReader';

/** 沿用原分享鉴权读取关联，合集成员与引用来源分别展示。 */
export function CollectionReaderRelations({ siteId, token, password, scope, canViewCollections, onNavigate }: {
  siteId: string; token: string; password?: string; scope: CollectionReaderScope; canViewCollections: boolean;
  onNavigate: (item: RelatedDocument) => void;
}) {
  const [related, setRelated] = useState<RelatedDocuments | null>(null);
  const [contexts, setContexts] = useState<CollectionContextPage | null>(null);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [contextError, setContextError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setReload(value => value + 1); };
    window.addEventListener('hosted-comments-changed', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('hosted-comments-changed', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void getRelatedDocuments(siteId, { token, password }).then(result => {
      if (!alive) return;
      if (result.success) setRelated(result.data); else setError(result.error?.message || '关联暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('关联暂时无法读取，请重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [siteId, token, password, reload]);
  useEffect(() => {
    if (!canViewCollections) return;
    let alive = true; setContextError('');
    void getCollectionContexts(siteId, page).then(result => {
      if (!alive) return;
      if (result.success) setContexts(result.data); else setContextError(result.error?.message || '其他合集暂时无法读取。');
    }).catch(() => { if (alive) setContextError('其他合集暂时无法读取。'); });
    return () => { alive = false; };
  }, [siteId, page, canViewCollections, reload]);
  const otherContexts = contexts?.items.filter(item => item.collectionId !== scope.collectionId
    && (!item.primaryLink || new URL(item.primaryLink.shareUrl, window.location.origin).pathname !== window.location.pathname)) ?? [];
  const manual = related?.items.filter(item => item.id !== siteId && item.isManual !== false && !scope.memberIds.includes(item.id)) ?? [];
  const citations = related?.items.filter(item => item.id !== siteId && (item.mentions?.length ?? 0) > 0) ?? [];
  const documentLink = (item: RelatedDocument) => <a href={item.href} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(item);
  }}>{item.title}</a>;
  return <>
    {canViewCollections && <section className="ledger-relation-group" aria-label="也收录于"><h2>也收录于</h2>
      {contextError ? <p role="alert">{contextError}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></p>
        : !contexts ? <p role="status"><MapSpinner size={12} />正在读取合集…</p>
          : otherContexts.length ? otherContexts.map(item => <div className="ledger-relation-item" key={item.id}>
            {item.primaryLink?.isActive ? <a href={item.primaryLink.shareUrl}>{item.title}</a> : <span>{item.title}</span>}
            <small>{item.memberCount} 份文档{!item.primaryLink ? ' · 尚未分享' : !item.primaryLink.isActive ? ` · ${item.primaryLink.statusLabel}` : ''}</small>
          </div>) : <p>暂无其他可查看的合集</p>}
      {contexts && contexts.total > contexts.pageSize && <nav className="related-pagination" aria-label="其他合集分页">
        <button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span>{page} / {Math.ceil(contexts.total / contexts.pageSize)}</span>
        <button type="button" disabled={page * contexts.pageSize >= contexts.total} onClick={() => setPage(value => value + 1)}>下一页</button>
      </nav>}
    </section>}
    {loading ? <p role="status"><MapSpinner size={12} />正在读取关联…</p> : error ? <p role="alert">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></p> : <>
      <section className="ledger-relation-group" aria-label="手动关联"><h2>手动关联</h2>
        {manual.length ? manual.map(item => <div className="ledger-relation-item" key={item.id}><span className="ledger-tag is-manual">手动</span>{documentLink(item)}</div>) : <p>暂无合集之外的手动关联</p>}
      </section>
      <section className="ledger-relation-group" aria-label="评论引用"><h2>评论引用</h2>
        {citations.length ? citations.map(item => <div className="ledger-relation-item" key={item.id}><div><span className="ledger-tag is-reference">引用</span>{documentLink(item)}</div>
          {item.mentions?.map(mention => <small key={`${mention.commentId}:${mention.sourceSiteId}`}>{mention.label}</small>)}</div>) : <p>暂无评论引用</p>}
      </section>
    </>}
  </>;
}
