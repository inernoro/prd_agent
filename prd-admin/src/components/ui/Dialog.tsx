import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
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
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[100] prd-dialog-overlay"
          style={{ background: 'rgba(0,0,0,0.72)' }}
        />
        <DialogPrimitive.Content
          {...(description ? {} : ({ 'aria-describedby': undefined } as const))}
          className={[
            'fixed left-1/2 top-1/2 z-[110] w-[92vw] rounded-[22px] p-6 flex flex-col prd-dialog-content',
            contentClassName ?? '',
          ].join(' ')}
          style={{
            background: 'rgba(14, 14, 17, 1)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
            maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : (maxWidth ?? '520px'),
            ...contentStyle,
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <div className="flex items-center gap-2">
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
