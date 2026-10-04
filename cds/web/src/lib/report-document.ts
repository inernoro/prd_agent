import type { Theme } from '@/lib/theme';

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
export function buildMarkdownReportDocument(parsed: string, theme: Theme): string {
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
