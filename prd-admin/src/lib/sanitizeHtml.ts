/**
 * 用户富文本的共同展示/粘贴边界。只接受 HTML 排版元素和明确的属性、URL 协议；
 * 存量和 API 写入内容也必须在插入 DOM 前调用，不能把“已保存”当作可信。
 */
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ALLOWED_TAGS = new Set('a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img li mark ol p pre s small span strong sub summary sup table tbody td th thead tr u ul'.split(' '));
const ALLOWED_ATTRS = new Set('alt title class style href src target rel width height colspan rowspan align color face size start reversed type open dir lang'.split(' '));
const SAFE_STYLE_PROPERTIES = new Set('color background-color font-family font-size font-weight font-style text-decoration text-align line-height white-space vertical-align margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-radius border-color border-width border-style width height max-width max-height min-width min-height'.split(' '));

function safeUrl(value: string, image: boolean): boolean {
  // HTML entities are already decoded by DOMParser. Strip URL-parser control characters.
  const normalized = Array.from(value).filter((char) => {
    const code = char.charCodeAt(0);
    return code > 0x20 && (code < 0x7f || code > 0x9f);
  }).join('');
  if (image && /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=]+$/i.test(normalized)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1].toLowerCase();
  return !scheme || ['http', 'https', ...(image ? ['blob'] : ['mailto', 'tel'])].includes(scheme);
}

export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty || typeof window === 'undefined' || typeof window.DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  doc.querySelectorAll('*').forEach((el) => {
    if (el === doc.documentElement || el === doc.head || el === doc.body) return;
    // Drop foreign namespaces and unknown containers whole: no SVG/MathML integration points,
    // templates, embeds or custom elements survive a later HTML parse.
    if (el.namespaceURI !== HTML_NAMESPACE || !ALLOWED_TAGS.has(el.localName)) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (attr.namespaceURI || (!ALLOWED_ATTRS.has(name) && !/^data-(?:mention|user|att)(?:-[a-z]+)?$/.test(name))) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && !safeUrl(attr.value, name === 'src' && el.localName === 'img')) {
        el.removeAttribute(attr.name);
      } else if (name === 'style') {
        const style = (el as HTMLElement).style;
        for (const property of Array.from(style)) {
          const value = style.getPropertyValue(property);
          if (!SAFE_STYLE_PROPERTIES.has(property) || /url\s*\(|expression\s*\(|[\\@]/i.test(value)) style.removeProperty(property);
        }
      }
    }
    if (el.localName === 'a' && el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML;
}

/**
 * 粘贴清洗：在净化基础上额外剥离 背景/颜色/字体/对齐 等表现型属性与 class/style，
 * 只保留结构化标签(加粗/斜体/标题/列表/链接/图片/段落/换行)，让粘贴内容自动融入当前主题，
 * 不再把来源页的白底色块带进暗色编辑器。
 */
const STRIP_ATTRS = new Set(['style', 'class', 'bgcolor', 'color', 'face', 'align', 'width', 'height', 'id', 'lang', 'dir']);

export function cleanPastedHtml(dirty: string | null | undefined): string {
  const safe = sanitizeHtml(dirty);
  if (!safe) return '';
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (STRIP_ATTRS.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}
