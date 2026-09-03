import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 系统弹窗：控制台形态（2026-09-01 用户选定方向 A）。
 *
 * 形态的三个数值就是它全部的主张：容器 8px、控件 6px、正文 12-13px。
 * 上一版是 22px 圆角 + 液态玻璃 + 44px 药丸按钮——那套语汇自成一体，
 * 压在管理界面上就是「另一个系统的东西」。现在它并回产品已有的那一档密度。
 *
 * 分区自带内边距、容器本身不留 padding，是为了让动作条能贴着容器底边铺满
 * （带一条上分隔线和一层极淡的底）。所以调用方**不要**再给 contentClassName
 * 传 p-4 之类的整体内边距，会和分区的内边距叠起来。
 *
 * 颜色与按钮尺寸全部在 CSS 侧（legacy.css 的 .prd-dialog-content 一族 + tokens.css
 * 的 --dialog-* 双写），这里只管结构。实底面板不需要按主题分叉，
 * 所以这个组件不再读 useDataTheme / 玻璃降级那一套。
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  content,
  actions,
  tone,
  maxWidth,
  contentClassName,
  contentStyle,
  titleAction,
  titleCenter,
  zIndex,
  closePlacement = 'right',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  content: React.ReactNode;
  /**
   * 底部动作条。传了才渲染——存量弹窗大多把按钮写在 content 里自己排版，
   * 那种照旧工作，只是拿不到贴底的分隔线与底色。
   */
  actions?: React.ReactNode;
  /** danger 时标题前加一根红竖条。整个弹窗里唯一提示「这一步要停一下」的信号。 */
  tone?: 'default' | 'danger';
  /** 默认 460px；可传 900 或 '900px' 等，用于大弹窗 */
  maxWidth?: number | string;
  /** 追加到 Dialog 内容容器的 className */
  contentClassName?: string;
  /** 追加到 Dialog 内容容器的 style */
  contentStyle?: React.CSSProperties;
  /** 标题栏右侧的操作按钮（在关闭按钮左侧） */
  titleAction?: React.ReactNode;
  /** 标题栏居中的内容（如标签切换） */
  titleCenter?: React.ReactNode;
  /** 覆盖 Overlay 的 z-index 层级（默认 z-100）；需要在更高层弹窗上方时使用 */
  zIndex?: number;
  /** 关闭按钮位置；沉浸式编辑器可放在左侧。 */
  closePlacement?: 'left' | 'right';
}) {
  const closeButton = (
    <DialogPrimitive.Close
      // 22px 是控制台密度里合适的视觉尺寸，但它同时也是点击区，手指按不准。
      // 手机端放到 32px（mobile-first-density 的 ≥36px 是给主操作定的，
      // 关闭还有点遮罩和 Esc 两条退路，32 够用），桌面维持 22。
      className="h-[32px] w-[32px] sm:h-[22px] sm:w-[22px] shrink-0 inline-flex items-center justify-center rounded-[5px] transition-colors hover-bg-soft"
      style={{ color: 'var(--text-secondary)' }}
      aria-label="关闭"
    >
      <X size={12} strokeWidth={2.2} />
    </DialogPrimitive.Close>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 flex items-center justify-center prd-dialog-overlay"
          style={{ background: 'var(--dialog-overlay)', zIndex: zIndex ?? 100 }}
        >
        <DialogPrimitive.Content
          {...(description ? {} : ({ 'aria-describedby': undefined } as const))}
          className={[
            'w-[92vw] rounded-[8px] overflow-hidden flex flex-col prd-dialog-content',
            contentClassName ?? '',
          ].join(' ')}
          style={{
            maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : (maxWidth ?? '460px'),
            maxHeight: 'calc(100vh - 48px)',
            ...contentStyle,
          }}
        >
          <div className="shrink-0 flex items-center justify-between gap-3 relative px-4 pt-3.5">
            {closePlacement === 'left' && closeButton}
            <div className="min-w-0 flex-shrink-0">
              <DialogPrimitive.Title
                className="flex items-center gap-2 text-[13px] font-[650]"
                style={{ color: 'var(--text-primary)' }}
              >
                {tone === 'danger' && (
                  <span
                    aria-hidden
                    className="w-[3px] h-[13px] rounded-[2px] shrink-0"
                    style={{ background: 'var(--semantic-danger-text)' }}
                  />
                )}
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
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
              {closePlacement === 'right' && closeButton}
            </div>
          </div>

          {/* px-4 同时兼作 Safari 的 box-shadow 呼吸位——上一版内边距挂在外层容器上，
              滚动容器自身零内边距才需要 -mx-1 px-1 那个补丁，现在内边距就在这里了。 */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-2 prd-dialog-body">{content}</div>

          {actions && (
            <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-2.5 prd-dialog-actions">
              {actions}
            </div>
          )}
        </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
