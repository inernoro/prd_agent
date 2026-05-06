import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, ArrowRight, Sparkles, Play } from 'lucide-react';
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

  const isAdMode = poster.presentationMode === 'ad-4-3';
  const isRichText = poster.presentationMode === 'ad-rich-text';
  // ad-4-3 与 ad-rich-text 共享 4:3 弹窗骨架，只是内部页面布局不同
  const isWideMode = isAdMode || isRichText;
  const aspect = isWideMode ? '4 / 3' : '1200 / 628';
  // 4:3 适合视频广告类弹窗（横屏不太宽、能装下竖屏视频又不极端），借鉴 Apple 产品视频弹窗 / Netflix 预告模态
  const widthCalc = isWideMode
    ? 'min(960px, calc((100vh - 80px) * 1.333), calc(100vw - 64px))'
    : 'min(1120px, calc((100vh - 80px) * 1.91), calc(100vw - 64px))';

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
          width: widthCalc,
          aspectRatio: aspect,
          background: isWideMode ? '#000' : '#06111e',
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
          {isAdMode ? (
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
