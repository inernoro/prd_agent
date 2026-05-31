import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';

/**
 * 通过缩放 iframe 生成网页缩略预览图。
 * 用于网页托管卡片、我的资源等需要展示站点截图的场景。
 *
 * 性能：iframe 会完整加载目标网页（HTML+JS+CSS+资源），列表里几十上百张卡片
 * 同时挂载会把网速打满。这里用 IntersectionObserver 做「懒挂」——只有滚动进入
 * 视口（含 200px 预加载边距）的卡片才真正挂载 iframe 触发加载，离开视口后卸载，
 * 避免离屏卡片下载整页。原生 loading="lazy" 只延迟离屏加载、却不卸载已加载的，
 * 大列表仍会累积大量已下载页面，故改用 IntersectionObserver 主动控制挂载。
 */
export function SitePreview({ url, className, style }: { url: string; className?: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [inView, setInView] = useState(false);
  const [containerW, setContainerW] = useState(240);
  const iframeWidth = 1280;
  const iframeHeight = 800;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 懒挂：进入视口（含预加载边距）才挂载 iframe，离开视口卸载，避免离屏卡片下载整页
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (!entry.isIntersecting) setLoaded(false);
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const scale = containerW / iframeWidth;

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {/* 占位符随「未进入视口 或 未加载完」显示——离屏后即使有迟到的 onLoad 把 loaded 置真，
          只要 inView 为 false 占位符仍可见，不会出现空白瓦片 */}
      {(!inView || !loaded) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <Globe size={20} style={{ color: 'var(--accent-primary)', opacity: 0.4 }} />
        </div>
      )}
      {inView && (
        <iframe
          src={url}
          title="preview"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          style={{
            width: iframeWidth,
            height: iframeHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            border: 'none',
            pointerEvents: 'none',
            position: 'absolute',
            top: 0,
            left: 0,
            opacity: inView && loaded ? 1 : 0,
            transition: 'opacity 0.3s',
          }}
        />
      )}
    </div>
  );
}
