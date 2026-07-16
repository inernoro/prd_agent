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
 *
 * 自愈：预览是「实时 iframe」而非缓存截图。刚上传的站点带 ?v={Ticks} 缓存击穿参数、
 * 指向刚写入 COS 的对象，在 CDN 传播完成前 iframe 请求会一直 pending，onLoad 迟迟
 * 不触发 → 卡片永远停在地球占位符（历史缺陷：只监听 onLoad，无超时/onError/重试）。
 * 这里加超时兜底 + onError：到点仍未加载完就带 retry 参数重挂 iframe 触发重新拉取，
 * 最多 MAX_RETRIES 次；对象一旦传播就绪，重试即可成功显示真实预览。
 */
// 递增退避窗口（毫秒）。刻意取较长的首个窗口：合法但加载慢的页面（大图/大脚本/慢网）
// 应在被打断前就自己加载完，避免「每 7s 重挂一次 → 每次从零重新下载 → 慢页永远加载不完」
// （Codex P2）。窗口用尽后不再起定时器，最后一次挂载的 iframe 会被留着不打断地一直加载，
// 保证慢页最终仍能渲染。数组长度即最大重挂次数。
const RETRY_DELAYS_MS = [12000, 20000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

export function SitePreview({ url, className, style }: { url: string; className?: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [inView, setInView] = useState(false);
  const [containerW, setContainerW] = useState(240);
  // 重试计数：变化即触发 iframe 重挂（key）并追加 _r 参数强制重新请求
  const [attempt, setAttempt] = useState(0);
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
        // 离开视口时复位加载态与重试计数，下次进入视口重新干净地加载 + 重试
        if (!entry.isIntersecting) {
          setLoaded(false);
          setAttempt(0);
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 加载超时自愈：在视口内且未加载完、且未耗尽重挂次数时起一个退避超时兜底，
  // 到点仍未 onLoad（多为新上传对象 CDN 传播中导致 iframe 一直 pending）就重挂重试。
  // attempt 达到 MAX_RETRIES 后本 effect 提前返回、不再起定时器 → 最后一次挂载的
  // iframe 不会被打断，慢页可继续加载直到 onLoad，不会因超时被永久卡在占位符。
  useEffect(() => {
    if (!inView || loaded || attempt >= MAX_RETRIES) return;
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const timer = setTimeout(() => setAttempt((a) => a + 1), delay);
    return () => clearTimeout(timer);
  }, [inView, loaded, attempt]);

  const scale = containerW / iframeWidth;
  // 首次（attempt=0）用原始 URL 命中 CDN 缓存；重试时追加 _r 强制绕过 pending/缓存重新拉取
  const src = attempt > 0 ? `${url}${url.includes('?') ? '&' : '?'}_r=${attempt}` : url;

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
          key={attempt}
          src={src}
          title="preview"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setAttempt((a) => (a < MAX_RETRIES ? a + 1 : a))}
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
