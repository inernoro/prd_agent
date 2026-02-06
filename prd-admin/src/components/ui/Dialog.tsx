import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  content,
  maxWidth,
  contentClassName,
  contentStyle,
  titleAction,
  titleCenter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  content: React.ReactNode;
  /** 默认 520px；可传 900 或 '900px' 等，用于大弹窗 */
  maxWidth?: number | string;
  /** 追加到 Dialog 内容容器的 className */
  contentClassName?: string;
  /** 追加到 Dialog 内容容器的 style */
  contentStyle?: React.CSSProperties;
  /** 标题栏右侧的操作按钮（在关闭按钮左侧） */
  titleAction?: React.ReactNode;
  /** 标题栏居中的内容（如标签切换） */
  titleCenter?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-100 prd-dialog-overlay"
          style={{ background: 'rgba(0,0,0,0.72)' }}
        />
        <DialogPrimitive.Content
          {...(description ? {} : ({ 'aria-describedby': undefined } as const))}
          className={[
            'fixed left-1/2 top-1/2 z-110 w-[92vw] rounded-[22px] p-6 flex flex-col prd-dialog-content',
            contentClassName ?? '',
          ].join(' ')}
          style={{
            background: `linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)`,
            border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
            backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
            maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : (maxWidth ?? '520px'),
            ...contentStyle,
          }}
        >
          <div className="flex items-center justify-between gap-4 relative">
            <div className="min-w-0 flex-shrink-0">
              <DialogPrimitive.Title className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            {titleCenter && (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                {titleCenter}
              </div>
            )}
            <div className="flex items-center gap-2 flex-shrink-0">
              {titleAction}
              <DialogPrimitive.Close
                className="h-9 w-9 inline-flex items-center justify-center rounded-[12px] hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                aria-label="关闭"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className="mt-5 flex-1 min-h-0">{content}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
