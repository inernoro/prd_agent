import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * 视频加载动画 — 用于页面跳转/懒加载等待期间。
 * 视频资源来自 CDN (i.pa.759800.com)，加载失败时降级为 PrdLoader。
 */

const VIDEO_CDN_DOMAIN = 'https://i.pa.759800.com';
const VIDEO_PATH = '/icon/title/home.mp4';
const VIDEO_SRC = `${VIDEO_CDN_DOMAIN}${VIDEO_PATH}`;

/** 视频至少显示的时间（ms），避免闪烁 */
const MIN_DISPLAY_MS = 600;

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
          maxWidth: '580px',
          maxHeight: '580px',
          width: '60vmin',
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

/**
 * 路由切换过渡视频 — 嵌入路由系统，在页面跳转时显示。
 * 显示一个覆盖内容区域（非全屏）的过渡视频，MIN_DISPLAY_MS 后自动淡出。
 */
export function RouteTransitionVideo() {
  const location = useLocation();
  const [show, setShow] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  const prevPathRef = useRef(location.pathname);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // 首次渲染不触发
    if (prevPathRef.current === location.pathname) return;
    prevPathRef.current = location.pathname;

    // 显示过渡
    setShow(true);
    setOpacity(1);

    // 清除之前的 timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // MIN_DISPLAY_MS 后开始淡出
    timerRef.current = setTimeout(() => {
      setOpacity(0);
      // 淡出动画结束后隐藏
      setTimeout(() => setShow(false), 400);
    }, MIN_DISPLAY_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [location.pathname]);

  if (!show) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base, #0a0a0a)',
        zIndex: 50,
        opacity,
        transition: 'opacity 400ms ease-out',
        pointerEvents: opacity > 0 ? 'auto' : 'none',
      }}
    >
      {videoFailed ? (
        <>
          <style>{`
@keyframes route-transition-pulse {
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
              animation: 'route-transition-pulse 1.2s ease-in-out infinite',
            }}
          />
        </>
      ) : (
        <video
          src={VIDEO_SRC}
          autoPlay
          loop
          muted
          playsInline
          onError={() => setVideoFailed(true)}
          style={{
            maxWidth: '420px',
            maxHeight: '420px',
            width: '50vmin',
            height: 'auto',
            objectFit: 'contain',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      )}
    </div>
  );
}
