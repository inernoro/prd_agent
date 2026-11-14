import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight, ExternalLink, List, Link2, MessageSquare, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSitePreviewHtml } from '@/components/web-hosting/useSitePreviewHtml';
import { useHostedReview } from '@/components/web-hosting/useHostedReview';
import { withAnnotationRuntime } from '@/components/web-hosting/useHostedAnnotations';
import { ReviewToolbarControls } from '@/components/web-hosting/ReviewToolbarControls';
import CommentsSection from '@/components/web-hosting/CommentsSection';
import { directPreviewSandbox, SRCDOC_PREVIEW_SANDBOX } from '@/components/web-hosting/previewHtml';
import type { HostedCollection, HostedCollectionItem } from '@/services/contracts/hostedCollections';
import { CollectionThemeButton, collectionDate } from './CollectionShell';

/** Only the embedded reading copy changes; the original preview, stored file and standalone page stay intact. */
function withCollectionTitleDeduplicated(html: string, title: string): string {
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
  if (!normalize(title)) return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const first = parsed.body.querySelector('h1');
  if (!first || normalize(first.textContent ?? '') !== normalize(title)) return html;
  first.setAttribute('data-collection-duplicate-title', '');
  first.setAttribute('hidden', ''); first.setAttribute('aria-hidden', 'true');
  first.style.setProperty('display', 'none', 'important');
  const doctype = parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : '';
  return doctype + parsed.documentElement.outerHTML;
}

export function HostedCollectionDocument({ item, collection, token, password, onBack, onNavigate, onManage, items }: {
  item?: HostedCollectionItem; collection: HostedCollection; token?: string; password?: string;
  onBack: () => void; onNavigate: (id: string) => void; onManage?: () => void; items: HostedCollectionItem[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [tab, setTab] = useState<'notes' | 'talk' | 'related'>('related');
  const [count, setCount] = useState<number>();
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 1100px)').matches);
  const [mobileReading, setMobileReading] = useState(() => matchMedia('(max-width: 700px)').matches);
  const [panelOpen, setPanelOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)'), phone = matchMedia('(max-width: 700px)');
    const update = () => { setCompact(media.matches); setMobileReading(phone.matches); setPanelOpen(false); };
    media.addEventListener('change', update); phone.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); phone.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    if (!compact || !panelOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setPanelOpen(false); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? []].filter(e => e.offsetParent !== null);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [compact, panelOpen]);
  const site = item?.siteUrl ? { id: item.id, title: item.title, siteUrl: item.siteUrl, entryFile: item.entryFile ?? 'index.html',
    wrappedAssetType: item.wrappedAssetType, contentShape: item.contentShape } : null;
  const review = useHostedReview(frame, site, site ? token ? { mode: 'share', token, password, siteId: site.id } : { mode: 'site', siteId: site.id } : null, () => { setTab('notes'); setPanelOpen(true); });
  const display = review.site ?? site;
  const preview = useSitePreviewHtml(display ? { ...display, shareAccess: token ? { token, password } : undefined } : null, !!display);
  const sourceHtml = review.preview?.html ?? preview.srcDoc;
  const html = useMemo(() => sourceHtml ? withAnnotationRuntime(mobileReading ? withCollectionTitleDeduplicated(sourceHtml, item?.title ?? '') : sourceHtml) : undefined, [sourceHtml, mobileReading, item?.title]);
  const index = items.findIndex(member => member.id === item?.id);
  const openPanel = (next: typeof tab) => {
    if (next !== 'notes') { review.annotations.clearDraft(); review.annotations.setEnabled(false); }
    setTab(next); setPanelOpen(true);
  };
  if (!item || item.unavailable) return <div className="hc-unavailable"><span className="tag t-x">不可用</span><h1 className="serif">此文档已删除或当前账号无权访问</h1><p>它仍保留在合集目录中。其他原文档、权限和批注不受影响。</p>{onManage && item && <><p>当前文档：「{item.title}」。将打开管理合集，请在成员列表中移出该项并保存；仅调整本合集目录，不会删除原文。{item.id === collection.mainSiteId && '该项为主文档，移出前须先选择新的主文档。'}</p><button className="btn" onClick={onManage}>从合集移出</button></>}<div className="hc-tools"><button className="btn" onClick={onBack}>返回目录</button>{index < items.length - 1 && <button className="btn pri" onClick={() => onNavigate(items[index + 1].id)}>阅读下一篇</button>}</div></div>;
  const toolbar = <><ReviewToolbarControls review={review} canUpload={item.canEdit && !token} onOpen={() => openPanel('notes')} expanded={tab === 'notes' && (!compact || panelOpen)} count={count} /><Link className="btn ghost" target="_blank" to={token ? `/s/wp/${encodeURIComponent(token)}?siteId=${encodeURIComponent(item.id)}` : `/web-pages?openSite=${encodeURIComponent(item.id)}`}><ExternalLink size={13} />独立打开</Link></>;
  return <div className="hc-doc-view"><header className="hc-mobile-doc-header"><button className="ib" aria-label="返回目录" onClick={onBack}><ArrowLeft size={20} /></button><span className="mono">返回目录 · {item.id === collection.mainSiteId ? '主' : String(index + 1).padStart(2, '0')}</span><CollectionThemeButton /></header><div className="hc-doc-head"><button className="lnk mono" onClick={onBack}><ArrowLeft size={13} /> 返回目录</button><span className="mono">第 {index + 1} / {items.length} 篇</span><div className="hc-doc-toolbar">{toolbar}</div></div><div className="hc-doc-columns"><article className="panel hc-doc-paper"><div className="hc-doc-position">{item.id === collection.mainSiteId && <span className="tag t-m">主文档</span>}<span className="mono">第 {index + 1} / {items.length} 篇 · v{item.versionNumber ?? 1}</span></div><div className="hc-doc-meta"><span className="tag t-l">{item.type}</span><span className="mono">{item.author} · 更新于 {collectionDate(item.updatedAt)}</span></div><h1 className="serif">{item.title}</h1><div className="hc-doc-mobile-meta">{item.author}{item.author && ' · '}更新于 {collectionDate(item.updatedAt)} · 批注 {count ?? item.annotationCount ?? 0} · 讨论 {item.discussionCount ?? 0}</div>{preview.loading && <MapSectionLoader text="正在读取正文…" />}{preview.error && <p className="hc-content-error" role="alert">{preview.error}</p>}<iframe ref={frame} className="hc-document-frame" title={item.title} srcDoc={html} src={!html ? display?.siteUrl : undefined} sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(display?.siteUrl ?? "")} referrerPolicy="no-referrer" onLoad={() => review.annotations.notifyFrame()} /><nav className="hc-doc-neighbors">{index > 0 ? <button className="panel lnk" onClick={() => onNavigate(items[index - 1].id)}><span className="mono">上一篇 {String(index).padStart(2, '0')}</span><span>{items[index - 1].title}</span></button> : <span />}{index < items.length - 1 ? <button className="panel lnk" onClick={() => onNavigate(items[index + 1].id)}><span className="mono">下一篇 {String(index + 2).padStart(2, '0')}</span><span>{items[index + 1].title}</span></button> : <span />}</nav></article><button className="hc-mobile-panel-scrim" aria-label="关闭阅读面板遮罩" hidden={!compact || !panelOpen} tabIndex={-1} onClick={() => setPanelOpen(false)} /><aside ref={panel} className={`panel hc-doc-aside ${compact && panelOpen ? 'hc-mobile-panel-open' : ''}`} role={compact && panelOpen ? 'dialog' : undefined} aria-modal={compact && panelOpen ? true : undefined} aria-label={compact && panelOpen ? '合集阅读面板' : undefined}><header className="hc-mobile-panel-header"><strong>阅读工具</strong><button className="ib" aria-label="关闭阅读面板" onClick={() => setPanelOpen(false)}><X size={18} /></button></header><div className="hc-mobile-panel-controls">{toolbar}</div><div className="hc-doc-tabs" role="tablist"><button className="tab" role="tab" aria-selected={tab === 'notes'} onClick={() => openPanel('notes')}>批注{count !== undefined ? ` ${count}` : ''}</button><button className="tab" role="tab" aria-selected={tab === 'talk'} onClick={() => openPanel('talk')}>讨论</button><button className="tab" role="tab" aria-selected={tab === 'related'} onClick={() => openPanel('related')}>关联</button></div><div className="hc-doc-panel-body">{tab === 'related' ? <div className="hc-doc-relations"><div className="mono">本合集</div><button className="lnk" onClick={onBack}><span className="tag t-m">成员</span>第 {index + 1} / {items.length} 篇 · 打开目录</button>{!!item.memberships?.filter(c => c.id !== collection.id).length && <><div className="mono">也收录于</div>{item.memberships.filter(c => c.id !== collection.id).map(c => <Link key={c.id} to={`/web-pages/collections/${c.id}`}>{c.name}</Link>)}</>}</div> : <CommentsSection key={`${item.id}:${tab}`} threadKind={tab === 'notes' ? 'annotation' : 'discussion'} {...(token ? { mode: 'share' as const, token, password, siteId: item.id } : { mode: 'site' as const, siteId: item.id })} review={review} annotations={tab === 'notes' ? review.annotations : undefined} onCountChange={tab === 'notes' ? setCount : undefined} onPickElement={tab === 'notes' ? () => { if (compact) setPanelOpen(false); review.annotations.select(); } : undefined} />}</div></aside></div><nav className="hc-mobile-read-tools" aria-label="阅读工具"><button onClick={onBack}><List size={18} /><span>目录</span></button><button data-tool="notes" aria-expanded={panelOpen && tab === 'notes'} onClick={() => openPanel('notes')}><MessageSquare size={18} /><span>批注{count !== undefined ? ` ${count}` : ''}</span></button><button data-tool="related" aria-expanded={panelOpen && tab === 'related'} onClick={() => openPanel('related')}><Link2 size={18} /><span>关联</span></button><button data-tool="next" disabled={index < 0 || index >= items.length - 1} onClick={() => onNavigate(items[index + 1].id)}><ChevronRight size={18} /><span>{index < items.length - 1 ? `下一篇 ${String(index + 2).padStart(2, '0')}` : '已是最后一篇'}</span></button></nav></div>;
}
