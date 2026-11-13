import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, FileText, FolderPlus, Grid2X2, Link2, Plus, Search, ShieldAlert, ShieldCheck, Star, X } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { HOSTED_SITE_PERMISSIONS_CHANGED, getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedSummary, type RelatedDocument, type RelatedDocuments, type RelatedDocumentSource, type RelatedPermissionPreview, type RelatedSyncResult } from '@/services/real/relatedDocuments';
import { updateSite } from '@/services/real/webPages';
import { previewCollectionPermissions, syncCollectionPermissions } from '@/services/real/hostedCollections';
import { RelatedDocumentContent } from './RelatedDocumentContent';
import { CollectionContextPanel } from './CollectionContextPanel';
import './RelatedDocumentsBar.css';

export default function RelatedDocumentsBar({ siteId, source, onNavigate, variant = 'bar', summary, collectionNavigation = false, siteTitle }: {
  siteId: string; collectionNavigation?: boolean; siteTitle?: string; variant?: 'bar' | 'toolbar' | 'badge';
  summary?: RelatedSummary; source?: RelatedDocumentSource; onNavigate?: (item: RelatedDocument) => void;
}) {
  const authToken = useAuthStore(state => state.token);
  const [data, setData] = useState<RelatedDocuments | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [tagTarget, setTagTarget] = useState<RelatedDocument | null>(null);
  const [manage, setManage] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const [split, setSplit] = useState(false);
  const [maxHeight, setMaxHeight] = useState(() => typeof window === 'undefined' ? 600 : window.innerHeight - 40);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const menuId = useId();
  const token = source?.token;
  const password = source?.password;
  const collectionsEnabled = collectionNavigation && !token;
  const active = !collectionsEnabled && (variant !== 'badge' || open);
  const close = useCallback(() => { setOpen(false); setPinned(false); }, []);
  const measureAvailableHeight = useCallback(() => {
    const bounds = anchor.current?.getBoundingClientRect();
    return Math.min(360, bounds ? Math.floor(Math.max(bounds.top - 14, window.innerHeight - bounds.bottom - 14)) : window.innerHeight - 40);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setMaxHeight(measureAvailableHeight());
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, measureAvailableHeight]);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); close(); anchor.current?.focus();
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [open, close]);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const result = await getRelatedDocuments(siteId, { token, password });
    if (current !== generation.current) return;
    setLoading(false);
    if (result.success) { setData(result.data); setError(''); window.dispatchEvent(new Event('hosted-relations-changed')); }
    else { setData(null); setError(result.error?.message || '关联文档加载失败'); }
  }, [siteId, token, password]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useLayoutEffect(() => { setData(null); setLoading(true); close(); }, [siteId, token, password, authToken, close]);
  useEffect(() => {
    if (active) void refresh();
    return () => { invalidate(); clearTimeout(closeTimer.current); };
  }, [refresh, authToken, active, invalidate]);
  useEffect(() => {
    if (!active) return;
    const revalidate = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', revalidate);
    window.addEventListener('hosted-comments-changed', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => { window.removeEventListener('focus', revalidate); window.removeEventListener('hosted-comments-changed', revalidate); document.removeEventListener('visibilitychange', revalidate); };
  }, [refresh, active]);
  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => { keepOpen(); if (!pinned) closeTimer.current = setTimeout(close, 240); };
  const openPanel = (pin: boolean) => {
    keepOpen(); if (!pin && pinned) return;
    if (pin && pinned && open) { close(); return; }
    setMaxHeight(measureAvailableHeight());
    setOpen(true); if (pin) setPinned(true);
  };
  const openManager = (next = data) => { setData(next); close(); setManage(true); };
  const openPermissions = (next = data) => { setData(next); close(); setPermissions(true); };
  if (variant === 'badge' && !summary?.count && !collectionsEnabled && !open) return null;
  const compact = variant !== 'bar';
  const main = data?.items.find(item => item.isMain);
  const warn = variant === 'toolbar' && data?.canManage && data.hasPermissionDifferences;
  const badgeTitle = collectionsEnabled ? `查看${siteTitle ? '「' + siteTitle + '」的' : ''}关联文档与所属合集`
    : summary ? `${summary.isMain ? '主文档 · ' : ''}关联 ${summary.count} 份文档：${summary.titles.join('、')}` : undefined;
  return <div className={`related-documents-bar related-variant-${variant}`} aria-label="关联文档导航" data-no-drag>
    <button ref={anchor} type="button" className="related-trigger" title={warn ? '关联文档权限不一致，展开查看' : badgeTitle}
      aria-description={warn ? '关联文档权限不一致，展开可查看差异' : undefined} style={warn ? { color: 'var(--accent-fg-warning)' } : undefined}
      aria-label={variant === 'badge' ? badgeTitle : '关联文档'} aria-expanded={open} aria-controls={menuId} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType === 'mouse') openPanel(false); }} onPointerLeave={leave} onClick={() => openPanel(true)}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); keepOpen(); setMaxHeight(measureAvailableHeight()); setOpen(true); setPinned(true);
        requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('input,a,button') ?? panel.current)?.focus());
      } }}>
      {variant === 'badge' ? <Link2 size={12} /> : <Grid2X2 size={14} />}{variant !== 'badge' && <span>关联文档</span>}
      {variant === 'badge' ? <>{!!summary?.count && <span className="related-count">{summary.count}</span>}<span className="related-badge-name">{summary?.isMain ? '主文档' : summary?.mainTitle || summary?.titles[0] || '关联'}</span></>
        : loading ? <MapSpinner size={12} /> : <span className="related-count">{data?.items.length ?? '—'}</span>}
      {warn && <ShieldAlert size={12} data-permission-warning aria-hidden />}<ChevronDown size={13} className={open ? 'related-chevron-open' : ''} />
    </button>
    {!compact && main && <span className="related-main-label"><Star size={12} />主文档<span title={main.title}>{main.title}</span></span>}
    {!compact && data?.canManage && data.version > 0 && <button type="button" className={`related-permission-hint ${data.hasPermissionDifferences ? 'is-warning' : ''}`} onClick={() => openPermissions()}>
      {data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}<span>{data.hasPermissionDifferences ? '权限不一致' : '权限与分享'}</span>
    </button>}
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align={compact ? 'right' : 'left'} gap={6} minWidth={280}
      className={`related-popover ${token ? 'surface-tone-dark' : ''}`} style={{ width: collectionsEnabled && split ? 'min(680px, calc(100vw - 24px))' : 'min(464px, calc(100vw - 24px))', maxHeight, padding: 0 }}>
      <div id={menuId} ref={panel} tabIndex={-1} role="dialog" aria-label="关联文档" onPointerDown={event => { event.stopPropagation(); setPinned(true); }} onPointerEnter={keepOpen} onPointerLeave={leave}
        onFocusCapture={keepOpen} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}>
        {collectionsEnabled ? <CollectionContextPanel key={siteId + authToken} siteId={siteId} maxHeight={maxHeight - 2} onSplitChange={setSplit} onClose={close} onNavigate={onNavigate}
          onManage={next => openManager(next)} onPermissions={next => openPermissions(next)} onTagEdit={item => { close(); setTagTarget(item); }} />
          : <RelatedDocumentContent key={siteId + token} siteId={siteId} maxHeight={maxHeight - 2} source={source} data={data} error={error} loading={loading} compact={compact}
            onReload={() => { setLoading(true); void refresh(); }} onManage={() => openManager()} onPermissions={() => openPermissions()}
            onTagEdit={item => { close(); setTagTarget(item); }} onNavigate={onNavigate} onClose={close} />}
      </div>
    </AnchoredMenu>
    {manage && data?.canManage && <RelatedDocumentsManager key={siteId} siteId={siteId} data={data} onClose={() => setManage(false)} onSaved={next => { setData(next); setManage(false); window.dispatchEvent(new Event('hosted-relations-changed')); }} />}
    {tagTarget && <RelatedTagsDialog item={tagTarget} onClose={() => setTagTarget(null)} onSaved={async () => { await refresh(); setTagTarget(null); }} />}
    {permissions && data?.canManage && <RelatedPermissionsDialog siteId={siteId} onClose={() => { setPermissions(false); void refresh(); }} />}
  </div>;
}

function RelatedDocumentsManager({ siteId, data, onClose, onSaved }: {
  siteId: string; data: RelatedDocuments; onClose: () => void; onSaved: (data: RelatedDocuments) => void;
}) {
  const [draft, setDraft] = useState(data.items.filter(item => item.isManual !== false));
  const [main, setMain] = useState(data.mainSiteId || siteId);
  const [candidates, setCandidates] = useState<RelatedDocument[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void getRelatedCandidates(siteId).then(result => {
      if (!alive) return;
      setLoading(false);
      if (result.success) setCandidates(result.data.items); else setError(result.error?.message || '加载可选文档失败');
    }).catch(() => { if (alive) { setLoading(false); setError('加载失败，请关闭后重试'); } });
    return () => { alive = false; };
  }, [siteId]);
  const move = (index: number, offset: number) => setDraft(items => {
    const next = [...items]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next;
  });
  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const result = await saveRelatedDocuments(siteId, { siteIds: draft.map(item => item.id), mainSiteId: main, version: data.version });
      if (result.success) onSaved(result.data); else setError(result.error?.message || '保存失败');
    } catch { setError('保存失败，请重试'); } finally { setSaving(false); }
  };
  const available = candidates.filter(item => !draft.some(selected => selected.id === item.id) && item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }} title="管理关联文档" maxWidth={680} zIndex={1000}
    description="选择同组文件并指定一份主文档。关联关系不会改变任何文件的权限。"
    content={<div className="related-manager"><div className="related-section-label">已关联 {draft.length} / 90<span>星标设为主文档</span></div>
      <div className="related-selected-list" style={{ maxHeight: '30dvh', overflowY: 'auto', minHeight: 0 }}>
        {draft.map((item, index) => <div className="related-selected-row" key={item.id}>
          <button type="button" className={main === item.id ? 'is-main' : ''} aria-label={`设为主文档：${item.title}`} aria-pressed={main === item.id} disabled={saving} onClick={() => setMain(item.id)}><Star size={15} /></button>
          <span title={item.title}>{item.title}</span>{item.id === siteId && <small>当前</small>}
          <button type="button" aria-label={`上移：${item.title}`} disabled={saving || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`下移：${item.title}`} disabled={saving || index + 1 === draft.length} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
          <button type="button" aria-label={`移出关联：${item.title}`} title={item.id === siteId ? '当前文档需保留；可从其他成员页移出' : '只移出关联，不删除文件'} disabled={saving || item.id === siteId}
            onClick={() => { setDraft(items => items.filter(selected => selected.id !== item.id)); if (main === item.id) setMain(siteId); }}><X size={14} /></button>
        </div>)}
      </div>
      <label className="related-search"><Search size={15} /><input placeholder="搜索并添加我的文档" aria-label="搜索并添加我的文档" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div style={{ maxHeight: '24dvh', overflowY: 'auto', minHeight: 0 }}>
        {loading ? <div className="related-empty"><MapSpinner size={16} />正在加载可选文件…</div>
          : available.length ? available.map(item => <button key={item.id} type="button" className="related-candidate" disabled={saving || draft.length >= 90} onClick={() => setDraft(items => [...items, item])}><FileText size={14} /><span>{item.title}</span><FolderPlus size={14} /></button>)
            : <p className="related-small-note">{search ? '没有找到匹配的可关联文档' : '没有其他可关联文档。已加入其他组的文件不会出现在这里。'}</p>}
      </div>
      {error && <p className="related-error" role="alert">{error}</p>}
    </div>}
    actions={<><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving && <MapSpinner size={14} />}保存关联</Button></>} />;
}

export function RelatedPermissionsDialog({ siteId, collectionId, onClose }: { siteId: string; collectionId?: string; onClose: () => void }) {
  const [preview, setPreview] = useState<RelatedPermissionPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const [result, setResult] = useState<RelatedSyncResult | null>(null);
  const load = useCallback(async () => {
    setError('');
    try {
      const response = await (collectionId ? previewCollectionPermissions(collectionId) : previewRelatedPermissions(siteId));
      if (response.success) setPreview(response.data); else setError(response.error?.message || '权限差异加载失败');
    } catch { setError('权限差异加载失败，请重试'); }
  }, [siteId, collectionId]);
  useEffect(() => { void load(); }, [load]);
  const sync = async () => {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const response = await (collectionId ? syncCollectionPermissions(collectionId, preview.fingerprint, revoke) : syncRelatedPermissions(siteId, preview.fingerprint, revoke));
      if (response.success) {
        setResult(response.data);
        // 同步可能只完成部分文档；列表和独立分享入口都应重新读取服务端实际状态。
        window.dispatchEvent(new Event(HOSTED_SITE_PERMISSIONS_CHANGED));
        await load();
      }
      else { setError(response.error?.message || '统一权限失败'); await load(); }
    } catch { setError('请求失败，请重新加载权限差异后核对实际结果'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title={collectionId ? "合集文档权限" : "关联文档权限"} maxWidth={680} zIndex={1000}
    description={collectionId ? "以主文档为准，同步合集成员的团队、分组和公开页可见性。评论引用保留独立权限。" : "以主文档为准，同步手动关联文档的团队、分组和公开页可见性。评论引用保留独立权限。"}
    content={<div className="related-manager">
      {!preview && !error && <div className="related-empty"><MapSpinner size={20} />正在核对访问范围…</div>}
      {preview && <><div className="related-source"><Star size={16} /><div><span>权限来源 · 主文档</span><strong>{preview.sourceTitle}</strong></div></div>
        <div style={{ maxHeight: '34dvh', overflowY: 'auto', minHeight: 0 }}>
          {preview.items.map(item => <div className="related-permission-row" key={item.id}>
            {item.matches ? <ShieldCheck size={16} className="related-success" /> : <ShieldAlert size={16} className="related-warning" />}
            <div><strong>{item.title}{item.isMain && <small>主文档</small>}</strong>
              <p>{item.differences.length ? item.differences.join('；') : '页面权限一致'}</p>
              {item.activeShareCount > 0 && <p className="related-warning">另有 {item.activeShareCount} 个独立分享入口</p>}</div>
          </div>)}
        </div>
        <div className="related-permission-notice"><ShieldAlert size={16} /><p>{preview.shareNotice}</p></div>
        <label className="related-revoke-option"><input type="checkbox" checked={revoke} disabled={busy || !preview.canRevokeShares} onChange={event => setRevoke(event.target.checked)} />
          <span>同时撤销其他文档的现有分享链接<small>旧链接将立即失效，不会复制主文档的分享凭证。</small></span></label>
        {!preview.canRevokeShares && <p className="related-small-note">存在其他成员创建的链接，请由链接创建者处理。</p>}
        {preview.blockingReason && <p className="related-error">{preview.blockingReason}</p>}
      </>}
      {result && <div role="status" className="related-sync-results">{result.results.map(item => <p key={item.id} className={item.success ? 'related-success' : 'related-error'}>{item.success && <Check size={13} />}{item.title}：{item.message}</p>)}
        {result.sharesRevoked > 0 && <p>已撤销 {result.sharesRevoked} 个分享链接。</p>}</div>}
      {error && <p role="alert" className="related-error">{error}</p>}
    </div>}
    actions={<><Button disabled={busy} onClick={onClose}>{result ? '完成' : '取消'}</Button>
      {error && <Button disabled={busy} onClick={() => void load()}>刷新差异</Button>}
      <Button variant="primary" disabled={!preview || !preview.canSync || busy || preview.items.length < 2} onClick={() => void sync()}>{busy ? <MapSpinner size={14} /> : <ShieldCheck size={14} />}应用统一权限</Button></>} />;
}

function RelatedTagsDialog({ item, onClose, onSaved }: { item: RelatedDocument; onClose: () => void; onSaved: () => Promise<void> }) {
  const [tags, setTags] = useState(item.tags ?? []);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const add = () => {
    const value = input.trim();
    if (!value) return;
    if (value.length > 24 || tags.length >= 20) { setError('每个标签最多 24 字，最多添加 20 个标签'); return; }
    setTags(current => current.includes(value) ? current : [...current, value]); setInput(''); setError('');
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const extra = input.trim();
      if (extra.length > 24 || (extra && !tags.includes(extra) && tags.length >= 20)) { setError('每个标签最多 24 字，最多添加 20 个标签'); return; }
      const result = await updateSite(item.id, { tags: extra && !tags.includes(extra) ? [...tags, extra] : tags });
      if (result.success) await onSaved(); else setError(result.error?.message || '标签保存失败');
    } catch { setError('标签保存失败，请重试'); } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }} title="编辑文档标签" description={item.title} zIndex={1000}
    content={<div className="related-manager"><div className="related-edit-tags">{tags.map(tag => <span key={tag}>{tag}<button type="button" aria-label={`删除标签：${tag}`} disabled={saving} onClick={() => setTags(current => current.filter(t => t !== tag))}><X size={12} /></button></span>)}</div>
      <form className="related-add-tag" onSubmit={event => { event.preventDefault(); add(); }}><input aria-label="新标签" placeholder="输入标签，按回车添加" value={input} maxLength={24} disabled={saving} onChange={event => setInput(event.target.value)} /><Button type="submit" size="sm" disabled={saving || !input.trim()}><Plus size={13} />添加</Button></form>
      <p className="related-small-note">标签保存在这份文档上，可用于筛选关联文件。</p>{error && <p role="alert" className="related-error">{error}</p>}</div>}
    actions={<><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving && <MapSpinner size={14} />}保存标签</Button></>} />;
}
