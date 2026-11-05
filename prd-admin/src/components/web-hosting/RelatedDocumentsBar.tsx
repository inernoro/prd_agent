import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, FolderPlus, Grid2X2, Link2, Search, ShieldAlert, ShieldCheck, Star, X } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedDocument, type RelatedDocuments, type RelatedDocumentSource, type RelatedPermissionPreview, type RelatedSyncResult } from '@/services/real/relatedDocuments';
import './RelatedDocumentsBar.css';

export default function RelatedDocumentsBar({ siteId, source, onNavigate }: {
  siteId: string;
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
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const menuId = useId();
  const token = source?.token;
  const password = source?.password;
  const close = useCallback(() => { setOpen(false); setPinned(false); }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const result = await getRelatedDocuments(siteId, { token, password });
    if (current !== generation.current) return;
    setLoading(false);
    if (result.success) { setData(result.data); setError(''); }
    else { setData(null); setError(result.error?.message || '关联文档加载失败'); }
  }, [siteId, token, password]);
  useLayoutEffect(() => {
    setData(null); setLoading(true); setPage(0); close();
  }, [siteId, token, password, authToken, close]);
  useEffect(() => {
    void refresh();
    return () => { invalidate(); clearTimeout(closeTimer.current); };
  }, [refresh, authToken, invalidate]);
  useEffect(() => {
    const revalidate = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => { window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', revalidate); };
  }, [refresh]);
  const keepOpen = () => clearTimeout(closeTimer.current);
  const leave = () => {
    keepOpen();
    if (!pinned) closeTimer.current = setTimeout(close, 240);
  };
  const [manage, setManage] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const main = data?.items.find(item => item.isMain);
  const pages = Math.max(1, Math.ceil((data?.items.length ?? 0) / 9));
  const currentPage = Math.min(page, pages - 1);
  const openManager = () => { close(); setManage(true); };
  const openPermissions = () => { close(); setPermissions(true); };
  return <div className="related-documents-bar" aria-label="关联文档导航">
    <button ref={anchor} type="button" className="related-trigger" aria-expanded={open} aria-controls={menuId} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType === 'mouse') { keepOpen(); setOpen(true); } }} onPointerLeave={leave}
      onClick={() => { keepOpen(); if (pinned) close(); else { setOpen(true); setPinned(true); } }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); setOpen(true); setPinned(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('a,button')?.focus());
      } }}>
      <Grid2X2 size={15} /><span>关联文档</span>
      {loading ? <MapSpinner size={12} /> : <span className="related-count">{data?.items.length ?? '—'}</span>}
      <ChevronDown size={13} className={open ? 'related-chevron-open' : ''} />
    </button>
    {main && <span className="related-main-label"><Star size={12} />主文档<span title={main.title}>{main.title}</span></span>}
    {data?.canManage && data.version > 0 && <button type="button" className={`related-permission-hint ${data.hasPermissionDifferences ? 'is-warning' : ''}`} onClick={openPermissions}>
      {data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
      <span>{data.hasPermissionDifferences ? '权限不一致' : '权限与分享'}</span>
    </button>}
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align="left" gap={6} minWidth={280}
      className={`related-popover ${token ? 'surface-tone-dark' : ''}`} style={{ width: 'min(720px, calc(100vw - 24px))', maxHeight: 'min(720px, calc(100dvh - 80px))', padding: 0 }}>
      <div id={menuId} ref={panel} role="dialog" aria-label="关联文档" onPointerEnter={keepOpen} onPointerLeave={leave}
        onFocusCapture={keepOpen} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}>
        <div className="related-panel-heading"><div><strong>关联文档</strong><span>在同一组文件间快速切换</span></div>
          {data?.canManage && <button className="related-text-button" type="button" onClick={openManager}><FolderPlus size={14} />管理关联</button>}
        </div>
        <div style={{ minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100dvh - 245px)', overscrollBehavior: 'contain' }}>
          {error ? <div className="related-empty" role="alert">{error}<Button size="sm" onClick={() => { setLoading(true); void refresh(); }}>重新加载</Button></div>
            : loading ? <div className="related-empty"><MapSpinner size={20} />正在加载关联文档…</div>
              : <div className="related-document-grid">
                {data?.items.slice(currentPage * 9, currentPage * 9 + 9).map((item, index) => <a key={item.id} href={item.href}
                  className={`related-document-card ${item.id === siteId ? 'is-current' : ''}`} aria-current={item.id === siteId ? 'page' : undefined}
                  onClick={event => {
                    if (item.id === siteId) { event.preventDefault(); close(); return; }
                    if (onNavigate && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(item); }
                    close();
                  }}>
                  <div className="related-card-preview" aria-hidden="true"><span className="related-preview-index">{String(currentPage * 9 + index + 1).padStart(2, '0')}</span>
                    <div className="related-paper"><FileText size={18} /><i /><i /><i /></div>
                    {item.isMain && <span className="related-main-badge"><Star size={10} />主文档</span>}
                    <ArrowUpRight size={14} className="related-card-arrow" />
                  </div>
                  <div className="related-card-content"><strong title={item.title}>{item.title}</strong><p>{item.description || '打开查看文档内容'}</p>
                    <span className="related-card-status">{item.id === siteId ? <><span className="related-current-dot" />当前文档</> : item.isMain ? '文档组的主要入口' : '关联文档'}</span>
                  </div>
                </a>)}
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
    {manage && data?.canManage && <RelatedDocumentsManager key={siteId} siteId={siteId} data={data} onClose={() => setManage(false)} onSaved={next => { setData(next); setManage(false); }} />}
    {permissions && data?.canManage && <RelatedPermissionsDialog siteId={siteId} onClose={() => { setPermissions(false); void refresh(); }} />}
  </div>;
}

function RelatedDocumentsManager({ siteId, data, onClose, onSaved }: {
  siteId: string; data: RelatedDocuments; onClose: () => void; onSaved: (data: RelatedDocuments) => void;
}) {
  const [draft, setDraft] = useState(data.items);
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

function RelatedPermissionsDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<RelatedPermissionPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const [result, setResult] = useState<RelatedSyncResult | null>(null);
  const load = useCallback(async () => {
    setError('');
    try {
      const response = await previewRelatedPermissions(siteId);
      if (response.success) setPreview(response.data); else setError(response.error?.message || '权限差异加载失败');
    } catch { setError('权限差异加载失败，请重试'); }
  }, [siteId]);
  useEffect(() => { void load(); }, [load]);
  const sync = async () => {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const response = await syncRelatedPermissions(siteId, preview.fingerprint, revoke);
      if (response.success) { setResult(response.data); await load(); }
      else { setError(response.error?.message || '统一权限失败'); await load(); }
    } catch { setError('请求失败，请重新加载权限差异后核对实际结果'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title="关联文档权限" maxWidth={680} zIndex={1000}
    description="以主文档为准，一次同步团队、团队分组和公开页可见性。以后单独修改时会重新提醒。"
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
