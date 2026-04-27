import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, ArrowRight, Sparkles } from 'lucide-react';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import type { WeeklyPoster, WeeklyPosterPage } from '@/services';

/**
 * 海报轮播弹窗 - 单一职责,props 驱动,不访问 store。
 *
 * 遵守 .claude/rules/frontend-modal.md 的三条硬约束:
 *   1) createPortal(modal, document.body)
 *   2) 关键尺寸 inline style
 *   3) flex 滚动容器 minHeight: 0 + overflowY: auto
 */
export function PosterCarousel({
  poster,
  onDismiss,
  navigateOnCta = true,
}: {
  poster: WeeklyPoster;
  onDismiss: () => void;
  /** 点末页 CTA 是否走路由跳转(预览模式可设 false,只关闭弹窗) */
  navigateOnCta?: boolean;
}) {
  const navigate = useNavigate();
  const [pageIndex, setPageIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const wheelLockUntil = useRef(0);

  const pages = useMemo(
    () => [...poster.pages].sort((a, b) => a.order - b.order),
    [poster.pages],
  );
  const totalPages = pages.length;
  const isLastPage = pageIndex === totalPages - 1;
  const currentPage = pages[Math.min(pageIndex, totalPages - 1)];
  const goPrev = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1));
  }, []);
  const goNext = useCallback(() => {
    setPageIndex((i) => Math.min(totalPages - 1, i + 1));
  }, [totalPages]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goNext, goPrev, onDismiss]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handleCta = () => {
    if (navigateOnCta) {
      const url = poster.ctaUrl || '/changelog';
      if (url.startsWith('http://') || url.startsWith('https://')) {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        navigate(url);
      }
    }
    onDismiss();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const dx = endX - touchStartX.current;
    if (Math.abs(dx) > 40) {
      if (dx < 0) goNext();
      else goPrev();
    }
    touchStartX.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);
    if (absX < 28 || absX < absY * 1.15) return;

    e.preventDefault();
    e.stopPropagation();

    const now = Date.now();
    if (now < wheelLockUntil.current) return;
    wheelLockUntil.current = now + 420;

    if (e.deltaX > 0) goNext();
    else goPrev();
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
      onWheel={handleWheel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: 'min(1200px, calc(100vw - 64px), calc((100vh - 64px) * 1.9108))',
          aspectRatio: '1200 / 628',
          minHeight: 360,
          maxHeight: 'calc(100vh - 64px)',
          background: 'linear-gradient(180deg, #14151b 0%, #0a0a12 100%)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow:
            '0 40px 80px -20px rgba(0,0,0,0.6), 0 0 120px rgba(124,58,237,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="absolute top-5 right-5 z-30 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-105"
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.85)',
          }}
        >
          <X size={16} />
        </button>

        <div
          className="absolute top-7 left-11 z-30 inline-flex items-center gap-2 px-4 h-9 rounded-full text-[13px] font-semibold tracking-[0.14em] uppercase"
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.75)',
          }}
        >
          <Sparkles size={13} />
          <span>{poster.weekKey}</span>
        </div>

        <div
          className="absolute inset-0 flex flex-col"
          style={{ minHeight: 0, overflow: 'hidden' }}
          key={`page-${pageIndex}`}
        >
          <PosterPageView page={currentPage} />
        </div>

        <div
          className="absolute inset-x-0 bottom-5 z-30 flex items-center justify-between gap-4 px-7 pointer-events-none"
        >
          <button
            type="button"
            onClick={goPrev}
            disabled={pageIndex === 0}
            aria-label="上一页"
            className="pointer-events-auto shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-white/10"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.85)',
            }}
          >
            <ChevronLeft size={18} />
          </button>

          <div className="pointer-events-auto absolute left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full px-3 py-2">
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPageIndex(i)}
                aria-label={`跳到第 ${i + 1} 页`}
                className="rounded-full transition-all"
                style={{
                  width: i === pageIndex ? 20 : 7,
                  height: 7,
                  background:
                    i === pageIndex
                      ? 'rgba(255,255,255,0.85)'
                      : 'rgba(255,255,255,0.25)',
                }}
              />
            ))}
          </div>

          {isLastPage ? (
            <button
              type="button"
              onClick={handleCta}
              className="pointer-events-auto shrink-0 inline-flex items-center gap-1.5 px-5 h-10 rounded-full text-[13px] font-medium transition-all hover:bg-white/20"
              style={{
                background: 'rgba(255,255,255,0.12)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              {poster.ctaText || '阅读完整周报'}
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              aria-label="下一页"
              className="pointer-events-auto shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:bg-white/10"
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)',
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
    <div className="absolute inset-0 flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="absolute inset-0"
        style={{
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
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="text-[96px] font-black opacity-20 tracking-tight"
              style={{ color: '#fff' }}
            >
              {(page.order + 1).toString().padStart(2, '0')}
            </div>
          </div>
        )}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              hasImage
                ? 'linear-gradient(180deg, rgba(6,8,14,0.08) 0%, rgba(6,8,14,0.16) 36%, rgba(6,8,14,0.9) 100%)'
                : 'linear-gradient(180deg, rgba(10,10,18,0.06) 0%, rgba(10,10,18,0.22) 44%, rgba(10,10,18,0.96) 100%)',
          }}
        />
      </div>

      <div
        className="relative z-10 mt-auto"
        style={{
          width: 'min(760px, calc(100% - 112px))',
          maxHeight: '52%',
          marginLeft: 56,
          marginBottom: 92,
          paddingRight: 16,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          color: 'rgba(255,255,255,0.85)',
        }}
      >
        <h2
          className="font-bold mb-4"
          style={{ color: '#fff', fontSize: 'clamp(28px, 3.6vw, 46px)', lineHeight: 1.12 }}
        >
          {page.title}
        </h2>
        {page.body ? (
          <MarkdownContent
            content={page.body}
            className="leading-relaxed poster-body-markdown"
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * 主页弹窗包装 - 从 store 读取当前海报 + 已读状态。
 * 登录后主页挂载这个组件,有未读就弹。
 */
export function WeeklyPosterModal() {
  const currentPoster = useWeeklyPosterStore((s) => s.currentPoster);
  const shouldShow = useWeeklyPosterStore((s) => s.shouldShowCurrent());
  const dismiss = useWeeklyPosterStore((s) => s.dismiss);

  if (!shouldShow || !currentPoster) return null;
  return (
    <PosterCarousel
      poster={currentPoster}
      onDismiss={() => dismiss(currentPoster.id)}
    />
  );
}
