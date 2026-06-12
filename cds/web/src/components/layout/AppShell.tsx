import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, LayoutGrid, LogOut, Menu, Monitor, Moon, MoreVertical, Rocket, Search, Settings, Sun, X } from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { CommitInbox } from '@/components/CommitInbox';
import { GlobalUpdateBadge } from '@/components/GlobalUpdateBadge';
import { OperatorApprovalModal } from '@/components/OperatorApprovalModal';
import { PendingImportInbox } from '@/components/PendingImportInbox';
import { AccessRequestInbox } from '@/components/AccessRequestInbox';
import { SiteNoticeInbox } from '@/components/SiteNoticeInbox';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api';
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

/*
 * MobileNavContext — lets the TopBar's hamburger (rendered from the page's
 * `topbar` prop, which lives inside AppShell's tree) open the slide-in nav
 * drawer that AppShell owns. Desktop never uses it (rail is always visible).
 */
const MobileNavContext = createContext<{ openNav: () => void }>({ openNav: () => {} });

/*
 * useFocusTrap — keep keyboard focus inside an open overlay (mobile nav drawer /
 * ⋮ action sheet), so Tab can't reach the obscured workspace behind the backdrop
 * (Bugbot #741「Modal overlays lack focus trap」). On open it moves focus into
 * the panel; on close it restores focus to the previously-focused trigger.
 *
 * Boundary-wrap only (wrap at first/last; never yank focus that is already
 * OUTSIDE the container). This is deliberately portal-safe: the sheet may host a
 * nested Radix dropdown (project list「一键部署」) whose content portals to
 * <body> — an aggressive trap would fight it. Normal tabbing still wraps inside.
 */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (!container) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
    const initial = window.setTimeout(() => focusables()[0]?.focus(), 0);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !container.contains(active)) return; // focus is elsewhere (e.g. nested portal) — leave it
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, ref]);
}

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

const preloadProjectListPage = (): void => { void import('@/pages/ProjectListPage'); };
const preloadCdsSettingsPage = (): void => { void import('@/pages/CdsSettingsPage'); };
const preloadReleaseCenterPage = (): void => { void import('@/pages/ReleaseCenterPage'); };

function shellLoginHref(mode?: string): string {
  const path = mode === 'github' ? '/api/auth/github/login' : '/login';
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
  const [navOpen, setNavOpen] = useState(false);
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
    fetch(apiUrl('/api/auth/status'), {
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

  // 抽屉打开时锁住页面滚动,否则触屏下背景工作区仍能滚动,与模态行为冲突
  // (Bugbot #741 Medium「Drawer open background scrolls」)。关闭时还原原值。
  useEffect(() => {
    if (!navOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [navOpen]);

  const logout = async (): Promise<void> => {
    const endpoint = authStatus?.logoutEndpoint;
    if (!endpoint) return;
    setLogoutState('running');
    try {
      const res = await fetch(apiUrl(endpoint), {
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
    <MobileNavContext.Provider value={{ openNav: () => setNavOpen(true) }}>
    <div className="cds-app-shell">
      {/* Desktop rail — always visible ≥768px, CSS-hidden on phones. */}
      <AppRail
        active={active}
        canLogout={Boolean(authStatus?.logoutEndpoint)}
        logoutState={logoutState}
        onLogout={() => { void logout(); }}
      />
      {/* Mobile slide-in drawer — replaces the rail on phones. */}
      <MobileNavDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
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
      {/* 2026-05-28 运维操作审批弹窗,挂全局,任何页面都能弹 */}
      <OperatorApprovalModal />
      {/* 2026-05-28 Agent 导入审批徽章 + 抽屉:右下角浮动,
          pendingCount > 0 时主动出现;flap 熔断事件也走这条 toast。
          用户反馈:不再需要 AI 给地址才能开审批 */}
      <PendingImportInbox />
      {/* 被动授权 — agent 免密发起的授权申请,右下角一键批准即派发授权密钥 */}
      <AccessRequestInbox />
      <CommitInbox />
      {/* 2026-05-04 主题切换右上角浮动(用户反馈左下角与 GlobalUpdateBadge
          重叠 + 行业 Vercel/Linear/Notion 都在右上)。fixed 不挤占 TopBar
          right slot,所有页面共享。 */}
      <FloatingThemeToggle />
    </div>
    </MobileNavContext.Provider>
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

interface RailNavProps {
  active: AppNavKey;
  canLogout: boolean;
  logoutState: 'idle' | 'running' | 'error';
  onLogout: () => void;
}

/*
 * RailNav — the nav body shared by the desktop rail and the mobile drawer.
 * `onNavigate` lets the mobile drawer close itself when a link is tapped.
 */
function RailNav({ active, canLogout, logoutState, onLogout, onNavigate }: RailNavProps & { onNavigate?: () => void }): JSX.Element {
  return (
    <>
      <div className="cds-rail-section">
        <Link
          to="/project-list"
          className="cds-rail-item"
          data-active={active === 'projects' ? 'true' : 'false'}
          aria-label="项目列表"
          title="项目列表"
          onClick={onNavigate}
          onMouseEnter={preloadProjectListPage}
          onFocus={preloadProjectListPage}
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
          onClick={onNavigate}
          onMouseEnter={preloadCdsSettingsPage}
          onFocus={preloadCdsSettingsPage}
        >
          <Settings />
          <span>Settings</span>
        </Link>
        <Link
          to="/release-center"
          className="cds-rail-item"
          data-active={active === 'release-center' ? 'true' : 'false'}
          aria-label="发布中心"
          title="发布中心（目标 / 版本 / 日志 / 回滚）"
          onClick={onNavigate}
          onMouseEnter={preloadReleaseCenterPage}
          onFocus={preloadReleaseCenterPage}
        >
          <Rocket />
          <span>Releases</span>
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
    </>
  );
}

function AppRail(props: RailNavProps): JSX.Element {
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
      <RailNav {...props} />
      {/* 2026-05-04 主题切换从这里挪到 AppShell 顶层右上(FloatingThemeToggle),
          原因:左下与 GlobalUpdateBadge 浮动徽章在某些状态下视觉重叠;industry
          标准位置(Vercel / Linear / Notion / Stripe)都在右上。 */}
    </nav>
  );
}

/*
 * MobileNavDrawer — phone-only slide-in navigation (≤767px). Replaces the
 * persistent desktop rail so the workspace gets the full screen width.
 * Opens from the TopBar hamburger; closes on backdrop tap, ESC, or nav.
 */
function MobileNavDrawer({
  open,
  onClose,
  ...nav
}: RailNavProps & { open: boolean; onClose: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时把键盘焦点困在抽屉内,Tab 不会跑到背后被遮挡的工作区
  // (Bugbot #741「Modal overlays lack focus trap」)。
  useFocusTrap(open, rootRef);

  // 关闭态:除了 aria-hidden + translateX 移出屏幕,还把整个抽屉设为 inert ——
  // 同步写在 JSX 上(不走 useEffect),避免「渲染后到 effect 执行之间」那一帧里
  // 关闭的抽屉链接/按钮仍在 Tab 序中(Bugbot #741 Medium「inert applied too late」)。
  // inert 同时移除交互 + 焦点 + a11y 树;React 18 类型无 inert 声明,用 spread 兼容。
  const inertProps = open ? {} : ({ inert: '' } as Record<string, string>);

  return (
    <div ref={rootRef} {...inertProps} className={cn('cds-mobile-drawer md:hidden', open ? 'is-open' : null)} aria-hidden={!open}>
      <div className="cds-mobile-drawer-backdrop" onClick={onClose} />
      <nav className="cds-mobile-drawer-panel" aria-label="主导航">
        <div className="cds-mobile-drawer-head">
          <div className="cds-rail-brand !pb-0">
            <div className="cds-rail-avatar" aria-label="CDS">
              <CdsMetallicLogo className="cds-rail-avatar-icon" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="cds-rail-brand-title truncate">Cloud Dev Suite</div>
            </div>
          </div>
          <button
            type="button"
            className="cds-icon-button"
            onClick={onClose}
            aria-label="关闭导航"
          >
            <X />
          </button>
        </div>
        <RailNav {...nav} onNavigate={onClose} />
      </nav>
    </div>
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
  const { openNav } = useContext(MobileNavContext);
  const [actionsOpen, setActionsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  // sheet 通过 portal 挂到 <body>(见下),所以用固定坐标定位到 ⋮ 按钮下方。
  // 不能留在 .cds-topbar 内:topbar 有 backdrop-filter,会成为 fixed 的包含块,
  // 导致全屏 backdrop 只盖住顶栏(Bugbot #741 Medium「Sheet backdrop clipped」)。
  const [sheetPos, setSheetPos] = useState<{ top: number; right: number } | null>(null);
  const toggleSheet = (): void => {
    // 先算好定位再切状态:不把 setSheetPos 塞进 setActionsOpen 的 updater(reducer 里
    // 做副作用是反模式),也保证 actionsOpen=true 时 sheetPos 必非空 —— 否则会出现
    // 「锁了背景滚动却没渲染 sheet」(Bugbot #741 Medium「Sheet open locks background scroll」)。
    const r = kebabRef.current?.getBoundingClientRect();
    setSheetPos(r
      ? { top: Math.round(r.bottom + 6), right: Math.round(Math.max(8, window.innerWidth - r.right)) }
      : { top: 56, right: 8 });
    setActionsOpen((o) => !o);
  };
  // ⋮ 动作 sheet 打开:锁背景滚动(否则触屏下背景仍可滚)+ 焦点陷阱(下方 useFocusTrap)。
  useEffect(() => {
    if (!actionsOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [actionsOpen]);
  useFocusTrap(actionsOpen, sheetRef);
  // ⋮ sheet 的键盘可关闭:焦点被困在 sheet 内时,必须能用 Esc 退出(与抽屉一致),
  // 否则键盘用户只能在菜单里打转(Bugbot #741 Medium「Sheet lacks keyboard dismiss」)。
  useEffect(() => {
    if (!actionsOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActionsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actionsOpen]);
  return (
    <header className="cds-topbar">
      {/* Hamburger — phone only. Opens the slide-in nav drawer. */}
      <button
        type="button"
        className="cds-topbar-burger cds-icon-button md:hidden"
        onClick={openNav}
        aria-label="打开导航菜单"
      >
        <Menu />
      </button>
      <div className="cds-topbar-lead flex min-w-0 flex-1 items-center gap-3 md:flex-none">
        {/* 桌面端 left 槽不收缩;手机端允许收缩 + 截断,作为单行 app-bar 标题。 */}
        <div className="cds-topbar-left flex min-w-0 shrink items-center gap-3 md:shrink-0">{left}</div>
      </div>
      {/* center(分支搜索 / Git URL 快建)单实例 + 纯 CSS 重定位:桌面行内居中扩展,
          手机端 order 靠后 + w-full,配合 header flex-wrap 落到 app-bar 第二行整宽。
          单 DOM 节点跨断点不卸载重挂(Bugbot #741 Low「Resize remounts」),
          也不双份挂载(避免分支搜索 ref/dropdown 状态被破坏)。 */}
      {center ? (
        <div className={`cds-topbar-center order-1 w-full min-w-0 md:order-none md:w-auto md:flex-1 ${centerWide ? 'md:max-w-none' : 'md:max-w-[640px]'}`}>
          {center}
        </div>
      ) : null}
      {/* 桌面端:动作按钮平铺。 */}
      {right ? <div className="cds-topbar-actions hidden shrink-0 items-center gap-2 md:flex">{right}</div> : null}
      {/* 手机端:动作收进 ⋮ 溢出菜单,点开是竖向 action sheet —— 真正的移动端形态,
          而非把一排 PC 工具栏按钮硬塞进窄屏。 */}
      {right ? (
        <div className="md:hidden">
          <button
            ref={kebabRef}
            type="button"
            className="cds-icon-button"
            onClick={toggleSheet}
            aria-label="更多操作"
            aria-expanded={actionsOpen}
          >
            <MoreVertical />
          </button>
          {/* backdrop + sheet 通过 portal 挂到 <body>,逃离 .cds-topbar 的
              backdrop-filter 包含块,fixed backdrop 才能盖满整个视口(Bugbot #741)。
              不在容器上 auto-close:right 槽可能含嵌套 Radix 菜单(项目列表「一键部署」),
              点一下就收起会破坏二级菜单 —— 改为点 backdrop / Esc 关闭。 */}
          {actionsOpen && sheetPos
            ? createPortal(
                <>
                  <div className="cds-topbar-sheet-backdrop" onClick={() => setActionsOpen(false)} />
                  <div
                    ref={sheetRef}
                    className="cds-topbar-sheet"
                    role="menu"
                    style={{ top: sheetPos.top, right: sheetPos.right }}
                  >
                    {right}
                  </div>
                </>,
                document.body,
              )
            : null}
        </div>
      ) : null}
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
