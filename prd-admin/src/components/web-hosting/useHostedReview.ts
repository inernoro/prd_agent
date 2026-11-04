import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listHostedReviewVersions, previewHostedReviewVersion, reuploadSite,
  type HostedReviewSource, type HostedReviewVersion, type HostedSite } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { useHostedAnnotations } from './useHostedAnnotations';

type ReviewSite = { id: string; title: string; siteUrl: string; entryFile: string; contentShape?: 'self-contained-html' | 'multi-file' };
function urlVersionKey(url: string): string {
  try { const raw = new URL(url, window.location.href).searchParams.get('v'); return raw ? String(BigInt(raw) / 10000n * 10000n) : ''; }
  catch { return ''; }
}

type Preview = { revision: HostedReviewVersion; html: string; siteUrl: string | null };

/** Version selection affects only this review; uploading appends and publishes using the existing upload contract. */
export function useHostedReview(frameRef: RefObject<HTMLIFrameElement>, live: ReviewSite | null,
  source: HostedReviewSource | null, onOpen: () => void, onPublished?: (site: HostedSite) => void) {
  const authToken = useAuthStore(s => s.token);
  const [versions, setVersions] = useState<HostedReviewVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [override, setOverride] = useState<HostedSite | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const sequence = useRef(0), selectionSequence = useRef(0), mounted = useRef(true);
  const sourceRef = useRef(source); sourceRef.current = source;
  const publishedRef = useRef(onPublished); publishedRef.current = onPublished;
  const identity = source?.mode === 'share' ? `share:${source.token}:${source.password ?? ''}:${live?.id}` : `site:${live?.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const currentSite = override?.id === live?.id ? override : live;
  const published = versions.find(v => v.isCurrent);
  const selected = selectedId ? versions.find(v => v.id === selectedId) : published;
  const liveSite = currentSite ? { ...currentSite,
    siteUrl: published?.siteUrl && urlVersionKey(currentSite.siteUrl) !== published.contentVersionKey ? published.siteUrl : currentSite.siteUrl,
    entryFile: published?.entryFile ?? currentSite.entryFile, contentShape: published?.contentShape ?? currentSite.contentShape } : null;
  const historical = !!selectedId && !!selected && !selected.isCurrent;
  const selectedUrl = historical ? ((preview?.revision.id === selectedId ? preview.siteUrl : selected.siteUrl) || liveSite?.siteUrl) : liveSite?.siteUrl;
  const displaySite = liveSite ? { ...liveSite, siteUrl: selectedUrl || '',
    entryFile: historical ? selected.entryFile : liveSite.entryFile,
    contentShape: historical ? selected.contentShape : liveSite.contentShape } : null;
  const annotations = useHostedAnnotations(frameRef, displaySite, onOpen, selected?.contentVersionKey);
  const annotationsRef = useRef(annotations); annotationsRef.current = annotations;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!sourceRef.current) return;
    const request = ++sequence.current;
    setError(null);
    try {
      const result = await listHostedReviewVersions(sourceRef.current);
      if (!mounted.current || request !== sequence.current) return;
      if (result.success && Array.isArray(result.data)) setVersions(result.data);
      else setError(result.error?.message || '无法加载版本');
    } catch { if (mounted.current && request === sequence.current) setError('无法加载版本，请重试'); }
  }, []);
  useEffect(() => {
    selectionSequence.current++; setSelectedId(null); setPreview(null); setOverride(null); setVersions([]); setPendingFocus(null); setLoading(false);
    void refresh();
  }, [identity, authToken, refresh]);
  useEffect(() => { setOverride(null); void refresh(); }, [live?.siteUrl, refresh]);

  const selectVersion = useCallback(async (id: string, commentId?: string) => {
    const version = versions.find(v => v.id === id);
    if (!version || !sourceRef.current) return;
    const request = ++selectionSequence.current;
    annotationsRef.current.setEnabled(false); annotationsRef.current.clearDraft(); annotationsRef.current.setActiveId(null);
    setPendingFocus(commentId ?? null); setError(null); setSelectedId(version.isCurrent ? null : id); setPreview(null);
    if (version.isCurrent) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await previewHostedReviewVersion(sourceRef.current, id);
      if (!mounted.current || request !== selectionSequence.current) return;
      if (result.success) setPreview(result.data);
      else { setError(result.error?.message || '无法打开历史版本'); setSelectedId(null); setPendingFocus(null); }
    } catch {
      if (mounted.current && request === selectionSequence.current) { setError('无法打开历史版本，请重试'); setSelectedId(null); setPendingFocus(null); }
    } finally { if (mounted.current && request === selectionSequence.current) setLoading(false); }
  }, [versions]);
  const { ready, focus } = annotations;
  useEffect(() => {
    if (pendingFocus && ready && !loading) { focus(pendingFocus); setPendingFocus(null); }
  }, [pendingFocus, ready, focus, loading]);

  const upload = useCallback(async (file: File) => {
    if (!live || uploading) return;
    const operation = identity;
    setUploading(true); setError(null); annotationsRef.current.setEnabled(false);
    try {
      const result = await reuploadSite(live.id, file, crypto.randomUUID());
      if (!mounted.current || operation !== identityRef.current) return;
      if (!result.success) { setError(result.error?.message || '新增版本失败'); return; }
      setOverride(result.data); setSelectedId(null); setPreview(null); setPendingFocus(null);
      publishedRef.current?.(result.data); await refresh();
    } catch { if (mounted.current && operation === identityRef.current) setError('新增版本失败，请重试'); }
    finally { if (mounted.current && operation === identityRef.current) setUploading(false); }
  }, [live, uploading, identity, refresh]);

  return { versions, selected, historical, preview, site: displaySite, liveSite, annotations,
    loading, uploading, error, selectVersion, upload, refresh };
}
export type HostedReview = ReturnType<typeof useHostedReview>;
