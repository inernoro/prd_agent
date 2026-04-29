import { useEffect, useRef, useState } from 'react';
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
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <span onClick={() => setOpen((current) => !current)}>{trigger}</span>
      {open ? (
        <div
          className="cds-overlay-anim absolute top-full z-30 mt-1.5 overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] py-1 shadow-2xl"
          style={{ width, [align === 'end' ? 'right' : 'left']: 0 }}
          role="menu"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
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
