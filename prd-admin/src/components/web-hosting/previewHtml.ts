/**
 * 托管站点在 iframe 里怎么渲染 —— 判据的唯一来源。
 *
 * 托管内容放在独立域名（与主站刻意跨域隔离，防止用户上传的 HTML 触达主站登录态），
 * 那个域名不返回 Access-Control-Allow-Origin，而且直链 iframe 在 Chrome 里存在
 * 「只绘制空白」的已知形态。可靠的显示路径只有一条：服务端同源代理取回入口 HTML，
 * 注入 `<base>` 之后塞进 srcDoc 渲染。
 *
 * 这套判据原先只长在 ShareViewPage 里（PR #1356 只修了分享页），
 * 卡片缩略图与站内大预览还留在直链上，于是同一个「空白」在列表页原样复发。
 * 抽到这里是为了让三处共用同一份判据，不让它再分裂出第二个口径
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 3）。
 */

function escapeHtmlAttr(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isHtmlEntry(siteUrl: string, entryFile?: string) {
  const target = entryFile || siteUrl.split('?')[0].split('#')[0];
  return /\.html?$/i.test(target);
}

/**
 * 这个站点有没有「可以取回来的 HTML 正文」。
 *
 * 光看入口是不是 .html 不够：PDF / 视频 / Markdown 包装站的入口**也是** index.html，
 * 只是那层壳子里没有正文，正文代理对任何非空 wrappedAssetType 一律拒绝。
 * 前端不看这个字段就会去问、拿回一个预期之内的拒绝，然后在一个本来显示得好好的
 * 直链预览上盖一条错误角标——用户看到的是「这页出错了」，其实什么事都没有。
 *
 * 但「任何包装类型一律跳过」又宽过头了：Markdown 包装站的壳子**就是**正文
 * （服务端把 .md 渲染成完整 HTML、样式内联、无外部引用），它拿得回来、也最适合 srcDoc。
 * 一刀切跳过的后果是 MD 站在分享页只能走直链 iframe，而直链正是那条会白屏的路径
 * —— 用户看到的就是标题栏下面一片白（2026-08-25 反馈）。
 *
 * 所以改成 default-deny 的白名单：只有确认「壳子即正文」的包装类型才放行，
 * 后端将来多一种包装形态时保持今天的行为，确认自包含之后才加进来。
 * 两侧判据必须同步 —— 后端 WebPagesController.SrcDocReadableWrappers 是同一份名单。
 */
const SRCDOC_READABLE_WRAPPERS = new Set(['markdown']);

export function hasFetchableHtml(site: {
  siteUrl: string;
  entryFile?: string;
  pdfAssetUrl?: string;
  wrappedAssetType?: string | null;
}): boolean {
  if (site.pdfAssetUrl) return false;
  if (site.wrappedAssetType && !SRCDOC_READABLE_WRAPPERS.has(site.wrappedAssetType)) return false;
  return isHtmlEntry(site.siteUrl, site.entryFile);
}

/**
 * 这份 HTML 能不能安全地走 srcDoc 预览。
 *
 * srcDoc 路径刻意不给 allow-same-origin（否则用户上传的任意 HTML 就拿到 MAP 同源能力），
 * 代价是文档处于**不透明源**。经典 `<script src>` 跨域不需要 CORS，照常能加载；
 * 但 `<script type="module">` 是按 CORS 模式取的——而托管域名不返回
 * Access-Control-Allow-Origin（正是本文件到处在说的那件事），模块脚本会被浏览器拦掉。
 *
 * 后果很具体：Vite/webpack 打包出来的 SPA 入口恰恰是 `<script type="module" src="...">`，
 * 走 srcDoc 会白屏。这类站点必须留在直链 iframe 上——直链是同源加载，模块脚本没问题。
 *
 * 所以判据是「有没有模块脚本」，而不是「是不是 HTML」。内联的 module 也算——
 * 它里面的 `import` 同样按 CORS 模式取，理由见 hasModuleScript。
 */
export function canUseSrcDocPreview(html: string): boolean {
  if (!html) return false;
  return !hasModuleScript(stripInjectedTelemetry(html));
}

/**
 * 剥掉**传输途中被注入的**遥测脚本。
 *
 * 托管域名前面挂着 CDN，它会往每一份 HTML 里塞一条
 * `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/...">`。
 * 那不是用户上传的内容，却是 `type="module"` —— 于是 canUseSrcDocPreview 一律判否，
 * **每一个**经过该 CDN 的托管站点都被踢出 srcDoc、落到会白屏的直链路径上。
 * （2026-08-25 每日验收脚本第一次跑就抓到：自己传的 200 字节纯 HTML，取回来 9336 字节、
 * 带着这条 beacon，于是 mode=direct、正文 0 字。）
 *
 * 判据刻意窄：只认「已知的第三方遥测端点」，逐条列出。
 * 不做「凡是跨域 module 一律剥」——那种页面可能真的靠 CDN 上的 ESM 依赖跑，
 * 剥掉等于把内容也剥了；它们留在直链路径上是对的。
 */
const INJECTED_TELEMETRY_HOSTS = [
  'static.cloudflareinsights.com',
];

export function stripInjectedTelemetry(html: string): string {
  if (!html) return html;
  let out = html;
  for (const host of INJECTED_TELEMETRY_HOSTS) {
    // 只删「开标签里 src 指向该 host」的那一对 script，不碰别的
    const re = new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']?[^"'>]*${host.replace(/\./g, '\\.')}[^"'>]*["']?[^>]*>\\s*</script>`, 'gi');
    out = out.replace(re, '');
  }
  return out;
}

/**
 * 有没有模块脚本（任何一种）。
 *
 * 判据经过两次收窄失败，现在取**最保守**的形态：只要页面上有 `type="module"` 的 script，
 * 无论外链还是内联，一律不走 srcDoc。
 *
 * 第一版写 `type\s*=\s*["']module["']`，硬要求引号存在——而 `<script type=module src=...>`
 * 是合法 HTML，这类页面被判成安全，进去白屏。改成逐属性解析后仍然漏一类：
 * 内联的 `<script type="module">import './app.js'</script>` 没有 `src`，被判成安全，
 * 可那条 `import` 同样是按 CORS 模式发的模块请求，在不透明源下照样被拦，照样白屏。
 *
 * 与其继续追着「哪种 module 会发跨域请求」逐条补（每补一条就是下一次漏判的温床），
 * 不如认所有 module。代价很小：真正自包含、不 import 任何东西的内联 module 页面会
 * 退回直链 iframe——而直链本来就能正常显示，只是拿不到 srcDoc 那点额外好处。
 *
 * 属性值三种合法写法（双引号 / 单引号 / 不带引号）都要认，属性顺序与大小写也不能挑。
 */
function hasModuleScript(html: string): boolean {
  // 只取 <script ...> 的开标签部分，逐个解析里面的属性
  const openTags = html.match(/<script\b[^>]*>/gi);
  if (!openTags) return false;

  for (const tag of openTags) {
    if (parseAttributes(tag).type === 'module') return true;
  }
  return false;
}

/** 解析标签里的属性；值支持双引号、单引号、无引号三种写法，键统一小写。 */
function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 去掉开头的 `<script` 与结尾的 `>`，只留属性区
  const body = tag.replace(/^<\s*script\b/i, '').replace(/\/?>$/, '');
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1].toLowerCase();
    if (!key) continue;
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim().toLowerCase();
    out[key] = value;
  }
  return out;
}

/**
 * 已有的 `<base href>` 是不是相对值（`./` `/assets/` `../` 这类）。
 *
 * 相对 base 在直链 iframe 里没问题——文档 URL 就是托管域名，解析出来还是托管域名。
 * 但注进 srcDoc 之后文档 URL 变成了**MAP 自己的页面地址**，同一个 `./` 会解析到
 * MAP 的路由上，于是页面的脚本、样式、链接全都去 MAP 上找，一个都取不到。
 * 上传通道本身会把根相对的 href 改写成 `./`，所以这类站点在真实数据里很常见。
 *
 * 判据只认「能不能独立成立的绝对地址」：带协议（http:、https:、data:）或协议相对（//）
 * 才算绝对，其余一律要按 siteUrl 重解析一次。
 */
function isAbsoluteBaseHref(href: string): boolean {
  const v = href.trim();
  if (!v) return false;
  return v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v);
}

type HtmlAttributeMatch = {
  start: number;
  end: number;
  value: string;
};

/**
 * 在一个开始标签里按 HTML 属性边界查找属性。
 *
 * `\bhref` 会命中 data-href，`\shref` 仍可能命中带引号属性值内部的文本。
 * 这里逐段跳过属性值，只在属性名位置比较，返回可原地替换的精确范围。
 */
function findHtmlAttribute(tag: string, targetName: string): HtmlAttributeMatch | null {
  let cursor = 1;
  if (tag[cursor] === '/') cursor += 1;
  while (cursor < tag.length && !/[\s/>]/.test(tag[cursor])) cursor += 1;

  while (cursor < tag.length) {
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === '>' || tag[cursor] === '/') break;

    const nameStart = cursor;
    while (cursor < tag.length && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    const name = tag.slice(nameStart, cursor);
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;

    if (tag[cursor] !== '=') {
      if (name.toLowerCase() === targetName.toLowerCase()) return null;
      continue;
    }

    cursor += 1;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor] : null;
    let value = '';

    if (quote) {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
      value = tag.slice(valueStart, cursor);
      if (tag[cursor] === quote) cursor += 1;
    } else {
      const valueStart = cursor;
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor])) cursor += 1;
      value = tag.slice(valueStart, cursor);
    }

    if (name.toLowerCase() === targetName.toLowerCase()) {
      return { start: nameStart, end: cursor, value };
    }
  }

  return null;
}

/**
 * srcDoc 中的纯片段链接必须继续指向当前文档。
 *
 * 浏览器会用 `<base href>` 解析 `href="#section"`，结果变成对象存储目录
 * `.../site-id/#section`。对象存储没有目录对象，最终显示 NoSuchKey。
 * `about:srcdoc#section` 是绝对地址，不受 base 影响，同时仍在当前 iframe 内完成页内跳转。
 *
 * 只处理 a / area 的纯片段 href；SVG 的 `<use href="#icon">` 等资源引用不能改。
 */
export function preserveSrcDocFragmentLinks(html: string): string {
  if (!html) return html;
  return html.replace(/<(a|area)\b[^>]*>/gi, (tag) => {
    const hrefAttr = findHtmlAttribute(tag, 'href');
    if (!hrefAttr) return tag;
    const href = hrefAttr.value.trim();
    if (!href.startsWith('#')) return tag;
    return `${tag.slice(0, hrefAttr.start)}href="${escapeHtmlAttr(`about:srcdoc${href}`)}"${tag.slice(hrefAttr.end)}`;
  });
}

export function withPreviewBase(html: string, siteUrl: string) {
  // 同一处剥干净：srcDoc 里留着一条注定加载不了的第三方 beacon 没有意义，
  // 还会在访客的控制台里刷一条 CORS 报错，让真问题更难被看见。
  html = preserveSrcDocFragmentLinks(stripInjectedTelemetry(html));
  const baseHref = new URL('.', siteUrl).toString();

  // 先找到那个 <base> 标签本身，再看它有没有 href —— 两件事分开判。
  // 合成一条正则要求 href 必须存在，会让 `<base target="_blank">` 这种「有标签、没 href」
  // 的页面整个漏过去：不改写，也不注入，相对资源在 srcDoc 下全部解析到 MAP 自己的页面。
  const tag = html.match(/<base\b[^>]*>/i)?.[0];
  if (tag) {
    const hrefAttr = findHtmlAttribute(tag, 'href');
    const href = hrefAttr?.value ?? null;

    // 已经是绝对地址：人家指的就是别处，不该动
    if (href !== null && isAbsoluteBaseHref(href)) return html;

    // 相对值按站点地址重解析；压根没写 href 就直接补上站点目录。
    // 原地改写而不是另插一个 <base>：浏览器只认第一个 base，追加的那个不生效。
    // 其余属性（target 等）原样保留。
    const resolved = href ? new URL(href.trim() || '.', baseHref).toString() : baseHref;
    const rewritten = hrefAttr
      ? `${tag.slice(0, hrefAttr.start)}href="${escapeHtmlAttr(resolved)}"${tag.slice(hrefAttr.end)}`
      : tag.replace(/^<\s*base\b/i, (m) => `${m} href="${escapeHtmlAttr(resolved)}"`);
    return html.replace(tag, rewritten);
  }

  const baseTag = `<base href="${escapeHtmlAttr(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `${baseTag}${html}`;
}

/**
 * srcDoc 预览的 sandbox 组合 —— 三处共用一份，不再各写各的。
 *
 * 不含 allow-same-origin：srcDoc 的内容是用户上传的任意 HTML，给了同源就等于把 MAP 的
 * localStorage（含登录令牌）交出去。也不含 `allow-fullscreen`——**那不是 sandbox 的合法取值**，
 * 浏览器会报 "invalid sandbox flag" 并整条忽略；全屏权限归 `allow="fullscreen"` 管。
 */
export const SRCDOC_PREVIEW_SANDBOX = 'allow-scripts allow-popups allow-forms';

/** 直链 iframe 的 sandbox 组合。直链文档来自托管域名，本就与 MAP 不同源，给 same-origin 不会泄漏 MAP 凭据。 */
export const DIRECT_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-forms';
