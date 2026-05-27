import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, LayoutGrid, LogOut, Monitor, Moon, Search, Settings, Sun } from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { CommitInbox } from '@/components/CommitInbox';
import { GlobalUpdateBadge } from '@/components/GlobalUpdateBadge';
import { SiteNoticeInbox } from '@/components/SiteNoticeInbox';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';
import { applyThemeMode, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/*
 * AppShell — single source of layout truth.
 *
 * Replaces every `<div className="cds-app-shell"> + custom <nav> + custom <main>`
 * pattern that each page used to re-implement. Pages now render only their
 * workspace content + an optional topbar. See `doc/plan.cds-web-migration.md`
 * Week 4.6 (visual rebuild) for why this exists.
 *
 * Visual contract:
 *   - Left sidebar: Railway-style workspace rail with text nav.
 *   - Topbar (optional): sticky, surface-base, breadcrumb left + actions right.
 *   - Main: surface-base, centered workspace ≤ 1240px (or 1360px wide).
 */

export type AppNavKey = 'projects' | 'cds-settings' | string;

export interface AppShellProps {
  /** Which left-rail item is active. */
  active?: AppNavKey;
  /** Topbar content (breadcrumb + actions). Pages should render `<TopBar>`. */
  topbar?: ReactNode;
  /** Page content. Wrap with `<Workspace>` for the standard centered column. */
  children: ReactNode;
  /** Use the wider workspace cap (1360px) for pages with a right operations rail. */
  wide?: boolean;
}

type ShellAuthStatus = {
  enabled?: boolean;
  mode?: string;
  logoutEndpoint?: string | null;
};

function shellLoginHref(mode?: string): string {
  const path = mode === 'github' ? '/login-gh.html' : '/login';
  if (window.location.port === '5173') {
    return `${window.location.protocol}//${window.location.hostname}:9900${path}`;
  }
  return path;
}

export function AppShell({ active = 'projects', topbar, children, wide = false }: AppShellProps): JSX.Element {
  /*
   * Global Cmd/Ctrl+K → CommandPalette opens. Mounting it here means every
   * page gets the palette for free, regardless of which page added the rail.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<ShellAuthStatus | null>(null);
  const [logoutState, setLogoutState] = useState<'idle' | 'running' | 'error'>('idle');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isAccel = event.metaKey || event.ctrlKey;
      if (isAccel && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    const onCustom = () => setPaletteOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('cds:open-palette' as keyof WindowEventMap, onCustom);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('cds:open-palette' as keyof WindowEventMap, onCustom);
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/auth/status', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    })
      .then((res) => res.ok ? res.json() as Promise<ShellAuthStatus> : null)
      .then((data) => setAuthStatus(data))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setAuthStatus(null);
      });
    return () => ctrl.abort();
  }, []);

  const logout = async (): Promise<void> => {
    const endpoint = authStatus?.logoutEndpoint;
    if (!endpoint) return;
    setLogoutState('running');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = shellLoginHref(authStatus.mode);
    } catch {
      setLogoutState('error');
      window.setTimeout(() => setLogoutState('idle'), 3000);
    }
  };

  return (
    <div className="cds-app-shell">
      <AppRail
        active={active}
        canLogout={Boolean(authStatus?.logoutEndpoint)}
        logoutState={logoutState}
        onLogout={() => { void logout(); }}
      />
      <div className="flex min-w-0 flex-col">
        {topbar}
        <main className={cn('cds-main', wide ? 'cds-main--wide' : null)}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* 2026-05-04 fix(用户反馈"更新看不出真假"):全局浮动徽章,任何页面
          都能看到 CDS 更新状态(GitHub 有新版本 / CDS 重启中 / 后端已更新等待
          刷新 / 前端 bundle 异常)。30s 一次轮询 /api/self-status,基于状态推
          视觉。 */}
      <GlobalUpdateBadge />
      <CommitInbox />
      {/* 2026-05-04 主题切换右上角浮动(用户反馈左下角与 GlobalUpdateBadge
          重叠 + 行业 Vercel/Linear/Notion 都在右上)。fixed 不挤占 TopBar
          right slot,所有页面共享。 */}
      <FloatingThemeToggle />
    </div>
  );
}

function FloatingThemeToggle(): JSX.Element {
  const { theme, mode, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState('');
  // 2026-05-07 用户反馈"右上角按钮被皮肤挡住":悬浮按钮 z-[70] 盖在 TopBar
  // nav buttons(z 默认)上,导致"运维"等按钮被遮挡。降到 z-[5] 让 nav 按钮
  // 在上层;同时挪到右下角避开 TopBar 区域,跟 GlobalUpdateBadge(也在底部)
  // 不重叠靠水平错开(theme 在 right-3,update badge 在 left)。
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const modeLabel = (next: 'light' | 'dark' | 'system'): string => {
    if (next === 'system') return `自动/${theme === 'dark' ? '黑天' : '白天'}`;
    return next === 'dark' ? '黑天' : '白天';
  };

  const changeTheme = (
    next: 'light' | 'dark' | 'system',
    event: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>,
  ): void => {
    setOpen(false);
    setToast(modeLabel(next));
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || prefersReduced) {
      applyThemeMode(next);
      setTheme(next);
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(() => {
      applyThemeMode(next);
      setTheme(next);
    });
    void transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 520,
          easing: 'cubic-bezier(.16,1,.3,1)',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    }).catch(() => { /* best-effort effect */ });
  };

  const toggleLightDark = (event: React.MouseEvent<HTMLButtonElement>): void => {
    changeTheme(theme === 'dark' ? 'light' : 'dark', event);
  };

  const items = [
    { mode: 'light' as const, label: '白天', icon: Sun },
    { mode: 'dark' as const, label: '黑天', icon: Moon },
    { mode: 'system' as const, label: '自动', icon: Monitor },
  ];

  return (
    <div
      className="fixed bottom-3 right-3 z-[60]"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {toast ? (
        <div className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 py-1 text-xs font-medium text-foreground shadow-lg">
          {toast}
        </div>
      ) : null}
      {open ? (
        <div className="absolute bottom-full right-0 mb-2 w-32 overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-1 shadow-2xl">
          {items.map((item) => {
            const Icon = item.icon;
            const active = mode === item.mode;
            return (
              <button
                key={item.mode}
                type="button"
                className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors ${active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground'}`}
                onClick={(event) => {
                  event.preventDefault();
                  changeTheme(item.mode, event);
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="flex-1">{item.label}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleLightDark}
        aria-label="切换主题"
        title={`切换主题(当前: ${mode === 'system' ? `自动/${theme === 'dark' ? '黑天' : '白天'}` : theme === 'dark' ? '黑天' : '白天'})`}
        className="h-9 w-9 rounded-full bg-[hsl(var(--surface-raised))]/80 backdrop-blur shadow-md hover:bg-[hsl(var(--surface-raised))]"
      >
        {mode === 'system' ? <Monitor /> : theme === 'dark' ? <Moon /> : <Sun />}
      </Button>
    </div>
  );
}

/*
 * PaletteHint — a small "⌘K" affordance for the topbar. Renders the
 * keystroke chip and dispatches the open event when clicked. Pages should
 * render this as the leftmost item in their TopBar `right` slot.
 */
export function PaletteHint(): JSX.Element {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
  const open = () => window.dispatchEvent(new Event('cds:open-palette'));
  return (
    <button
      type="button"
      onClick={open}
      title="搜索项目 / 分支 / 操作（Cmd/Ctrl + K）"
      aria-label="打开命令面板"
      className="hidden h-8 items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
    >
      <Search className="h-3.5 w-3.5" />
      搜索
      <kbd className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-1 font-mono text-[10px]">
        {isMac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
  );
}

function AppRail({
  active,
  canLogout,
  logoutState,
  onLogout,
}: {
  active: AppNavKey;
  canLogout: boolean;
  logoutState: 'idle' | 'running' | 'error';
  onLogout: () => void;
}): JSX.Element {
  return (
    <nav className="cds-rail" aria-label="主导航">
      <div className="cds-rail-brand">
        <div className="cds-rail-avatar" aria-label="CDS">
          <CdsMetallicLogo className="cds-rail-avatar-icon" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="cds-rail-brand-title truncate">Cloud Dev Suite</div>
        </div>
      </div>

      <div className="cds-rail-section">
      <Link
        to="/project-list"
        className="cds-rail-item"
        data-active={active === 'projects' ? 'true' : 'false'}
        aria-label="项目列表"
        title="项目列表"
      >
        <LayoutGrid />
        <span>Projects</span>
      </Link>
      <Link
        to="/cds-settings"
        className="cds-rail-item"
        data-active={active === 'cds-settings' ? 'true' : 'false'}
        aria-label="CDS 系统设置"
        title="CDS 系统设置（更新 / 存储 / 集群 / 全局变量）"
      >
        <Settings />
        <span>Settings</span>
      </Link>
      </div>
      <div className="flex-1" />
      {canLogout ? (
        <button
          type="button"
          className="cds-rail-item cds-rail-item--danger"
          onClick={onLogout}
          disabled={logoutState === 'running'}
          aria-label="退出登录"
          title="退出登录"
        >
          <LogOut />
          <span>
            {logoutState === 'running' ? '退出中' : logoutState === 'error' ? '退出失败' : 'Logout'}
          </span>
        </button>
      ) : null}
      {/* 2026-05-04 主题切换从这里挪到 AppShell 顶层右上(FloatingThemeToggle),
          原因:左下与 GlobalUpdateBadge 浮动徽章在某些状态下视觉重叠;industry
          标准位置(Vercel / Linear / Notion / Stripe)都在右上。 */}
    </nav>
  );
}

export interface TopBarProps {
  /** Breadcrumb / page label area, left-aligned. */
  left: ReactNode;
  /** Optional inline form area (Git URL paste, branch search, etc.) that
   *  the page wants persistently visible in the topbar. Sits between left
   *  and right slots; flexes to fill available space. Set `centerWide` to
   *  let it grow more aggressively on wide screens. */
  center?: ReactNode;
  centerWide?: boolean;
  /** Action buttons or stats, right-aligned. */
  right?: ReactNode;
}

/*
 * TopBar — sticky 56px header. Three opinionated slots:
 *   left   = breadcrumb (always visible)
 *   center = page-level inline form (Git URL paste / branch search) so the
 *            user can act without the page rendering a separate "hero" card.
 *   right  = action buttons.
 */
export function TopBar({ left, center, right, centerWide = false }: TopBarProps): JSX.Element {
  return (
    <header className="cds-topbar">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex shrink-0 items-center gap-3">{left}</div>
        {center ? (
          <div className={`min-w-0 flex-1 ${centerWide ? 'max-w-none' : 'max-w-[640px]'} hidden md:block`}>
            {center}
          </div>
        ) : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
      <SiteNoticeInbox />
    </header>
  );
}

export interface CrumbItem {
  label: string;
  href?: string;
  /**
   * Optional inline dropdown attached AFTER the label (Week 4.8 Round 4d).
   * Used for the "项目" segment so users can switch projects in 1 click
   * instead of having to go back to /project-list. Render is up to the
   * caller — Crumb just renders it next to the label.
   */
  dropdown?: ReactNode;
}

export interface CrumbProps {
  items: Array<CrumbItem>;
}

/*
 * Crumb — minimal breadcrumb for the topbar. Last item is highlighted as
 * active. No icons, no chips — keep it boring so primary actions stand out.
 * Items can attach a small dropdown via the `dropdown` slot for in-place
 * navigation (eg. project switcher).
 */
export function Crumb({ items }: CrumbProps): JSX.Element {
  return (
    <nav className="cds-crumb" aria-label="面包屑">
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const className = isLast ? 'cds-crumb-active' : 'transition-colors hover:text-foreground';
        return (
          <span key={`${item.label}-${idx}`} className="inline-flex items-center gap-1.5">
            {item.href && !isLast ? (
              <a href={item.href} className={className}>
                {item.label}
              </a>
            ) : (
              <span className={className}>{item.label}</span>
            )}
            {item.dropdown ?? null}
            {isLast ? null : <span className="text-muted-foreground/60">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

export interface WorkspaceProps {
  /** Use the wider 1360px cap for pages with right-side operations rail. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}

/*
 * Workspace — centered column inside <main>. Pages should render their content
 * inside this so that all pages share the same horizontal cap. Avoid
 * applying `max-w-*` directly on page content.
 */
export function Workspace({ wide = false, className, children }: WorkspaceProps): JSX.Element {
  return (
    <div className={cn('cds-workspace', wide ? 'cds-workspace-wide' : null, className)}>
      {children}
    </div>
  );
}
