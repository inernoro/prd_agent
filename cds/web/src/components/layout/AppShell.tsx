import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Cloud, Home, Moon, Search, Sun } from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
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
 *   - Left rail: 56px, surface-sunken, icon-only nav, theme toggle bottom.
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

export function AppShell({ active = 'projects', topbar, children, wide = false }: AppShellProps): JSX.Element {
  /*
   * Global Cmd/Ctrl+K → CommandPalette opens. Mounting it here means every
   * page gets the palette for free, regardless of which page added the rail.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  return (
    <div className="cds-app-shell">
      <AppRail active={active} />
      <div className="flex min-w-0 flex-col">
        {topbar}
        <main className={cn('cds-main', wide ? 'cds-main--wide' : null)}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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

function AppRail({ active }: { active: AppNavKey }): JSX.Element {
  const { theme, toggle } = useTheme();
  return (
    <nav className="cds-rail" aria-label="主导航">
      <a
        href="/project-list"
        className="cds-rail-item"
        data-active={active === 'projects' ? 'true' : 'false'}
        aria-label="项目列表"
        title="项目列表"
      >
        <Home />
      </a>
      <a
        href="/cds-settings"
        className="cds-rail-item"
        data-active={active === 'cds-settings' ? 'true' : 'false'}
        aria-label="CDS 系统设置"
        title="CDS 系统设置"
      >
        <Cloud />
      </a>
      <div className="flex-1" />
      <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题" title="切换主题">
        {theme === 'dark' ? <Sun /> : <Moon />}
      </Button>
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
