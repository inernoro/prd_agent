import { useAnchoredPosition } from '@/components/ui/anchored-popover';
import { ReactElement, ReactNode, cloneElement, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { Button } from '@/components/ui/button';

interface ConfirmActionProps {
  trigger: ReactElement<{ onClick?: React.MouseEventHandler<HTMLElement>; disabled?: boolean; 'aria-expanded'?: boolean; 'aria-controls'?: string; 'aria-haspopup'?: 'dialog'; onKeyDown?: React.KeyboardEventHandler<HTMLElement> }>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
  pending?: boolean;
  /** 调用方对象身份变化时，不能沿用已打开的确认。 */
  scopeKey?: string;
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
  scopeKey,
  onConfirm,
}: ConfirmActionProps): JSX.Element {
  const authScope = useContext(ConsoleAuthContext).status;
  const dialogId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  const didFocus = useRef(false);
  const openingScope = useRef<{ auth: typeof authScope; key?: string; title?: string; description?: string } | null>(null);
  const titleText = typeof title === 'string' ? title : undefined;
  const descriptionText = typeof description === 'string' ? description : undefined;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [popoverNode, setPopoverNode] = useState<HTMLDivElement | null>(null);
  const panelRef = useMemo(() => ({ current: popoverNode }), [popoverNode]);
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, widthRem: 18, align: 'end', gap: 8 });

  function scopeIsCurrent(): boolean {
    const snapshot = openingScope.current;
    return Boolean(!disabled && !pending && !trigger.props.disabled && snapshot && snapshot.auth === authScope && snapshot.key === scopeKey && snapshot.title === titleText && snapshot.description === descriptionText);
  }

  useLayoutEffect(() => {
    if (open && !scopeIsCurrent()) setOpen(false);
  }, [open, authScope, scopeKey, titleText, descriptionText, disabled, pending, trigger.props.disabled]);

  useLayoutEffect(() => {
    if (!open) {
      didFocus.current = false;
      return;
    }
    if (position.visibility !== 'visible' || !popoverNode || didFocus.current) return;
    didFocus.current = true;
    const cancel = popoverNode?.querySelector<HTMLElement>('[data-confirm-cancel]');
    (cancel || popoverNode)?.focus({ preventScroll: true });
  }, [open, position, popoverNode]);

  const triggerNode = cloneElement(trigger, {
    disabled: disabled || pending || trigger.props.disabled,
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    'aria-controls': open ? dialogId : undefined,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      trigger.props.onKeyDown?.(event);
    },
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault(); event.stopPropagation();
      if (disabled || pending) return;
      if (!open) {
        returnFocus.current = rootRef.current?.querySelector<HTMLElement>('button, a, [tabindex]') || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        openingScope.current = { auth: authScope, key: scopeKey, title: titleText, description: descriptionText };
      }
      setOpen((value) => !value);
    },
  });

  const popover = open
    ? (
      <DialogPrimitive.Portal>
        {/* CDS surface tokens are opaque in both themes; the confirmation stays above its workspace. */}
        <DialogPrimitive.Content
          ref={setPopoverNode}
          className="fixed z-[200] w-72 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3 text-left shadow-2xl"
          id={dialogId}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={event => {
            event.preventDefault();
            // FocusScope has paused the underlying workspace before this event.
            popoverNode?.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
          }}
          tabIndex={-1}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          aria-label={typeof title === 'string' ? title : '确认操作'}
          style={position}
        >
          <DialogPrimitive.Title className="text-sm font-semibold leading-5 text-foreground">{title}</DialogPrimitive.Title>
          {description ? <DialogPrimitive.Description asChild><div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div></DialogPrimitive.Description> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" data-confirm-cancel type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="destructive" size="sm" onClick={() => void confirm()} disabled={disabled || pending || trigger.props.disabled}>
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      )
    : null;

  async function confirm(): Promise<void> {
    // 2026-05-04 fix(用户反馈"点了按钮 popover 不关闭"):
    // 之前是 await onConfirm() 完才 setOpen(false),但 self-update / force-sync
    // 这类长任务的 onConfirm 是 SSE 流,会跑几十秒甚至重启进程,popover 期间
    // 一直挂着挡视线。
    // 改为先关 popover,再后台跑 onConfirm。错误反馈走 toast,不依赖 popover。
    //
    // Bugbot PR #524 反馈:popover 已关 + onConfirm 抛异常时,如果调用方没自己
    // 包 try/catch,会变成 unhandled rejection 静默吞掉。这里加一层兜底:
    // 至少 console.error,让开发可见;调用方仍应自己 toast 提示用户。
    const accepted = scopeIsCurrent();
    setOpen(false);
    if (!accepted) return;
    try {
      await onConfirm();
    } catch (err) {
      console.error('[ConfirmAction] onConfirm threw:', err);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <div ref={rootRef} className="inline-flex">
        {triggerNode}
        {popover}
      </div>
    </DialogPrimitive.Root>
  );
}
