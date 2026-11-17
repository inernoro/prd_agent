import { MotionLink, SurfaceOriginContext, isConsoleHref } from '@/components/layout/RouteMotion';
import { useInRouterContext } from 'react-router-dom';
import { useRef, useState } from 'react';
import { AnchoredPopover } from './anchored-popover';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Tiny click-outside dropdown. Not full Radix — just enough for "工具菜单"
 * style buttons (anchor + popover with click-outside + esc to close).
 *
 * Usage:
 *   <DropdownMenu trigger={<Button>...</Button>}>
 *     <DropdownItem onSelect={...}>...</DropdownItem>
 *     <DropdownDivider />
 *     <DropdownItem onSelect={...}>...</DropdownItem>
 *   </DropdownMenu>
 *
 * Implementation note: the popover renders into document.body via createPortal
 * so it can never be clipped by an ancestor with `overflow: hidden` (e.g.
 * the BranchTile card). Position is computed from the trigger's bounding
 * rect on open + on scroll/resize while open.
 */
export function DropdownMenu({ trigger, children, align = 'end', width = 220 }: {
  trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; width?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [autoFocus, setAutoFocus] = useState<false | 'first' | 'last'>(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  return <span ref={triggerRef} className="relative inline-flex" onKeyDown={event => {
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setAutoFocus(event.key === 'ArrowDown' ? 'first' : 'last'); setOpen(true);
    }
  }}>
    <span onClick={event => { event.stopPropagation(); setAutoFocus(event.detail === 0 ? 'first' : false); setOpen(value => !value); }}>{trigger}</span>
    <AnchoredPopover open={open} anchorRef={triggerRef} onDismiss={() => setOpen(false)} width={width} align={align} autoFocus={autoFocus}
      className="cds-overlay-anim z-[300] rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] py-1 shadow-2xl" role="menu"
      onClick={event => { event.stopPropagation(); setOpen(false); }}>
      <SurfaceOriginContext.Provider value={triggerRef.current}>{children}</SurfaceOriginContext.Provider>
    </AnchoredPopover>
  </span>;
}

export function DropdownItem({
  children,
  onSelect,
  asChild,
  href,
  download,
  disabled,
  destructive,
  target,
  rel,
}: {
  children: ReactNode;
  onSelect?: () => void;
  asChild?: boolean;
  href?: string;
  download?: boolean | string;
  disabled?: boolean;
  destructive?: boolean;
  target?: string;
  rel?: string;
}): JSX.Element {
  const inRouter = useInRouterContext();
  const className = cn(
    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[hsl(var(--surface-sunken))]',
    destructive ? 'text-destructive hover:text-destructive' : 'text-foreground',
    disabled ? 'pointer-events-none opacity-50' : null,
  );
  if (asChild && href && inRouter && isConsoleHref(href)) {
    return <MotionLink className={className} to={href} download={download} target={target} rel={rel} role="menuitem">{children}</MotionLink>;
  }
  if (asChild && href) {
    return (
      <a className={className} href={href} download={download} target={target} rel={rel} role="menuitem">
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onSelect} disabled={disabled} role="menuitem">
      {children}
    </button>
  );
}

export function DropdownDivider(): JSX.Element {
  return <div className="my-1 h-px bg-[hsl(var(--hairline))]" />;
}

export function DropdownLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </div>
  );
}
