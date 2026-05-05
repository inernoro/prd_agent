import { useEffect, useMemo, useRef, useState } from 'react';
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

  const pages = useMemo(
    () => [...poster.pages].sort((a, b) => a.order - b.order),
    [poster.pages],
  );
  const totalPages = pages.length;
  const isLastPage = pageIndex === totalPages - 1;
  const currentPage = pages[Math.min(pageIndex, totalPages - 1)];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
      else if (e.key === 'ArrowLeft') setPageIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setPageIndex((i) => Math.min(totalPages - 1, i + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [totalPages, onDismiss]);

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
        className="relative overflow-hidden"
        style={{
          width: 'min(1120px, calc((100vh - 80px) * 1.91), calc(100vw - 64px))',
          aspectRatio: '1200 / 628',
          background: '#06111e',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 28,
          boxShadow:
            '0 40px 80px -20px rgba(0,0,0,0.6), 0 0 120px rgba(124,58,237,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="absolute top-5 right-5 z-20 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110"
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.85)',
          }}
        >
          <X size={16} />
        </button>

        <div
          className="relative h-full"
          style={{ overflow: 'hidden' }}
          key={`page-${pageIndex}`}
        >
          <WeeklyPosterPageView page={currentPage} weekKey={poster.weekKey} />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24" style={{ background: 'linear-gradient(180deg, transparent, rgba(4,8,18,0.28))' }} />
        <div className="absolute bottom-7 left-7 z-30">
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
        </div>

        <div className="absolute bottom-9 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5">
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
                    ? 'rgba(255,255,255,0.85)'
                    : 'rgba(255,255,255,0.25)',
              }}
            />
          ))}
        </div>

        <div className="absolute bottom-7 right-7 z-30">
          {isLastPage ? (
            <button
              type="button"
              onClick={handleCta}
              className="shrink-0 inline-flex items-center gap-1.5 px-4 h-9 rounded-full text-[13px] font-medium transition-all hover:bg-white/20"
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

export function WeeklyPosterPageView({
  page,
  weekKey,
  metaLabel,
}: {
  page: WeeklyPosterPage | undefined;
  weekKey?: string;
  metaLabel?: string;
}) {
  if (!page) return null;
  const accent = page.accentColor || '#7c3aed';
  const hasImage = !!page.imageUrl;

  return (
    <div className="relative h-full flex flex-col" style={{ minHeight: 0, background: '#06111e' }}>
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
          isVideoUrl(page.imageUrl ?? '') ? (
            <video
              src={page.imageUrl ?? ''}
              className="absolute inset-0 w-full h-full object-cover"
              muted
              playsInline
              autoPlay
              loop
            />
          ) : (
            <img
              src={page.imageUrl ?? ''}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          )
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
          className="absolute inset-x-0 bottom-0 pointer-events-none"
          style={{
            height: '50%',
            background:
              'linear-gradient(180deg, transparent 0%, rgba(6,17,30,0.76) 70%, rgba(6,17,30,1) 100%)',
          }}
        />
      </div>

      {weekKey && (
        <div
          className="absolute left-[4.8%] top-[6.2%] z-10 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em]"
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.16)',
            color: 'rgba(255,255,255,0.78)',
          }}
        >
          <Sparkles size={12} />
          {weekKey}
        </div>
      )}

      <div
        className="relative flex-1 px-[5%] pt-[3.7%] pb-[6%]"
        style={{
          minHeight: 0,
          overflow: 'hidden',
          color: 'rgba(255,255,255,0.85)',
        }}
      >
        <h2
          className="mb-4 text-[clamp(24px,3vw,36px)] font-black tracking-normal"
          style={{ color: '#fff', lineHeight: 1.12 }}
        >
          {page.title}
        </h2>
        {page.body ? (
          <div className="max-w-[78%] overflow-hidden" style={{ maxHeight: '48%' }}>
            <MarkdownContent
              content={page.body}
              className="text-[clamp(15px,1.65vw,22px)] leading-relaxed poster-body-markdown"
            />
          </div>
        ) : null}
        {metaLabel && (
          <div
            className="absolute bottom-[8%] right-[4.8%] rounded-full px-4 py-2 text-[13px] font-semibold text-white/72"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}
          >
            {metaLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function isVideoUrl(url: string) {
  if (!url) return false;
  if (/^data:video\//i.test(url)) return true;
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return true;
  // TikTok / 抖音 CDN 视频 URL 没有扩展名（路径含 /video/tos/）但 content-type 是 video/mp4
  if (/(tiktokcdn|tiktokv|douyinvod|aweme\.snssdk|byteimg\.com\/.*\/video)/i.test(url)) return true;
  if (/\/video\/tos\//i.test(url)) return true;
  return false;
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
