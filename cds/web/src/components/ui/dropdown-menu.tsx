import { MotionLink, SurfaceOriginContext, isConsoleHref } from '@/components/layout/RouteMotion';
import { useInRouterContext } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

/** Preserve the existing facade while sharing the project's menu layering and keyboard primitive. */
export function DropdownMenu({ trigger, children, align = 'end', width = 220 }: {
  trigger: ReactElement; children: ReactNode; align?: 'start' | 'end'; width?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const disabled = Boolean(trigger.props.disabled);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  return <DropdownPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
    <DropdownPrimitive.Trigger asChild ref={triggerRef} disabled={disabled} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') event.stopPropagation();
    }}>{trigger}</DropdownPrimitive.Trigger>
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content ref={contentRef} align={align} sideOffset={6} collisionPadding={8}
        className="cds-overlay-anim z-[300] overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] py-1 shadow-2xl"
        style={{ width, maxWidth: 'calc(100vw - 1rem)', maxHeight: 'var(--radix-dropdown-menu-content-available-height)' }}
        onClick={event => {
          event.stopPropagation();
          // MotionLink prevents native navigation; close its menu even when Radix skips selection.
          if (event.target instanceof Element && event.target.closest('a[role="menuitem"]')) setOpen(false);
        }}
        onCloseAutoFocus={event => {
          // A selected action may already have moved focus into a confirmation dialog.
          const active = document.activeElement as HTMLElement | null;
          if (active && active !== document.body && active !== triggerRef.current && !contentRef.current?.contains(active) && !active.closest('[role="menu"]')) event.preventDefault();
        }}>
        <SurfaceOriginContext.Provider value={triggerRef.current}>{children}</SurfaceOriginContext.Provider>
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  </DropdownPrimitive.Root>;
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
    'flex min-h-[3.25rem] w-full items-center gap-2.5 px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-[hsl(var(--surface-sunken))] data-[highlighted]:bg-[hsl(var(--surface-sunken))] lg:min-h-0',
    destructive ? 'text-destructive hover:text-destructive' : 'text-foreground',
    disabled ? 'pointer-events-none opacity-50' : null,
  );
  if (disabled) return <DropdownPrimitive.Item disabled className={className}>{children}</DropdownPrimitive.Item>;
  if (asChild && href && inRouter && isConsoleHref(href)) {
    return <DropdownPrimitive.Item asChild><MotionLink className={className} to={href} download={download} target={target} rel={rel}>{children}</MotionLink></DropdownPrimitive.Item>;
  }
  if (asChild && href) {
    return (
      <DropdownPrimitive.Item asChild><a className={className} href={href} download={download} target={target} rel={rel}>
        {children}
      </a></DropdownPrimitive.Item>
    );
  }
  return (
    <DropdownPrimitive.Item className={className} onSelect={onSelect}>
      {children}
    </DropdownPrimitive.Item>
  );
}

export function DropdownDivider(): JSX.Element {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-[hsl(var(--hairline))]" />;
}

export function DropdownLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <DropdownPrimitive.Label className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </DropdownPrimitive.Label>
  );
}
