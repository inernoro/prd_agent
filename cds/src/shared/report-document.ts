import { marked } from 'marked';
import { parse, serialize } from 'parse5';

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

const headingId = (attributes: string): string | null => {
  const match = attributes.match(/(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
};

export function addHeadingIdsToReportHtml(parsed: string): string {
  const headingPattern = /<h([1-6])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/h\1>/gi;
  const reservedIds = new Set<string>();
  for (const match of parsed.matchAll(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const id = headingId(match[0]);
    if (id !== null) reservedIds.add(id);
  }

  const occurrences = new Map<string, number>();
  return parsed.replace(headingPattern, (heading, level, attributes, content) => {
    if (headingId(attributes) !== null) return heading;
    const base = headingSlug(content) || 'section';
    let occurrence = occurrences.get(base) ?? 0;
    let id = occurrence === 0 ? base : `${base}-${occurrence}`;
    while (reservedIds.has(id)) {
      occurrence += 1;
      id = `${base}-${occurrence}`;
    }
    occurrences.set(base, occurrence + 1);
    reservedIds.add(id);
    return `<h${level}${attributes} id="${id}">${content}</h${level}>`;
  });
}

const INTERNAL_ANCHOR_SCRIPT = `<script>
document.addEventListener('click', function (event) {
  var source = event.target;
  var anchor = source instanceof Element ? source.closest('a[href^="#"]') : null;
  if (!anchor) return;
  var href = anchor.getAttribute('href') || '';
  if (href === '#') {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
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
export function buildMarkdownReportDocument(markdown: string, theme: 'light' | 'dark'): string {
  const parsed = addHeadingIdsToReportHtml(marked.parse(markdown, { async: false }) as string);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${reportReadingStyle(theme)}${INTERNAL_ANCHOR_SCRIPT}</head><body class="report-markdown">${parsed}${reportReadingScript(theme)}</body></html>`;
}

/** Readability constraints apply to content, never to the surrounding application. */
export function reportReadingStyle(theme: 'light' | 'dark'): string {
  return `<style data-report-reading>
:root{color-scheme:${theme};--report-link:${theme === 'dark' ? '#60a5fa' : '#2563eb'}}
body{overflow-wrap:anywhere}
body.report-markdown{background:Canvas;color:CanvasText;font-family:system-ui,sans-serif;line-height:1.7}
body.report-markdown{max-width:72rem;margin:0 auto;padding:1.5rem clamp(1rem,4vw,4rem);font-size:1rem}
*,*::before,*::after{box-sizing:border-box}h1,h2,h3,h4,h5,h6{overflow-wrap:anywhere;scroll-margin-top:1rem;line-height:1.4}a{color:var(--report-link);overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;padding:1rem;background:color-mix(in srgb,CanvasText 7%,Canvas);border-radius:.4rem;white-space:pre}code{font-family:ui-monospace,monospace}pre code{overflow-wrap:normal}table{border-collapse:collapse}th,td{border:1px solid color-mix(in srgb,CanvasText 25%,Canvas);padding:.5rem .75rem;text-align:left;vertical-align:top}img{max-width:100%;height:auto}figure{max-width:100%;margin-inline:0}
.report-scroll{max-width:100%;overflow:auto;overscroll-behavior-x:contain;touch-action:pan-x pan-y;margin-block:1rem}.report-scroll:focus-visible{outline:2px solid var(--report-link);outline-offset:2px}.report-scroll table{min-width:100%}.report-scroll th,.report-scroll td{min-width:8rem;max-width:32rem;overflow-wrap:anywhere}.report-scroll svg{display:block;max-width:none!important;height:auto}
.report-recovery{padding:.75rem;border:1px solid color-mix(in srgb,CanvasText 30%,Canvas);border-radius:.4rem;background:Canvas;color:CanvasText;margin-block:.5rem}.report-recovery button{font:inherit;color:inherit;background:Canvas;border:1px solid currentColor;border-radius:.3rem;padding:.35rem .7rem;cursor:pointer}.report-recovery summary{cursor:pointer}.report-diagram-status{animation:report-pulse 1.4s ease-in-out infinite}@keyframes report-pulse{50%{opacity:.5}}@media(prefers-reduced-motion:reduce){.report-diagram-status{animation:none}}
@media(max-width:40rem){body.report-markdown{padding:1rem}.report-markdown h1{font-size:1.65rem}}
</style>`;
}

export function reportReadingScript(theme: 'light' | 'dark'): string {
  return `<script data-report-reading>(()=>{
const start=()=>{
 document.querySelectorAll('table').forEach(table=>{if(table.parentElement?.classList.contains('report-scroll'))return;const wrap=document.createElement('div');wrap.className='report-scroll';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','完整表格，可左右滚动');table.before(wrap);wrap.append(table)});
 document.querySelectorAll('a[href]').forEach(a=>{const href=a.getAttribute('href')||'';if(/^(https?:|mailto:)/i.test(href)){a.target='_blank';a.rel='noopener noreferrer'}});
 document.querySelectorAll('img').forEach(img=>{
  let recovery;const failed=()=>{if(recovery)return;recovery=document.createElement('div');recovery.className='report-recovery';recovery.setAttribute('role','status');const text=document.createElement('p');text.textContent='图片未能加载：'+(img.alt||'报告图片')+'。请检查网络后重试，或联系作者补充图片。';const retry=document.createElement('button');retry.textContent='重新加载图片';retry.onclick=()=>{recovery.remove();recovery=null;const src=img.getAttribute('src');img.removeAttribute('src');if(src)img.setAttribute('src',src)};recovery.append(text,retry);img.after(recovery)};img.addEventListener('error',failed);img.addEventListener('load',()=>{recovery?.remove();recovery=null});if(img.complete&&!img.naturalWidth)failed();
 });
 const nodes=[...document.querySelectorAll('pre > code.language-mermaid,pre.mermaid,.mermaid:not(svg)')].filter(n=>!n.closest('[data-report-diagram]'));
 if(!nodes.length)return;
 let library;
 const load=()=>library||(library=new Promise((resolve,reject)=>{if(window.mermaid){resolve(window.mermaid);return}const script=document.createElement('script');script.src='/report-assets/mermaid.min.js';script.onload=()=>window.mermaid?resolve(window.mermaid):reject(new Error('library'));script.onerror=()=>{library=null;script.remove();reject(new Error('network'))};document.head.append(script)}));
 nodes.forEach((node,index)=>{const source=node.textContent||'';const host=document.createElement('section');host.dataset.reportDiagram='true';const status=document.createElement('p');status.setAttribute('role','status');const output=document.createElement('div');output.className='report-scroll';output.tabIndex=0;output.setAttribute('role','region');output.setAttribute('aria-label','完整图表，可左右滚动');const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='查看图表源代码';const pre=document.createElement('pre');pre.textContent=source;details.append(summary,pre);const retry=document.createElement('button');retry.textContent='重新渲染图表';retry.hidden=true;const recovery=document.createElement('div');recovery.className='report-recovery';recovery.append(status,retry,details);host.append(output,recovery);(node.tagName==='CODE'?node.parentElement:node).replaceWith(host);
 const render=async()=>{retry.hidden=true;status.className='report-diagram-status';status.textContent='正在渲染图表…';try{const mermaid=await load();mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'${theme === 'dark' ? 'dark' : 'default'}',suppressErrorRendering:true});const result=await mermaid.render('report-diagram-'+index+'-'+Date.now(),source);output.innerHTML=result.svg;const svg=output.querySelector('svg');if(svg){const width=svg.viewBox.baseVal.width;if(width)svg.style.width=Math.max(width,320)+'px'}status.textContent='图表已渲染，可左右滚动查看全图。';details.open=false}catch(_){output.replaceChildren();status.textContent='图表未能渲染。请检查网络后重试；若仍失败，可展开源代码并请作者检查图表语法。';details.open=true;retry.hidden=false}finally{status.className=''}};retry.onclick=render;render();
 });
};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();</script>`;
}

/** Preserve authored HTML and its styles while adding the same reading tools as Markdown. */
export function enhanceHtmlReportDocument(html: string, theme: 'light' | 'dark'): string {
  // parse5 performs no resource requests and safely handles full documents and fragments.
  const document = parse(html);
  const head = document.childNodes.find(n => 'tagName' in n && n.tagName === 'html');
  if (head && 'childNodes' in head) {
    const h = head.childNodes.find(n => 'tagName' in n && n.tagName === 'head');
    if (h && 'childNodes' in h) {
      h.childNodes = h.childNodes.filter(n => !('tagName' in n && n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv' && a.value.toLowerCase().trim() === 'refresh')));
    }
  }
  const normalized = serialize(document);
  return normalized.replace('</head>', `<meta name="viewport" content="width=device-width, initial-scale=1">${reportReadingStyle(theme)}</head>`)
    .replace('</body>', `${reportReadingScript(theme)}</body>`);
}

export function buildPublicReportShell(document: string, title: string, theme: 'light' | 'dark'): string {
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escape(title)}</title><style>:root{color-scheme:${theme}}*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText;font:1rem/1.5 system-ui,sans-serif;height:100dvh;display:flex;flex-direction:column}header{flex:none;display:flex;align-items:center;gap:.75rem;padding:.75rem max(.75rem,env(safe-area-inset-right)) .75rem max(.75rem,env(safe-area-inset-left));border-bottom:1px solid GrayText;flex-wrap:wrap}h1{font-size:1rem;margin:0;overflow-wrap:anywhere;flex:1;min-width:8rem}button,a{font:inherit;color:inherit}button{padding:.4rem .7rem;cursor:pointer}iframe{width:100%;min-height:0;flex:1;border:0;padding-bottom:env(safe-area-inset-bottom)}</style></head><body><header><button type="button" onclick="history.length>1?history.back():location.assign('/reports')">返回</button><h1>${escape(title)}</h1><a href="?theme=${theme === 'dark' ? 'light' : 'dark'}">${theme === 'dark' ? '浅色主题' : '深色主题'}</a><button type="button" onclick="location.reload()">重新加载</button></header><iframe title="${escape(title)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escape(document)}"></iframe></body></html>`;
}
