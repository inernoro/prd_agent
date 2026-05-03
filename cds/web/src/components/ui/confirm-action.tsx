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
        // 2026-05-04 fix(.claude/rules/cds-theme-tokens.md):
        // 之前 bg-popover / text-popover-foreground 在 cds/web/src/index.css
        // 完全没定义 → CSS var 解析为空 → popover 透明,下方"更新日志"
        // 卡片内容直接穿透显示,用户看不清是什么。
        // 改用 CDS 已确实存在的 surface-raised + hairline + foreground 三 token,
        // 两个主题(dark/light)都有显式定义,绝不透明。
        // z-50 → z-[200] 提高,popover 必须高于同 tab 内的 surface 内容。
        <div
          className="absolute right-0 top-full z-[200] mt-2 w-72 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3 text-left shadow-2xl"
          role="dialog"
          aria-label={typeof title === 'string' ? title : '确认操作'}
        >
          <div className="text-sm font-semibold leading-5 text-foreground">{title}</div>
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
