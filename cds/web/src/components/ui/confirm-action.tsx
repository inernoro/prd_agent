import { ReactElement, ReactNode, cloneElement, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

interface ConfirmActionProps {
  trigger: ReactElement<{ onClick?: () => void; disabled?: boolean; 'aria-expanded'?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  disabled = false,
  pending = false,
  onConfirm,
}: ConfirmActionProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const triggerNode = cloneElement(trigger, {
    disabled: disabled || pending || trigger.props.disabled,
    'aria-expanded': open,
    onClick: () => {
      if (disabled || pending) return;
      setOpen((value) => !value);
    },
  });

  async function confirm(): Promise<void> {
    await onConfirm();
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      {triggerNode}
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-md border border-border bg-popover p-3 text-left shadow-lg">
          <div className="text-sm font-semibold leading-5 text-popover-foreground">{title}</div>
          {description ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void confirm()} disabled={pending}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
