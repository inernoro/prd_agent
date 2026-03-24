import { useEffect, useRef, useState } from 'react';

/**
 * 视频加载动画 — 用于页面跳转/懒加载等待期间。
 * 视频资源来自 CDN (i.pa.759800.com)，加载失败时降级为 PrdLoader。
 */

const VIDEO_CDN_DOMAIN = 'https://i.pa.759800.com';
const VIDEO_PATH = '/icon/title/home.mp4';
const VIDEO_SRC = `${VIDEO_CDN_DOMAIN}${VIDEO_PATH}`;


export function VideoLoader({ className }: { className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // 延迟 150ms 再显示，极短加载无需展示动画
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  if (videoFailed) {
    // 降级：简洁的 CSS 脉冲动画
    return (
      <div
        className={className}
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-base, #0a0a0a)',
          zIndex: 9999,
        }}
      >
        <style>{`
@keyframes video-loader-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.96); }
  50% { opacity: 1; transform: scale(1); }
}
        `}</style>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'var(--accent, #6366f1)',
            animation: 'video-loader-pulse 1.2s ease-in-out infinite',
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base, #0a0a0a)',
        zIndex: 9999,
      }}
    >
      <video
        ref={videoRef}
        src={VIDEO_SRC}
        autoPlay
        loop
        muted
        playsInline
        onError={() => setVideoFailed(true)}
        style={{
          maxWidth: '280px',
          maxHeight: '280px',
          width: '40vmin',
          height: 'auto',
          objectFit: 'contain',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
    </div>
  );
}

/**
 * 带最小显示时长的 VideoLoader —— 用于 Suspense fallback。
 * 避免加载极快时动画一闪而过。
 */
export function SuspenseVideoLoader() {
  return <VideoLoader />;
}
