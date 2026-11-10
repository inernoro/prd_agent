import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { useTheme } from '@/lib/theme';
import { reportFrameBridge } from './report-frame-bridge';

/** A pure HTML parser cannot fetch resources. Preserve document styling while removing automatic navigation. */
function withoutAutomaticNavigation(html: string): string {
  if (!/<meta[\s/]/i.test(html)) return html;
  const document = parse(html);
  let changed = false;
  const visit = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    node.childNodes = node.childNodes.filter(child => {
      const refresh = 'tagName' in child && child.tagName === 'meta'
        && child.attrs.some(attr => attr.name === 'http-equiv' && attr.value.trim().toLowerCase() === 'refresh');
      if (refresh) changed = true;
      return !refresh;
    });
    for (const child of node.childNodes) {
      if ('childNodes' in child) visit(child);
      if ('tagName' in child && child.tagName === 'template' && 'content' in child) visit(child.content);
    }
  };
  visit(document);
  return changed ? serialize(document) : html;
}

export function buildCodeReviewDocument(content: string, format: 'html' | 'md', theme: 'dark' | 'light', resizeToken?: string, rootFontSize = 16): string {
  const token = resizeToken && /^[a-f0-9-]{36}$/.test(resizeToken) ? resizeToken : undefined;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${token ? `script-src 'nonce-${token}'; ` : ''}style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`;
  const size = Number.isFinite(rootFontSize) && rootFontSize >= 8 && rootFontSize <= 32 ? rootFontSize : 16;
  const style = `<style>:root{color-scheme:${theme};font-size:${size}px}*{box-sizing:border-box}body{background:Canvas;color:CanvasText;font:1.029412rem/1.7 system-ui,sans-serif;margin:0;padding:1.470588rem 2.058824rem;overflow-wrap:anywhere}h1,h2,h3{line-height:1.5;margin:0 0 .735294rem}h1{font-size:1.470588rem}h2{font-size:1.176471rem;margin-top:1.764706rem}h3{font-size:1.029412rem;margin-top:1.470588rem}p,ul,ol,pre,table,blockquote{margin:0 0 .882353rem}ul,ol{padding-left:1.470588rem}li+li{margin-top:.147059rem}pre{padding:.882353rem;background:color-mix(in srgb,CanvasText 7%,Canvas);overflow:auto;border-radius:.441176rem}code{font:.919118rem/1.7 ui-monospace,monospace}table{max-width:100%;border-collapse:collapse;font-size:.955882rem}td,th{padding:.588235rem .882353rem;border:1px solid color-mix(in srgb,CanvasText 20%,Canvas);text-align:left}img{max-width:100%;height:auto}body>:last-child{margin-bottom:0}@media(max-width:30rem){body{padding:1.176471rem}h1{font-size:1.25rem}h2{font-size:1.0625rem}}</style>`;
  // Bootstrap before user markup, so an unfinished tag or stricter uploaded CSP cannot swallow it.
  const bridge = token ? reportFrameBridge(token) : '';
  // Original HTML keeps its own layout and styles. It is never inserted into the host DOM.
  return withoutAutomaticNavigation(format === 'html' ? `<!doctype html>${csp}${bridge}${content}`
    : `<!doctype html><html><head><meta charset="utf-8">${csp}${bridge}${style}</head><body>${marked.parse(content, { async: false, breaks: true })}</body></html>`);
}

export function ReportDocument({ content, format, title }: { content: string; format: 'html' | 'md'; title: string }): JSX.Element {
  const { theme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => crypto.randomUUID(), [content, format]);
  const [height, setHeight] = useState(400);
  const [rootSize, setRootSize] = useState(() => typeof window === 'undefined' ? 16 : parseFloat(getComputedStyle(window.document.documentElement).fontSize));
  useEffect(() => {
    const sync = (): void => setRootSize(parseFloat(getComputedStyle(window.document.documentElement).fontSize));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-ui-scale', 'style'] });
    window.addEventListener('resize', sync);
    return () => { observer.disconnect(); window.removeEventListener('resize', sync); };
  }, []);
  const document = useMemo(() => buildCodeReviewDocument(content, format, theme, token, rootSize), [content, format, theme, token, rootSize]);
  const requestHeight = (): void => frame.current?.contentWindow?.postMessage({ kind: 'cds-report-measure', token }, '*');
  useEffect(() => {
    setHeight(400);
    const resize = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || !event.data || event.data.token !== token) return;
      if (event.data.kind === 'cds-report-height') {
        const next: unknown = event.data.height;
        if (typeof next === 'number' && Number.isSafeInteger(next) && next > 0) setHeight(Math.max(160, Math.min(next, 100_000)));
        return;
      }
      const scroller = frame.current?.closest<HTMLElement>('.cds-main');
      if (!scroller) return;
      if (event.data.kind === 'cds-report-scroll') {
        const { delta, mode } = event.data;
        if (typeof delta === 'number' && Number.isFinite(delta) && [0, 1, 2].includes(mode)) {
          scroller.scrollBy({ top: Math.max(-10_000, Math.min(10_000, delta)) * (mode === 1 ? 20 : mode === 2 ? scroller.clientHeight : 1), behavior: 'instant' });
        }
      } else if (event.data.kind === 'cds-report-key') {
        const { key, shift } = event.data;
        if (key === 'Home' || key === 'End') scroller.scrollTo({ top: key === 'Home' ? 0 : scroller.scrollHeight, behavior: 'instant' });
        else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(key)) {
          scroller.scrollBy({ top: (/Up/.test(key) || key === ' ' && shift === true ? -1 : 1) * (key.startsWith('Arrow') ? 40 : scroller.clientHeight * .85), behavior: 'instant' });
        }
      }
    };
    window.addEventListener('message', resize);
    requestHeight();
    return () => window.removeEventListener('message', resize);
  }, [token]);
  return <iframe ref={frame} title={title} srcDoc={document} onLoad={requestHeight}
    sandbox="allow-scripts" referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />;
}
