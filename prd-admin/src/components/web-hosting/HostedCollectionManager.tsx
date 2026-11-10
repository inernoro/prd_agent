import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, GripVertical, Plus, Search, ShieldCheck, Star, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getSitesPrivateSources, revokeShare } from '@/services/real/webPages';
import { runWithPrivateSourceGate } from './privateSourceConfirm';
import PrivateSourceConfirmHost from './PrivateSourceConfirmHost';
import { RelatedPermissionsDialog } from './RelatedDocumentsBar';
import { adoptCollection, createCollection, createCollectionShare, dissolveCollection, getCollection, getCollectionByShare,
  getCollectionCandidates, listCollections, previewCollectionSharing, stopCollectionSharing, updateCollection,
  type CollectionDetails, type CollectionMember, type CollectionSharingPreview, type HostedCollection } from '@/services/real/hostedCollections';
import './HostedCollectionManager.css';

const COLLECTIONS_CHANGED = 'hosted-collections-changed';
const changed = () => window.dispatchEvent(new Event(COLLECTIONS_CHANGED));

export function HostedCollectionLibrary({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<HostedCollection[]>([]);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void listCollections(keyword, page).then(result => {
      if (!alive) return; setLoading(false);
      if (result.success) { setItems(result.data.items); setTotal(result.data.total); }
      else setError(result.error?.message || '合集加载失败，请重试');
    }).catch(() => { if (alive) { setLoading(false); setError('合集加载失败，请重试'); } });
    return () => { alive = false; };
  }, [keyword, page, selected]);
  if (selected) return <HostedCollectionEditor collectionId={selected === 'new' ? undefined : selected} onClose={() => setSelected(null)} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title="我的合集" description="管理合集，保留原文档与独立分享。" maxWidth={800} zIndex={800}
    content={<div className="collection-manager" style={{ maxHeight: '65dvh', overflowY: 'auto', minHeight: 0 }}>
      <div className="collection-search"><Search size={16} /><input aria-label="搜索合集" placeholder="搜索合集名称" value={keyword} onChange={e => { setKeyword(e.target.value); setPage(1); }} /></div>
      {loading ? <MapSpinner size={22} /> : items.length ? items.map(item => <button key={item.id} className="collection-library-row" onClick={() => setSelected(item.id)}><span><strong>{item.title}</strong><small>{item.siteIds.length} 份文档 · 可管理名称、成员、主文档和分享</small></span><ExternalLink size={16} /></button>) : <p>还没有可管理合集。可新建合集，或从旧合集分享页选择“管理合集”导入。</p>}
      {error && <p role="alert" className="collection-error">{error}</p>}
      <div className="collection-pager"><Button disabled={page === 1 || loading} onClick={() => setPage(x => x - 1)}>上一页</Button><span>第 {page} 页 · 共 {total} 个</span><Button disabled={page * 20 >= total || loading} onClick={() => setPage(x => x + 1)}>下一页</Button></div>
    </div>}
    actions={<><Button onClick={onClose}>关闭</Button><Button variant="primary" onClick={() => setSelected('new')}><Plus size={15} />新建合集</Button></>} />;
}

export function HostedCollectionEditor({ collectionId, shareToken, initialSites = [], onClose }: {
  collectionId?: string; shareToken?: string; initialSites?: CollectionMember[]; onClose: () => void;
}) {
  const [detail, setDetail] = useState<CollectionDetails | null>(null);
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<CollectionMember[]>(initialSites);
  const [main, setMain] = useState('');
  const [loading, setLoading] = useState(!!(collectionId || shareToken));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidates, setCandidates] = useState<CollectionMember[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const drag = useRef<number | null>(null);
  const collection = detail?.collection;
  const legacy = !!detail?.legacyShare && !collection;
  const dirty = !collection || title !== collection.title || main !== collection.mainSiteId || members.map(x => x.id).join() !== collection.siteIds.join();
  const apply = useCallback((data: CollectionDetails) => {
    setDetail(data); setTitle(data.collection?.title || data.legacyShare?.title || '');
    setMembers(data.sites); setMain(data.collection?.mainSiteId || '');
  }, []);
  const reload = async () => {
    const result = collection ? await getCollection(collection.id) : collectionId ? await getCollection(collectionId) : shareToken ? await getCollectionByShare(shareToken) : null;
    if (result?.success) apply(result.data); else if (result) setError(result.error?.message || '无法加载合集，请重试');
  };
  useEffect(() => {
    let alive = true;
    const promise = collectionId ? getCollection(collectionId) : shareToken ? getCollectionByShare(shareToken) : null;
    if (promise) void promise.then(result => { if (!alive) return; setLoading(false); if (result.success) apply(result.data); else setError(result.error?.message || '合集加载失败'); })
      .catch(() => { if (alive) { setLoading(false); setError('合集加载失败，请重试'); } });
    return () => { alive = false; };
  }, [collectionId, shareToken, apply]);
  useEffect(() => {
    let alive = true; setCandidateLoading(true);
    void getCollectionCandidates(keyword, candidatePage).then(result => {
      if (!alive) return; setCandidateLoading(false);
      if (result.success) { setCandidates(result.data.items); setCandidateTotal(result.data.total); }
      else setError(result.error?.message || '可选文档加载失败');
    }).catch(() => { if (alive) { setCandidateLoading(false); setError('可选文档加载失败'); } });
    return () => { alive = false; };
  }, [keyword, candidatePage]);
  const save = async () => {
    setBusy(true); setError(''); setStatus('');
    try {
      const draft = { title: title.trim(), siteIds: members.map(x => x.id), mainSiteId: main, version: collection?.version || 0 };
      const result = collection ? await updateCollection(collection.id, draft) : legacy && shareToken
        ? await adoptCollection(shareToken, draft.title, main) : await createCollection(draft);
      if (result.success) { apply(result.data); setStatus('合集已保存。成员和主文档的变更不会自动扩大旧分享范围。'); changed(); }
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
      const result = pending === 'dissolve' ? await dissolveCollection(collection.id, collection.version)
        : pending === 'stop' ? await stopCollectionSharing(collection.id, collection.version) : await revokeShare(pending, '作者在合集管理中停止分享');
      if (result.success) { changed(); if (pending === 'dissolve') { onClose(); return; } setPending(null); await reload(); setStatus('分享已停止，原文档保留。'); }
      else setError(result.error?.message || '操作未完成，请刷新后重试');
    } catch { setError('操作未完成，请刷新后核对实际结果'); } finally { setBusy(false); }
  };
  if (sharing && collection) return <CollectionShareForm collection={collection} onClose={() => { setSharing(false); void reload(); }} />;
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title={legacy ? '将旧分享设为可管理合集' : collection ? '管理合集' : '创建合集'} maxWidth={850} zIndex={850}
    description="组织文档、指定主文档与管理分享。"
    content={<div className="collection-manager" style={{ maxHeight: '65dvh', overflowY: 'auto', minHeight: 0 }}>
      {loading ? <MapSpinner size={22} /> : pending ? <div className="collection-confirm"><h3>{pending === 'dissolve' ? '解散这个合集？' : '停止分享？'}</h3><p>{pending === 'dissolve' ? '合集的全部分享入口将失效。原文档及其独立分享保留，已有手动关联组不会被解除。' : pending === 'stop' ? '本合集当前全部分享入口将失效，合集和原文档保留。以后可重新生成新链接。' : '仅停止这一条链接，其他分享和原文档保留。'}</p><p>已下载或缓存的副本无法收回。</p></div> : <>
        {legacy && <p className="collection-notice">旧链接和原授权范围保留。先确认名称与主文档完成导入，再调整成员；不会自动合并已有的关联组。</p>}
        <label className="collection-field">合集名称（必填）<input aria-label="合集名称" maxLength={100} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：项目发布资料" disabled={busy} /></label>
        <div className="collection-section"><strong>合集成员 · {members.length} / 90</strong><span>星标设主文档，拖动或上下移动排序</span></div>
        <div className="collection-member-list" style={{ maxHeight: '30dvh', overflowY: 'auto', minHeight: 0 }}>
          {members.map((item, index) => <div key={item.id} className="collection-member-row" draggable={!busy && !legacy && item.id !== main}
            onDragStart={() => { drag.current = index; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag.current !== null) move(drag.current, index); drag.current = null; }} onDragEnd={() => { drag.current = null; }}>
            <GripVertical size={15} aria-hidden="true" /><button aria-label={`设为主文档：${item.title}`} aria-pressed={main === item.id} disabled={busy || item.available === false} onClick={() => setMainMember(item.id)}><Star size={15} /></button>
            <span className="collection-member-title" title={item.title}>{item.title}{main === item.id && <small>主文档</small>}{item.available === false && <small className="collection-error">不可用，请移出</small>}</span>
            <button aria-label={`上移：${item.title}`} disabled={busy || legacy || index === 0 || item.id === main || members[index - 1]?.id === main} onClick={() => move(index, index - 1)}><ArrowUp size={14} /></button>
            <button aria-label={`下移：${item.title}`} disabled={busy || legacy || index + 1 === members.length || item.id === main} onClick={() => move(index, index + 1)}><ArrowDown size={14} /></button>
            <button aria-label={`移出：${item.title}`} title={item.id === main ? '请先选择替代主文档，或解散合集' : '移出合集，不删除原文档或撤销独立分享'} disabled={busy || legacy || item.id === main} onClick={() => setMembers(items => items.filter(x => x.id !== item.id))}><X size={14} /></button>
          </div>)}
          {!members.length && <p>从下方搜索并添加文档，也可在托管列表中多选后创建合集。</p>}
        </div>
        {!legacy && <><div className="collection-search"><Search size={16} /><input aria-label="搜索可加入的文档" placeholder="搜索我的文档，不影响已有合集归属" value={keyword} onChange={e => { setKeyword(e.target.value); setCandidatePage(1); }} /></div>
          {candidateLoading ? <MapSpinner size={18} /> : <div className="collection-candidates">{candidates.filter(x => !members.some(m => m.id === x.id)).map(item => <button key={item.id} disabled={busy || members.length >= 90} onClick={() => setMembers(items => [...items, item])}><Plus size={14} />{item.title}</button>)}</div>}
          <div className="collection-pager"><Button disabled={candidatePage === 1 || busy} onClick={() => setCandidatePage(x => x - 1)}>上一页</Button><span>可选文档第 {candidatePage} 页</span><Button disabled={candidatePage * 30 >= candidateTotal || busy} onClick={() => setCandidatePage(x => x + 1)}>下一页</Button></div></>}
        {collection && <><div className="collection-section"><strong>分享与权限</strong><Button disabled={busy || dirty} onClick={() => setPermissions(true)}><ShieldCheck size={14} />查看权限差异</Button></div>
          <p className="collection-notice">修改成员、顺序或主文档后，旧链接保留原快照。保存后重新生成链接，并按需停止旧分享；页面权限与独立分享分别管理。</p>
          {detail.shares.map(share => <div key={share.id} className="collection-share-row"><span><a href={`/s/wp/${encodeURIComponent(share.token)}`} target="_blank" rel="noopener noreferrer">{share.active ? '打开分享' : '查看已失效入口'}<ExternalLink size={12} /></a><small>{share.memberCount} 份 · {share.needsUpdate ? '早期成员快照' : '当前版本'} · {share.active ? '有效' : '已停止或到期'}</small></span>{share.active && <Button disabled={busy} onClick={() => setPending(share.id)}>停止此分享</Button>}</div>)}
          {!detail.shares.length && <p>尚未创建分享链接，合集只在管理中保存。</p>}
          <div className="collection-danger-actions"><Button disabled={busy} onClick={() => setPending('stop')}>停止全部分享</Button><Button variant="danger" disabled={busy} onClick={() => setPending('dissolve')}>解散合集</Button></div>
        </>}
      </>}
      {status && <p role="status" className="collection-notice">{status}</p>}
      {error && <div className="collection-error" role="alert">{error}<Button disabled={busy} onClick={() => void reload()}>刷新实际状态</Button></div>}
    </div>}
    actions={pending ? <><Button disabled={busy} onClick={() => setPending(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void execute()}>{busy && <MapSpinner size={13} />}{pending === 'dissolve' ? '确认解散合集' : '确认停止分享'}</Button></>
      : <><Button disabled={busy} onClick={onClose}>关闭</Button>{collection && <Button disabled={busy || dirty} onClick={() => setSharing(true)}>生成分享链接</Button>}<Button variant="primary" disabled={busy || loading || !title.trim() || !main || !members.length || (!!collection && !dirty)} onClick={() => void save()}>{busy && <MapSpinner size={13} />}{legacy ? '确认导入' : '保存合集'}</Button></>} />
    {permissions && collection && <RelatedPermissionsDialog siteId={collection.mainSiteId} collectionId={collection.id} onClose={() => setPermissions(false)} />}
  </>;
}

function CollectionShareForm({ collection, onClose }: { collection: HostedCollection; onClose: () => void }) {
  const [preview, setPreview] = useState<CollectionSharingPreview | null>(null);
  const [visibility, setVisibility] = useState<'owner-only' | 'logged-in' | 'public'>('owner-only');
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState(() => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ shareUrl: string; password?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { let alive = true; void previewCollectionSharing(collection.id).then(res => { if (!alive) return; if (res.success) setPreview(res.data); else setError(res.error?.message || '权限预检失败，请返回管理页刷新'); }).catch(() => { if (alive) setError('权限预检失败，请返回管理页刷新'); }); return () => { alive = false; }; }, [collection.id]);
  const create = async () => {
    if (!preview || busy) return; setBusy(true); setError('');
    try {
      const gated = await runWithPrivateSourceGate({ inspect: visibility !== 'owner-only' ? () => getSitesPrivateSources(collection.siteIds)
        : async () => ({ success: true as const, data: { requiresConfirmation: false, items: [] }, error: null }),
        run: fingerprint => createCollectionShare(collection.id, { visibility, password: usePassword ? password : undefined, expiresInDays: days,
          collectionVersion: preview.version, permissionFingerprint: preview.fingerprint, confirmedPrivateSourceFingerprint: fingerprint }), actionLabel: '生成合集分享' });
      if (gated.status === 'done') { if (gated.res.success) { setResult(gated.res.data); changed(); } else setError(gated.res.error?.message || '分享未生成，请返回后重新预检'); }
    } catch { setError('分享未完成，请返回管理页核对实际结果'); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}${result.shareUrl}${result.password ? `\n访问密码：${result.password}` : ''}`); setCopied(true); }
    catch { setError('未能复制，请选择下方链接手动复制'); }
  };
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title={`分享合集 · ${collection.title}`} maxWidth={720} zIndex={900}
    description="核对成员和访问范围，再生成分享。"
    content={<div className="collection-manager" style={{ maxHeight: '65dvh', overflowY: 'auto', minHeight: 0 }}>
      {result ? <><p className="collection-notice" role="status">分享已生成，包含已确认的成员快照。</p><a className="collection-generated-link" href={result.shareUrl} target="_blank" rel="noopener noreferrer">{window.location.origin}{result.shareUrl}<ExternalLink size={15} /></a>{result.password && <p>访问密码：<code>{result.password}</code></p>}</>
        : <>{preview ? <><p>{preview.notice}</p><div className="collection-preflight-list">{preview.items.map(item => <div key={item.id}><span>{item.isMain && <Star size={13} />}{item.title}</span><small>{item.visibility === 'public' ? '页面公开' : '页面受限'} · {item.teamCount} 个共享团队</small></div>)}</div>
          <label className="collection-field">谁能访问<select aria-label="合集分享可见性" value={visibility} onChange={e => setVisibility(e.target.value as typeof visibility)}><option value="owner-only">仅我和原协作者</option><option value="logged-in">拿到链接的登录用户</option><option value="public">任何拿到链接的人</option></select></label>
          {visibility !== 'owner-only' && <p className="collection-notice">确认生成后，所选访问者可通过这条链接读取上方所有成员，即使原页面是受限的。其他分享入口不受影响。</p>}
          <label className="collection-checkbox"><input type="checkbox" checked={usePassword} onChange={e => setUsePassword(e.target.checked)} />密码保护</label>
          {usePassword && <label className="collection-field">访问密码<input aria-label="合集访问密码" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" /></label>}
          <label className="collection-field">有效期<select aria-label="合集分享有效期" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={0}>永久</option></select></label>
          {!preview.canShare && <p className="collection-error">部分文档当前不能再分享，请返回管理页调整成员。</p>}
        </> : !error && <MapSpinner size={22} />}</>}
      {error && <p className="collection-error" role="alert">{error}</p>}
    </div>}
    actions={<><Button disabled={busy} onClick={onClose}>返回合集管理</Button>{result ? <Button variant="primary" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制链接和密码'}</Button>
      : <Button variant="primary" disabled={busy || !preview?.canShare || (usePassword && !password.trim())} onClick={() => void create()}>{busy && <MapSpinner size={14} />}确认范围并生成链接</Button>}</>} /><PrivateSourceConfirmHost /></>;
}
