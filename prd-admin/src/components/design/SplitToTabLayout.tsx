import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export interface SplitToTabPanel {
  key: string;
  label: string;
  /** 面板内容 */
  content: ReactNode;
  /** 桌面端宽度 (仅在 splitMode 时生效), 如 'flex-1', 'w-96', 'w-[350px]' */
  desktopWidth?: string;
}

interface SplitToTabLayoutProps {
  panels: SplitToTabPanel[];
  /** 桌面端默认活跃的面板 (Tab 模式下的初始 Tab) */
  defaultActiveKey?: string;
  /** 桌面端间距 */
  gap?: string;
  /** 强制使用 Tab 模式 (忽略 breakpoint) */
  forceTab?: boolean;
  className?: string;
}

/**
 * 桌面端 = 左右分栏, 移动端 = Tab 切换。
 *
 * 解决 VisualAgent / LiteraryAgent / DefectAgent 等双面板页面的移动端适配问题。
 *
 * ```tsx
 * <SplitToTabLayout
 *   panels={[
 *     { key: 'canvas', label: '画布', content: <Canvas />, desktopWidth: 'flex-1' },
 *     { key: 'chat', label: '聊天', content: <Chat />, desktopWidth: 'w-[350px]' },
 *   ]}
 * />
 * ```
 */
export function SplitToTabLayout({
  panels,
  defaultActiveKey,
  gap = 'gap-4',
  forceTab = false,
  className,
}: SplitToTabLayoutProps) {
  const { isMobile } = useBreakpoint();
  const useTabMode = isMobile || forceTab;
  const [activeKey, setActiveKey] = useState(defaultActiveKey || panels[0]?.key);

  if (!panels.length) return null;

  // ── Tab 模式 (移动端) ──
  if (useTabMode) {
    const activePanel = panels.find((p) => p.key === activeKey) || panels[0];
    return (
      <div className={cn('h-full min-h-0 flex flex-col', className)}>
        {/* Tab 切换栏 */}
        <div
          className="flex shrink-0 overflow-x-auto border-b"
          style={{ borderColor: 'var(--border-subtle)', scrollbarWidth: 'none' }}
        >
          {panels.map((p) => {
            const active = p.key === activeKey;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setActiveKey(p.key)}
                className={cn(
                  'px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                  'min-h-[var(--mobile-min-touch,44px)]',
                  active ? 'border-b-2' : 'border-b-2 border-transparent',
                )}
                style={{
                  color: active ? 'var(--accent-gold)' : 'var(--text-muted)',
                  borderBottomColor: active ? 'var(--accent-gold)' : 'transparent',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* 面板内容 */}
        <div className="flex-1 min-h-0 overflow-auto">
          {activePanel.content}
        </div>
      </div>
    );
  }

  // ── Split 模式 (桌面端) ──
  return (
    <div className={cn('h-full min-h-0 flex', gap, className)}>
      {panels.map((p) => (
        <div
          key={p.key}
          className={cn('min-h-0 flex flex-col', p.desktopWidth || 'flex-1')}
        >
          {p.content}
        </div>
      ))}
    </div>
  );
}
