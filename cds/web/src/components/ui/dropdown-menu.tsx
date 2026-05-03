import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  width = 220,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Recompute position whenever the menu opens or the page is scrolled/resized
  // while open. Using viewport-relative coordinates so we render with `position:
  // fixed` (no need to traverse offset parents).
  const updatePosition = (): void => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = rect.bottom + 6; // 6px gap below the trigger (was mt-1.5)
    const left = align === 'end' ? rect.right - width : rect.left;
    setCoords({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    // 1 ms isn't enough on slow phones — but rAF is. Re-position on the next
    // frame to catch layout shifts that happen mid-mount (e.g. a parent
    // animating in).
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onLayoutChange = () => updatePosition();
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onLayoutChange, true); // capture: scrolls inside any ancestor
    window.addEventListener('resize', onLayoutChange);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onLayoutChange, true);
      window.removeEventListener('resize', onLayoutChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <span ref={triggerRef} className="relative inline-flex">
      <span
        onClick={(event) => {
          // Stop propagation so click-outside on the parent (e.g. the card's
          // onClick={onDetail}) doesn't immediately close the menu.
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {trigger}
      </span>
      {open && coords
        ? createPortal(
            <div
              ref={popoverRef}
              className="cds-overlay-anim fixed z-[10100] overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] py-1 shadow-2xl"
              style={{ width, top: coords.top, left: coords.left }}
              role="menu"
              onClick={(event) => {
                // Items handle their own clicks; close the menu after any selection.
                event.stopPropagation();
                setOpen(false);
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

export function DropdownItem({
  children,
  onSelect,
  asChild,
  href,
  download,
  disabled,
  destructive,
}: {
  children: ReactNode;
  onSelect?: () => void;
  asChild?: boolean;
  href?: string;
  download?: boolean | string;
  disabled?: boolean;
  destructive?: boolean;
}): JSX.Element {
  const className = cn(
    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[hsl(var(--surface-sunken))]',
    destructive ? 'text-destructive hover:text-destructive' : 'text-foreground',
    disabled ? 'pointer-events-none opacity-50' : null,
  );
  if (asChild && href) {
    return (
      <a className={className} href={href} download={download} role="menuitem">
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
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </div>
  );
}
