import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';

/**
 * 工具条上的一个收纳气泡（「显示」「筛选」）。
 *
 * 存在的理由：旧工具条把搜索、排序、视图、卡片尺寸、组织方式、筛选六组控件平铺在同一行，
 * 每一组视觉权重相同，用户不知道先看哪个。收纳的判据是「这组控件回答的是不是我每次都要
 * 回答的问题」——不是就进气泡，按钮上带命中数，让用户知道里面有没有正在生效的东西。
 */
export function ToolbarPopover({
  label,
  count,
  open,
  onOpenChange,
  tourId,
  children,
}: {
  label: string;
  /** 生效中的条目数；>0 时按钮高亮并显示数字 */
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tourId?: string;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const active = open || (count ?? 0) > 0;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-tour-id={tourId}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors"
        style={{
          background: active ? 'var(--selection-bg)' : 'var(--bg-input)',
          border: `1px solid ${active ? 'var(--selection-border)' : 'var(--border-default)'}`,
          color: active ? 'var(--selection-text)' : 'var(--text-primary)',
        }}
      >
        {label}
        {(count ?? 0) > 0 && <span className="text-[12px] tabular-nums">{count}</span>}
        <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <AnchoredMenu
          open={open}
          onClose={() => onOpenChange(false)}
          anchorRef={anchorRef}
          minWidth={260}
          align="right"
          style={{ padding: 12 }}
        >
          {children}
        </AnchoredMenu>
      )}
    </>
  );
}
