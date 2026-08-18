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
 * 判据故意宽松：只要声明了任何包装类型就跳过，而不是逐个列举 pdf/video/markdown。
 * 后端将来多一种包装形态，这里不用跟着改（形状 1：判据别比它该管的范围窄）。
 */
export function hasFetchableHtml(site: {
  siteUrl: string;
  entryFile?: string;
  pdfAssetUrl?: string;
  wrappedAssetType?: string | null;
}): boolean {
  if (site.pdfAssetUrl) return false;
  if (site.wrappedAssetType) return false;
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
  return !hasModuleScript(html);
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

export function withPreviewBase(html: string, siteUrl: string) {
  const baseHref = new URL('.', siteUrl).toString();

  // 先找到那个 <base> 标签本身，再看它有没有 href —— 两件事分开判。
  // 合成一条正则要求 href 必须存在，会让 `<base target="_blank">` 这种「有标签、没 href」
  // 的页面整个漏过去：不改写，也不注入，相对资源在 srcDoc 下全部解析到 MAP 自己的页面。
  const tag = html.match(/<base\b[^>]*>/i)?.[0];
  if (tag) {
    const hrefAttr = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/i);
    const href = hrefAttr ? (hrefAttr[1] ?? hrefAttr[2] ?? hrefAttr[3] ?? '') : null;

    // 已经是绝对地址：人家指的就是别处，不该动
    if (href !== null && isAbsoluteBaseHref(href)) return html;

    // 相对值按站点地址重解析；压根没写 href 就直接补上站点目录。
    // 原地改写而不是另插一个 <base>：浏览器只认第一个 base，追加的那个不生效。
    // 其余属性（target 等）原样保留。
    const resolved = href ? new URL(href.trim() || '.', baseHref).toString() : baseHref;
    const rewritten = hrefAttr
      ? tag.replace(hrefAttr[0], `href="${escapeHtmlAttr(resolved)}"`)
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
