import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { buildApiUrl } from '@/services/real/webPages';
import type { HostedSiteCommentAnchor, HostedSiteCommentDto } from '@/services/real/webPages';

/** srcDoc remains an opaque origin. Only the public runtime enters the frame, never authentication. */
export function withAnnotationRuntime(html: string): string {
  if (!html || /data-map-artifact-mode\s*=\s*["']declarative-only["']/i.test(html)
    || /http-equiv\s*=\s*["']content-security-policy["']/i.test(html)) return html;
  html = html.replace(/<script\b[^>]*\bdata-map-annotations\s*=\s*(["'])[^"']*\1[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const url = new URL(buildApiUrl('/api/web-pages/annotation-runtime.js?v=5'), window.location.href);
  const safeUrl = url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `${html}<script data-map-annotations="v1" src="${safeUrl}"></script>`;
}

export function isAnnotationAnchor(value: unknown): value is HostedSiteCommentAnchor {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return (a.kind === 'element' || a.kind === 'text')
    && ['pagePath', 'selector', 'tagName', 'text', 'elementText', 'prefix', 'suffix', 'contentVersion']
      .every(key => typeof a[key] === 'string')
    && (a.selector as string).length > 0 && (a.selector as string).length <= 2000
    && (a.pagePath as string).length <= 2000 && /^[a-z][a-z0-9-]*$/.test(a.tagName as string)
    && (a.text as string).length <= 1000 && (a.elementText as string).length <= 1000
    && (a.prefix as string).length <= 100 && (a.suffix as string).length <= 100;
}

export type AnnotationDisplayMode = 'hidden' | 'standard' | 'bubble';
export type AnnotationRect = { left: number; top: number; width: number; height: number };
export type AnnotationPreview = { id: string; rect: AnnotationRect; obstacles: AnnotationRect[] };
const isRect = (value: unknown): value is AnnotationRect => {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['left', 'top', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && Math.abs(rect[key] as number) < 1e7)
    && (rect.width as number) > 0 && (rect.height as number) > 0;
};

export function useHostedAnnotations(frameRef: RefObject<HTMLIFrameElement>, site: { id: string; siteUrl: string } | null,
  onOpen: () => void, contentVersionKey?: string) {
  const siteId = site?.id ?? '', siteUrl = site?.siteUrl ?? '';
  const [enabled, setEnabled] = useState(false);
  const [displayMode, setDisplayMode] = useState<AnnotationDisplayMode>('standard');
  const [preview, setPreview] = useState<AnnotationPreview | null>(null);
  const [ready, setReady] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<HostedSiteCommentAnchor | null>(null);
  const [threads, setThreads] = useState<HostedSiteCommentDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const nonce = useMemo(() => siteId && siteUrl ? `${crypto.randomUUID()}:${contentVersionKey ?? 'live'}` : '', [siteId, siteUrl, contentVersionKey]);
  const connected = useRef(false);
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const initRef = useRef<() => void>(() => {});
  initRef.current = () => {
    if (!siteId || !siteUrl) return;
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-init', nonce, siteId, siteUrl: new URL(siteUrl, window.location.href).href,
      contentVersion: contentVersionKey ?? new URL(siteUrl, window.location.href).searchParams.get('v') ?? '', enabled, displayMode,
      threads: threads.filter(t => !t.parentId && t.anchor).map(t => ({ id: t.id, anchor: t.anchor, isResolved: t.isResolved })),
      activeId, pending: !!draftAnchor,
    }, '*');
  };
  useEffect(() => {
    connected.current = false;
    setReady(false); setEnabled(false); setDraftAnchor(null); setActiveId(null); setPreview(null);
    setMissingIds([]); setConnectionChecked(false);
  }, [siteId, siteUrl, contentVersionKey]);
  useEffect(() => { setThreads([]); }, [siteId]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frameRef.current?.contentWindow || !data || typeof data !== 'object'
        || data.nonce !== nonce || data.siteId !== siteId) return;
      if (data.type === 'map-annotation-ready') { connected.current = true; setReady(true); }
      if (data.type === 'map-annotation-preview' && typeof data.id === 'string' && isRect(data.rect)) {
        setPreview({ id: data.id, rect: data.rect, obstacles: Array.isArray(data.obstacles) ? data.obstacles.slice(0, 100).filter(isRect) : [] });
      }
      if (data.type === 'map-annotation-preview-hide') setPreview(null);
      if (data.type === 'map-annotation-selected' && isAnnotationAnchor(data.anchor)) {
        setDraftAnchor(data.anchor); setActiveId(null); setEnabled(false); openRef.current();
      }
      if (data.type === 'map-annotation-activate' && typeof data.id === 'string') {
        setActiveId(data.id); setEnabled(false); openRef.current();
      }
      if (data.type === 'map-annotation-locations' && Array.isArray(data.missingIds)) {
        setMissingIds(data.missingIds.filter((id: unknown): id is string => typeof id === 'string'));
      }
      if (data.type === 'map-annotation-cancel') { setEnabled(false); openRef.current(); }
    };
    window.addEventListener('message', receive);
    initRef.current();
    const retry = window.setInterval(() => { if (!connected.current) initRef.current(); }, 800);
    const timeout = window.setTimeout(() => setConnectionChecked(true), 5000);
    return () => { window.removeEventListener('message', receive); window.clearInterval(retry); window.clearTimeout(timeout); };
  }, [frameRef, nonce, siteId]);
  useEffect(() => { initRef.current(); }, [enabled, displayMode, threads, activeId, draftAnchor, contentVersionKey]);
  const notifyFrame = useCallback(() => { connected.current = false; setReady(false); initRef.current(); }, []);
  const select = useCallback(() => { setDraftAnchor(null); setEnabled(true); setPreview(null); setDisplayMode(mode => mode === 'hidden' ? 'standard' : mode); }, []);
  const clearDraft = useCallback(() => setDraftAnchor(null), []);
  const focus = useCallback((id: string) => {
    setActiveId(id);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-focus', siteId, nonce, id }, '*');
  }, [frameRef, siteId, nonce]);
  const dismissPreview = useCallback(() => {
    setPreview(null);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-preview-dismiss', siteId, nonce }, '*');
  }, [frameRef, siteId, nonce]);
  const openThread = useCallback((id: string) => { dismissPreview(); setActiveId(id); setEnabled(false); openRef.current(); }, [dismissPreview]);
  return { enabled, ready, connectionChecked, displayMode, setDisplayMode, preview, dismissPreview, openThread, draftAnchor, activeId, missingIds, threads,
    select, clearDraft, focus, notifyFrame, setThreads, setEnabled, setActiveId };
}

export type HostedAnnotations = ReturnType<typeof useHostedAnnotations>;
