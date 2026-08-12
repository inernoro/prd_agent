/**
 * 托管站点在 iframe 里到底该加载哪个 URL —— 唯一判定源。
 *
 * 背景：上传 .pdf 时后端会把它包成「index.html 壳子 + 原 PDF」，壳子用 PDF.js 把 PDF
 * 渲染成 <canvas>（移动端 Safari / 微信 WebView 不支持在 iframe 里显示 PDF，只能这么做）。
 * 但那个壳子从 `cdn.jsdelivr.net` 取 PDF.js —— 这个域名在部分网络里是**挂起**而不是快速失败，
 * 于是 `script.onerror` 永远不触发、壳子的降级分支永远走不到，页面就永久停在
 * 「正在加载 PDF…」的 spinner 上。这正是 #1356 要修的那一类病（判据把「挂起」当成了
 * 「正在加载」），只是深了一层：外层 iframe 修好了，壳子内部又挂了一次。
 *
 * 后端早就为绕开壳子算好了 `pdfAssetUrl`（HostedSiteService.TryBuildPdfAssetUrl），
 * 但站内预览弹窗从来没读过它 —— 建了一半的接线，删掉不会有任何测试变红
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 2）。这里把它接上。
 *
 * 为什么不无条件绕开壳子：桌面浏览器有原生 PDF 阅读器，直连 PDF 是零外部依赖的最优解；
 * 移动端 Safari / 微信 WebView 在 iframe 里根本渲染不了 PDF，绕开壳子等于白屏。
 * 所以由调用方按自己的运行环境传 `nativePdfViewer`，判据只有一处、不复制。
 */

export interface SitePreviewSourceInput {
  siteUrl: string;
  /**
   * 后端对 PDF 包装站给出的原始 PDF 直链；非包装站为 undefined。
   *
   * 写成**必填属性**（而不是 `pdfAssetUrl?:`）是刻意的：可选属性会让「传进来的对象压根没有这个字段」
   * 静默通过类型检查——这正是第一版的病，判据在、数据不在，站内大预览的绕壳分支永远走不到。
   * 必填之后，调用方的类型里少了这个字段就直接编译不过，比任何源码扫描守卫都硬。
   */
  pdfAssetUrl: string | undefined;
}

export interface SitePreviewSource {
  /** iframe 该加载的 URL */
  src: string;
  /** 是否绕开了壳子、交给浏览器原生 PDF 阅读器 */
  usingNativePdfViewer: boolean;
}

/**
 * 这个浏览器能不能在 iframe 里用内置阅读器渲染 PDF。
 *
 * 判据必须是**能力信号**，不是视口宽度。第一版用 `useIsMobile()`（768px 断点）代替能力，
 * 于是 iPad、横屏手机、平板 WebView 全被算成桌面，照样会拿到裸 PDF 白屏——
 * 而壳子存在的理由正是这些客户端（predicate-and-wiring-discipline 形状 1：
 * 判据比它该管的范围窄，换个等价场景就翻转）。
 *
 * `navigator.pdfViewerEnabled` 是 HTML 规范里就为这件事定义的字段：浏览器是否具备
 * 内置 PDF 阅读器。iOS Safari 与各类嵌入式 WebView 报 false，桌面 Chrome/Firefox/Safari 报 true。
 *
 * 取不到这个字段（老浏览器）时**一律当作不支持**：走壳子最多是多依赖一次 CDN，
 * 走错方向则是彻底白屏，两种代价不对等。
 */
export function supportsNativePdfViewer(
  nav: { pdfViewerEnabled?: boolean } = typeof navigator === 'undefined' ? {} : navigator,
): boolean {
  return nav.pdfViewerEnabled === true;
}

export function resolveSitePreviewSource(
  site: SitePreviewSourceInput,
  options: { nativePdfViewer: boolean },
): SitePreviewSource {
  if (options.nativePdfViewer && site.pdfAssetUrl) {
    return { src: site.pdfAssetUrl, usingNativePdfViewer: true };
  }
  return { src: site.siteUrl, usingNativePdfViewer: false };
}
