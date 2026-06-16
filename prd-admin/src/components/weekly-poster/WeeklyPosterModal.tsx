import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, ArrowRight, Sparkles, Play, Heart, MessageCircle, Bookmark, Share2, Eye, Clock, Maximize2 } from 'lucide-react';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { hexToRgba } from '@/lib/themeComputed';
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
  const [minimized, setMinimized] = useState(false);
  // feed-card 模式下，由当前页媒体（cover / video）的真实宽高比驱动 modal aspect
  const [feedCardMediaAspect, setFeedCardMediaAspect] = useState<number | null>(null);
  const touchStartX = useRef<number | null>(null);

  const pages = useMemo(
    () => [...poster.pages].sort((a, b) => a.order - b.order),
    [poster.pages],
  );
  const totalPages = pages.length;
  const isLastPage = pageIndex === totalPages - 1;
  const currentPage = pages[Math.min(pageIndex, totalPages - 1)];

  // 切页时重置媒体比例（不同页可能横/竖屏不同）
  useEffect(() => { setFeedCardMediaAspect(null); }, [pageIndex]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape 与右上角 X 一致：收起到右下角胶囊，不彻底 dismiss
      // （胶囊上的红色 ✕ 才走 onDismiss）
      if (e.key === 'Escape') setMinimized(true);
      else if (e.key === 'ArrowLeft') setPageIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setPageIndex((i) => Math.min(totalPages - 1, i + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [totalPages]);

  // body overflow 锁定仅在「主模态展开」状态下生效；收起到胶囊时解锁让用户能滚页
  useEffect(() => {
    if (minimized) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [minimized]);

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

  const isAdMode = poster.presentationMode === 'ad-4-3';
  const isRichText = poster.presentationMode === 'ad-rich-text';
  const isFeedCard = poster.presentationMode === 'feed-card';
  // 取当前页 accentColor 作为品牌色；feed-card 视频卡的外框光晕、顶部细带都吃这个色
  const brandAccent = currentPage?.accentColor || '#ff0050';
  // ad-4-3 / ad-rich-text 走 4:3 横屏；feed-card 默认 9:16 竖屏，但若检测到当前页视频是
  // 横屏（aspect>1.2）则切到 16:9，方屏（0.85~1.2）切到 4:3
  const isWideMode = isAdMode || isRichText;
  let feedCardAspect: '9 / 16' | '16 / 9' | '4 / 3' = '9 / 16';
  if (isFeedCard && feedCardMediaAspect) {
    if (feedCardMediaAspect > 1.2) feedCardAspect = '16 / 9';
    else if (feedCardMediaAspect > 0.85) feedCardAspect = '4 / 3';
  }
  const aspect = isFeedCard ? feedCardAspect : (isWideMode ? '4 / 3' : '1200 / 628');
  // 三档尺寸（用户反馈 9:16 竖屏太小不显眼，全档位整体放大 ~17%）：
  //   9:16 竖屏 460→540px / 4:3 方屏 760→880px / 16:9 横屏 920→1100px
  //   ad-4-3 / ad-rich-text 宽模式 960→1120px / 长 banner 1120→1280px
  // 同时把视口高度预算从 80px 缩到 40px（顶部只有 dismiss 按钮 + 圆角，不需要那么多 chrome），
  // 让 9:16 在 1080p 屏上能用满 540 cap 而不是被视口卡到 460
  const widthCalc = isFeedCard
    ? (feedCardAspect === '16 / 9'
        ? 'min(1100px, calc((100vh - 40px) * 1.778), calc(100vw - 32px))'
        : feedCardAspect === '4 / 3'
          ? 'min(880px, calc((100vh - 40px) * 1.333), calc(100vw - 32px))'
          : 'min(540px, calc((100vh - 40px) * 0.5625), calc(100vw - 32px))')
    : isWideMode
      ? 'min(1120px, calc((100vh - 40px) * 1.333), calc(100vw - 64px))'
      : 'min(1280px, calc((100vh - 40px) * 1.91), calc(100vw - 64px))';

  // 最小化态：右下角胶囊浮层（缩略图 + 标题 + 展开/关闭）。
  // 主模态在 minimized 时 display:none 不卸载子组件 → PosterFeedCardView 的
  // hasPlayed / activeCueIdx / video.currentTime 全部保留。展开后 video 接续播
  const minimizedCoverUrl = currentPage?.secondaryImageUrl
    || (currentPage?.imageUrl && !isVideoUrl(currentPage.imageUrl) ? currentPage.imageUrl : null);
  const minimizedTitle = currentPage?.title || poster.title || '';
  const capsuleNode = minimized ? (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex items-center gap-2 px-2 py-2 rounded-2xl"
      style={{
        background: 'rgba(11,11,16,0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 16px 40px -8px rgba(0,0,0,0.55), 0 0 32px rgba(124,58,237,0.18)',
        maxWidth: 280,
      }}
    >
      <button
        type="button"
        onClick={() => setMinimized(false)}
        aria-label="展开海报"
        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer text-left rounded-xl px-1 py-1 hover:bg-white/5 transition-colors"
      >
        <div
          className="shrink-0 rounded-lg overflow-hidden flex items-center justify-center"
          style={{ width: 44, height: 44, background: '#000', border: '1px solid rgba(255,255,255,0.1)' }}
        >
          {minimizedCoverUrl ? (
            <img src={minimizedCoverUrl} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <Sparkles size={18} className="text-white/60" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-white truncate">{minimizedTitle}</div>
          <div className="inline-flex items-center gap-1 text-[10px] text-white/55 mt-0.5">
            <Maximize2 size={10} />
            <span>{totalPages > 1 ? `${pageIndex + 1}/${totalPages} · 点击展开` : '点击展开'}</span>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="不再显示"
        title="不再显示（彻底关闭）"
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all hover:bg-red-500/40 text-white/70 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  ) : null;

  const modal = (
    <div
      className="fixed inset-0 z-[9999] items-center justify-center"
      style={{
        // minimized 时 display:none 隐藏，但子组件不卸载 — 视频继续保留 currentTime / hasPlayed 等内部状态
        display: minimized ? 'none' : 'flex',
        background: 'rgba(3,3,6,0.78)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      // 点击 backdrop 与 X 按钮一致：收起到右下角胶囊（不彻底 dismiss）
      onClick={() => setMinimized(true)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative overflow-hidden"
        style={{
          width: widthCalc,
          aspectRatio: aspect,
          background: isFeedCard || isWideMode ? '#000' : '#06111e',
          // feed-card 用 accent 色描边 + 有色光晕，把"光秃秃的视频"包装成"海报里嵌的视频"
          border: isFeedCard
            ? `1.5px solid ${hexToRgba(brandAccent, 0.55)}`
            : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 28,
          boxShadow: isFeedCard
            ? `0 40px 80px -20px rgba(0,0,0,0.6), 0 0 140px ${hexToRgba(brandAccent, 0.32)}, 0 0 0 1px ${hexToRgba(brandAccent, 0.18)}, inset 0 1px 0 rgba(255,255,255,0.08)`
            : '0 40px 80px -20px rgba(0,0,0,0.6), 0 0 120px rgba(124,58,237,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        {/* feed-card 模式：顶部一条 accent 色细带 + 渐隐光，让视频卡有"海报外框"的视觉重量 */}
        {isFeedCard && (
          <div
            className="absolute inset-x-0 top-0 z-20 pointer-events-none"
            style={{
              height: 4,
              background: `linear-gradient(90deg, transparent, ${brandAccent} 30%, ${brandAccent} 70%, transparent)`,
              boxShadow: `0 0 24px ${hexToRgba(brandAccent, 0.7)}`,
            }}
          />
        )}
        {/* 右上角只保留一个按钮：收起到右下角胶囊。彻底 dismiss 在胶囊上的 ✕ 触发 */}
        <button
          type="button"
          onClick={() => setMinimized(true)}
          aria-label="收起到右下角"
          title="收起到右下角（仍可在右下角胶囊找到）"
          className="absolute top-5 right-5 z-30 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110"
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
          {isFeedCard ? (
            <PosterFeedCardView
              page={currentPage}
              onMediaAspectDetected={setFeedCardMediaAspect}
            />
          ) : isAdMode ? (
            <PosterAdPageView page={currentPage} weekKey={poster.weekKey} />
          ) : isRichText ? (
            <PosterRichTextPageView page={currentPage} weekKey={poster.weekKey} />
          ) : (
            <WeeklyPosterPageView page={currentPage} weekKey={poster.weekKey} />
          )}
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

  // modal 与 capsule 同时存在于 portal：minimized 时 modal display:none 但保留子组件挂载，
  // 视频不会被卸载，再次展开时 hasPlayed / currentTime / activeCueIdx 全部接续
  return createPortal(
    <>
      {modal}
      {capsuleNode}
    </>,
    document.body,
  );
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
              preload="metadata"
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
  // 必须用路径级别识别（host 共用：tiktokcdn 主机同时服务 cover 静图 + video，不能仅按 host 判定）：
  // - TikTok app/v3 + 抖音 web 视频: 路径含 /video/tos/
  // - 抖音 web 直链: 路径含 /aweme/v{N}/play/
  // cover 走 /tos-xxx-p-/ 路径，不会命中以上模式。
  if (/\/video\/tos\//i.test(url)) return true;
  if (/\/aweme\/v[0-9]+\/play\//i.test(url)) return true;
  return false;
}

/**
 * 广告版海报页（4:3 全 bleed + 中央 Play + 用户主动点开）。
 * 借鉴：Apple 产品发布会视频弹窗 / Netflix 预告 modal / Twitch 视频卡片。
 *
 * 关键差异 vs `WeeklyPosterPageView`：
 *   - 全屏铺满 cover/video（不是上下分屏）
 *   - 视频不 autoplay，显示中央 Play 按钮，用户点击才播
 *   - 播放后 cover/title 渐隐，让视频成为主角
 *   - 原生 controls，可暂停/调音量/全屏
 *
 * 实现策略（避坑）：
 *   - cover 静图用独立 <img> 层渲染，**不**塞到 <video poster> 里——动图 webp 当 poster
 *     在部分浏览器（含 Chrome 某些版本）会渲染破图占位符
 *   - <video> 元素仅在用户点 Play 后才挂载，避开"未播放视频元素"产生的视觉噪音
 *   - cover 加载失败也不会破图（onError 静默隐藏）
 */
export function PosterAdPageView({
  page,
  weekKey,
}: {
  page: WeeklyPosterPage | undefined;
  weekKey?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [coverErrored, setCoverErrored] = useState(false);

  if (!page) return null;
  const primaryUrl = page.imageUrl ?? '';
  const isVideo = isVideoUrl(primaryUrl);
  // cover 来源：secondaryImageUrl 优先（capsule 写视频时会同步填这个 cover），
  // 没有时退回 primaryUrl（仅当 primary 是图片时才能用）
  const coverUrl = page.secondaryImageUrl || (isVideo ? null : primaryUrl);

  const handlePlay = () => {
    setHasPlayed(true);
    // 等 React 把 <video> 挂上 DOM 后再调 play()
    setTimeout(() => {
      videoRef.current?.play().catch(() => {
        /* 浏览器可能拦截编程式播放，用户可手点原生 play */
      });
    }, 30);
  };

  const accent = page.accentColor || '#7c3aed';
  const showCover = !hasPlayed && !!coverUrl && !coverErrored;
  const showFallbackBg = !hasPlayed && (!coverUrl || coverErrored);

  return (
    <div className="relative h-full" style={{ background: '#000' }}>
      {/* 媒体层 */}
      <div className="absolute inset-0">
        {/* Cover 静图层（仅播放前） */}
        {showCover && (
          <img
            src={coverUrl as string}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
            onError={() => setCoverErrored(true)}
          />
        )}

        {/* 无 cover 兜底渐变 */}
        {showFallbackBg && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, ${accent} 0%, #0a0a12 100%)`,
            }}
          >
            <div className="text-[120px] font-black text-white/15 select-none">
              {(page.order + 1).toString().padStart(2, '0')}
            </div>
          </div>
        )}

        {/* 静图直显（页面就是图片，不是视频） */}
        {!isVideo && primaryUrl && (
          <img
            src={primaryUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        )}

        {/* 视频层（仅用户点击 Play 后才挂载，避开未播放元素的视觉噪音） */}
        {isVideo && hasPlayed && (
          <video
            ref={videoRef}
            src={primaryUrl}
            className="absolute inset-0 w-full h-full object-contain bg-black"
            controls
            playsInline
            autoPlay
          />
        )}
      </div>

      {/* 中央 Play 按钮（仅在视频且未播放时显示） */}
      {isVideo && !hasPlayed && (
        <button
          type="button"
          onClick={handlePlay}
          aria-label="播放视频"
          className="absolute inset-0 z-10 flex items-center justify-center group cursor-pointer"
          style={{ background: 'rgba(0,0,0,0.18)' }}
        >
          <div
            className="flex items-center justify-center transition-all duration-200 group-hover:scale-110"
            style={{
              width: 96,
              height: 96,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.18)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1.5px solid rgba(255,255,255,0.35)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            }}
          >
            <Play size={36} fill="white" strokeWidth={0} style={{ marginLeft: 4 }} />
          </div>
        </button>
      )}

      {/* 底部渐变遮罩 + 文案（播放后渐隐让位给视频） */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300"
        style={{
          height: '46%',
          background:
            'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.45) 35%, rgba(0,0,0,0.92) 100%)',
          opacity: hasPlayed ? 0 : 1,
        }}
      />

      {weekKey && !hasPlayed && (
        <div
          className="absolute left-6 top-6 z-20 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] font-semibold tracking-wide transition-opacity duration-300"
          style={{
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.18)',
            color: 'rgba(255,255,255,0.92)',
          }}
        >
          <Sparkles size={12} />
          {weekKey}
        </div>
      )}

      {!hasPlayed && (
        <div
          className="absolute inset-x-0 bottom-0 z-20 px-7 pb-20 pt-8 pointer-events-none transition-opacity duration-300"
        >
          <h2
            className="font-black text-white leading-tight"
            style={{
              fontSize: 'clamp(20px, 2.4vw, 32px)',
              textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            }}
          >
            {page.title}
          </h2>
          {page.body && (
            <div
              className="mt-3 max-w-[80%] text-white/85 leading-relaxed line-clamp-2"
              style={{
                fontSize: 'clamp(13px, 1.3vw, 16px)',
                textShadow: '0 1px 8px rgba(0,0,0,0.5)',
              }}
            >
              <MarkdownContent content={page.body} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 图文混排海报页（4:3，左侧动态 cover + 右侧 hook & bullets，底部 Play 切回全屏视频）。
 * 借鉴：Instagram Story Ad / Apple Newsroom 卡片 / 小红书笔记 三套行业范式。
 *
 * 字段约定（沿用 ad-4-3）：
 *   - imageUrl           = 视频 URL（点 Play 才会播放，无视频时仅展示图文）
 *   - secondaryImageUrl  = cover 静图/动图 URL（左侧主体），无值时退回到 imageUrl 或渐变兜底
 *   - title              = hook 大字
 *   - body               = bullets markdown（- bullet1 / - bullet2 ...）
 *   - accentColor        = 分隔线 / 角标色调
 *
 * 状态：
 *   - 默认渲染图文双栏；用户点 Play 后切到 ad-4-3 风格的全 bleed 视频播放器。
 *   - 没有视频源时不渲染 Play 按钮，纯图文广告。
 */
export function PosterRichTextPageView({
  page,
  weekKey,
}: {
  page: WeeklyPosterPage | undefined;
  weekKey?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [coverErrored, setCoverErrored] = useState(false);

  if (!page) return null;

  // body 为空时降级到 ad-4-3 全 bleed 视图（ASR 失败 / 旧投稿无 LLM 提炼 / 字段缺失）
  // 避免右侧 bullets 区域空白，仍能看视频广告
  const bodyHasContent = !!(page.body && page.body.trim().length > 0);
  if (!bodyHasContent) {
    return <PosterAdPageView page={page} weekKey={weekKey} />;
  }

  const primaryUrl = page.imageUrl ?? '';
  const isVideo = isVideoUrl(primaryUrl);
  // cover 优先用 secondaryImageUrl（capsule 输出 video 时会同步填这个 cover），
  // 没有时退回 primaryUrl（仅当 primary 是图片时才能用）
  const coverUrl = page.secondaryImageUrl || (isVideo ? null : primaryUrl);
  const accent = page.accentColor || '#7c3aed';

  const handlePlay = () => {
    if (!isVideo) return;
    setHasPlayed(true);
    setTimeout(() => {
      videoRef.current?.play().catch(() => {});
    }, 30);
  };

  // 已点击 Play → 切换为 ad-4-3 风格的全 bleed 视频（与 PosterAdPageView 播放后视觉一致）
  // 左上角加返回按钮，让用户能回到 rich-text 详情视图
  if (hasPlayed && isVideo) {
    return (
      <div className="relative h-full" style={{ background: '#000' }}>
        <div className="absolute inset-0">
          <video
            ref={videoRef}
            src={primaryUrl}
            className="absolute inset-0 w-full h-full object-contain bg-black"
            controls
            playsInline
            autoPlay
          />
        </div>
        <button
          type="button"
          onClick={() => setHasPlayed(false)}
          aria-label="返回详情"
          className="absolute top-5 left-5 z-30 inline-flex items-center gap-1.5 px-3 h-9 rounded-full text-[12px] font-medium transition-all hover:bg-white/15"
          style={{
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.18)',
            color: 'rgba(255,255,255,0.92)',
          }}
        >
          <ChevronLeft size={14} />
          返回详情
        </button>
      </div>
    );
  }

  return (
    <div
      className="relative h-full flex"
      style={{
        background: `linear-gradient(135deg, #0b0b14 0%, #15101a 60%, #0a0a12 100%)`,
        color: 'rgba(255,255,255,0.92)',
      }}
    >
      {/* 左侧 cover 区（约 44% 宽，动态/静态封面 + 中央 Play hover） */}
      <div
        className="relative shrink-0 flex items-center justify-center"
        style={{
          width: '44%',
          padding: '5.6% 0 5.6% 5.6%',
        }}
      >
        <div
          className="relative w-full overflow-hidden"
          style={{
            aspectRatio: '9 / 16',
            borderRadius: 18,
            background: '#0a0a12',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 24px 60px -16px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          {coverUrl && !coverErrored ? (
            <img
              src={coverUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
              onError={() => setCoverErrored(true)}
            />
          ) : !isVideo && primaryUrl ? (
            <img
              src={primaryUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                background: `linear-gradient(135deg, ${accent} 0%, #0a0a12 100%)`,
              }}
            >
              <div className="text-[80px] font-black text-white/15 select-none">
                {(page.order + 1).toString().padStart(2, '0')}
              </div>
            </div>
          )}
          {/* hover Play 浮层（仅有视频时） */}
          {isVideo && (
            <button
              type="button"
              onClick={handlePlay}
              aria-label="播放视频"
              className="absolute inset-0 flex items-center justify-center group cursor-pointer transition-colors"
              style={{ background: 'rgba(0,0,0,0.18)' }}
            >
              <div
                className="flex items-center justify-center transition-all duration-200 group-hover:scale-110"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.18)',
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  border: '1.5px solid rgba(255,255,255,0.35)',
                  boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
                }}
              >
                <Play size={24} fill="white" strokeWidth={0} style={{ marginLeft: 3 }} />
              </div>
            </button>
          )}
        </div>
      </div>

      {/* 右侧文案区（hook 大字 + 分割线 + bullets） */}
      <div
        className="relative flex-1 flex flex-col justify-center"
        style={{
          padding: '5.6% 5.6% 5.6% 4%',
          minWidth: 0,
        }}
      >
        {weekKey && (
          <div
            className="inline-flex items-center gap-2 self-start rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.14)',
              color: 'rgba(255,255,255,0.7)',
              marginBottom: '4%',
            }}
          >
            <Sparkles size={11} />
            {weekKey}
          </div>
        )}

        <h2
          className="font-black tracking-tight"
          style={{
            color: '#fff',
            fontSize: 'clamp(22px, 2.8vw, 38px)',
            lineHeight: 1.14,
            marginBottom: '3.2%',
          }}
        >
          {page.title}
        </h2>

        <div
          className="shrink-0"
          style={{
            width: 56,
            height: 3,
            borderRadius: 2,
            background: accent,
            marginBottom: '3.6%',
          }}
        />

        {page.body && (
          <div
            className="text-white/82 leading-relaxed overflow-hidden [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1.5 [&_p]:my-1.5 [&_strong]:text-white"
            style={{
              fontSize: 'clamp(13px, 1.35vw, 17px)',
              maxHeight: '52%',
            }}
          >
            <MarkdownContent content={page.body} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 短视频内容卡（9:16 竖屏，借鉴抖音/小红书播放页布局）。
 * 把 9 个信息单元一起装进海报：
 *   ① 顶部：作者头像 + @用户名 + 平台 chip + 时长
 *   ② 中央：视频本体 + cover poster + 中央 Play
 *   ③ 右栏（半透明浮层）：❤️ 点赞 / 💬 评论 / ⭐ 收藏 / 🔗 分享
 *   ④ 底部：标题 hook + 标签 chip 列表 + 完整视频 CTA（外层 PosterCarousel 的 CTA 按钮已覆盖）
 *
 * 字段约定：沿用 ad-4-3（imageUrl=video, secondaryImageUrl=cover），新增字段全部走可选 fallback。
 *
 * 设计妥协（9:16 太窄）：
 *   - 标签 chip 行最多展示 3 个，多余折叠到 +N
 *   - 互动数字大于 1k 简写为 1.2k / 5.9k
 *   - 没有头像时用渐变色圆形带首字母
 */
export function PosterFeedCardView({ page, onMediaAspectDetected }: {
  page: WeeklyPosterPage | undefined;
  onMediaAspectDetected?: (aspect: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [coverErrored, setCoverErrored] = useState(false);
  const [avatarErrored, setAvatarErrored] = useState(false);
  // 当前播放时间对应的字幕 cue index（-1 表示无）
  const [activeCueIdx, setActiveCueIdx] = useState(-1);

  // 监听 video timeupdate 切到对应 cue。useEffect 依赖 page 切换时重置
  useEffect(() => {
    setActiveCueIdx(-1);
  }, [page?.imageUrl]);

  useEffect(() => {
    if (!hasPlayed) return;
    const v = videoRef.current;
    if (!v) return;
    const cues = page?.transcriptCues;
    if (!cues || cues.length === 0) return;
    const onTime = () => {
      const t = v.currentTime;
      // 二分查找当前时间所在 cue
      let lo = 0, hi = cues.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].startSec <= t && t <= cues[mid].endSec) { found = mid; break; }
        if (t < cues[mid].startSec) hi = mid - 1; else lo = mid + 1;
      }
      // 没命中精确区间时，取距离当前时间最近的 cue（视频播放到字幕间隙时让最近一句保持显示）
      if (found < 0 && cues.length > 0) {
        // 找 startSec <= t 的最大那条
        for (let i = cues.length - 1; i >= 0; i--) {
          if (cues[i].startSec <= t) { found = i; break; }
        }
      }
      setActiveCueIdx(found);
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [hasPlayed, page?.transcriptCues]);

  if (!page) return null;
  const primaryUrl = page.imageUrl ?? '';
  const isVideo = isVideoUrl(primaryUrl);
  const coverUrl = page.secondaryImageUrl || (isVideo ? null : primaryUrl);
  const accent = page.accentColor || '#ff0050';
  const author = page.authorName || '';
  const platform = page.platform || '';
  const stats = page.stats;
  const tags = (page.hashtags || []).slice(0, 3);
  const tagOverflow = (page.hashtags?.length || 0) - tags.length;

  const handlePlay = () => {
    if (!isVideo) return;
    setHasPlayed(true);
    setTimeout(() => {
      videoRef.current?.play().catch(() => {});
    }, 30);
  };

  const platformLabel = ({
    tiktok: 'TikTok',
    douyin: '抖音',
    bilibili: 'B 站',
    xiaohongshu: '小红书',
    youtube: 'YouTube',
  } as Record<string, string>)[platform] || platform;

  return (
    <div className="relative h-full" style={{ background: '#000' }}>
      {/* 媒体层：视频 / 封面 / 静图三选一互斥渲染。
            播放后只显示 video；未播放时按优先级单层渲染：
              静图主体 (非视频且有 primaryUrl) → cover (有 secondaryImageUrl) → 兜底渐变
            避免之前 cover 与 primary 同时铺底导致双层叠图 + onMediaAspectDetected 双触发 */}
      <div className="absolute inset-0">
        {(() => {
          if (hasPlayed) return null;
          // 优先级 1：静图 page（非视频 page，imageUrl 是图片）— 单层 primaryUrl
          if (!isVideo && primaryUrl) {
            return (
              <img
                src={primaryUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  const t = e.currentTarget;
                  if (t.naturalWidth > 0 && t.naturalHeight > 0)
                    onMediaAspectDetected?.(t.naturalWidth / t.naturalHeight);
                }}
              />
            );
          }
          // 优先级 2：视频 page 未播放，渲染 cover（如果有）
          if (coverUrl && !coverErrored) {
            return (
              <img
                src={coverUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  const t = e.currentTarget;
                  if (t.naturalWidth > 0 && t.naturalHeight > 0)
                    onMediaAspectDetected?.(t.naturalWidth / t.naturalHeight);
                }}
                onError={() => setCoverErrored(true)}
              />
            );
          }
          // 优先级 3：啥都没有 → 兜底渐变
          return (
            <div
              className="absolute inset-0"
              style={{ background: `linear-gradient(135deg, ${accent} 0%, #0a0a12 100%)` }}
            />
          );
        })()}
        {isVideo && hasPlayed && (
          <video
            ref={videoRef}
            src={primaryUrl}
            poster={coverUrl ?? undefined}
            className="absolute inset-0 w-full h-full object-cover bg-black"
            controls
            playsInline
            autoPlay
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0)
                onMediaAspectDetected?.(v.videoWidth / v.videoHeight);
            }}
          />
        )}
      </div>

      {/* 字幕浮层（仅播放后 + 有 transcriptCues 时显示）。位置在视频中下部，上限避开右栏与底部信息 */}
      {hasPlayed && activeCueIdx >= 0 && page.transcriptCues && page.transcriptCues[activeCueIdx] && (
        <div
          className="absolute z-20 pointer-events-none flex justify-center"
          style={{ left: 12, right: 70, bottom: '24%' }}
        >
          <div
            className="px-3 py-1.5 rounded-md max-w-full text-center"
            style={{
              background: 'rgba(0,0,0,0.62)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              color: '#fff',
              fontSize: 'clamp(13px, 1.4vw, 16px)',
              fontWeight: 600,
              lineHeight: 1.35,
              textShadow: '0 1px 2px rgba(0,0,0,0.7)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {page.transcriptCues[activeCueIdx].text}
          </div>
        </div>
      )}

      {/* 中央 Play 按钮（仅视频未播放时） */}
      {isVideo && !hasPlayed && (
        <button
          type="button"
          onClick={handlePlay}
          aria-label="播放视频"
          className="absolute inset-0 z-10 flex items-center justify-center group cursor-pointer"
          style={{ background: 'rgba(0,0,0,0.18)' }}
        >
          <div
            className="flex items-center justify-center transition-all duration-200 group-hover:scale-110"
            style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'rgba(255,255,255,0.18)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1.5px solid rgba(255,255,255,0.35)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            }}
          >
            <Play size={30} fill="white" strokeWidth={0} style={{ marginLeft: 3 }} />
          </div>
        </button>
      )}

      {/* 顶部条：作者头像 + @用户名 + 平台 + 时长（fade out on play） */}
      <div
        className="absolute inset-x-0 top-0 z-20 px-4 pt-4 pointer-events-none transition-opacity duration-300"
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)',
          paddingBottom: 32,
          opacity: hasPlayed ? 0 : 1,
        }}
      >
        <div className="flex items-center gap-2.5">
          {/* 头像 */}
          <div
            className="shrink-0 rounded-full overflow-hidden flex items-center justify-center"
            style={{
              width: 36, height: 36,
              background: `linear-gradient(135deg, ${accent}, #0a0a12)`,
              border: '1.5px solid rgba(255,255,255,0.4)',
            }}
          >
            {page.authorAvatarUrl && !avatarErrored ? (
              <img
                src={page.authorAvatarUrl}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
                referrerPolicy="no-referrer"
                onError={() => setAvatarErrored(true)}
              />
            ) : (
              <span className="text-white text-[14px] font-bold">
                {(author || 'U').charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-white text-[13px] font-semibold">
              <span className="truncate">{author ? `@${author}` : '匿名作者'}</span>
              {platformLabel && (
                <span
                  className="shrink-0 inline-flex items-center px-1.5 rounded text-[10px] font-medium"
                  style={{
                    background: 'rgba(255,255,255,0.22)',
                    color: 'rgba(255,255,255,0.92)',
                    height: 16,
                  }}
                >
                  {platformLabel}
                </span>
              )}
            </div>
            {typeof page.durationSec === 'number' && page.durationSec > 0 && (
              <div className="inline-flex items-center gap-1 text-white/72 text-[11px] mt-0.5">
                <Clock size={11} />
                <span>{formatDuration(page.durationSec)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 右栏：互动指标（播放后半透明常驻，避免完全遮蔽视频但仍让用户看到数据） */}
      {stats && (
        <div
          className="absolute right-3 z-20 flex flex-col items-center gap-3 transition-opacity duration-300"
          style={{ bottom: 110, opacity: hasPlayed ? 0.6 : 1 }}
        >
          {typeof stats.likes === 'number' && stats.likes > 0 && (
            <FeedStatChip icon={<Heart size={20} fill="white" strokeWidth={0} />} value={stats.likes} accent="#ff2d55" />
          )}
          {typeof stats.comments === 'number' && stats.comments > 0 && (
            <FeedStatChip icon={<MessageCircle size={20} fill="white" strokeWidth={0} />} value={stats.comments} />
          )}
          {typeof stats.collects === 'number' && stats.collects > 0 && (
            <FeedStatChip icon={<Bookmark size={20} fill="white" strokeWidth={0} />} value={stats.collects} accent="#ffcc00" />
          )}
          {typeof stats.shares === 'number' && stats.shares > 0 && (
            <FeedStatChip icon={<Share2 size={20} />} value={stats.shares} />
          )}
          {(stats.likes == null || stats.likes === 0) && typeof stats.plays === 'number' && stats.plays > 0 && (
            <FeedStatChip icon={<Eye size={20} />} value={stats.plays} />
          )}
        </div>
      )}

      {/* 底部信息：标题 hook + 标签 chip + 渐变背景 */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 px-4 pb-4 pt-8 pointer-events-none transition-opacity duration-300"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 35%, rgba(0,0,0,0.92) 100%)',
          opacity: hasPlayed ? 0 : 1,
          // 标题/标签让出右侧互动指标栏的宽度，避免窄卡片下文字压到点赞数上（元素重叠）
          paddingRight: stats ? 60 : undefined,
        }}
      >
        <h2
          className="font-bold text-white leading-snug line-clamp-2"
          style={{
            fontSize: 'clamp(15px, 1.5vw, 18px)',
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
          }}
        >
          {page.title}
        </h2>
        {tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{
                  background: 'rgba(255,255,255,0.16)',
                  color: 'rgba(255,255,255,0.95)',
                  border: '1px solid rgba(255,255,255,0.18)',
                }}
              >
                #{t}
              </span>
            ))}
            {tagOverflow > 0 && (
              <span className="text-white/60 text-[11px]">+{tagOverflow}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 互动数字 chip（垂直栈，图标 + 缩写数字） */
function FeedStatChip({ icon, value, accent }: { icon: React.ReactNode; value: number; accent?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 pointer-events-none">
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center"
        style={{
          background: 'rgba(0,0,0,0.42)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: accent || '#fff',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        {icon}
      </div>
      <span
        className="text-white text-[11px] font-semibold"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}
      >
        {formatStatNumber(value)}
      </span>
    </div>
  );
}

function formatStatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1000000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (sec < 3600) return `${m}:${s.toString().padStart(2, '0')}`;
  const h = Math.floor(sec / 3600);
  return `${h}:${(m % 60).toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * 主页弹窗包装 - 从 store 读取当前海报 + 已读状态。
 * 登录后主页挂载这个组件,有未读就弹。
 *
 * "每次登录展示一次"约束：弹出 1.5s 后自动登记已看过（写入 sessionStorage），用户即便不
 * 点 ✕ 也只会看一次；同会话内任何页面再次挂载主页不再弹；浏览器关闭后 sessionStorage
 * 清空，下次登录视为新会话再弹一次（符合"一天一次"的口语预期）。
 */
export function WeeklyPosterModal() {
  const currentPoster = useWeeklyPosterStore((s) => s.currentPoster);
  const shouldShow = useWeeklyPosterStore((s) => s.shouldShowCurrent());
  const dismiss = useWeeklyPosterStore((s) => s.dismiss);
  const markSeen = useWeeklyPosterStore((s) => s.markSeen);

  useEffect(() => {
    if (!currentPoster?.id || !shouldShow) return;
    const id = currentPoster.id;
    // 1.5s 后**静默**标记已读（写后端 SeenBy + sessionStorage） — modal 保持显示，让用户
    // 想看多久看多久。只有点 ✕ 才走 dismiss 真正关闭。
    const t = setTimeout(() => markSeen(id), 1500);
    return () => clearTimeout(t);
  }, [currentPoster?.id, shouldShow, markSeen]);

  if (!shouldShow || !currentPoster) return null;
  return (
    <PosterCarousel
      poster={currentPoster}
      onDismiss={() => dismiss(currentPoster.id)}
    />
  );
}
