/**
 * 「下载源文件」的形态判定。
 *
 * 为什么抽成纯函数：托管站点有三种形态（单文件 HTML / 多文件站 / 包装资产站），
 * 三者的「源文件」根本不是同一个东西。把判定写在按钮的 onClick 里，就变成
 * 「按下去才知道能不能下、下到的是不是完整的那一份」——正是要避免的那种惊讶。
 * 判定提前算出来，按钮的可用性、提示语、下载后的说明全由它决定。
 */

/** 站点侧需要的最小字段集（SharedSiteInfo 的子集，站内页面也能复用同一份判定） */
export interface SourceDownloadSite {
  title?: string;
  entryFile?: string;
  fileCount?: number;
  pdfAssetUrl?: string;
  wrappedAssetType?: string | null;
}

export type SourceDownloadPlan =
  /**
   * 源文件是一份独立资产（PDF 等），只能**在新窗口打开**，由浏览器内联显示、用户自己另存。
   *
   * 为什么不是「下载」：跨域的 a[download] 会被浏览器忽略；想真的落盘就得 fetch 到
   * Blob，而托管域名的 CORS 是**逐个域名配的白名单**——生产 map.ebcone.net 在里面，
   * 分支预览域名不在（2026-09-20 实测）。那样做出来就是「生产能用、预览不能用」，
   * 而预览正是验收的地方。所以这一档老老实实叫「打开」，按钮文案也跟着改，
   * 不宣称一个它做不到的动作（no-rootless-tree）。
   */
  | { kind: 'open'; url: string }
  /**
   * 源文件是入口 HTML，走服务端同源代理取回。
   * partial=true 表示这个站点还有别的文件（图片 / CSS / JS），下到的只是入口那一份。
   */
  | { kind: 'html'; fileName: string; partial: boolean; fileCount: number }
  /** 拿不到源文件，reason 是给用户看的一句话（不是错误码） */
  | { kind: 'unavailable'; reason: string };

/**
 * 壳子本身就是完整正文、可以直接当 HTML 下回去的包装类型。
 *
 * SSOT 在后端 `WebPagesController.SrcDocReadableWrappers`——那里是 default-deny：
 * 不在名单里的包装类型，取正文端点一律 400。这里跟着它列，是为了在**按下去之前**
 * 就把按钮置灰并说明原因，而不是让用户点一次换一个报错。
 * 后端放行新的包装类型时这里要一起加（守卫见 sourceDownload.test.ts）。
 */
const HTML_READABLE_WRAPPERS = new Set(['markdown']);

/** Windows 与 macOS 都不接受的文件名字符，外加控制字符 */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

/**
 * 把站点标题变成能落盘的文件名。
 * 标题是用户自己起的，可能带斜杠、引号、换行，甚至整条都是空白。
 */
export function sanitizeFileBaseName(title: string | undefined, fallback = 'page'): string {
  const cleaned = (title ?? '')
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 末尾的点会被 Windows 吞掉，连带把扩展名一起吃没
    .replace(/\.+$/, '')
    .trim();
  if (!cleaned) return fallback;
  // 留出扩展名的余地；80 是肉眼可读与路径长度限制之间的折中
  return cleaned.slice(0, 80);
}

/** 从 URL 或文件路径里取扩展名（含点），取不到给空串 */
export function extensionOf(pathOrUrl: string | undefined): string {
  if (!pathOrUrl) return '';
  const withoutQuery = pathOrUrl.split(/[?#]/)[0];
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot === lastSegment.length - 1) return '';
  const ext = lastSegment.slice(dot).toLowerCase();
  // 扩展名里混进奇怪字符时宁可不要，也不要拼出一个坏文件名
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function planSourceDownload(site: SourceDownloadSite): SourceDownloadPlan {
  const base = sanitizeFileBaseName(site.title);

  // 1) 包装资产站：源文件是被包起来的那份资产，壳子 HTML 只是容器，下它没有意义
  const wrapped = (site.wrappedAssetType ?? '').trim().toLowerCase();
  if (wrapped && !HTML_READABLE_WRAPPERS.has(wrapped)) {
    if (site.pdfAssetUrl) {
      return { kind: 'open', url: site.pdfAssetUrl };
    }
    // 视频这类目前没有把资产地址透到分享数据里。说清现状，不要给一个点了会报错的按钮。
    return {
      kind: 'unavailable',
      reason: `这是${wrapped === 'video' ? '视频' : wrapped}包装站点，源文件不是网页，暂时不能从这里取。请找分享者要原始文件。`,
    };
  }

  // 2) 存量 PDF 包装站可能 wrappedAssetType 为空但资产地址在，按资产处理
  if (site.pdfAssetUrl) {
    return { kind: 'open', url: site.pdfAssetUrl };
  }

  // 3) 普通 HTML 站
  const fileCount = site.fileCount ?? 1;
  const ext = extensionOf(site.entryFile) || '.html';
  return {
    kind: 'html',
    fileName: `${base}${ext}`,
    partial: fileCount > 1,
    fileCount,
  };
}

/**
 * 下载完成后要不要多说一句。
 * 多文件站下到的只是入口那一份——不说清楚，用户会以为手里这份是完整的站点。
 */
export function describeDownloadResult(plan: SourceDownloadPlan): string | null {
  if (plan.kind === 'html' && plan.partial) {
    return `已下载入口文件。本站共 ${plan.fileCount} 个文件，图片与样式等其余 ${plan.fileCount - 1} 个不在这一份里。`;
  }
  return null;
}

/**
 * 把一段文本存成本地文件。
 *
 * 为什么不直接给托管直链挂 a[download]：托管内容在独立域名，跨域的 a[download]
 * 会被浏览器忽略掉 download 属性、退化成导航打开——而「导航打开一份 text/html」
 * 正是某些 App 内置浏览器会弹「Download：(null)」的那条路径。走 Blob 从同源落盘，
 * 浏览器不必再为这份内容发一次跨域请求。
 */
export function saveTextAsFile(text: string, fileName: string, mime = 'text/html;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 立刻 revoke 会让部分浏览器来不及开始下载；一拍之后再回收
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
