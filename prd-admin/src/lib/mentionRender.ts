/**
 * 将历史导入/评论中的纯文本 @用户名 渲染为可样式化的 mention 节点（前端展示层）。
 */

/** TAPD / 微信式 @名：不含空白与常见分隔符，支持中文、英文、数字、点、中划线。 */
export const MENTION_TEXT_PATTERN = /@([\u4e00-\u9fa5\w.\-·]{1,40})/g;
const MENTION_TEXT_CAPTURE = /@([\u4e00-\u9fa5\w.\-·]{1,40})/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function mentionSpan(name: string): string {
  const safe = escapeHtml(name);
  return `<span class="pa-mention" data-mention="${escapeAttr(name)}">@${safe}</span>`;
}

/** 纯文本行内 @ → mention span（非 mention 部分转义）。 */
export function wrapMentionsInPlainText(text: string): string {
  if (!text) return '';
  let result = '';
  let lastIndex = 0;
  const re = new RegExp(MENTION_TEXT_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    result += mentionSpan(match[1]);
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

/** 已转义 HTML 的文本节点内补 mention（用于 descriptionToHtml 每行）。 */
export function wrapMentionsInEscapedHtmlText(text: string): string {
  if (!text) return '';
  return text.replace(MENTION_TEXT_CAPTURE, (_, name: string) => mentionSpan(name));
}

function looksLikeHtml(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

/** 已有 HTML：仅处理标签之间的文本，避免破坏结构。 */
export function enrichHtmlWithMentions(html: string): string {
  if (!html || html.includes('pa-mention')) return html;
  return html.replace(/>([^<]+)</g, (_match, text: string) => {
    const enriched = wrapMentionsInEscapedHtmlText(text);
    return `>${enriched}<`;
  });
}

/** 纯文本：按行转 <p> 并包裹 @；已是 HTML 则走 enrichHtmlWithMentions。 */
export function enrichContentWithMentions(content: string): string {
  if (!content.trim()) return content;
  if (looksLikeHtml(content)) return enrichHtmlWithMentions(content);
  return content
    .split(/\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      return `<p>${wrapMentionsInPlainText(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join('');
}
