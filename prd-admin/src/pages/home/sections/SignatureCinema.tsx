import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useLanguage } from '../contexts/LanguageContext';
import { Reveal } from '../components/Reveal';

interface SignatureCinemaProps {
  className?: string;
  /** 视频源，缺失时降级为 poster + "即将上线"标签 */
  src?: string;
  /** 静帧海报（视频加载前显示） */
  poster?: string;
  /** 右下角署名文案 */
  caption?: string;
}

/**
 * 幕 4 · Signature Cinema — 全站唯一的"电影时刻"
 *
 * 设计原则：
 * - scroll-snap 视角：进入视口自动播放，离开自动暂停
 * - 降级路径：src 缺失时渲染 poster + "即将上线"签名，禁止空白
 * - 稀缺美学：这一幕是全站唯一一块"全宽 16:9 黑箱"，不允许被复制使用
 */
export function SignatureCinema({ className, src, poster, caption }: SignatureCinemaProps) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [isInView, setIsInView] = useState(false);

  // 视口感知：进入 60% 可见时 play，离开时 pause
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !src) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInView(entry.isIntersecting);
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (isInView) {
      video.play().catch(() => {
        // 自动播放失败（Safari/iOS 限制）静默处理，用户点击后可恢复
      });
    } else {
      video.pause();
    }
  }, [isInView, src]);

  const hasVideo = Boolean(src);

  return (
    <section
      ref={sectionRef}
      className={cn('relative w-full py-24 md:py-36', className)}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-7xl mx-auto px-6">
        {/* 小标题 */}
        <div className="text-center mb-14">
          <Reveal>
            <div
              className="inline-block text-[11px] uppercase text-cyan-300/80 mb-4"
              style={{ letterSpacing: '0.32em', fontFamily: 'var(--font-mono)' }}
            >
              {t.cinema.eyebrow}
            </div>
          </Reveal>
          <Reveal delay={120} offset={22}>
            <h2
              className="text-white font-light"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(2rem, 5vw, 3.75rem)',
                letterSpacing: '-0.02em',
                lineHeight: 1.05,
              }}
            >
              {t.cinema.title}
              <br className="sm:hidden" />
              <span className="text-white/55">{t.cinema.tail}</span>
            </h2>
          </Reveal>
        </div>

        {/* 16:9 电影窗口 */}
        <div
          className="relative w-full overflow-hidden rounded-[28px] border border-white/10 bg-black"
          style={{
            aspectRatio: '16 / 9',
            boxShadow:
              '0 0 0 1px rgba(255,255,255,0.04), 0 80px 160px -40px rgba(0, 240, 255, 0.18), 0 40px 120px -30px rgba(124, 58, 237, 0.22)',
          }}
        >
          {/* 视频 or 海报 */}
          {hasVideo ? (
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              src={src}
              poster={poster}
              muted
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <PosterFallback poster={poster} comingSoon={t.cinema.comingSoon} />
          )}

          {/* 边缘暗角 — 加"镜头感" */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
            }}
          />

          {/* 顶部扫光细线 — HUD 感 */}
          <div
            className="absolute top-0 left-0 right-0 h-px pointer-events-none"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(0, 240, 255, 0.6) 50%, transparent 100%)',
            }}
          />

          {/* 右下署名 */}
          <div
            className="absolute bottom-5 right-6 text-[10px] text-white/50 uppercase"
            style={{ letterSpacing: '0.24em', fontFamily: 'var(--font-mono)' }}
          >
            {caption ?? t.cinema.caption}
          </div>
        </div>
      </div>
    </section>
  );
}

/** 无视频时的降级海报：深色渐变 + 大播放图标 + "即将上线"标签 */
function PosterFallback({ poster, comingSoon }: { poster?: string; comingSoon: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* 背景层：poster 图 or 渐变 */}
      {poster ? (
        <img
          src={poster}
          alt="Signature cinema poster"
          className="absolute inset-0 w-full h-full object-cover opacity-75"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 35% 40%, rgba(0, 240, 255, 0.22) 0%, transparent 55%), radial-gradient(ellipse at 65% 60%, rgba(124, 58, 237, 0.25) 0%, transparent 55%), linear-gradient(135deg, #050512 0%, #0a0a1f 50%, #0b0516 100%)',
          }}
        />
      )}

      {/* 中心播放占位 */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div
          className="w-20 h-20 md:w-24 md:h-24 rounded-full border border-white/25 backdrop-blur-md flex items-center justify-center bg-white/[0.04]"
          style={{
            boxShadow:
              '0 0 60px rgba(0, 240, 255, 0.25), inset 0 0 40px rgba(124, 58, 237, 0.12)',
          }}
        >
          <svg
            className="w-8 h-8 md:w-10 md:h-10 text-white/85 translate-x-0.5"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <div
          className="text-[11px] uppercase text-white/60"
          style={{ letterSpacing: '0.32em', fontFamily: 'var(--font-mono)' }}
        >
          {comingSoon}
        </div>
      </div>
    </div>
  );
}
