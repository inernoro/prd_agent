import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listHostedReviewVersions, previewHostedReviewVersion, reuploadSite, rollbackHostedSiteRevision,
  type HostedReviewSource, type HostedReviewVersion, type HostedSite } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { canUseSrcDocPreview } from './previewHtml';
import { useHostedAnnotations, type HostedAnnotationOptions } from './useHostedAnnotations';

type ReviewSite = { id: string; title: string; siteUrl: string; entryFile: string; contentShape?: 'self-contained-html' | 'multi-file' }
  & { wrappedAssetType?: string | null }
  & Partial<Pick<HostedSite, 'pdfAssetUrl' | 'pdfFilePaths' | 'requiresPreviewBridge'>>;
function urlVersionKey(url: string): string {
  try { const raw = new URL(url, window.location.href).searchParams.get('v'); return raw ? String(BigInt(raw) / 10000n * 10000n) : ''; }
  catch { return ''; }
}

function versionAtLeast(recorded: string, live: string) {
  try { return !live || BigInt(recorded) >= BigInt(live); }
  catch { return false; }
}

function inlineSnapshotBase(site: ReviewSite, entryFile: string) {
  const base = new URL('.', new URL(site.siteUrl, window.location.href));
  const directory = site.entryFile.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  if (directory && base.pathname.endsWith(directory + '/')) base.pathname = base.pathname.slice(0, -directory.length - 1);
  return new URL(entryFile, base).href;
}

type Preview = { revision: HostedReviewVersion; html: string; siteUrl: string | null };

/** Version selection affects only this review; uploading appends and publishes using the existing upload contract. */
export function useHostedReview(frameRef: RefObject<HTMLIFrameElement>, live: ReviewSite | null,
  source: HostedReviewSource | null, onOpen: () => void, onPublished?: (site: HostedSite) => void,
  annotationOptions?: HostedAnnotationOptions) {
  const authToken = useAuthStore(s => s.token);
  const [versions, setVersions] = useState<HostedReviewVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [override, setOverride] = useState<HostedSite | null>(null);
  const [loading, setLoading] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(!!source);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [versionPreview, updateVersionPreview] = useState<{ id: string; commentId?: string } | null>(null);
  const setVersionPreview = useCallback((next: typeof versionPreview) => {
    setRestoreError(null); updateVersionPreview(next);
  }, []);
  const sequence = useRef(0), selectionSequence = useRef(0), mounted = useRef(true);
  const sourceRef = useRef(source); sourceRef.current = source;
  const publishedRef = useRef(onPublished); publishedRef.current = onPublished;
  const identity = source?.mode === 'share' ? `share:${source.token}:${source.password ?? ''}:${live?.id}`
    : `${source ? 'site' : 'none'}:${live?.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const currentSite = override?.id === live?.id ? override : live;
  const published = versions.find(v => v.isCurrent);
  const metadataBehind = !!currentSite && !!published
    && !versionAtLeast(published.contentVersionKey, urlVersionKey(currentSite.siteUrl));
  const selected = selectedId ? versions.find(v => v.id === selectedId) : metadataBehind ? undefined : published;
  const useRecordedMetadata = !!published && !metadataBehind;
  const liveSite = currentSite ? { ...currentSite,
    siteUrl: useRecordedMetadata && published.siteUrl ? published.siteUrl : currentSite.siteUrl,
    entryFile: useRecordedMetadata ? published.entryFile : currentSite.entryFile,
    contentShape: useRecordedMetadata ? published.contentShape ?? currentSite.contentShape : currentSite.contentShape } : null;
  const historical = !!selectedId && !!selected && !selected.isCurrent;
  const selectedUrl = historical ? (preview?.revision.id === selectedId ? preview.siteUrl : selected.siteUrl) : liveSite?.siteUrl;
  const displaySite = liveSite ? { ...liveSite, siteUrl: selectedUrl || '',
    entryFile: historical ? selected.entryFile : liveSite.entryFile,
    contentShape: historical ? selected.contentShape : liveSite.contentShape,
    // Live wrapper/download metadata cannot describe an immutable HTML revision.
    ...(historical ? { wrappedAssetType: undefined, pdfAssetUrl: undefined, pdfFilePaths: undefined, requiresPreviewBridge: undefined } : {}) } : null;
  // A logical hosted address anchors inline snapshots; it is never used as their navigation fallback.
  const previewBaseUrl = historical ? selectedUrl || (liveSite ? inlineSnapshotBase(liveSite, selected.entryFile) : undefined) : liveSite?.siteUrl;
  const annotationSite = displaySite && previewBaseUrl ? { ...displaySite, siteUrl: previewBaseUrl } : null;
  const annotations = useHostedAnnotations(frameRef, metadataBehind && !selectedId ? null : annotationSite, onOpen, selected?.contentVersionKey, annotationOptions);
  const annotationsRef = useRef(annotations); annotationsRef.current = annotations;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!sourceRef.current) { setVersionsLoading(false); return; }
    setVersionsLoading(true);
    setError(null);
    try {
      const result = await listHostedReviewVersions(sourceRef.current);
      if (!mounted.current || request !== sequence.current) return;
      if (result.success && Array.isArray(result.data)) setVersions(result.data);
      else setError(result.error?.message || '无法加载版本');
    } catch { if (mounted.current && request === sequence.current) setError('无法加载版本，请重试'); }
    finally { if (mounted.current && request === sequence.current) setVersionsLoading(false); }
  }, []);
  useEffect(() => {
    selectionSequence.current++; setSelectedId(null); setPreview(null); setOverride(null); setVersions([]); setPendingFocus(null); setVersionPreview(null); setLoading(false);
    void refresh();
  }, [identity, authToken, refresh, setVersionPreview]);
  useEffect(() => { setOverride(null); void refresh(); }, [live?.siteUrl, refresh]);

  const selectVersion = useCallback(async (id: string, commentId?: string) => {
    const version = versions.find(v => v.id === id);
    if (!version || !sourceRef.current) return;
    const request = ++selectionSequence.current;
    annotationsRef.current.setEnabled(false); annotationsRef.current.clearDraft(); annotationsRef.current.setActiveId(null);
    setPendingFocus(commentId ?? null); setError(null); setSelectedId(version.isCurrent ? null : id); setPreview(null);
    // Unarchived publications still have their own discussion scope. Do not
    // ask the snapshot endpoint to serve a document it has marked unavailable.
    if (version.isCurrent || version.canPreview === false) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await previewHostedReviewVersion(sourceRef.current, id);
      if (!mounted.current || request !== selectionSequence.current) return;
      if (result.success) {
        if (!result.data.siteUrl && (!result.data.html || result.data.revision.contentShape !== 'self-contained-html' || !canUseSrcDocPreview(result.data.html))) {
          setError('这份历史版本暂时无法预览，请重试或选择其他版本'); setSelectedId(null); setPendingFocus(null);
        } else setPreview(result.data);
      }
      else { setError(result.error?.message || '无法打开历史版本'); setSelectedId(null); setPendingFocus(null); }
    } catch {
      if (mounted.current && request === selectionSequence.current) { setError('无法打开历史版本，请重试'); setSelectedId(null); setPendingFocus(null); }
    } finally { if (mounted.current && request === selectionSequence.current) setLoading(false); }
  }, [versions]);
  const { ready, focus, threads } = annotations;
  useEffect(() => {
    if (pendingFocus && ready && !loading && threads.some(thread => thread.id === pendingFocus)) { focus(pendingFocus); setPendingFocus(null); }
  }, [pendingFocus, ready, focus, loading, threads]);

  const upload = useCallback(async (file: File) => {
    if (!live || uploading) return false;
    const operation = identity;
    setUploading(true); setError(null); annotationsRef.current.setEnabled(false);
    try {
      const result = await reuploadSite(live.id, file, crypto.randomUUID());
      if (!mounted.current || operation !== identityRef.current) return false;
      if (!result.success) { setError(result.error?.message || '新增版本失败'); return false; }
      setOverride(result.data); setSelectedId(null); setPreview(null); setPendingFocus(null);
      publishedRef.current?.(result.data); await refresh(); return true;
    } catch {
      if (mounted.current && operation === identityRef.current) setError('新增版本失败，请重试');
      return false;
    }
    finally { if (mounted.current && operation === identityRef.current) setUploading(false); }
  }, [live, uploading, identity, refresh]);

  const restoreVersion = useCallback(async (id: string, idempotencyKey: string) => {
    if (!live || uploading) return false;
    const version = versions.find(version => version.id === id);
    if (!version || version.isCurrent || !version.canPreview) return false;
    const operation = identity;
    setUploading(true); setError(null); setRestoreError(null);
    try {
      const result = await rollbackHostedSiteRevision(live.id, id, idempotencyKey);
      if (!mounted.current || operation !== identityRef.current) return false;
      if (!result.success) { setRestoreError(result.error?.message || '恢复未完成，请重试'); return false; }
      selectionSequence.current++; setOverride(result.data.site); setSelectedId(null); setPreview(null); setPendingFocus(null);
      publishedRef.current?.(result.data.site); await refresh(); return true;
    } catch {
      if (mounted.current && operation === identityRef.current) setRestoreError('恢复结果尚未确认，请刷新版本列表核对或重试');
      return false;
    } finally { if (mounted.current && operation === identityRef.current) setUploading(false); }
  }, [live, uploading, versions, identity, refresh]);

  return { source, versions, selected, historical, preview, versionPreview, setVersionPreview, previewBaseUrl, site: displaySite, liveSite, annotations,
    loading: loading || (!selectedId && (metadataBehind || (versionsLoading && !published))), uploading, error, restoreError, selectVersion, upload, restoreVersion, refresh };
}
export type HostedReview = ReturnType<typeof useHostedReview>;
