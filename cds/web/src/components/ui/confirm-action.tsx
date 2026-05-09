import { ReactElement, ReactNode, cloneElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';

const POPOVER_WIDTH = 288;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

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
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function updatePosition(): void {
      const triggerRect = rootRef.current?.getBoundingClientRect();
      if (!triggerRect) return;

      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
      const minLeft = viewportLeft + VIEWPORT_PADDING;
      const maxLeft = viewportLeft + viewportWidth - POPOVER_WIDTH - VIEWPORT_PADDING;
      const preferredLeft = triggerRect.right - POPOVER_WIDTH;
      const left = Math.min(Math.max(preferredLeft, minLeft), Math.max(minLeft, maxLeft));

      const belowTop = triggerRect.bottom + POPOVER_GAP;
      const aboveTop = triggerRect.top - popoverHeight - POPOVER_GAP;
      const belowSpace = viewportTop + viewportHeight - VIEWPORT_PADDING - belowTop;
      const aboveSpace = triggerRect.top - (viewportTop + VIEWPORT_PADDING) - POPOVER_GAP;
      const shouldPlaceAbove = popoverHeight > 0 && belowSpace < popoverHeight && aboveSpace > belowSpace;
      const unclampedTop = shouldPlaceAbove ? aboveTop : belowTop;
      const maxTop = viewportTop + viewportHeight - VIEWPORT_PADDING - popoverHeight;
      const top = Math.min(Math.max(unclampedTop, viewportTop + VIEWPORT_PADDING), Math.max(viewportTop + VIEWPORT_PADDING, maxTop));
      const maxHeight = Math.max(120, viewportHeight - VIEWPORT_PADDING * 2);

      setPosition({ left, top, maxHeight });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [open, title, description]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
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

  const popover = open
    ? createPortal(
        // 2026-05-04 fix(.claude/rules/cds-theme-tokens.md):
        // 之前 bg-popover / text-popover-foreground 在 cds/web/src/index.css
        // 完全没定义 → CSS var 解析为空 → popover 透明,下方"更新日志"
        // 卡片内容直接穿透显示,用户看不清是什么。
        // 改用 CDS 已确实存在的 surface-raised + hairline + foreground 三 token,
        // 两个主题(dark/light)都有显式定义,绝不透明。
        // z-50 → z-[200] 提高,popover 必须高于同 tab 内的 surface 内容。
        <div
          ref={popoverRef}
          className="fixed z-[200] w-72 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3 text-left shadow-2xl"
          role="dialog"
          aria-label={typeof title === 'string' ? title : '确认操作'}
          style={{
            left: position?.left ?? VIEWPORT_PADDING,
            top: position?.top ?? VIEWPORT_PADDING,
            maxHeight: position?.maxHeight,
            overflowY: 'auto',
            visibility: position ? 'visible' : 'hidden',
          }}
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
        </div>,
        document.body,
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
