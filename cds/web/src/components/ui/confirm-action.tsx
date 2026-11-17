import { AnchoredPopover } from '@/components/ui/anchored-popover';
import { ReactElement, ReactNode, cloneElement, useRef, useState } from 'react';

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

  const close = (): void => {
    rootRef.current?.querySelector<HTMLElement>('button,[href],[tabindex]')?.focus({ preventScroll: true });
    setOpen(false);
  };
  const triggerNode = cloneElement(trigger, {
    disabled: disabled || pending || trigger.props.disabled,
    'aria-expanded': open,
    onClick: () => {
      if (disabled || pending) return;
      setOpen((value) => !value);
    },
  });

  const popover = open
    ? (
        // 2026-05-04 fix(.claude/rules/cds-theme-tokens.md):
        // 之前 bg-popover / text-popover-foreground 在 cds/web/src/index.css
        // 完全没定义 → CSS var 解析为空 → popover 透明,下方"更新日志"
        // 卡片内容直接穿透显示,用户看不清是什么。
        // 改用 CDS 已确实存在的 surface-raised + hairline + foreground 三 token,
        // 两个主题(dark/light)都有显式定义,绝不透明。
        // z-50 → z-[200] 提高,popover 必须高于同 tab 内的 surface 内容。
        <AnchoredPopover open anchorRef={rootRef} onDismiss={() => setOpen(false)} widthRem={18} align="end" autoFocus="first"
          className="fixed z-[200] w-72 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3 text-left shadow-2xl"
          role="dialog"
          aria-label={typeof title === 'string' ? title : '确认操作'}
        >
          <div className="text-sm font-semibold leading-5 text-foreground">{title}</div>
          {description ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void confirm()} disabled={pending}>
              {confirmLabel}
            </Button>
          </div>
        </AnchoredPopover>
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
    setOpen(false);
    try {
      await onConfirm();
    } catch (err) {
      console.error('[ConfirmAction] onConfirm threw:', err);
    }
  }

  return (
    <div ref={rootRef} className="inline-flex">
      {triggerNode}
      {popover}
    </div>
  );
}
