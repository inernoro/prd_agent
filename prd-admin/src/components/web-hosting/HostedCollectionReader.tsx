import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CommentThreadCounts } from './CommentsSection';

export type CollectionThreadKind = 'annotation' | 'discussion';
export interface CollectionReaderScope { memberIds: string[]; collectionId?: string }
export interface CollectionReaderParts {
  content: ReactNode;
  title?: ReactNode;
  controls?: ReactNode;
  metadata?: ReactNode;
  comments?: (kind: CollectionThreadKind, onCounts: (counts: CommentThreadCounts) => void) => ReactNode;
  related?: (scope: CollectionReaderScope) => ReactNode;
  annotationsOpen?: boolean;
  onDismissAnnotations?: () => void;
  fullscreen?: boolean;
}
export type CollectionReaderRenderer = (parts: CollectionReaderParts) => ReactNode;

/** 设计稿和真实文档共用同一阅读布局，文档状态与鉴权仍由原阅读器负责。 */
export function HostedCollectionReader({ title, heading, metadata, navigation, related, parts, mobileDirectory, mobileNext }: {
  title: string; heading: ReactNode; metadata: ReactNode; navigation: ReactNode; related?: ReactNode;
  parts: CollectionReaderParts; mobileDirectory?: ReactNode; mobileNext?: ReactNode;
}) {
  const [tab, setTab] = useState<CollectionThreadKind | 'related'>('related');
  const [counts, setCounts] = useState<CommentThreadCounts | null>(null);
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { if (parts.annotationsOpen) setTab('annotation'); }, [parts.annotationsOpen]);
  const select = (next: typeof tab) => { setTab(next); parts.onDismissAnnotations?.(); };
  const tabs = [
    ...(parts.comments ? [{ id: 'annotation' as const, label: '批注', count: counts?.annotations }, { id: 'discussion' as const, label: '讨论', count: counts?.discussions }] : []),
    { id: 'related' as const, label: '关联', count: undefined },
  ];
  return <div className={`ledger-reading-layout${parts.fullscreen ? ' is-fullscreen' : ''}`}>
    <article className="ledger-reading-article">
      {heading}
      <div className="ledger-reading-meta">{metadata}</div>
      <h1 className="ledger-document-title">{parts.title ?? title}</h1>
      <div className="ledger-document-metadata">{parts.metadata}{parts.controls}</div>
      <div className="ledger-document-body ledger-reader-content">{parts.content}</div>
      {navigation}
    </article>
    <aside ref={panel} className="ledger-review-panel" aria-label="批注、讨论与关联" style={{ minHeight: 0 }}>
      <div className="ledger-reader-tabs" role="tablist" aria-label="阅读侧栏">
        {tabs.map(item => <button key={item.id} id={`${id}-${item.id}`} type="button" role="tab" aria-selected={tab === item.id}
          aria-controls={`${id}-${item.id}-panel`} onClick={() => select(item.id)}>{item.label}{item.count != null && <> <span>{item.count}</span></>}</button>)}
      </div>
      {parts.comments && <div id={`${id}-${tab === 'discussion' ? 'discussion' : 'annotation'}-panel`} role="tabpanel"
        aria-labelledby={`${id}-${tab === 'discussion' ? 'discussion' : 'annotation'}`} hidden={tab === 'related'} className="ledger-reader-comments" style={{ minHeight: 0 }}>
        {parts.comments(tab === 'discussion' ? 'discussion' : 'annotation', setCounts)}
      </div>}
      <div id={`${id}-related-panel`} role="tabpanel" aria-labelledby={`${id}-related`} hidden={tab !== 'related'} className="ledger-reader-relations">
        {related}
      </div>
    </aside>
    <nav className="ledger-mobile-reader-tools" aria-label="阅读工具">
      {mobileDirectory}
      {parts.comments && <button type="button" onClick={() => { select('annotation'); requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'start' })); }}>批注{counts && ` ${counts.annotations}`}</button>}
      <button type="button" onClick={() => { select('related'); requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'start' })); }}>关联</button>
      {mobileNext}
    </nav>
  </div>;
}
