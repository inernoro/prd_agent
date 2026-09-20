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
  /** 入口文件**自己**的字节数（后端 SharedSiteInfo.EntrySize）。取不到时为 0 / undefined */
  entrySize?: number;
  pdfAssetUrl?: string;
  wrappedAssetType?: string | null;
}

/**
 * 取正文那条同源代理的字节上限。
 *
 * SSOT 在后端 `WebPagesController.FetchSiteHtmlResultAsync` 的 `maxBytes`（它是匿名可达的
 * 路由，读满就断，防的是「一次请求分配几百 MB」）。而托管上传允许到 500MB——两个数字差了
 * 两个量级，于是入口 HTML 超过 2MB 的单文件站，「下载源文件」**必然失败**（Codex 第二轮 P2）。
 *
 * 前端抄这个数字是为了在**按下去之前**就判出来，而不是让用户点一次换一个后端报错。
 * 抄一份就有漂移风险，所以配了守卫读后端源码比对（见 sourceDownload.test.ts）。
 */
export const SOURCE_PROXY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * CDN 注入余量：两个数量的**量纲不一样**，边界上必须留出这段差。
 *
 * `EntrySize` 量的是**存进对象存储的**那一份；后端那个 `maxBytes` 量的是**CDN 服务出来的**
 * 那一份。中间隔着 CDN 往每份 HTML 里塞的遥测（见 previewHtml.ts 的
 * `stripInjectedTelemetry`）。于是恰好压线、以及贴着上限的那一档，前端判「能下」、代理
 * 读满即断，**确定性失败**（Codex 第七轮 P2）。
 *
 * 这个数是**上界估计，不是精确值**：能引的唯一一次实测是 2026-08-25 的验收记录——自己传的
 * 200 字节纯 HTML 取回来 9336 字节。取 16KB 覆盖它并留一倍富余；宁可让 1.98MB 那一档多报
 * 一次「装不下」（那一档有替代路径可走），也不要让人点一次必然失败。
 *
 * 真正的解法是一条不经过 CDN 的源文件端点，那样两个数量就是同一个量纲，这条余量可以删掉。
 * 已记进 PR 的后续事项。
 */
export const CDN_INJECTION_HEADROOM_BYTES = 16 * 1024;

/** 前端据以判「能不能下」的实际阈值：代理上限减去 CDN 注入余量。 */
export const SOURCE_DOWNLOADABLE_MAX_BYTES = SOURCE_PROXY_MAX_BYTES - CDN_INJECTION_HEADROOM_BYTES;

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

  /*
   * 拿**入口文件自己的**大小判，不拿 totalSize。
   *
   * 上一版用 totalSize 近似，于是只能对单文件站成立——多文件站的 totalSize 是所有文件之和，
   * 入口那份可能只有几十 KB，拿总和去拦会误伤。可那个特例又把「多文件站里入口 HTML 本身
   * 超过 2MB」的一类漏掉了：按钮看着能用，点下去必然被代理拒（Codex 第四轮 P2）。
   *
   * 正解不是在近似值上继续打补丁，而是让后端把真正该判的那个数给出来
   * （SharedSiteInfo.EntrySize）。换成它之后，判据对单文件站和多文件站是同一条，特例消失。
   *
   * 后端取不到入口条目时给 0：那就不拦，失败时仍有受控文案兜底——宁可多给一次尝试，
   * 也不要凭一个不知道的数去拦掉本来下得动的站点。
   */
  const entrySize = site.entrySize ?? 0;
  if (entrySize > SOURCE_DOWNLOADABLE_MAX_BYTES) {
    return {
      kind: 'unavailable',
      reason: `这份源文件 ${formatBytes(entrySize)}，取回通道的上限是 2MB，`
        + '而取回时 CDN 还会往 HTML 里塞几 KB 遥测，这一份装不下。'
        + '可以用顶栏的「新窗口打开」，在浏览器里另存。',
    };
  }

  const ext = extensionOf(site.entryFile) || '.html';
  return {
    kind: 'html',
    fileName: `${base}${ext}`,
    partial: fileCount > 1,
    fileCount,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

/**
 * 取源文件失败时给用户看什么。
 *
 * 后端那条路由的报错是**协议口径**的（`站点内容读取失败（HTTP 404）`、
 * `站点入口文件超过 2MB，不支持读取`）。把它原样端给访客，等于把「这是什么意思、
 * 我该怎么办」的推导工作转嫁给他——正是 external-cause-first 要治的那种文案：
 * 第一句必须是人话的外因 + 要不要紧 + 下一步，技术细节下沉成附注。
 *
 * 匹配用的是**一张表**而不是一串 if：新增一条就加一行，且每行都有守卫盯着
 * （`.claude/rules/external-cause-first.md` 第四节：能用状态就用状态，状态拿不到才关键字匹配；
 * 这里拿不到结构化状态——后端给的就是一句话，所以走匹配，但必须是数据形态）。
 */
const FAILURE_COPY: ReadonlyArray<{ match: RegExp; text: string }> = [
  {
    match: /超过\s*2\s*MB|不支持读取/,
    text: '这份源文件太大，服务端的取回通道装不下。用顶栏的「新窗口打开」，在浏览器里另存即可。',
  },
  {
    match: /HTTP\s*40[34]|不存在|NOT_FOUND/i,
    text: '源文件已经不在托管上了，多半是分享者删掉或重新上传过。让他把链接重发一次。',
  },
  {
    match: /HTTP\s*5\d\d|超时|timeout/i,
    text: '取源文件超时了，多半是这会儿网络慢。过一会儿再点一次；一直不行就找分享者要原始文件。',
  },
];

/**
 * 失败提示。
 *
 * detail（原始报错）**只在认不出这条错误时**才带上，这是两条要求折中出来的：
 *
 * - `external-cause-first` 要求内因别删掉、只是下沉——排障要用；
 * - 但这里的读者是分享链接的**外部访客**（客户、合作方），不是运维。认得出来的错误已经
 *   有了受控文案，再把 `HTTP 404` 摆给他，增量信息为零、观感是「这系统在冒内部细节」
 *   （Codex 第四轮 P2）。
 *
 * 认不出来的时候情况反过来：受控文案只能给一句通用的「稍后再试」，此时原文是他唯一能
 * 转述给分享者/支持的线索，删掉等于让他两手空空。所以那一档保留。
 */
export function describeDownloadFailure(message?: string | null): { text: string; detail?: string } {
  const raw = (message ?? '').trim();
  const hit = FAILURE_COPY.find((rule) => rule.match.test(raw));
  if (hit) return { text: hit.text };
  return {
    text: '取源文件失败了，稍后再试一次；一直不行就找分享者要原始文件。',
    detail: raw || undefined,
  };
}
