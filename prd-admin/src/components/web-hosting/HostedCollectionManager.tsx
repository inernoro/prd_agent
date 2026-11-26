import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, FileText, FolderOpen, GripVertical, Plus, Search, ShieldCheck, Star, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { PdfThumbnail } from '@/components/PdfThumbnail';
import { SitePreview } from '@/components/SitePreview';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getSitesPrivateSources, revokeShare, type HostedSite, type ShareLinkItem } from '@/services/real/webPages';
import { QuickSharePopover } from './QuickSharePopover';
import { QUICK_SHARE_DEFAULTS } from './quickShare';
import type { ApiResponse } from '@/types/api';
import { runWithPrivateSourceGate } from './privateSourceConfirm';
import PrivateSourceConfirmHost from './PrivateSourceConfirmHost';
import { RelatedPermissionsDialog } from './RelatedDocumentsBar';
import { adoptCollection, createCollection, createCollectionShare, dissolveCollection, getCollection, getCollectionByShare,
  getCollectionCandidates, listCollections, suggestCollectionNames, previewCollectionSharing, stopCollectionSharing, updateCollection,
  type CollectionDetails, type CollectionMember, type CollectionSharingPreview, type HostedCollection } from '@/services/real/hostedCollections';
import './HostedCollectionManager.css';

const EMPTY_MEMBERS: CollectionMember[] = [];
const COLLECTIONS_CHANGED = 'hosted-collections-changed';
const changed = () => window.dispatchEvent(new Event(COLLECTIONS_CHANGED));

export interface CollectionArrival {
  id: string;
  title: string;
  bounds?: DOMRect;
}

export function HostedCollectionLibrary({ onBack, recentId, onArrival, renderCards }: {
  onBack: () => void;
  recentId: string | null;
  onArrival: (arrival: CollectionArrival) => void;
  renderCards: (items: HostedSite[]) => ReactNode;
}) {
  const [items, setItems] = useState<HostedCollection[]>([]);
  const [members, setMembers] = useState<Record<string, HostedSite>>({});
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const recentGroup = useRef<HTMLElement>(null);
  const revealed = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void listCollections(keyword, page, recentId ?? undefined).then(result => {
      if (!alive) return;
      if (result.success) {
        const { items, recent } = result.data;
        setItems(recent ? [recent, ...items.filter(item => item.id !== recent.id)] : items);
        setMembers(result.data.members ?? {});
        setTotal(result.data.total);
      } else setError(result.error?.message || '合集加载失败，请重试');
    }).catch(() => {
      if (alive) setError('合集加载失败，请重试');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [keyword, page, revision, recentId]);

  useEffect(() => {
    const group = recentGroup.current;
    if (loading || !group || !recentId || revealed.current === recentId) return;
    revealed.current = recentId;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    group.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'nearest' });
    if (!reduced) group.animate([
      { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' },
      { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' },
    ], { duration: 440, easing: 'ease-out' });
  }, [items, loading, recentId]);

  return <section className="collection-library" aria-label="我的合集">
    <div className="collection-library-toolbar">
      <Button size="sm" variant="ghost" onClick={onBack}>返回资产库</Button>
      <label className="collection-search"><Search size={15} /><input aria-label="搜索合集" placeholder="搜索合集名称" value={keyword} onChange={e => { setKeyword(e.target.value); setPage(1); }} /></label>
      <Button size="sm" variant="primary" onClick={() => setSelected('new')}><Plus size={15} />新建合集</Button>
    </div>
    <div className="collection-library-body">
      <h2>我的合集 <small>{loading ? '' : `· ${total} 个`}</small></h2>
      {loading ? <MapSpinner size={22} /> : error ? <p role="alert">{error} <Button size="xs" onClick={() => setRevision(value => value + 1)}>重试</Button></p>
        : !items.length ? <p>{keyword ? '没有找到相符的合集。' : '还没有合集。可以新建合集，或从资产库批量选择网页。'}</p>
        : items.map(item => {
          const cards = item.siteIds.flatMap(id => members[id] ? [members[id]] : []);
          const hidden = item.siteIds.length - cards.length;
          return <section key={item.id} ref={item.id === recentId ? recentGroup : undefined}
            className="collection-library-group" data-recent={item.id === recentId} aria-label={item.title}>
            <div className="collection-library-group-heading">
              <FolderOpen size={15} />
              <h3 title={item.title}>{item.title}</h3><span>· {item.siteIds.length} 份</span>
              {item.id === recentId && <span className="collection-recent-label">刚收入</span>}
              <Button size="xs" variant="ghost" aria-label={`管理合集：${item.title}`} onClick={() => setSelected(item.id)}>管理</Button>
            </div>
            {renderCards(cards)}
            {hidden > 0 && <p>{hidden} 份文档当前不可查看，可在管理中调整。</p>}
          </section>;
        })}
      {total > 20 && <div className="collection-pager">
        <Button size="sm" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</Button>
        <span>第 {page} 页</span>
        <Button size="sm" disabled={page * 20 >= total || loading} onClick={() => setPage(value => value + 1)}>下一页</Button>
      </div>}
    </div>
    {selected && <HostedCollectionEditor collectionId={selected === 'new' ? undefined : selected}
      onArrival={arrival => { setKeyword(''); setPage(1); onArrival(arrival); }}
      onClose={() => { setSelected(null); setRevision(value => value + 1); }} />}
  </section>;
}

function collectionNames(members: CollectionMember[], generated: string[] = []) {
  const raw = members.find(member => member.available !== false)?.title.trim() ?? '';
  const subject = [...raw.replace(/合集$/, '')].slice(0, 23).join('').trim() || '网页文档';
  return [...new Set([...generated, `${subject}合集`, `${subject}阅读合集`, `${subject}参考合集`])].slice(0, 3);
}

function currentShare(details: CollectionDetails, collection: HostedCollection): ShareLinkItem | null {
  const share = details.shares.find(item => item.active && !item.needsUpdate && !item.isRevoked
    && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()));
  if (!share) return null;
  return {
    id: share.id, token: share.token, siteIds: share.siteIds?.length ? share.siteIds : collection.siteIds,
    shareType: 'collection', title: collection.title, createdAt: share.createdAt ?? collection.updatedAt,
    accessLevel: share.accessLevel ?? '', viewCount: share.viewCount ?? 0, createdBy: collection.ownerUserId,
    isRevoked: false, visibility: share.visibility, expiresAt: share.expiresAt,
  };
}

const sharePanelStyle = {
  position: 'fixed', inset: 'auto 14px 14px auto', width: 'min(364px, calc(100vw - 28px))',
  maxHeight: 'calc(100dvh - 28px)', borderRadius: 12,
} as const;

function CollectionQuickShare({ collection, detail, autoCreate, busy, onClose, onAdvanced, onBusy, onLinkReady, onChanged }: {
  collection: HostedCollection;
  detail: CollectionDetails;
  autoCreate: boolean;
  busy: boolean;
  onClose: () => void;
  onAdvanced: () => void;
  onBusy: (busy: boolean) => void;
  onLinkReady: () => void;
  onChanged: () => void;
}) {
  const findCurrent = async (): Promise<ApiResponse<ShareLinkItem | null>> => {
    const result = await getCollection(collection.id);
    if (!result.success) return result;
    if (result.data.collection?.version !== collection.version) {
      return { success: false, data: null as never, error: { code: 'COLLECTION_CHANGED', message: '合集已更新，请回到管理页核对后再分享' } };
    }
    const link = currentShare(result.data, collection);
    if (link) onLinkReady();
    return { success: true, error: null, data: link };
  };
  const create = async (fingerprint?: string): Promise<ApiResponse<ShareLinkItem>> => {
    const preview = await previewCollectionSharing(collection.id);
    if (!preview.success) return preview;
    if (!preview.data.canShare || preview.data.version !== collection.version) {
      return { success: false, data: null as never, error: { code: 'COLLECTION_CHANGED', message: '合集或成员权限已变化，请关闭分享面板后核对合集' } };
    }
    const link = await createCollectionShare(collection.id, {
      ...QUICK_SHARE_DEFAULTS, collectionVersion: preview.data.version, permissionFingerprint: preview.data.fingerprint,
      confirmedPrivateSourceFingerprint: fingerprint,
    });
    if (!link.success) return link;
    onLinkReady();
    return { success: true, error: null, data: {
      ...link.data, shareType: 'collection', siteIds: collection.siteIds, title: collection.title,
      accessLevel: link.data.password ? 'password' : 'direct', viewCount: 0, createdBy: collection.ownerUserId,
      createdAt: new Date().toISOString(), isRevoked: false,
    } };
  };
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title="分享" description={collection.title}
    maxWidth={364} zIndex={900} contentClassName="hosted-collection-dialog collection-quick-share" contentStyle={sharePanelStyle}
    content={<QuickSharePopover anchorEl={null} site={collection} links={[]} onClose={onClose} onOpenAdvanced={onAdvanced}
      onLinksChanged={onChanged} onBusyChange={onBusy} collection={{ link: currentShare(detail, collection), memberIds: collection.siteIds, findCurrent, create, autoCreate }} />} />
    <PrivateSourceConfirmHost /></>;
}

export function HostedCollectionEditor({ collectionId, shareToken, initialSites = EMPTY_MEMBERS, onClose, onArrival, demo = false, initialSharing = false, initialTitle }: {
  collectionId?: string; shareToken?: string; initialSites?: CollectionMember[]; onClose: () => void; onArrival?: (arrival: CollectionArrival) => void; demo?: boolean; initialSharing?: boolean; initialTitle?: string;
}) {
  const [detail, setDetail] = useState<CollectionDetails | null>(() => demo ? { collection: { id: 'demo-collection', ownerUserId: 'demo', title: initialTitle || '2026 Q4 Agent 平台评审资料', siteIds: initialSites.map(site => site.id), mainSiteId: initialSites[0]?.id || '', version: 1, shareGeneration: 1, isDissolved: false, updatedAt: '' }, sites: initialSites, shares: [] } : null);
  const isCreate = !demo && !collectionId && !shareToken;
  const initialMain = initialSites.find(site => site.available !== false);
  const [title, setTitle] = useState(demo ? initialTitle || '2026 Q4 Agent 平台评审资料' : isCreate && initialMain ? collectionNames(initialSites)[0] : '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const named = useRef(false);
  const titleChosen = useRef(false);
  const newCollection = useRef(false);
  const shareCompleted = useRef(false);
  const autoShare = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState<CollectionMember[]>(initialSites);
  const [main, setMain] = useState(demo || isCreate ? initialMain?.id ?? '' : '');
  const [loading, setLoading] = useState(!!(collectionId || shareToken));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidates, setCandidates] = useState<CollectionMember[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [sharing, setSharing] = useState<null | 'quick' | 'advanced'>(initialSharing ? 'advanced' : null);
  const [shareBusy, setShareBusy] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const drag = useRef<number | null>(null);
  const shareDetails = useRef<HTMLDetailsElement>(null);
  const collection = detail?.collection;
  const targetUnavailable = !demo && !!(collectionId || shareToken) && !detail;
  const legacy = !!detail?.legacyShare && !collection;
  const dirty = !collection || title !== collection.title || main !== collection.mainSiteId || members.map(x => x.id).join() !== collection.siteIds.join();
  const apply = useCallback((data: CollectionDetails) => {
    setDetail(data); setTitle(data.collection?.title || data.legacyShare?.title || '');
    setMembers(data.sites); setMain(data.collection?.mainSiteId || '');
  }, []);
  const reload = async () => {
    if (demo || !(collection || collectionId || shareToken)) return;
    setLoading(true);
    try {
      const result = collection ? await getCollection(collection.id) : collectionId ? await getCollection(collectionId) : await getCollectionByShare(shareToken!);
      if (result.success) { apply(result.data); setError(''); } else setError(result.error?.message || '无法加载合集，请重试');
    } catch { setError('合集加载失败，请重试'); } finally { setLoading(false); }
  };
  useEffect(() => {
    let alive = true;
    const promise = collectionId ? getCollection(collectionId) : shareToken ? getCollectionByShare(shareToken) : null;
    if (promise) void promise.then(result => { if (!alive) return; setLoading(false); if (result.success) apply(result.data); else setError(result.error?.message || '合集加载失败'); })
      .catch(() => { if (alive) { setLoading(false); setError('合集加载失败，请重试'); } });
    return () => { alive = false; };
  }, [collectionId, shareToken, apply]);
  useEffect(() => {
    if (demo) { setCandidates(initialSites.filter(site => site.title.includes(keyword)).slice((candidatePage - 1) * 30, candidatePage * 30)); setCandidateTotal(initialSites.length); setCandidateLoading(false); return; }
    let alive = true; setCandidateLoading(true);
    void getCollectionCandidates(keyword, candidatePage).then(result => {
      if (!alive) return; setCandidateLoading(false);
      if (result.success) { setCandidates(result.data.items); setCandidateTotal(result.data.total); }
      else setError(result.error?.message || '可选文档加载失败');
    }).catch(() => { if (alive) { setCandidateLoading(false); setError('可选文档加载失败'); } });
    return () => { alive = false; };
  }, [keyword, candidatePage, demo, initialSites]);
  const namingMembers = useRef<CollectionMember[] | null>(initialMain && isCreate ? initialSites : null);
  const hasNamingMembers = namingMembers.current !== null;
  useEffect(() => {
    if (!isCreate || !hasNamingMembers || named.current) return;
    const abort = new AbortController();
    const schedule = window.setTimeout(() => {
      if (named.current || !namingMembers.current) return;
      named.current = true;
      const input = namingMembers.current.filter(member => member.available !== false);
      setNaming(true);
      const fallback = window.setTimeout(() => {
        abort.abort();
        setNaming(false);
        setSuggestions(collectionNames(input));
      }, 1975);
      void (async () => {
        let names = collectionNames(input);
        try {
          const result = await suggestCollectionNames(input.map(member => member.id), abort.signal);
          if (result.success) names = collectionNames(input, result.data.names);
        } catch { /* The draft already has a usable name. */ }
        finally {
          window.clearTimeout(fallback);
          if (!abort.signal.aborted) {
            setNaming(false);
            setSuggestions(names);
            if (!titleChosen.current) setTitle(names[0]);
          }
        }
      })();
    }, 0);
    return () => { window.clearTimeout(schedule); abort.abort(); };
  }, [hasNamingMembers, isCreate]);

  const finishEditor = () => {
    if (collection && (newCollection.current || shareCompleted.current)) {
      const bounds = editor.current?.querySelector('.collection-member-card')?.getBoundingClientRect()
        ?? editor.current?.getBoundingClientRect();
      onArrival?.({ id: collection.id, title: collection.title, bounds });
    }
    onClose();
  };
  const closeEditor = () => { if (!busy && !shareBusy) finishEditor(); };

  const addOrRemove = (item: CollectionMember) => {
    const present = members.some(member => member.id === item.id);
    if (present) {
      setMembers(items => items.filter(member => member.id !== item.id));
      return;
    }
    const next = [...members, item];
    setMembers(next);
    if (!main && item.available !== false) setMain(item.id);
    if (isCreate && !namingMembers.current) {
      namingMembers.current = next;
      if (!titleChosen.current) setTitle(collectionNames(next)[0]);
    }
  };

  const save = async () => {
    if (busy || loading || targetUnavailable) return;
    titleChosen.current = true;
    setBusy(true); setError(''); setStatus('');
    try {
      const draft = { title: title.trim(), siteIds: members.map(x => x.id), mainSiteId: main, version: collection?.version || 0 };
      if (demo) { apply({ collection: { id: 'demo-collection', ownerUserId: 'demo', title: draft.title, siteIds: draft.siteIds, mainSiteId: main, version: (collection?.version || 0) + 1, shareGeneration: 1, isDissolved: false, updatedAt: new Date().toISOString() }, sites: members, shares: detail?.shares || [] }); setStatus('演示修改已保存，仅用于本次设计预览。'); return; }
      const result = collection ? await updateCollection(collection.id, draft) : legacy && shareToken
        ? await adoptCollection(shareToken, draft.title, main) : await createCollection(draft);
      if (result.success) {
        if (isCreate && !collection) newCollection.current = true;
        apply(result.data); setStatus('合集已保存'); changed();
      }
      else setError(result.error?.message || '保存未完成，请刷新后重试');
    } catch { setError('保存未完成，请刷新后核对实际结果'); } finally { setBusy(false); }
  };
  const setMainMember = (id: string) => { setMain(id); setMembers(items => [...items.filter(x => x.id === id), ...items.filter(x => x.id !== id)]); };
  const move = (from: number, to: number) => {
    if (busy || legacy || to < 0 || to >= members.length || members[from]?.id === main || members[to]?.id === main) return;
    setMembers(items => { const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; });
  };
  const execute = async () => {
    if (!collection || !pending) return; setBusy(true); setError('');
    try {
      if (demo) { if (pending === 'dissolve') { onClose(); return; } setDetail(current => current ? { ...current, shares: current.shares.map(share => pending === 'stop' || share.id === pending ? { ...share, active: false } : share) } : current); setPending(null); setStatus('演示分享已停止，原文档保留。'); return; }
      const result = pending === 'dissolve' ? await dissolveCollection(collection.id, collection.version)
        : pending === 'stop' ? await stopCollectionSharing(collection.id, collection.version) : await revokeShare(pending, '作者在合集管理中停止分享');
      if (result.success) { changed(); if (pending === 'dissolve') { onClose(); return; } setPending(null); await reload(); setStatus('分享已停止，原文档保留。'); }
      else setError(result.error?.message || '操作未完成，请刷新后重试');
    } catch { setError('操作未完成，请刷新后核对实际结果'); } finally { setBusy(false); }
  };
  const openSharing = () => {
    autoShare.current = true;
    if (collection && detail && currentShare(detail, collection)) shareCompleted.current = true;
    setSharing(demo ? 'advanced' : 'quick');
  };
  const finishSharing = () => {
    setSharing(null);
    if (onArrival && (shareCompleted.current || newCollection.current)) finishEditor();
    else void reload();
  };
  const markShareReady = () => { shareCompleted.current = true; };

  return <><Dialog open onOpenChange={open => { if (!open) closeEditor(); }} title={legacy ? '将旧分享设为可管理合集' : collection || collectionId || shareToken ? '管理合集' : '创建合集'} maxWidth={1060} zIndex={850} contentClassName="hosted-collection-dialog" contentStyle={{ position: 'fixed', top: 0, right: 0, bottom: 0, height: '100dvh', maxHeight: '100dvh', width: 'min(1060px, 100vw)', maxWidth: '100vw', borderRadius: 0 }}
    description={demo ? "示例数据 · 修改仅保存在本次预览中" : "修改后，新链接使用新成员；已分享链接保持原快照"}
    content={<div ref={editor} className="collection-manager collection-editor" style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {loading ? <MapSpinner size={22} /> : targetUnavailable ? null : pending ? <div className="collection-confirm"><h3>{pending === 'dissolve' ? '解散这个合集？' : '停止分享？'}</h3><p>{pending === 'dissolve' ? '合集的全部分享入口将失效。原文档及其独立分享保留，已有手动关联组不会被解除。' : pending === 'stop' ? '本合集当前全部分享入口将失效，合集和原文档保留。以后可重新生成新链接。' : '仅停止这一条链接，其他分享和原文档保留。'}</p><p>已下载或缓存的副本无法收回。</p></div> : <>
        <div className="collection-editor-grid"><section className="collection-editor-primary">        {legacy && <p className="collection-notice">旧链接和原授权范围保留。先确认名称与主文档完成导入，再调整成员；不会自动合并已有的关联组。</p>}
        <label className="collection-field">合集名称（必填）<input aria-label="合集名称" maxLength={100} value={title} onChange={e => { titleChosen.current = true; setTitle(e.target.value); }} placeholder="例如：项目发布资料" disabled={busy} /></label>
        {isCreate && !collection && (naming || suggestions.length > 0) && <div className="collection-name-suggestions" aria-label="推荐合集名称">
          {naming ? <span role="status"><MapSpinner size={13} /> 正在提议合集名称 · 约 2 秒</span> : suggestions.map(name =>
            <button type="button" key={name} title={name} aria-pressed={title === name} disabled={busy}
              onClick={() => { titleChosen.current = true; setTitle(name); }}>{name}</button>)}
        </div>}
        <div className="collection-section"><strong>合集成员 · {members.length} / 90</strong><span>拖动卡片或用箭头调整顺序</span></div>
        <div className="collection-member-list">
          {members.map((item, index) => <article key={item.id} className="collection-member-card" data-main={main === item.id} draggable={!busy && !legacy && item.id !== main}
            onDragStart={() => { drag.current = index; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag.current !== null) move(drag.current, index); drag.current = null; }} onDragEnd={() => { drag.current = null; }}>
            <div className="collection-member-cover">
              {item.coverImageUrl ? <img src={item.coverImageUrl} alt="" loading="lazy" />
                : item.wrappedAssetType === 'pdf' ? <PdfThumbnail className="h-full w-full" sizeBytes={item.totalSize} compact />
                : item.siteUrl ? <SitePreview site={{ ...item, siteUrl: item.siteUrl }} url={item.siteUrl} className="h-full w-full" decorative />
                : <FileText size={23} aria-hidden="true" />}
              {main === item.id && <span>主文档</span>}
            </div>
            <div className="collection-member-caption">
              <span className="collection-member-title" title={item.title}>{item.title}</span>
              {item.available === false && <small className="collection-member-unavailable">不可用，请移出</small>}
              <div className="collection-member-actions">
                {main !== item.id && <button type="button" className="collection-set-main" aria-label={`设为主文档：${item.title}`} disabled={busy || item.available === false} onClick={() => setMainMember(item.id)}>设为主文档</button>}
                {!legacy && <><GripVertical size={14} aria-hidden="true" />
                  <button type="button" aria-label={`上移：${item.title}`} disabled={busy || index === 0 || item.id === main || members[index - 1]?.id === main} onClick={() => move(index, index - 1)}><ArrowUp size={14} /></button>
                  <button type="button" aria-label={`下移：${item.title}`} disabled={busy || index + 1 === members.length || item.id === main} onClick={() => move(index, index + 1)}><ArrowDown size={14} /></button>
                  <button type="button" aria-label={`移出：${item.title}`} title={item.id === main ? '请先选择替代主文档，或解散合集' : '移出合集'} disabled={busy || item.id === main} onClick={() => addOrRemove(item)}><X size={14} /></button></>}
              </div>
            </div>
          </article>)}
          {!members.length && <p>从下方搜索并添加文档，也可在托管列表中多选后创建合集。</p>}
        </div>
        {collection && <details className="collection-sharing-details" ref={shareDetails}><summary>分享与权限 · {detail.shares.length} 条链接</summary><div className="collection-section"><strong>分享与权限</strong><Button disabled={busy || dirty} onClick={() => setPermissions(true)}><ShieldCheck size={14} />查看权限差异</Button></div>
          <p className="collection-notice">修改成员、顺序或主文档后，旧链接保留原快照。保存后重新生成链接，并按需停止旧分享；页面权限与独立分享分别管理。</p>
          {detail.shares.map(share => <div key={share.id} className="collection-share-row"><span><a href={demo ? '/_dev/web-hosting-share' : `/s/wp/${encodeURIComponent(share.token)}`} target="_blank" rel="noopener noreferrer">{share.active ? '打开分享' : '查看已失效入口'}<ExternalLink size={12} /></a><small>{share.memberCount} 份 · {share.needsUpdate ? '早期成员快照' : '当前版本'} · {share.active ? '有效' : '已停止或到期'}</small></span>{share.active && <Button disabled={busy} onClick={() => setPending(share.id)}>停止此分享</Button>}</div>)}
          {!detail.shares.length && <p>尚未创建分享链接，合集只在管理中保存。</p>}
          <div className="collection-danger-actions"><Button disabled={busy} onClick={() => setPending('stop')}>停止全部分享</Button><Button variant="danger" disabled={busy} onClick={() => setPending('dissolve')}>解散合集</Button></div>
        </details>}</section><aside className="collection-editor-candidates"><strong>添加文档</strong>        {!legacy && <><div className="collection-search"><Search size={16} /><input aria-label="搜索可加入的文档" placeholder="搜索我的文档" value={keyword} onChange={e => { setKeyword(e.target.value); setCandidatePage(1); }} /></div>
          {candidateLoading ? <MapSpinner size={18} /> : <div className="collection-candidates">{candidates.map(item => { const selected = members.some(member => member.id === item.id); return <button key={item.id} aria-pressed={selected} disabled={busy || item.id === main || (!selected && members.length >= 90)} title={item.title} onClick={() => addOrRemove(item)}>{selected ? <Check size={14} /> : <Plus size={14} />}<span>{item.title}</span></button>; })}</div>}
          <div className="collection-pager"><Button disabled={candidatePage === 1 || busy} onClick={() => setCandidatePage(x => x - 1)}>上一页</Button><span>可选文档第 {candidatePage} 页</span><Button disabled={candidatePage * 30 >= candidateTotal || busy} onClick={() => setCandidatePage(x => x + 1)}>下一页</Button></div></>}
<p className="collection-candidate-note">加入合集不会修改文档原有权限。分享合集时可预览差异。</p></aside></div>
      </>}
      {status && <p role="status" className="collection-notice">{status}</p>}
      {error && <div className="collection-error" role="alert">{error}<Button disabled={busy} onClick={() => void reload()}>刷新实际状态</Button></div>}
    </div>}
    actions={pending ? <><Button disabled={busy} onClick={() => setPending(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void execute()}>{busy && <MapSpinner size={13} />}{pending === 'dissolve' ? '确认解散合集' : '确认停止分享'}</Button></>
      : <>{collection && <button type="button" className="collection-lifecycle-shortcut" disabled={busy} onClick={() => setPending('dissolve')}>撤销合集</button>}
        <Button disabled={busy} onClick={closeEditor}>关闭</Button>
        {collection && !dirty ? <Button variant="primary" disabled={busy || loading} onClick={openSharing}>生成分享链接</Button>
          : <Button variant="primary" disabled={busy || loading || targetUnavailable || !title.trim() || !main || !members.length} onClick={() => void save()}>
            {busy && <MapSpinner size={13} />}{legacy ? '确认导入' : '保存合集'}
          </Button>}</>} />
    {sharing === 'quick' && collection && detail && <CollectionQuickShare collection={collection} detail={detail} autoCreate={autoShare.current} busy={shareBusy}
      onClose={finishSharing} onAdvanced={() => { autoShare.current = false; setSharing('advanced'); }} onBusy={setShareBusy} onLinkReady={markShareReady}
      onChanged={() => { changed(); void reload(); }} />}
    {sharing === 'advanced' && collection && <CollectionShareForm collection={collection} demoSites={demo ? members : undefined}
      onClose={complete => {
        if (complete) finishSharing();
        else { setSharing(demo ? null : 'quick'); void reload(); }
      }} onCreated={link => {
        markShareReady();
        if (demo) setDetail(current => current ? { ...current, shares: [{ id: crypto.randomUUID(), visibility: 'public', active: true, isRevoked: false, needsUpdate: false, memberCount: members.length, collectionVersion: collection.version, ...link }, ...current.shares] } : current);
      }} />}
    {permissions && demo && <Dialog open onOpenChange={open => { if (!open) setPermissions(false); }} title="示例权限差异" zIndex={1000} content={<div className="collection-manager"><p>示例数据 · 所有成员当前均为页面受限，与主文档一致。</p>{members.map(member => <div key={member.id} className="collection-share-row">{member.title}<span>页面权限一致</span></div>)}</div>} actions={<Button onClick={() => setPermissions(false)}>关闭</Button>} />}
    {permissions && collection && !demo && <RelatedPermissionsDialog siteId={collection.mainSiteId} collectionId={collection.id} onClose={() => setPermissions(false)} />}
  </>;
}

function CollectionShareForm({ collection, onClose, demoSites, onCreated }: { collection: HostedCollection; onClose: (complete: boolean) => void; demoSites?: CollectionMember[]; onCreated?: (link: { token: string }) => void }) {
  const [preview, setPreview] = useState<CollectionSharingPreview | null>(null);
  const [visibility, setVisibility] = useState<'owner-only' | 'logged-in' | 'public'>('owner-only');
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState(() => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  const [days, setDays] = useState(7);
  const [shortLink, setShortLink] = useState(false);
  const [questions, setQuestions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ shareUrl: string; password?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (demoSites) { setPreview({ fingerprint: 'demo', version: collection.version, canShare: true, notice: '示例数据：本次分享仅用于设计预览，不会创建真实链接或修改文档权限。', items: demoSites.map(site => ({ ...site, visibility: 'private', teamCount: 0, isMain: site.id === collection.mainSiteId })) }); return; } let alive = true; void previewCollectionSharing(collection.id).then(res => { if (!alive) return; if (res.success) setPreview(res.data); else setError(res.error?.message || '权限预检失败，请返回管理页刷新'); }).catch(() => { if (alive) setError('权限预检失败，请返回管理页刷新'); }); return () => { alive = false; }; }, [collection.id, collection.version, collection.mainSiteId, demoSites]);
  const create = async () => {
    if (!preview || busy) return; setBusy(true); setError('');
    try {
      if (demoSites) { setResult({ shareUrl: '/_dev/web-hosting-share' }); onCreated?.({ token: 'demo' }); return; }
      const gated = await runWithPrivateSourceGate({ inspect: visibility !== 'owner-only' ? () => getSitesPrivateSources(collection.siteIds)
        : async () => ({ success: true as const, data: { requiresConfirmation: false, items: [] }, error: null }),
        run: fingerprint => createCollectionShare(collection.id, { visibility, password: usePassword ? password : undefined, expiresInDays: days,
          allocateShortLink: shortLink, askSuggestedQuestions: questions.split('\n').map(question => question.trim()).filter(Boolean).slice(0, 3),
          collectionVersion: preview.version, permissionFingerprint: preview.fingerprint, confirmedPrivateSourceFingerprint: fingerprint }), actionLabel: '生成合集分享' });
      if (gated.status === 'done') {
        if (gated.res.success) {
          const link = gated.res.data;
          setResult({ ...link, shareUrl: shortLink && link.shortSeq ? `/s/${link.shortSeq}` : link.shareUrl });
          onCreated?.(link);
          changed();
        } else setError(gated.res.error?.message || '分享未生成，请返回后重新预检');
      }
    } catch { setError('分享未完成，请返回管理页核对实际结果'); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}${result.shareUrl}${result.password ? `\n访问密码：${result.password}` : ''}`); setCopied(true); }
    catch { setError('未能复制，请选择下方链接手动复制'); }
  };
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(!!result); }} title="新建分享" maxWidth={364} zIndex={900} contentClassName="hosted-collection-dialog collection-share-dialog" contentStyle={sharePanelStyle}
    description={collection.title}
    content={<div className="collection-manager" style={{ maxHeight: '65dvh', overflowY: 'auto', minHeight: 0 }}>
      {result ? <><p className="collection-notice" role="status">{demoSites ? '演示链接已准备，仅打开设计预览，不会生成真实分享授权。' : '分享已生成，包含已确认的成员快照。'}</p><a className="collection-generated-link" href={result.shareUrl} target="_blank" rel="noopener noreferrer">{window.location.origin}{result.shareUrl}<ExternalLink size={15} /></a>{result.password && <p>访问密码：<code>{result.password}</code></p>}</>
        : <>{preview ? <><p>{preview.notice}</p><div className="collection-preflight-list">{preview.items.map(item => <div key={item.id}><span>{item.isMain && <Star size={13} />}{item.title}</span><small>{item.visibility === 'public' ? '页面公开' : '页面受限'} · {item.teamCount} 个共享团队</small></div>)}</div>
          <label className="collection-field">谁能访问<select aria-label="合集分享可见性" value={visibility} onChange={e => setVisibility(e.target.value as typeof visibility)}><option value="owner-only">仅我和原协作者</option><option value="logged-in">拿到链接的登录用户</option><option value="public">任何拿到链接的人</option></select></label>
          {visibility !== 'owner-only' && <p className="collection-notice">确认生成后，所选访问者可通过这条链接读取上方所有成员，即使原页面是受限的。其他分享入口不受影响。</p>}
          <label className="collection-checkbox"><input type="checkbox" checked={usePassword} onChange={e => setUsePassword(e.target.checked)} />密码保护</label>
          {usePassword && <label className="collection-field">访问密码<input aria-label="合集访问密码" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" /></label>}
          <label className="collection-checkbox"><input type="checkbox" checked={shortLink} onChange={e => setShortLink(e.target.checked)} />生成数字短链</label>
          <label className="collection-field">开场问题<textarea rows={2} maxLength={240} placeholder="选填，每行一个" value={questions} onChange={e => setQuestions(e.target.value)} /></label>
          <label className="collection-field">有效期<select aria-label="合集分享有效期" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={0}>永久</option></select></label>
          {!preview.canShare && <p className="collection-error">部分文档当前不能再分享，请返回管理页调整成员。</p>}
        </> : !error && <MapSpinner size={22} />}</>}
      {error && <p className="collection-error" role="alert">{error}</p>}
    </div>}
    actions={<><Button disabled={busy} onClick={() => onClose(!!result)}>{result ? '完成' : '返回分享'}</Button>{result ? <Button variant="primary" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : demoSites ? '复制演示链接' : result.password ? '复制链接和密码' : '复制链接'}</Button>
      : <Button variant="primary" disabled={busy || !preview?.canShare || (usePassword && !password.trim())} onClick={() => void create()}>{busy && <MapSpinner size={14} />}确认范围并生成链接</Button>}</>} /><PrivateSourceConfirmHost /></>;
}
