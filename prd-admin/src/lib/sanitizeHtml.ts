/**
 * 轻量 HTML 净化（零第三方依赖，基于浏览器 DOMParser）。
 *
 * 用途：渲染用户输入的富文本（评论 / 描述等）前调用，堵住存储型 XSS。
 * 策略：移除脚本/危险元素 + 去除所有 on* 事件属性 + 拦截 javascript:/data:text/html 协议 + 去 style expression。
 * 仅做"减法"，保留正常排版标签（加粗/斜体/标题/列表/图片/链接/段落等），不破坏既有内容格式。
 * 注意：本项目纯 CSR，window 始终存在；SSR 兜底仅为类型安全。
 */
const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'noscript'];

export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  doc.querySelectorAll(DANGEROUS_TAGS.join(',')).forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.replace(/\s+/g, '').toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && (val.startsWith('javascript:') || val.startsWith('data:text/html'))) {
        el.removeAttribute(attr.name);
      } else if (name === 'style' && val.includes('expression(')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}
