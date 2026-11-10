import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, FolderPlus, Grid2X2, List, Tags, Plus, Link2, Search, ShieldAlert, ShieldCheck, Star, X, ExternalLink } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { HOSTED_SITE_PERMISSIONS_CHANGED, getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedSummary, type RelatedDocument, type RelatedDocuments, type RelatedDocumentSource, type RelatedPermissionPreview, type RelatedSyncResult } from '@/services/real/relatedDocuments';
import { SitePreview } from '@/components/SitePreview';
import { updateSite } from '@/services/real/webPages';
import { previewCollectionPermissions, syncCollectionPermissions } from '@/services/real/hostedCollections';
import './RelatedDocumentsBar.css';

export default function RelatedDocumentsBar({ siteId, source, onNavigate, variant = 'bar', summary }: {
  siteId: string;
  variant?: 'bar' | 'toolbar' | 'badge';
  summary?: RelatedSummary;
  source?: RelatedDocumentSource;
  onNavigate?: (item: RelatedDocument) => void;
}) {
  const authToken = useAuthStore(state => state.token);
  const [data, setData] = useState<RelatedDocuments | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'cards' | 'list'>(() => {
    try { return localStorage.getItem('hosted-related-view') === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
  });
  const [tagFilter, setTagFilter] = useState('');
  const [referenceScope, setReferenceScope] = useState<'all' | 'members' | 'references'>('all');
  const [tagTarget, setTagTarget] = useState<RelatedDocument | null>(null);
  const changeView = (next: 'cards' | 'list') => {
    setView(next); try { localStorage.setItem('hosted-related-view', next); } catch { /* 私密浏览仍可切换。 */ }
  };
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const menuId = useId();
  const active = variant !== 'badge' || open;
  const token = source?.token;
  const password = source?.password;
  const close = useCallback(() => { setOpen(false); setPinned(false); }, []);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // 在文档和窗口上的父弹窗监听器之前消费按键，一次只关闭关联浮层。
      event.preventDefault(); event.stopPropagation();
      close(); anchor.current?.focus();
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [open, close]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const result = await getRelatedDocuments(siteId, { token, password });
    if (current !== generation.current) return;
    setLoading(false);
    if (result.success) { setData(result.data); setError(''); window.dispatchEvent(new Event('hosted-relations-changed')); }
    else { setData(null); setError(result.error?.message || '关联文档加载失败'); }
  }, [siteId, token, password]);
  useLayoutEffect(() => {
    setData(null); setLoading(true); setPage(0); setTagFilter(''); close();
  }, [siteId, token, password, authToken, close]);
  useEffect(() => {
    if (active) void refresh();
    return () => { invalidate(); clearTimeout(closeTimer.current); };
  }, [refresh, authToken, invalidate, active]);
  useEffect(() => {
    if (!active) return;
    const revalidate = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', revalidate);
    window.addEventListener('hosted-comments-changed', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => { window.removeEventListener('focus', revalidate); window.removeEventListener('hosted-comments-changed', revalidate); document.removeEventListener('visibilitychange', revalidate); };
  }, [refresh, active]);
  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    keepOpen();
    if (!pinned) closeTimer.current = setTimeout(close, 240);
  };
  const [manage, setManage] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const main = data?.items.find(item => item.isMain);
  const availableTags = [...new Set(data?.items.flatMap(item => item.tags ?? []) ?? [])];
  const displayed = data?.items.filter(item => (!tagFilter || item.tags?.includes(tagFilter)) && (referenceScope === 'all' || (referenceScope === 'members' ? item.isManual !== false : item.isManual === false))) ?? [];
  const pages = Math.max(1, Math.ceil(displayed.length / 9));
  const currentPage = Math.min(page, pages - 1);
  const openManager = () => { close(); setManage(true); };
  const openPermissions = () => { close(); setPermissions(true); };
  if (variant === 'badge' && !summary?.count && !open) return null;
  const compact = variant !== 'bar';
  const warn = variant === 'toolbar' && data?.canManage && data.hasPermissionDifferences;
  const badgeTitle = summary ? `${summary.isMain ? '主文档 · ' : ''}关联 ${summary.count} 份文档：${summary.titles.join('、')}` : undefined;
  return <div className={`related-documents-bar related-variant-${variant}`} aria-label="关联文档导航" data-no-drag>
    <button ref={anchor} type="button" className="related-trigger" title={warn ? '关联文档权限不一致，展开查看' : badgeTitle}
      aria-description={warn ? '关联文档权限不一致，展开可查看差异' : undefined} style={warn ? { color: 'var(--accent-fg-warning)' } : undefined} aria-label={variant === 'badge' ? badgeTitle : '关联文档'} aria-expanded={open} aria-controls={menuId} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType === 'mouse') { keepOpen(); setOpen(true); } }} onPointerLeave={leave}
      onClick={() => { keepOpen(); if (pinned) close(); else { setOpen(true); setPinned(true); } }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); setOpen(true); setPinned(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('a,button')?.focus());
      } }}>
      {variant === 'badge' ? <Link2 size={12} /> : <Grid2X2 size={14} />}{variant !== 'badge' && <span>关联文档</span>}
      {variant === 'badge' ? <><span className="related-count">{summary?.count ?? 0}</span><span className="related-badge-name">{summary?.isMain ? '主文档' : summary?.mainTitle || summary?.titles[0]}</span></>
        : loading ? <MapSpinner size={12} /> : <span className="related-count">{data?.items.length ?? '—'}</span>}
      {warn && <ShieldAlert size={12} data-permission-warning aria-hidden />}
      <ChevronDown size={13} className={open ? 'related-chevron-open' : ''} />
    </button>
    {!compact && main && <span className="related-main-label"><Star size={12} />主文档<span title={main.title}>{main.title}</span></span>}
    {!compact && data?.canManage && data.version > 0 && <button type="button" className={`related-permission-hint ${data.hasPermissionDifferences ? 'is-warning' : ''}`} onClick={openPermissions}>
      {data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
      <span>{data.hasPermissionDifferences ? '权限不一致' : '权限与分享'}</span>
    </button>}
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align={compact ? 'right' : 'left'} gap={6} minWidth={280}
      className={`related-popover ${token ? 'surface-tone-dark' : ''}`} style={{ width: 'min(720px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 40px)', padding: 0 }}>
      <div id={menuId} ref={panel} role="dialog" aria-label="关联文档" onPointerDown={event => event.stopPropagation()} onPointerEnter={keepOpen} onPointerLeave={leave}
        onFocusCapture={keepOpen} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}>
        <div className="related-panel-heading"><div><strong>{data?.contextLabel || '关联文档'}</strong><span>手动成员保留作者顺序，评论引用独立展示</span></div>
          <div className="related-heading-actions"><div className="related-view-switch" aria-label="关联文档展示方式">
            <button type="button" aria-label="卡片视图" aria-pressed={view === 'cards'} onClick={() => changeView('cards')}><Grid2X2 size={14} /></button>
            <button type="button" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => changeView('list')}><List size={15} /></button>
          </div>{data?.canManage && <button className="related-text-button" type="button" onClick={openManager}><FolderPlus size={14} />管理关联</button>}</div>
        </div>
        {compact && (main || (data?.canManage && data.version > 0)) && <div className="related-context-row">
          {main && <span className="related-main-label"><Star size={12} />主文档<span title={main.title}>{main.title}</span></span>}
          {data?.canManage && data.version > 0 && <button type="button" className={`related-permission-hint ${data.hasPermissionDifferences ? 'is-warning' : ''}`} onClick={openPermissions}>
            {data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}{data.hasPermissionDifferences ? '权限不一致' : '权限与分享'}
          </button>}
        </div>}
        {data?.items.some(item => item.isManual === false) && <div className="related-tag-filters" aria-label="按关联来源筛选">
          <button type="button" aria-pressed={referenceScope === 'all'} onClick={() => { setReferenceScope('all'); setPage(0); }}>全部</button>
          <button type="button" aria-pressed={referenceScope === 'members'} onClick={() => { setReferenceScope('members'); setPage(0); }}>{data.contextLabel || '手动关联'}</button>
          <button type="button" aria-pressed={referenceScope === 'references'} onClick={() => { setReferenceScope('references'); setPage(0); }}>评论引用</button>
        </div>}
        {availableTags.length > 0 && <div className="related-tag-filters" aria-label="按标签筛选">
          <button type="button" aria-pressed={!tagFilter} onClick={() => { setTagFilter(''); setPage(0); }}>全部</button>
          {availableTags.map(tag => <button key={tag} type="button" aria-pressed={tagFilter === tag} onClick={() => { setTagFilter(tag); setPage(0); }}>{tag}</button>)}
        </div>}
        <div style={{ minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100dvh - 220px)', overscrollBehavior: 'contain' }}>
          {error ? <div className="related-empty" role="alert">{error}<Button size="sm" onClick={() => { setLoading(true); void refresh(); }}>重新加载</Button></div>
            : loading ? <div className="related-empty"><MapSpinner size={20} />正在加载关联文档…</div>
              : <div className={`related-document-grid ${view === 'list' ? 'is-list' : ''}`}>
                {displayed.slice(currentPage * 9, currentPage * 9 + 9).map((item, index) => <div key={item.id} className="related-item">
                  <a href={item.href} className={`related-document-card ${item.id === siteId ? 'is-current' : ''}`} aria-current={item.id === siteId ? 'page' : undefined}
                    onClick={event => {
                      if (item.id === siteId) { event.preventDefault(); close(); return; }
                      if (onNavigate && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(item); }
                      close();
                    }}>
                    <div className="related-card-preview">
                      {item.preview ? <SitePreview url={item.preview.siteUrl} site={{ ...item.preview,
                        shareAccess: item.preview.useShareAccess && token ? { token, password } : undefined }} className="related-live-preview" />
                        : <span className="related-no-preview">暂无预览</span>}
                      <span className="related-preview-index">{String(currentPage * 9 + index + 1).padStart(2, '0')}</span>
                      {item.isMain && <span className="related-main-badge"><Star size={10} />主文档</span>}
                    </div>
                    <div className="related-card-content"><strong title={item.title}>{item.title}</strong><p>{item.description || '打开查看文档内容'}</p>
                      <div className="related-tag-list">{item.tags?.map(tag => <span className="related-custom-tag" key={tag}>{tag}</span>)}
                        {item.mentions?.slice(0, 2).map(mention => <span key={mention.commentId} className="related-mention-tag" title={`${mention.sourceTitle} · ${mention.label}`}>{mention.label}</span>)}
                      </div>
                      <span className="related-card-status">{item.id === siteId ? <><span className="related-current-dot" />当前文档</> : item.isMain ? '文档组的主要入口' : item.isManual === false ? '评论引用' : '关联文档'}</span>
                    </div>
                  </a>
                  <a className="related-open-new-tab" href={item.href} target="_blank" rel="noopener noreferrer" data-no-drag
                    aria-label={`在新标签页打开：${item.title}`} title="在新标签页打开" onClick={event => event.stopPropagation()}><ExternalLink size={12} /></a>
                  {item.canEditTags && <button type="button" className="related-tag-edit" aria-label={`编辑标签：${item.title}`} title="编辑文档标签"
                    onClick={() => { close(); setTagTarget(item); }}><Tags size={13} /></button>}
                </div>)}
                {!displayed.length && <p className="related-small-note">没有符合该标签的关联文档。</p>}
              </div>}

        </div>
        <div className="related-panel-footer"><span><Link2 size={13} />每份文档独立授权</span>
          {pages > 1 ? <div className="related-pagination"><button aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15} /></button>
            <span>{currentPage + 1} / {pages}</span><button aria-label="下一页" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15} /></button></div>
            : data?.canManage && data.version > 0 && <button type="button" className="related-text-button" onClick={openPermissions}>{data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
              {data.hasPermissionDifferences ? '查看权限差异' : '查看权限与分享'}</button>}
        </div>
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
