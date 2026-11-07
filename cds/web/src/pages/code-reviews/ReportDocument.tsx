import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { useTheme } from '@/lib/theme';

export function buildCodeReviewDocument(content: string, format: 'html' | 'md', theme: 'dark' | 'light', resizeToken?: string): string {
  const token = resizeToken && /^[a-f0-9-]{36}$/.test(resizeToken) ? resizeToken : undefined;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${token ? `script-src 'nonce-${token}'; ` : ''}style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`;
  const style = `<style>:root{color-scheme:${theme}}*{box-sizing:border-box}body{background:Canvas;color:CanvasText;font:.875rem/1.75 system-ui,sans-serif;margin:0;padding:1.5rem;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4}h1{font-size:1.5rem}h2{font-size:1.125rem;margin-top:1.75rem}pre{padding:1rem;background:color-mix(in srgb,CanvasText 7%,Canvas);overflow:auto;border-radius:.375rem}code{font:.75rem/1.7 ui-monospace,monospace}table{max-width:100%;border-collapse:collapse;font-size:.8125rem}td,th{padding:.5rem .75rem;border:1px solid color-mix(in srgb,CanvasText 20%,Canvas);text-align:left}img{max-width:100%;height:auto}</style>`;
  // Original HTML keeps its own layout and styles. It is never inserted into the host DOM.
  const document = format === 'html' ? `<!doctype html>${csp}${content}`
    : `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${marked.parse(content, { async: false })}</body></html>`;
  if (!token) return document;
  // Only this nonce-bearing script may execute, inside an opaque-origin sandbox.
  // Uploaded scripts, event attributes, requests and forms remain forbidden by CSP.
  return `${document}<script nonce="${token}">(()=>{const send=()=>parent.postMessage({kind:'cds-report-height',token:'${token}',height:Math.ceil((document.body||document.documentElement).scrollHeight)},'*');new ResizeObserver(send).observe(document.body||document.documentElement);addEventListener('load',send);requestAnimationFrame(send)})()</script>`;
}

export function ReportDocument({ content, format, title }: { content: string; format: 'html' | 'md'; title: string }): JSX.Element {
  const { theme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => crypto.randomUUID(), [content, format]);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    setHeight(400);
    const resize = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || !event.data || event.data.kind !== 'cds-report-height' || event.data.token !== token) return;
      const next: unknown = event.data.height;
      if (typeof next === 'number' && Number.isSafeInteger(next) && next > 0) setHeight(Math.max(160, Math.min(next, 100_000)));
    };
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  }, [token]);
  return <iframe ref={frame} title={title} srcDoc={buildCodeReviewDocument(content, format, theme, token)}
    sandbox="allow-scripts" referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />;
}
