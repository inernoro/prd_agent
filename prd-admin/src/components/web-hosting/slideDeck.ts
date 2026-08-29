/**
 * 这份托管内容是不是一套幻灯片。
 *
 * 为什么要从 HTML 正文判，而不是读站点字段：站点上**没有**能回答这个问题的字段。
 * `SlideNavCompatVersion` 看着像，其实是「注入过第几版键盘垫片」的版本号，
 * 后端对每一次上传都无条件盖上（HostedSiteService 三处 Create + 一处 Reupload），
 * 拿它当 deck 标记就是 predicate-and-wiring-discipline 形状 8：
 * 把一份恒为真的证据当成了成立的证明。
 *
 * 所以只认正文里真实存在的框架痕迹。认不出来就当它不是幻灯片——
 * 宁可不提示，也不要在一篇普通网页上教用户按方向键。
 */

/** 各家幻灯框架在 HTML 里留下的、不会出现在普通网页上的痕迹 */
const DECK_SIGNATURES: ReadonlyArray<RegExp> = [
  // reveal.js：容器 class="reveal" + 内层 .slides，两者同时出现才算
  /class\s*=\s*["'][^"']*\breveal\b[^"']*["'][\s\S]{0,4000}class\s*=\s*["'][^"']*\bslides\b/i,
  /\breveal(?:\.min)?\.js\b/i,
  /\bReveal\.initialize\s*\(/i,
  // impress.js
  /\bid\s*=\s*["']impress["']/i,
  /\bimpress(?:\.min)?\.js\b/i,
  // remark / remarkjs
  /\bremark\.create\s*\(/i,
  // deck.js
  /\bdeck(?:\.min)?\.js\b/i,
];

/**
 * @param html 已经取回的页面原文；null/空一律返回 false（没看过就不下结论）
 */
export function detectSlideDeck(html: string | null | undefined): boolean {
  if (!html) return false;
  // 只看前 200KB：幻灯框架的引用都在文档头部或容器处，往后全是内容，
  // 整篇跑正则在大 deck 上是白烧 CPU
  const head = html.length > 200_000 ? html.slice(0, 200_000) : html;
  return DECK_SIGNATURES.some((re) => re.test(head));
}
