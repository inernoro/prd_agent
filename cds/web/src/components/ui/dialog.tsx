/*
 * Dialog primitive — wraps Radix Dialog with CDS theming.
 *
 * Replaces the 5 hand-rolled modal implementations in cds/web/*.js (each one
 * had its own portal/focus-trap/ESC/min-h-0/dark-fallback bugs). Radix
 * handles portal + focus trap + ESC + scroll lock; tokens come from theme.
 * See .claude/rules/frontend-modal.md.
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /**
     * frame 布局：不再套「整体滚动」的内层包裹，children 直接铺在 flex-col 的
     * Content 里，由调用方自己划分 shrink-0 头部 / flex-1 滚动主体 / shrink-0 底栏。
     * 给「操作按钮必须永远可见」的高内容弹窗用（发布弹窗返工的根因之一就是
     * 底栏跟着长内容一起滚走，用户要「使劲拉下去才能看到下一步操作」）。
     */
    frame?: boolean;
  }
>(({ className, children, style, frame, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 flex w-full max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col border bg-card shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg',
        frame && 'overflow-hidden',
        className
      )}
      // 布局关键尺寸走 inline style：frontend-modal.md 明确 Tailwind arbitrary value(h-[90vh]) 在 v4 下不可靠。
      // 高内容弹窗(如「一键部署项目」含 12 个基建预设)在此 cap 90vh + 内层滚动，杜绝内容飞出视口顶部。
      style={{ maxHeight: '90vh', ...style }}
      {...props}
    >
      {frame ? children : (
        <div
          className="grid gap-4 overflow-y-auto p-6"
          // gridTemplateColumns 的 minmax(0, 1fr)：grid 轨道默认 min-content 下限，
          // 一段不换行的长内容（日志 <pre>、整段脚本）会把轨道撑得比弹窗还宽，
          // 右侧内容整体被裁掉——2026-07-30 用户截图里「输入框不见了」「步骤 2/4/6
          // 消失」就是这个。钉死 minmax(0,1fr) 后轨道永不超过容器，
          // 长内容只能在自己的滚动容器里消化。
          style={{ minHeight: 0, overscrollBehavior: 'contain', gridTemplateColumns: 'minmax(0, 1fr)' }}
        >
          {children}
        </div>
      )}
      <DialogPrimitive.Close className="absolute right-4 top-4 z-10 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">关闭</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/** frame 布局里的滚动主体：flex-1 + min-h-0 + 自己消化纵向滚动。 */
export const DialogBody = ({ className, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4', className)}
    style={{ overscrollBehavior: 'contain', ...style }}
    {...props}
  />
);
DialogBody.displayName = 'DialogBody';

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
