import type { ReactNode } from 'react';
import { Cloud, Home, Moon, Sun } from 'lucide-react';
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
  return (
    <div className="cds-app-shell">
      <AppRail active={active} />
      <div className="flex min-w-0 flex-col">
        {topbar}
        <main className={cn('cds-main', wide ? 'cds-main--wide' : null)}>
          {children}
        </main>
      </div>
    </div>
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
  /** Action buttons or stats, right-aligned. */
  right?: ReactNode;
}

/*
 * TopBar — sticky 56px header. Pass two slots; layout is opinionated to keep
 * every page consistent (Railway/Vercel pattern: text left, actions right).
 */
export function TopBar({ left, right }: TopBarProps): JSX.Element {
  return (
    <header className="cds-topbar">
      <div className="flex min-w-0 flex-1 items-center gap-3">{left}</div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </header>
  );
}

export interface CrumbProps {
  items: Array<{ label: string; href?: string }>;
}

/*
 * Crumb — minimal breadcrumb for the topbar. Last item is highlighted as
 * active. No icons, no chips — keep it boring so primary actions stand out.
 */
export function Crumb({ items }: CrumbProps): JSX.Element {
  return (
    <nav className="cds-crumb" aria-label="面包屑">
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const className = isLast ? 'cds-crumb-active' : 'transition-colors hover:text-foreground';
        return (
          <span key={`${item.label}-${idx}`} className="inline-flex items-center gap-2">
            {item.href && !isLast ? (
              <a href={item.href} className={className}>
                {item.label}
              </a>
            ) : (
              <span className={className}>{item.label}</span>
            )}
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
