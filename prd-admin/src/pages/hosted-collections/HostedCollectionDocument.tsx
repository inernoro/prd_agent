import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSitePreviewHtml } from '@/components/web-hosting/useSitePreviewHtml';
import { useHostedReview } from '@/components/web-hosting/useHostedReview';
import { withAnnotationRuntime } from '@/components/web-hosting/useHostedAnnotations';
import { ReviewToolbarControls } from '@/components/web-hosting/ReviewToolbarControls';
import CommentsSection from '@/components/web-hosting/CommentsSection';
import { directPreviewSandbox, SRCDOC_PREVIEW_SANDBOX } from '@/components/web-hosting/previewHtml';
import type { HostedCollection, HostedCollectionItem } from '@/services/contracts/hostedCollections';
import { collectionDate } from './CollectionShell';

export function HostedCollectionDocument({ item, collection, token, password, onBack, onNavigate, items }: {
  item?: HostedCollectionItem; collection: HostedCollection; token?: string; password?: string;
  onBack: () => void; onNavigate: (id: string) => void; items: HostedCollectionItem[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [tab, setTab] = useState<'notes' | 'talk' | 'related'>('related');
  const [count, setCount] = useState<number>();
  const site = item?.siteUrl ? { id: item.id, title: item.title, siteUrl: item.siteUrl, entryFile: item.entryFile ?? 'index.html',
    wrappedAssetType: item.wrappedAssetType, contentShape: item.contentShape } : null;
  const review = useHostedReview(frame, site, site ? token ? { mode: 'share', token, password, siteId: site.id } : { mode: 'site', siteId: site.id } : null, () => setTab('notes'));
  const display = review.site ?? site;
  const preview = useSitePreviewHtml(display ? { ...display, shareAccess: token ? { token, password } : undefined } : null, !!display);
  const html = review.preview ? withAnnotationRuntime(review.preview.html) : preview.srcDoc ? withAnnotationRuntime(preview.srcDoc) : undefined;
  const index = items.findIndex(member => member.id === item?.id);
  if (!item || item.unavailable) return <div className="hc-unavailable"><span className="tag t-x">不可用</span><h1 className="serif">此文档已删除或当前账号无权访问</h1><p>它仍保留在合集目录中。其他原文档、权限和批注不受影响。</p><div className="hc-tools"><button className="btn" onClick={onBack}>返回目录</button>{index < items.length - 1 && <button className="btn pri" onClick={() => onNavigate(items[index + 1].id)}>阅读下一篇</button>}</div></div>;
  return <div className="hc-doc-view"><div className="hc-doc-head"><button className="lnk mono" onClick={onBack}><ArrowLeft size={13} /> 返回目录</button><span className="mono">第 {index + 1} / {items.length} 篇</span><div className="hc-doc-toolbar"><ReviewToolbarControls review={review} canUpload={item.canEdit && !token} onOpen={() => setTab('notes')} expanded={tab === 'notes'} count={count} /><Link className="btn ghost" target="_blank" to={token ? `/s/wp/${encodeURIComponent(token)}?siteId=${encodeURIComponent(item.id)}` : `/web-pages?openSite=${encodeURIComponent(item.id)}`}><ExternalLink size={13} />独立打开</Link></div></div><div className="hc-doc-columns"><article className="panel hc-doc-paper"><div className="hc-doc-meta"><span className="tag t-l">{item.type}</span><span className="mono">{item.author} · 更新于 {collectionDate(item.updatedAt)}</span></div><h1 className="serif">{item.title}</h1>{preview.loading && <MapSectionLoader text="正在读取正文…" />}{preview.error && <p className="hc-content-error" role="alert">{preview.error}</p>}<iframe ref={frame} className="hc-document-frame" title={item.title} srcDoc={html} src={!html ? display?.siteUrl : undefined} sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(display?.siteUrl ?? "")} referrerPolicy="no-referrer" onLoad={() => review.annotations.notifyFrame()} /><nav className="hc-doc-neighbors">{index > 0 ? <button className="panel lnk" onClick={() => onNavigate(items[index - 1].id)}><span className="mono">上一篇 {String(index).padStart(2, '0')}</span><span>{items[index - 1].title}</span></button> : <span />}{index < items.length - 1 ? <button className="panel lnk" onClick={() => onNavigate(items[index + 1].id)}><span className="mono">下一篇 {String(index + 2).padStart(2, '0')}</span><span>{items[index + 1].title}</span></button> : <span />}</nav></article><aside className="panel hc-doc-aside"><div className="hc-doc-tabs" role="tablist"><button className="tab" role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')}>批注{count !== undefined ? ` ${count}` : ''}</button><button className="tab" role="tab" aria-selected={tab === 'talk'} onClick={() => { review.annotations.clearDraft(); review.annotations.setEnabled(false); setTab('talk'); }}>讨论</button><button className="tab" role="tab" aria-selected={tab === 'related'} onClick={() => setTab('related')}>关联</button></div>{tab === 'related' ? <div className="hc-doc-relations"><div className="mono">本合集</div><button className="lnk" onClick={onBack}><span className="tag t-m">成员</span>第 {index + 1} / {items.length} 篇 · 打开目录</button>{!!item.memberships?.filter(c => c.id !== collection.id).length && <><div className="mono">也收录于</div>{item.memberships.filter(c => c.id !== collection.id).map(c => <Link key={c.id} to={`/web-pages/collections/${c.id}`}>{c.name}</Link>)}</>}</div> : <CommentsSection key={`${item.id}:${tab}`} threadKind={tab === 'notes' ? 'annotation' : 'discussion'} {...(token ? { mode: 'share' as const, token, password, siteId: item.id } : { mode: 'site' as const, siteId: item.id })} review={review} annotations={tab === 'notes' ? review.annotations : undefined} onCountChange={tab === 'notes' ? setCount : undefined} onPickElement={tab === 'notes' ? () => review.annotations.select() : undefined} />}</aside></div></div>;
}
