import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, MoreHorizontal, Pencil, Settings2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useResolvedThemeMode } from '@/stores/mobileThemeStore';
import { updateSite, type SharedSiteInfo } from '@/services/real/webPages';

import { AnchoredMenu } from '@/components/ui/AnchoredMenu';

const SiteSettingsDialog = lazy(() => import('./SiteSettingsDialog'));

export function SharePageTitle({ site, onRenamed }: {
  site: SharedSiteInfo;
  onRenamed: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(site.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const next = title.trim();
    if (!next || saving) return;
    setSaving(true);
    setError('');
    try {
      // 只更新站点元信息；不调用分享创建或撤销接口。
      const result = await updateSite(site.id, { title: next });
      if (!result.success) { setError(result.error?.message || '修改标题失败'); return; }
      onRenamed(result.data.title);
      setOpen(false);
    } catch {
      setError('修改标题失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };
  return <>
    <span title={site.title}>{site.title}</span>
    {site.viewerIsOwner && <>
      <button type="button" className="share-topbar-btn" aria-label="修改标题" title="修改标题"
        onClick={() => { setTitle(site.title); setError(''); setOpen(true); }}>
        <Pencil size={14} />
      </button>
      <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }} title="修改网页标题"
        description="修改后原分享链接仍然有效。"
        content={<form id="rename-hosted-page" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="block text-sm" htmlFor="hosted-page-title">网页标题</label>
          <input id="hosted-page-title" autoFocus value={title} disabled={saving} maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-2 w-full rounded-md border border-token-default bg-token-input px-3 py-2 text-token-primary" />
          {error && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--semantic-danger-text)' }}>{error}</p>}
        </form>}
        actions={<><Button variant="secondary" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
          <Button type="submit" form="rename-hosted-page" disabled={saving || !title.trim()}>
            {saving ? '保存中…' : '保存'}
          </Button></>} />
    </>}
  </>;
}

export function SharePageActions({ site, compact, menu, children, onSettingsSaved }: {
  site: SharedSiteInfo;
  compact: boolean;
  menu?: boolean;
  children?: ReactNode;
  onSettingsSaved: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const role = menu ? 'menuitem' : undefined;
  const actions = <>
    {site.viewerIsOwner && <button type="button" role={role} className="share-topbar-btn" title="设置" aria-label="设置"
      onClick={() => setSettingsOpen(true)}><Settings2 size={15} />{menu && '设置'}</button>}
    <button type="button" role={role} className="share-topbar-btn" title="返回网页托管" aria-label="返回网页托管"
      onClick={() => navigate(site.viewerCanEdit
        ? `/web-pages?focusSite=${encodeURIComponent(site.id)}` : '/web-pages')}>
      <ArrowLeft size={15} />{(menu || !compact) && '返回网页托管'}
    </button>{children}
  </>;
  return <>
    {menu ? <ShareMoreMenu adaptive>{actions}</ShareMoreMenu> : actions}
    {settingsOpen && site.viewerIsOwner && <Suspense fallback={<MapSpinner size={16} />}>
      <SiteSettingsDialog siteId={site.id} siteTitle={site.title} onClose={() => setSettingsOpen(false)}
        onSaved={async () => {
          try { await onSettingsSaved(); }
          catch { throw new Error('设置已保存，页面刷新失败，请重试或重新打开网页。'); }
        }} />
    </Suspense>}
  </>;
}


/** 低频动作放在同一个锚定菜单里，避免占满阅读页顶栏。 */
export function ShareMoreMenu({ children, adaptive = false }: { children: ReactNode; adaptive?: boolean }) {
  const [open, setOpen] = useState(false);
  const theme = useResolvedThemeMode();
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <button ref={anchor} type="button" className="share-topbar-btn share-topbar-icon" title="更多" aria-label="更多"
      aria-expanded={open} aria-haspopup="menu" onClick={event => {
        focusOnOpen.current = event.detail === 0;
        setOpen(value => !value);
      }} onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (open) menu.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
        else {
          focusOnOpen.current = true;
          setOpen(true);
        }
      }}>
      <MoreHorizontal size={17} />
    </button>
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} ignoreAutomaticFrameFocus
      className={`share-more-menu ${adaptive ? '' : 'surface-tone-dark'}`} minWidth={180} theme={adaptive ? theme : undefined}
      style={adaptive ? { background: 'var(--review-b-popover)' } : undefined}>
      <div ref={menu} role="menu" aria-label="更多网页操作" onClick={(event) => {
        const action = (event.target as Element).closest('button:not(:disabled), a[href]');
        if (action && !action.hasAttribute('data-menu-keep-open')) { close(); anchor.current?.focus({ preventScroll: true }); }
      }} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.current?.focus({ preventScroll: true }); }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
        const current = items.indexOf(document.activeElement as HTMLElement);
        items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      }}>{children}</div>
    </AnchoredMenu>
  </>;
}
