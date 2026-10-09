import type { Theme } from '@/lib/theme';
import { marked } from 'marked';

const decodeCodePoint = (entity: string, value: string, radix: number) => {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity;
};

const decodeHeadingText = (value: string) => value
  .replace(/<[^>]*>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeCodePoint(entity, hex, 16))
  .replace(/&#([0-9]+);/g, (entity, decimal: string) => decodeCodePoint(entity, decimal, 10))
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const headingSlug = (value: string) => decodeHeadingText(value)
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
  .replace(/\s+/g, '-');

export function addHeadingIdsToReportHtml(parsed: string): string {
  const occurrences = new Map<string, number>();
  return parsed.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (heading, level, attributes, content) => {
    if (/\sid\s*=\s*["']/i.test(attributes)) return heading;
    const base = headingSlug(content) || 'section';
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const id = occurrence === 0 ? base : `${base}-${occurrence}`;
    return `<h${level}${attributes} id="${id}">${content}</h${level}>`;
  });
}

const INTERNAL_ANCHOR_SCRIPT = `<script>
document.addEventListener('click', function (event) {
  var source = event.target;
  var anchor = source instanceof Element ? source.closest('a[href^="#"]') : null;
  if (!anchor) return;
  var href = anchor.getAttribute('href') || '';
  if (href.length <= 1) return;
  var targetId;
  try { targetId = decodeURIComponent(href.slice(1)); } catch (_) { return; }
  var target = document.getElementById(targetId);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
</script>`;

/**
 * 生成隔离的 Markdown 报告文档。
 *
 * srcDoc 的相对 hash 默认会导航到父页面 URL，导致 sandbox iframe 离开
 * about:srcdoc 并丢失正文。这里在文档内部接管有效的同页锚点，只滚动当前
 * iframe；外部链接和找不到目标的链接继续保留浏览器默认行为。
 */
export function buildMarkdownReportDocument(markdown: string, theme: Theme): string {
  const parsed = addHeadingIdsToReportHtml(marked.parse(markdown, { async: false }) as string);
  const linkColor = theme === 'dark' ? '#60a5fa' : '#2563eb';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    :root { color-scheme: ${theme}; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 1.75rem clamp(1.75rem, 6vw, 6rem); max-width: 68.75rem; margin: 0 auto; }
    pre { background: rgba(127,127,127,0.12); padding: 0.75rem; border-radius: 0.5rem; overflow: auto; }
    code { background: rgba(127,127,127,0.12); padding: 1px 0.25rem; border-radius: 0.25rem; }
    pre code { background: transparent; padding: 0; }
    table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,0.3); padding: 0.375rem 0.625rem; }
    img { max-width: 100%; height: auto; }
    a { color: ${linkColor}; }
  </style>${INTERNAL_ANCHOR_SCRIPT}</head><body>${parsed}</body></html>`;
}
