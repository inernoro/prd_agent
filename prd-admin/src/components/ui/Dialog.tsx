import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { glassPanel } from '@/lib/glassStyles';
import { useDataTheme } from '@/pages/report-agent/hooks/useDataTheme';
import { useThemeStore } from '@/stores/themeStore';
import { shouldReduceEffects } from '@/lib/themeApplier';
import { useReducedMotion } from '@/lib/useReducedMotion';

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
  zIndex,
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
  /** 覆盖 Overlay 的 z-index 层级（默认 z-100）；需要在更高层弹窗上方时使用 */
  zIndex?: number;
}) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  // 玻璃关闭(backdrop-filter 被全局清除)时半透遮罩会失焦，故回退近实底深色。
  // useReducedMotion 让本组件在 OS 偏好变化时即时重渲染(遮罩 inline 不再滞后)，
  // shouldReduceEffects 同时覆盖「性能模式」与「prefers-reduced-motion」两条路径。
  const reducedMotion = useReducedMotion();
  const themeConfigForGlass = useThemeStore((s) => s.config);
  const glassReduced = reducedMotion || shouldReduceEffects(themeConfigForGlass);

  // 浅色下走纯白卡片(不依赖 glassPanel,因为 themeComputed.ts 在性能模式下
  // 会用暗色 bgElevated 重置 --glass-bg-start/end,不区分主题)
  const panelStyle: React.CSSProperties = isLight
    ? {
        background: 'var(--bg-card)',
        border: '1px solid var(--hairline-strong)',
        boxShadow: '0 24px 48px rgba(89, 65, 50, 0.12), 0 8px 16px rgba(89, 65, 50, 0.06)',
      }
    : glassPanel;

  // B 玻璃：暗色遮罩降透明度(0.72→0.40)，配合 .prd-dialog-overlay 的 backdrop 模糊，
  // 让底下繁忙页面"变暗+模糊"地透出来，弹窗玻璃才有内容可映照。
  // 但玻璃关闭时没有模糊，需用近实底遮罩保证对比与聚焦。
  const overlayBg = isLight
    ? 'var(--modal-overlay)'
    : glassReduced
      ? 'rgba(0,0,0,0.72)'
      : 'rgba(8,8,14,0.40)';

  const closeHoverCls = isLight
    ? 'hover:bg-[rgba(15,23,42,0.05)]'
    : 'hover:bg-white/5';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 flex items-center justify-center prd-dialog-overlay"
          style={{ background: overlayBg, zIndex: zIndex ?? 100 }}
        >
        <DialogPrimitive.Content
          {...(description ? {} : ({ 'aria-describedby': undefined } as const))}
          className={[
            'w-[92vw] rounded-[22px] p-6 flex flex-col prd-dialog-content',
            contentClassName ?? '',
          ].join(' ')}
          style={{
            ...panelStyle,
            maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : (maxWidth ?? '520px'),
            maxHeight: 'calc(100vh - 48px)',
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
                className={`h-9 w-9 inline-flex items-center justify-center rounded-[12px] ${closeHoverCls}`}
                style={{ color: 'var(--text-secondary)' }}
                aria-label="关闭"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* -mx-1 px-1: Safari 裁剪 overflow 容器内子元素 box-shadow，留 4px 呼吸空间 */}
          <div className="mt-5 flex-1 min-h-0 overflow-y-auto -mx-1 px-1">{content}</div>
        </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
