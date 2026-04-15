import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ArrowRight, Calendar } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  useChangelogStore,
  selectUnreadCount,
  selectRecentEntries,
} from '@/stores/changelogStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

interface ChangelogBellProps {
  /** 图标尺寸（px） */
  size?: number;
  /** 是否在移动端使用（更紧凑的样式） */
  compact?: boolean;
}

const TYPE_COLOR_MAP: Record<string, string> = {
  feat: '#86efac',
  fix: '#fdba74',
  refactor: '#93c5fd',
  perf: '#c4b5fd',
  docs: '#67e8f9',
  chore: '#d4d4d8',
};

const TYPE_LABEL_MAP: Record<string, string> = {
  feat: '新',
  fix: '修',
  refactor: '重',
  perf: '优',
  docs: '文',
  chore: '杂',
};

/**
 * 顶栏「✨ 更新提醒」铃铛 + Popover。
 * - 红点 = 自上次查看以来的新条目数
 * - 点击 → 弹出最近 5 条 + 「查看全部 →」按钮
 * - 弹出后自动 markAsSeen
 *
 * 遵守 frontend-modal 规则：popover 用 createPortal 挂到 document.body，
 * 关键尺寸走 inline style，避免 Tailwind arbitrary value 在某些路径上不生效。
 */
export function ChangelogBell({ size = 18, compact = false }: ChangelogBellProps) {
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  const currentWeek = useChangelogStore((s) => s.currentWeek);
  const loadingCurrent = useChangelogStore((s) => s.loadingCurrent);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const markAsSeen = useChangelogStore((s) => s.markAsSeen);
  const unread = useChangelogStore(selectUnreadCount);
  const recent = useChangelogStore((s) => selectRecentEntries(s, 5));

  // 首次挂载：拉取本周更新（让红点提前出现）
  useEffect(() => {
    void loadCurrentWeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计算 popover 位置（基于按钮位置）
  const openPopover = () => {
    void loadCurrentWeek(true);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverWidth = 360;
      // 默认右对齐到按钮右边缘
      let left = rect.right - popoverWidth;
      // 防止超出视口左侧
      if (left < 12) left = 12;
      // 防止超出视口右侧
      if (left + popoverWidth > window.innerWidth - 12) {
        left = window.innerWidth - popoverWidth - 12;
      }
      setPopoverPos({
        top: rect.bottom + 8,
        left,
      });
    }
    setOpen(true);
    // 打开即视为已看到
    markAsSeen();
  };

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleViewAll = () => {
    setOpen(false);
    navigate('/changelog');
  };

  const buttonSizeClass = compact ? 'h-9 w-9' : 'h-9 w-9';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        className={`relative ${buttonSizeClass} inline-flex items-center justify-center rounded-xl transition-colors`}
        style={{ color: 'var(--text-secondary)' }}
        aria-label="产品更新"
        title="产品更新"
      >
        <Sparkles size={size} />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 h-4 min-w-4 rounded-full flex items-center justify-center text-[9px] font-bold px-1"
            style={{
              background: 'linear-gradient(135deg, #fbbf24, #f97316)',
              color: '#1a1a1a',
              boxShadow: '0 0 0 1.5px var(--bg-primary, #0f1014)',
            }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && popoverPos && createPortal(
        <>
          {/* 透明遮罩用于点击关闭 */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1099,
              background: 'transparent',
            }}
          />
          {/* Popover */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: popoverPos.top,
              left: popoverPos.left,
              width: 360,
              maxHeight: 'min(520px, calc(100vh - 100px))',
              minHeight: 0,
              zIndex: 1100,
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg, rgba(20, 22, 30, 0.96), rgba(15, 16, 20, 0.96))',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 16,
              boxShadow: '0 20px 60px -20px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.04)',
              backdropFilter: 'blur(20px)',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div
              className="shrink-0 px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
            >
              <div className="flex items-center gap-2">
                <Sparkles size={14} style={{ color: 'var(--accent-gold, #fbbf24)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  本周更新
                </span>
                {currentWeek?.weekStart && (
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    {currentWeek.weekStart} ~ {currentWeek.weekEnd}
                  </span>
                )}
              </div>
            </div>

            {/* List */}
            <div
              className="flex-1 px-3 py-2"
              style={{
                minHeight: 0,
                overflowY: 'auto',
                overscrollBehavior: 'contain',
              }}
            >
              {loadingCurrent && recent.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-8 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <MapSpinner size={14} />
                  正在加载…
                </div>
              )}

              {!loadingCurrent && recent.length === 0 && (
                <div
                  className="rounded-lg px-3 py-6 text-center text-[11px]"
                  style={{
                    color: 'var(--text-muted)',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px dashed rgba(255, 255, 255, 0.08)',
                    margin: '8px 4px',
                  }}
                >
                  本周还没有新的更新
                </div>
              )}

              {recent.length > 0 && (
                <div className="flex flex-col gap-1.5 py-1">
                  {recent.map((entry, idx) => {
                    const typeColor = TYPE_COLOR_MAP[entry.type.toLowerCase()] ?? '#d4d4d8';
                    const typeLabel = TYPE_LABEL_MAP[entry.type.toLowerCase()] ?? entry.type[0]?.toUpperCase() ?? '?';
                    return (
                      <div
                        key={`${entry.date}-${idx}`}
                        className="rounded-lg px-2.5 py-2 flex items-start gap-2"
                        style={{
                          background: 'rgba(255, 255, 255, 0.025)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        <div
                          className="shrink-0 h-5 w-5 rounded inline-flex items-center justify-center text-[10px] font-bold mt-0.5"
                          style={{
                            background: `${typeColor}22`,
                            color: typeColor,
                            border: `1px solid ${typeColor}44`,
                          }}
                        >
                          {typeLabel}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span
                              className="text-[10px] font-mono px-1 rounded"
                              style={{
                                color: 'var(--text-muted)',
                                background: 'rgba(255, 255, 255, 0.04)',
                              }}
                            >
                              {entry.module}
                            </span>
                            <span className="text-[9.5px] font-mono inline-flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                              <Calendar size={9} />
                              {entry.date}
                            </span>
                          </div>
                          <div
                            className="text-[12px] leading-snug"
                            style={{
                              color: 'var(--text-secondary)',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {entry.description}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <button
              type="button"
              onClick={handleViewAll}
              className="shrink-0 px-4 py-2.5 inline-flex items-center justify-center gap-1.5 text-[12px] font-medium transition-colors"
              style={{
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'var(--accent-gold, #fbbf24)',
                background: 'rgba(251, 191, 36, 0.04)',
              }}
            >
              查看全部更新
              <ArrowRight size={13} />
            </button>
          </div>
        </>,
        document.body
      )}
    </>
  );
}
