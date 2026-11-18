import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { buildApiUrl } from '@/services/real/webPages';
import type { HostedSiteCommentAnchor, HostedSiteCommentDto } from '@/services/real/webPages';

/** srcDoc remains an opaque origin. Only the public runtime enters the frame, never authentication. */
export function withAnnotationRuntime(html: string): string {
  if (!html || /data-map-artifact-mode\s*=\s*["']declarative-only["']/i.test(html)
    || /http-equiv\s*=\s*["']content-security-policy["']/i.test(html)) return html;
  html = html.replace(/<script\b[^>]*\bdata-map-annotations\s*=\s*(["'])[^"']*\1[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const url = new URL(buildApiUrl('/api/web-pages/annotation-runtime.js?v=12'), window.location.href);
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
export type AnnotationPreview = { id: string; rect: AnnotationRect; obstacles: AnnotationRect[]; markers?: AnnotationRect[] };
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
  const [displayMode, setDisplayMode] = useState<AnnotationDisplayMode>('bubble');
  const [preview, setPreview] = useState<AnnotationPreview | null>(null);
  const [previews, setPreviews] = useState<AnnotationPreview[] | null>(null);
  const [ready, setReady] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<HostedSiteCommentAnchor | null>(null);
  const [dismissedPreviewIds, setDismissedPreviewIds] = useState(new Set<string>());
  const [allPreviewsHidden, setAllPreviewsHidden] = useState(false);
  const legacyPreview = useRef<AnnotationPreview | null>(null);
  const dismissedPreviews = useRef(new Set<string>());
  const previewsHiddenRef = useRef(false), revealedPreviews = useRef(new Set<string>());
  const [threads, setThreads] = useState<HostedSiteCommentDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const nonce = useMemo(() => siteId && siteUrl ? `${crypto.randomUUID()}:${contentVersionKey ?? 'live'}` : '', [siteId, siteUrl, contentVersionKey]);
  const revealPreview = useCallback((id: string) => {
    revealedPreviews.current.add(id);
    if (legacyPreview.current?.id === id) setPreview(legacyPreview.current);
    if (dismissedPreviews.current.has(id)) {
      const next = new Set(dismissedPreviews.current); next.delete(id); dismissedPreviews.current = next; setDismissedPreviewIds(next);
    }
  }, []);
  const connected = useRef(false);
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const initRef = useRef<() => void>(() => {});
  initRef.current = () => {
    if (!siteId || !siteUrl) return;
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-init', nonce, siteId, siteUrl: new URL(siteUrl, window.location.href).href,
      previewsHidden: previewsHiddenRef.current, revealedPreviewIds: [...revealedPreviews.current], dismissedPreviewIds: [...dismissedPreviews.current],
      contentVersion: contentVersionKey ?? new URL(siteUrl, window.location.href).searchParams.get('v') ?? '', enabled, displayMode,
      threads: threads.filter(t => !t.parentId && t.anchor).map(t => ({ id: t.id, anchor: t.anchor, isResolved: t.isResolved })),
      activeId, pending: !!draftAnchor,
    }, '*');
  };
  useEffect(() => {
    connected.current = false;
    setReady(false); setEnabled(false); setDraftAnchor(null); setActiveId(null); setPreview(null); setPreviews(null);
    setMissingIds([]); setConnectionChecked(false);
    previewsHiddenRef.current = false; revealedPreviews.current.clear(); legacyPreview.current = null; setAllPreviewsHidden(false); dismissedPreviews.current = new Set(); setDismissedPreviewIds(dismissedPreviews.current);
  }, [siteId, siteUrl, contentVersionKey]);
  useEffect(() => { setThreads([]); }, [siteId]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frameRef.current?.contentWindow || !data || typeof data !== 'object'
        || data.nonce !== nonce || data.siteId !== siteId) return;
      if (data.type === 'map-annotation-ready') { connected.current = true; setReady(true); }
      if (data.type === 'map-annotation-preview' && typeof data.id === 'string' && isRect(data.rect)) {
        const next = { id: data.id, rect: data.rect, obstacles: Array.isArray(data.obstacles) ? data.obstacles.slice(0, 100).filter(isRect) : [] };
        legacyPreview.current = next;
        if (!dismissedPreviews.current.has(data.id) && (!previewsHiddenRef.current || revealedPreviews.current.has(data.id))) setPreview(next);
      }
      if (data.type === 'map-annotation-preview-hide') setPreview(null);
      if (data.type === 'map-annotation-previews' && Array.isArray(data.items)) {
        const items: AnnotationPreview[] = data.items.slice(0, 500).filter((item: AnnotationPreview) => item && typeof item.id === 'string' && isRect(item.rect) && !dismissedPreviews.current.has(item.id) && (!previewsHiddenRef.current || revealedPreviews.current.has(item.id)));
        const obstacles = Array.isArray(data.obstacles) ? data.obstacles.slice(0, 100).filter(isRect) : [];
        const markers = Array.isArray(data.markers) ? data.markers.slice(0, 100).filter(isRect) : [];
        setPreviews([...new Map(items.map(item => [item.id, { id: item.id, rect: item.rect, obstacles, markers }])).values()]);
      }
      if (data.type === 'map-annotation-preview-select' && typeof data.id === 'string') { revealPreview(data.id); setActiveId(data.id); }
      if (data.type === 'map-annotation-selected' && isAnnotationAnchor(data.anchor)) {
        setDraftAnchor(data.anchor); setActiveId(null); setEnabled(false); openRef.current();
      }
      if (data.type === 'map-annotation-activate' && typeof data.id === 'string') {
        revealPreview(data.id); setActiveId(data.id); setEnabled(false); openRef.current();
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
  }, [frameRef, nonce, siteId, revealPreview]);
  useEffect(() => { initRef.current(); }, [enabled, displayMode, threads, activeId, draftAnchor, contentVersionKey]);
  const notifyFrame = useCallback(() => { connected.current = false; setReady(false); initRef.current(); }, []);
  const select = useCallback(() => { setDraftAnchor(null); setEnabled(true); setPreview(null); setDisplayMode(mode => mode === 'hidden' ? 'standard' : mode); }, []);
  const clearDraft = useCallback(() => setDraftAnchor(null), []);
  const focus = useCallback((id: string) => {
    revealPreview(id); setActiveId(id);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-focus', siteId, nonce, id }, '*');
  }, [frameRef, siteId, nonce, revealPreview]);
  const dismissPreview = useCallback((id?: string) => {
    const targetId = id ?? legacyPreview.current?.id;
    if (targetId) {
      const next = new Set(dismissedPreviews.current).add(targetId); dismissedPreviews.current = next; setDismissedPreviewIds(next); revealedPreviews.current.delete(targetId);
    }
    setPreview(null);
    setPreviews(items => items?.filter(item => item.id !== targetId) ?? null);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-preview-dismiss', siteId, nonce, id: targetId }, '*');
  }, [frameRef, siteId, nonce]);
  const hideAllPreviews = useCallback(() => {
    previewsHiddenRef.current = true; revealedPreviews.current.clear(); setAllPreviewsHidden(true); setPreviews(items => items === null ? null : []); setPreview(null);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-previews-hide', siteId, nonce }, '*');
  }, [frameRef, siteId, nonce]);
  const showAllPreviews = useCallback(() => {
    previewsHiddenRef.current = false; revealedPreviews.current.clear(); setAllPreviewsHidden(false); dismissedPreviews.current = new Set(); setDismissedPreviewIds(dismissedPreviews.current);
    setDisplayMode('bubble'); setPreview(legacyPreview.current);
    frameRef.current?.contentWindow?.postMessage({ type: 'map-annotation-previews-show', siteId, nonce }, '*');
  }, [frameRef, siteId, nonce]);
  const openThread = useCallback((id: string) => { setActiveId(id); setEnabled(false); openRef.current(); }, []);
  return { enabled, ready, connectionChecked, displayMode, setDisplayMode, preview, previews, allPreviewsHidden, hasHiddenPreviews: allPreviewsHidden || dismissedPreviewIds.size > 0, hideAllPreviews, showAllPreviews, dismissPreview, openThread, draftAnchor, activeId, missingIds, threads,
    select, clearDraft, focus, notifyFrame, setThreads, setEnabled, setActiveId };
}

export type HostedAnnotations = ReturnType<typeof useHostedAnnotations>;
