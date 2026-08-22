import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, LayoutTemplate } from 'lucide-react';
import {
  DIRECT_PREVIEW_SANDBOX,
  SRCDOC_PREVIEW_SANDBOX,
} from '@/components/web-hosting/previewHtml';
import { useSitePreviewHtml, type SitePreviewHtmlSite } from '@/components/web-hosting/useSitePreviewHtml';

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
 * 显示路径有两条，优先级固定：
 *
 * 1. **srcDoc（传了 site 才有）**：服务端同源代理取回入口 HTML，注 `<base>` 后塞进 srcDoc。
 *    这是唯一可靠的一条——直链 iframe 指向托管域名，Chrome 在这条路径上存在「只绘制空白」
 *    的已知形态，分享页（PR #1356）已经因此改走代理，缩略图当时留在了直链上，于是同一个
 *    空白在列表页原样复发（用户报「网页托管无法显示内容」）。
 * 2. **直链**：取不回正文（无权限 / 打包型 SPA / 代理失败）时如实退回，多数站点仍能显示。
 *
 * 自愈（只作用于直链路径）：刚上传的站点带 ?v={Ticks} 缓存击穿参数、指向刚写入对象存储的
 * 对象，在 CDN 传播完成前 iframe 请求会一直 pending。这里加超时兜底 + onError：到点仍未
 * 加载完就带 retry 参数重挂 iframe 触发重新拉取，最多 MAX_RETRIES 次。
 */
// 递增退避窗口（毫秒）。刻意取较长的首个窗口：合法但加载慢的页面（大图/大脚本/慢网）
// 应在被打断前就自己加载完，避免「每 7s 重挂一次 → 每次从零重新下载 → 慢页永远加载不完」
// （Codex P2）。窗口用尽后不再起定时器，最后一次挂载的 iframe 会被留着不打断地一直加载，
// 保证慢页最终仍能渲染。数组长度即最大重挂次数。
const RETRY_DELAYS_MS = [12000, 20000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

// 「首绘窗口」：iframe 挂载多久之后无条件淡入，不再等 load。
//
// 为什么不能只等 load：load 要等**所有子资源**结算才触发，而托管的 AI 生成页普遍外链
// Google Fonts 这类三方域名，它们在部分网络里是「挂起」而不是快速失败——正文早就画完了，
// load 却永远不来，于是重挂次数用尽后 loaded 恒为 false，卡片**永久停在地球占位符**。
// 判据从「load 到了吗」换成「给它一段时间自己画」，见
// .claude/rules/predicate-and-wiring-discipline.md 形状 1。
const FIRST_PAINT_MS = 1200;

export function SitePreview({
  url,
  site,
  className,
  style,
}: {
  url: string;
  /**
   * 托管站点信息。传了才能走 srcDoc 这条可靠路径；不传（如桌面端/移动端资产列表里
   * 那些根本不是托管站点的 URL）就只走直链，行为与以前一致。
   */
  site?: SitePreviewHtmlSite;
  className?: string;
  style?: React.CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  /** 首绘窗口已过：即使 load 还没来也把 iframe 显出来（内容通常早已绘制） */
  const [revealed, setRevealed] = useState(false);
  const [inView, setInView] = useState(false);
  const [containerW, setContainerW] = useState(240);
  // 重试计数：变化即触发 iframe 重挂（key）并追加 _r 参数强制重新请求
  const [attempt, setAttempt] = useState(0);
  const iframeWidth = 1280;
  const iframeHeight = 800;

  // 只有进入视口才去取正文，和 iframe 懒挂同一个开关，列表不会一次性打几十个接口
  const { srcDoc, error: htmlError, loading: htmlLoading } = useSitePreviewHtml(site ?? null, inView);

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
          setRevealed(false);
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
  // 停止重试的信号只能是 loaded，**不能**是 revealed。
  //
  // 上一轮 review 指出「已经画出来了还重挂会闪白」，我据此把 revealed 也加进了这个守卫，
  // 那是过度修正：revealed 是**纯时间**的（挂载 1.2s 后无条件置真），它不证明页面画出来了。
  // 于是 CDN 传播中那种「导航一直 pending、既不 load 也不 error」的情形——正是本组件
  // 当初加重试要救的那一种——会在第一个 12s 窗口到来之前就被这个守卫掐掉，自愈彻底失效。
  //
  // srcDoc 路径不需要这套：内容已经在手里，不存在「传播中」。
  useEffect(() => {
    if (srcDoc) return;
    if (!inView || loaded || attempt >= MAX_RETRIES) return;
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const timer = setTimeout(() => setAttempt((a) => a + 1), delay);
    return () => clearTimeout(timer);
  }, [inView, loaded, attempt, srcDoc]);

  // 首绘窗口：进入视口后给 iframe 一段时间自己画，到点即淡入，不再等 load 事件。
  // 重挂（attempt 变化）会重开一次窗口，但**不回退 revealed**——已经显示出来的画面不该再被
  // 占位符盖回去（那会造成「闪回地球」的倒退感）。
  useEffect(() => {
    if (!inView) return;
    const timer = setTimeout(() => setRevealed(true), FIRST_PAINT_MS);
    return () => clearTimeout(timer);
  }, [inView, attempt]);

  const visible = inView && (loaded || revealed);

  const scale = containerW / iframeWidth;
  // 首次（attempt=0）用原始 URL 命中 CDN 缓存；重试时追加 _r 强制绕过 pending/缓存重新拉取
  const src = attempt > 0 ? `${url}${url.includes('?') ? '&' : '?'}_r=${attempt}` : url;

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {/*
        占位符**永远铺在最底层**，而不是「iframe 该显示时就把它拿掉」。
        跨域 iframe 读不到「画出来了没有」的信号（详见 doc/debt.web-hosting.md 第 21 条），
        原先靠 1.2s 定时器无条件撤掉占位符，等于拿时间冒充证据：页面真没画出来时，
        用户看到的是一块**纯空白瓦片**——比地球图标更糟，它看起来像内容，其实什么都没有
        （predicate-and-wiring-discipline 形状 8：不成立的证据不能当证据）。
        改成分层之后不需要任何判据：iframe 画出了东西就自然盖住占位符，没画出来就露出地球。
      */}
      {/*
        占位两态（设计稿屏 2「缩略图两态」）：
        - 正在取正文：斜纹井底 + 文档图标 + 扫光，明确「在取」而不是空瓦片；
        - 降级态：额外挂一枚「取不到正文 · 显示占位」的暖色提示条，说明为什么是占位，
          不假装在加载（跨域 / 打包型 SPA / 代理失败都会走到这里）。
      */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-1"
        style={{
          background: 'var(--bg-well)',
          backgroundImage: 'repeating-linear-gradient(135deg, var(--border-faint) 0 8px, transparent 8px 16px)',
        }}
      >
        <LayoutTemplate size={22} style={{ color: 'var(--text-tertiary)' }} />
        {htmlError && !srcDoc && (
          <span
            className="inline-flex items-center gap-1"
            style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 'var(--radius-xs)',
              color: 'var(--accent-fg-warning)', border: '1px solid var(--semantic-warning-border)',
              background: 'var(--semantic-warning-soft)',
            }}
            title={htmlError}
          >
            <AlertTriangle size={10} /> 取不到正文 · 显示占位
          </span>
        )}
        {htmlLoading && !srcDoc && (
          <span className="site-preview-shimmer pointer-events-none absolute inset-0" aria-hidden />
        )}
      </div>
      {inView && (
        <iframe
          key={srcDoc ? 'srcdoc' : `direct-${attempt}`}
          src={srcDoc ? undefined : src}
          srcDoc={srcDoc || undefined}
          title="preview"
          sandbox={srcDoc ? SRCDOC_PREVIEW_SANDBOX : DIRECT_PREVIEW_SANDBOX}
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
            // srcDoc 的内容已经在手里，渲染是同步的，不需要等首绘窗口
            opacity: srcDoc || visible ? 1 : 0,
            transition: 'opacity 0.3s',
          }}
        />
      )}
    </div>
  );
}
