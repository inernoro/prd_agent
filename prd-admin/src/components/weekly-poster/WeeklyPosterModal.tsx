import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, ArrowRight, Sparkles } from 'lucide-react';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import type { WeeklyPoster, WeeklyPosterPage } from '@/services';

/**
 * 周报海报轮播弹窗(主页挂载)。
 *
 * 遵守 .claude/rules/frontend-modal.md 的三条硬约束:
 *   1) createPortal(modal, document.body) 脱离祖先 overflow/transform 影响
 *   2) 关键尺寸 inline style(非 Tailwind arbitrary value)
 *   3) flex 滚动容器 minHeight: 0 + overflowY: auto + overscrollBehavior: contain
 *
 * 操作:
 *   - 左右箭头 / 键盘 ← → 翻页
 *   - 点击蒙版 / ESC / 右上角 X 关闭
 *   - 关闭后本会话不再自动弹出(dismissedIds 存 sessionStorage)
 *   - 末页显示 CTA 跳转按钮
 */
export function WeeklyPosterModal() {
  const currentPoster = useWeeklyPosterStore((s) => s.currentPoster);
  const shouldShow = useWeeklyPosterStore((s) => s.shouldShowCurrent());
  const dismiss = useWeeklyPosterStore((s) => s.dismiss);

  if (!shouldShow || !currentPoster) return null;
  return <PosterModalInner poster={currentPoster} onDismiss={() => dismiss(currentPoster.id)} />;
}

function PosterModalInner({ poster, onDismiss }: { poster: WeeklyPoster; onDismiss: () => void }) {
  const navigate = useNavigate();
  const [pageIndex, setPageIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const pages = useMemo(() => [...poster.pages].sort((a, b) => a.order - b.order), [poster.pages]);
  const totalPages = pages.length;
  const isLastPage = pageIndex === totalPages - 1;
  const currentPage = pages[pageIndex];

  // 键盘操作:← → 翻页、ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      } else if (e.key === 'ArrowLeft') {
        setPageIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        setPageIndex((i) => Math.min(totalPages - 1, i + 1));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [totalPages, onDismiss]);

  // 阻止背后 body 滚动(弹窗打开期间)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handleCta = () => {
    const url = poster.ctaUrl || '/changelog';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      navigate(url);
    }
    onDismiss();
  };

  // 触摸手势翻页(移动端友好)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const dx = endX - touchStartX.current;
    if (Math.abs(dx) > 40) {
      if (dx < 0) setPageIndex((i) => Math.min(totalPages - 1, i + 1));
      else setPageIndex((i) => Math.max(0, i - 1));
    }
    touchStartX.current = null;
  };

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        background: 'rgba(3,3,6,0.78)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      onClick={onDismiss}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: 'min(720px, 92vw)',
          height: 'min(82vh, 780px)',
          maxHeight: '82vh',
          background: 'linear-gradient(180deg, #14151b 0%, #0a0a12 100%)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow:
            '0 40px 80px -20px rgba(0,0,0,0.6), 0 0 120px rgba(124,58,237,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="absolute top-4 right-4 z-20 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110"
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.85)',
          }}
        >
          <X size={16} />
        </button>

        {/* 品牌标识 — 左上角 */}
        <div
          className="absolute top-4 left-4 z-20 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium tracking-[0.08em] uppercase"
          style={{
            background: 'rgba(124,58,237,0.18)',
            border: '1px solid rgba(124,58,237,0.3)',
            color: '#c4b5fd',
          }}
        >
          <Sparkles size={10} />
          <span>本周更新 · {poster.weekKey}</span>
        </div>

        {/* 海报页(flex-1 min-h-0 配合 overflow) */}
        <div
          className="flex-1 flex flex-col relative"
          style={{ minHeight: 0, overflow: 'hidden' }}
          key={`page-${pageIndex}`}
        >
          <PosterPageView page={currentPage} />
        </div>

        {/* 翻页控件 + 指示器 + CTA */}
        <div
          className="shrink-0 flex items-center justify-between gap-4 px-6 py-4"
          style={{
            background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.06) 100%)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {/* 上一页 */}
          <button
            type="button"
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            disabled={pageIndex === 0}
            aria-label="上一页"
            className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-white/10"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.85)',
            }}
          >
            <ChevronLeft size={18} />
          </button>

          {/* 指示器 */}
          <div className="flex items-center gap-1.5">
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPageIndex(i)}
                aria-label={`跳到第 ${i + 1} 页`}
                className="rounded-full transition-all"
                style={{
                  width: i === pageIndex ? 20 : 6,
                  height: 6,
                  background:
                    i === pageIndex
                      ? 'linear-gradient(90deg, #00f0ff, #7c3aed)'
                      : 'rgba(255,255,255,0.25)',
                  boxShadow:
                    i === pageIndex ? '0 0 10px rgba(124,58,237,0.5)' : 'none',
                }}
              />
            ))}
          </div>

          {/* 下一页 / CTA */}
          {isLastPage ? (
            <button
              type="button"
              onClick={handleCta}
              className="shrink-0 inline-flex items-center gap-1.5 px-4 h-9 rounded-full text-[13px] font-medium transition-all hover:scale-[1.03]"
              style={{
                background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
                color: '#fff',
                boxShadow: '0 4px 16px rgba(124,58,237,0.4)',
              }}
            >
              {poster.ctaText || '阅读完整周报'}
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPageIndex((i) => Math.min(totalPages - 1, i + 1))}
              aria-label="下一页"
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:bg-white/10"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.85)',
              }}
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function PosterPageView({ page }: { page: WeeklyPosterPage | undefined }) {
  if (!page) return null;
  const accent = page.accentColor || '#7c3aed';
  const hasImage = !!page.imageUrl;

  return (
    <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      {/* 上半部分:配图或渐变占位 */}
      <div
        className="relative shrink-0"
        style={{
          height: '48%',
          background: hasImage
            ? undefined
            : `linear-gradient(135deg, ${accent} 0%, #0a0a12 100%)`,
        }}
      >
        {hasImage ? (
          <img
            src={page.imageUrl ?? ''}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          // 无图兜底:abstract 纹理 + 大字编号
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="text-[96px] font-black opacity-20 tracking-tight"
              style={{ color: '#fff', fontFamily: 'var(--font-display, inherit)' }}
            >
              {(page.order + 1).toString().padStart(2, '0')}
            </div>
          </div>
        )}
        {/* 底部渐变压暗,保证底部文字在渐变图上也清晰 */}
        <div
          className="absolute inset-x-0 bottom-0 pointer-events-none"
          style={{
            height: '50%',
            background:
              'linear-gradient(180deg, transparent 0%, rgba(10,10,18,0.75) 70%, rgba(10,10,18,1) 100%)',
          }}
        />
      </div>

      {/* 下半部分:文本(滚动) */}
      <div
        className="flex-1 px-8 pt-6 pb-8"
        style={{
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <h2
          className="text-[22px] font-semibold tracking-tight mb-3"
          style={{ color: '#fff', lineHeight: 1.25 }}
        >
          {page.title}
        </h2>
        <div
          className="text-[14px] leading-relaxed whitespace-pre-wrap"
          style={{ color: 'rgba(255,255,255,0.8)' }}
        >
          {page.body}
        </div>
      </div>
    </div>
  );
}
