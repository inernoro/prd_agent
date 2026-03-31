import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';

/**
 * 通过缩放 iframe 生成网页缩略预览图。
 * 用于网页托管卡片、我的资源等需要展示站点截图的场景。
 */
export function SitePreview({ url, className, style }: { url: string; className?: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
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

  const scale = containerW / iframeWidth;

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <Globe size={20} style={{ color: 'var(--accent-primary)', opacity: 0.4 }} />
        </div>
      )}
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
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.3s',
        }}
      />
    </div>
  );
}
