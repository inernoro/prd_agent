import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';

export interface CardMoreAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

/** 卡片底部的常驻操作条。分享/预览靠左，hover 层与 kebab 靠右。 */
export function CardActionBar({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 flex items-center gap-1">{children}</div>;
}

/**
 * 卡片上的一枚操作按钮。
 * `primary` 是这张卡最想让人点的那一个（预览）；`compact` 是 hover 层的图标按钮。
 *
 * hover 层用 opacity + pointer-events 双控：不显形时不可点，避免误触；
 * `group-focus-within` 让键盘 Tab 到卡片时同样展开，触屏则整条不渲染（见 SiteCard 的 sm: 断点）。
 */
export function CardIconAction({
  label,
  icon,
  onClick,
  primary,
  compact,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  compact?: boolean;
}) {
  const base =
    'inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md text-[11px] font-medium transition-colors';
  if (compact) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title={label}
        aria-label={label}
        data-no-drag
        className={[
          base,
          'w-7 pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover-bg-soft',
        ].join(' ')}
        style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      data-no-drag
      className={[base, 'px-2'].join(' ')}
      style={
        primary
          ? { background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }
          : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }
      }
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * kebab 菜单。
 *
 * `touchActions` 是「hover 层等价项」的条数：这些项在桌面端 hover 条里已经有了，
 * 在菜单里仍然保留并置顶，触屏与键盘用户才有等价可达路径（设计稿屏 2 的操作分层要求）。
 * 置顶那几项与其余低频配置之间画一条分隔线，避免读成同一组。
 */
export function CardMoreButton({ actions, touchActions = 0 }: { actions: CardMoreAction[]; touchActions?: number }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  if (actions.length === 0) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover-bg-soft"
        title="更多设置"
        aria-label="更多设置"
        data-no-drag
        style={{ color: 'var(--text-secondary)' }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} minWidth={190} align="left" style={{ padding: 6 }}>
          {actions.map((action, i) => (
            <div key={action.label}>
              {touchActions > 0 && i === touchActions && (
                <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
              )}
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium transition-colors hover-bg-soft"
                style={{ color: action.danger ? 'var(--semantic-danger-text)' : 'var(--text-secondary)' }}
                onClick={() => {
                  setOpen(false);
                  action.onClick();
                }}
              >
                <span className="inline-flex w-4 shrink-0 items-center justify-center">{action.icon}</span>
                <span className="truncate">{action.label}</span>
              </button>
            </div>
          ))}
        </AnchoredMenu>
      )}
    </>
  );
}
