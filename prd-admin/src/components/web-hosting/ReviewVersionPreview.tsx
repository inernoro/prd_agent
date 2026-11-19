import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CircleAlert, History, RotateCcw, MessageSquare, Paperclip, Upload, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { downloadCommentFile, listShareComments, listSiteComments, type HostedReviewSource, type HostedReviewVersion, type HostedSiteCommentDto, type HostedSiteCommentFile } from '@/services/real/webPages';
import { useHostedReview, type HostedReview } from './useHostedReview';
import { useSitePreviewHtml } from './useSitePreviewHtml';
import { canUseSrcDocPreview, directPreviewSandbox, SRCDOC_PREVIEW_SANDBOX, withPreviewBase } from './previewHtml';
import { withAnnotationRuntime } from './useHostedAnnotations';
import { AnnotationBubble } from './AnnotationBubble';
import { annotationPreviewText } from './annotationPreviewText';
import CommentsSection from './CommentsSection';
import { saveBlobAsFile } from './sourceDownload';
import '@/styles/hosted-review-history.css';

type Point = { x: number; y: number };
export type ReviewHistoryPlacement = {
  trigger: RefObject<HTMLButtonElement>;
  stage?: RefObject<HTMLElement>;
  lastPosition: MutableRefObject<Point | null>;
};

type ReviewVersionPreviewProps = {
  site: NonNullable<HostedReview['liveSite']>;
  source: HostedReviewSource;
  versionId: string;
  canRestore: boolean;
  restoring: boolean;
  restoreError: string | null;
  onRestore: (key: string) => Promise<boolean>;
  onClose: () => void;
  commentId?: string;
  versions?: HostedReviewVersion[];
  onVersionChange?: (id: string) => void;
  onReturnFocus?: (event: Event) => void;
  placement?: ReviewHistoryPlacement;
  onUpload?: () => void;
  uploadError?: string | null;
  uploading?: boolean;
};

/** A separate read context keeps the current page, scroll position and drafts intact. */
export function ReviewVersionPreview(props: ReviewVersionPreviewProps) {
  return props.placement ? <ReviewHistoryWindow {...props} placement={props.placement} /> : <LegacyVersionPreview {...props} />;
}

function LegacyVersionPreview({ site, source, versionId, commentId, versions: history, onVersionChange,
  canRestore, restoring, restoreError, onRestore, onClose, onReturnFocus }: ReviewVersionPreviewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [commentsOverride, setCommentsOverride] = useState<boolean | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const showComments = commentsOverride ?? count > 0;
  const restoreKeys = useRef(new Map<string, string>());
  const review = useHostedReview(frame, site, source, () => setCommentsOverride(true));
  const { versions, selectVersion } = review;
  const selected = useRef<{ id: string; commentId?: string } | null>(null);
  useEffect(() => {
    if (!versions.some(version => version.id === versionId)) return;
    if (selected.current?.id === versionId && selected.current.commentId === commentId) return;
    selected.current = { id: versionId, commentId }; void selectVersion(versionId, commentId);
  }, [versionId, commentId, versions, selectVersion]);
  const version = versions.find(version => version.id === versionId) ?? history?.find(version => version.id === versionId);
  const previewReady = review.selected?.id === versionId && !review.loading && !!review.preview;
  const html = previewReady && review.preview?.html && review.site?.contentShape === 'self-contained-html' && canUseSrcDocPreview(review.preview.html)
    ? withAnnotationRuntime(withPreviewBase(review.preview.html, review.previewBaseUrl!)) : undefined;
  const error = review.error || restoreError;
  const restore = async () => {
    const key = restoreKeys.current.get(versionId) ?? crypto.randomUUID();
    restoreKeys.current.set(versionId, key);
    if (await onRestore(key)) onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open && !restoring) onClose(); }} title={<><History size={16} />{version?.versionLabel ?? '历史版本'} · 版本预览</>}
    onCloseAutoFocus={onReturnFocus}
    zIndex={2147483646} maxWidth={920} contentClassName="review-history-dialog" contentStyle={{ maxHeight: 'calc(100dvh - 30px)' }}
    titleAction={<button type="button" className="review-tool" aria-label="查看此版本批注" aria-expanded={previewReady && showComments} disabled={!previewReady} onClick={() => setCommentsOverride(!showComments)}><MessageSquare size={14} />批注 {previewReady && count || ''}</button>}
    content={<div className="review-history-layout">
      {history && history.length > 0 && <nav className="review-history-versions" aria-label="历史版本列表">
        {history.map(item => <button type="button" key={item.id} aria-current={item.id === versionId ? 'true' : undefined}
          disabled={restoring || (!item.isCurrent && !item.canPreview)} onClick={() => {
            if (item.isCurrent) { onClose(); return; }
            if (item.id === versionId) return;
            setConfirmVersion(null); setCommentsOverride(null); setCount(0); onVersionChange?.(item.id);
          }}>
          <span><strong>{item.versionLabel}</strong><small className={item.isCurrent ? 'is-current' : ''}>{item.isCurrent ? '当前发布' : item.canPreview ? '历史版本' : '原文不可预览'}</small></span>
          {item.publishedAt && <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}
        </button>)}
      </nav>}
      <div className="review-history-reader">
      {version && <div className="review-history-context"><strong>{version.versionLabel}</strong><span>历史预览</span></div>}
      <div className="review-version-preview">
      <div className="review-document-stage review-history-document">
      {previewReady ? <iframe ref={frame} title={`${version?.versionLabel} 网页预览`} srcDoc={html} src={html ? undefined : review.site?.siteUrl || undefined}
        sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(review.site?.siteUrl ?? '')} referrerPolicy="no-referrer" onLoad={review.annotations.notifyFrame}
        className="w-full" style={{ height: '100%', border: 0, background: 'var(--bg-elevated)' }} />
        : <div className="review-empty" role="status">{review.error ? <><p>{review.error}</p><button type="button" className="review-tool" onClick={() => { if (version) void review.selectVersion(versionId, commentId); else void review.refresh(); }}>重试预览</button></> : <><MapSpinner size={20} /><p>正在预览历史版本…</p></>}</div>}
      <AnnotationBubble annotations={review.annotations} hidden={showComments} />
      </div>
      {previewReady && <aside className="review-sidebar review-history-comments review-b-surface" hidden={!showComments}>
        <div className="review-sidebar-heading"><span>此版本批注</span><button type="button" aria-label="收起此版本批注" onClick={() => setCommentsOverride(false)}><X size={16} /></button></div>
        <div style={{ flex: 1, minHeight: 0 }}><CommentsSection visible={showComments} {...(source.mode === 'share' ? { mode: 'share', token: source.token, siteId: source.siteId, password: source.password } : { mode: 'site', siteId: source.siteId })}
          annotations={review.annotations} review={review} splitLayout versionOnly onThreadCountsChange={counts => setCount(counts.annotations + counts.discussions)} onPickElement={() => setCommentsOverride(false)} /></div>
      </aside>}
      </div>
      </div>
    </div>}
    actions={<div className="review-version-preview-actions">
      {error && <p role="alert">{error}</p>}
      {canRestore && previewReady && !version?.isCurrent && (confirmVersion === versionId ? <>
        <p>将 {version?.versionLabel} 的内容作为新版本发布。现有版本保留，旧批注仍留在原版本。</p>
        <button type="button" className="review-tool" disabled={restoring} onClick={() => setConfirmVersion(null)}>取消</button>
        <button type="button" className="review-send-action" disabled={restoring} onClick={() => void restore()}>{restoring ? <MapSpinner size={14} /> : <RotateCcw size={14} />}{restoring ? '正在恢复…' : '确认恢复并发布'}</button>
      </> : <button type="button" className="review-tool" onClick={() => setConfirmVersion(versionId)}><RotateCcw size={14} />恢复为当前版本</button>)}
      <button type="button" className="review-tool review-history-return" disabled={restoring} onClick={onClose}>返回当前页</button>
    </div>} />;
}

const historyDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const emptyHistory: HostedReviewVersion[] = [];
const emptyComments: HostedSiteCommentDto[] = [];
const historyOpinionPreviewLength = 70;

function formatHistoryDate(value: string | null | undefined) {
  const stamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? historyDate.format(stamp) : '';
}

function groupHistoryThreads(comments: HostedSiteCommentDto[], versions: HostedReviewVersion[]) {
  const versionByKey = new Map(versions.map(entry => [entry.contentVersionKey, entry]));
  const versionById = new Map(versions.map(entry => [entry.id, entry]));
  const groups = new Map<string, HostedSiteCommentDto[]>();
  for (const comment of comments) {
    if (comment.parentId) continue;
    const version = (comment.contentVersion ? versionByKey.get(comment.contentVersion) : undefined)
      ?? (comment.revisionId ? versionById.get(comment.revisionId) : undefined);
    if (!version) continue;
    const group = groups.get(version.id);
    if (group) group.push(comment);
    else groups.set(version.id, [comment]);
  }
  return groups;
}

function preferActiveAnchor(placement: ReviewHistoryPlacement) {
  const toolbar = placement.trigger.current?.closest('.review-reader-toolbar');
  const stage = placement.stage?.current?.closest('.review-document-stage')
    ?? placement.stage?.current ?? toolbar?.parentElement?.querySelector('.review-document-stage')
    ?? toolbar?.parentElement?.parentElement?.querySelector('.review-document-stage');
  return { toolbar, stage };
}

function positionHistoryWindow(position: Point): Point {
  const width = Math.min(660, window.innerWidth - 32);
  const height = Math.min(600, window.innerHeight - 80);
  return {
    x: Math.min(Math.max(position.x, 16), Math.max(16, window.innerWidth - width - 16)),
    y: Math.min(Math.max(position.y, 16), Math.max(16, window.innerHeight - height - 16)),
  };
}

function ReviewHistoryWindow({ placement, site, source, versionId, commentId, versions: initialVersions, onVersionChange,
  canRestore, restoring, restoreError, onRestore, onClose, onReturnFocus, onUpload, uploadError, uploading }: ReviewVersionPreviewProps & { placement: ReviewHistoryPlacement }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const commentList = useRef<HTMLElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const selectedRequest = useRef<{ id: string; commentId?: string }>();
  const restoreKeys = useRef(new Map<string, string>());
  const headingId = useId();
  const drag = useRef<{ id: number; origin: Point; pointer: Point }>();
  const [position, setPosition] = useState<Point>({ x: 16, y: 68 });
  const [theme, setTheme] = useState<'light' | 'dark'>();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [commentState, setCommentState] = useState<{ rows: HostedSiteCommentDto[]; status: 'loading' | 'ready' | 'error' }>({ rows: [], status: 'loading' });
  const [commentAttempt, setCommentAttempt] = useState(0);
  const [expandedOpinion, setExpandedOpinion] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<string | null>(null);
  const [failedDownload, setFailedDownload] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const review = useHostedReview(frame, site, source, () => {}, undefined, { dualColumn: true });
  const { selected, selectVersion, versions, loading } = review;
  const entries = versions.length ? versions : initialVersions ?? emptyHistory;
  const version = entries.find(entry => entry.id === versionId);
  const current = entries.find(entry => entry.isCurrent);
  const isUnarchived = !!version && !version.isCurrent && version.canPreview === false;
  const currentSite = version?.isCurrent && selected?.id === versionId && !loading && review.liveSite?.siteUrl ? {
    ...review.liveSite, shareAccess: source.mode === 'share' ? { token: source.token, password: source.password } : undefined,
  } : null;
  const currentPreview = useSitePreviewHtml(currentSite, true);
  const currentReady = !!currentSite && currentPreview.settled && !currentPreview.error;
  const snapshotReady = !isUnarchived && selected?.id === versionId && !loading && !!review.preview;
  const previewError = review.error || currentPreview.error;
  const archiveReady = !!version && !previewError && (isUnarchived || currentReady || snapshotReady);
  const confirmOpen = !!version && confirmation === version.id;
  const commentsByVersion = useMemo(() => groupHistoryThreads(commentState.rows, entries), [entries, commentState.rows]);
  const versionRows = version ? commentsByVersion.get(version.id) ?? emptyComments : emptyComments;
  const currentRows = current ? commentsByVersion.get(current.id) ?? emptyComments : emptyComments;
  const replies = useMemo(() => {
    const byParent = new Map<string, HostedSiteCommentDto[]>();
    for (const reply of commentState.rows) {
      if (!reply.parentId) continue;
      const rows = byParent.get(reply.parentId);
      if (rows) rows.push(reply);
      else byParent.set(reply.parentId, [reply]);
    }
    return byParent;
  }, [commentState.rows]);
  const restoredFrom = (entry?: HostedReviewVersion) => entry?.restoredFromRevisionId
    ? entries.find(item => item.id === entry.restoredFromRevisionId)
    : undefined;
  const eligible = canRestore && snapshotReady && !version?.isCurrent;
  const nextNumber = /^V(\d+)$/i.exec(current?.versionLabel ?? '')?.[1];
  const nextLabel = nextNumber ? `V${Number(nextNumber) + 1}` : undefined;

  const { mode } = source;
  const sharedToken = source.mode === 'share' ? source.token : undefined;
  const sharedPassword = source.mode === 'share' ? source.password : undefined;
  const sourceSite = source.siteId;
  const getAttachment = async (commentId: string, file: HostedSiteCommentFile) => {
    setFailedDownload(null);
    try {
      const { blob, fileName } = await downloadCommentFile(source, commentId, file);
      saveBlobAsFile(blob, fileName);
    } catch {
      setFailedDownload(commentId);
    }
  };
  const renderAttachments = (comment: HostedSiteCommentDto) => comment.attachments?.length ? <>
    <ul className="review-comment-files" aria-label="评论附件">
      {comment.attachments.map(file => <li key={file.index}>
        <button type="button" title={file.name} onClick={() => void getAttachment(comment.id, file)}>
          <Paperclip size={13} /><span>{file.name}</span>
        </button>
      </li>)}
    </ul>
    {failedDownload === comment.id && <p role="alert" className="review-history-window-restore-error">附件下载失败，请重试。</p>}
  </> : null;
  useEffect(() => {
    let active = true;
    setCommentState({ rows: [], status: 'loading' });
    const fetch = mode === 'share' && sharedToken
      ? listShareComments(sharedToken, sharedPassword, sourceSite)
      : listSiteComments(sourceSite ?? site.id);
    void fetch.then(result => {
      if (!active) return;
      setCommentState(result.success && Array.isArray(result.data?.comments)
        ? { rows: result.data.comments, status: 'ready' } : { rows: [], status: 'error' });
    }).catch(() => { if (active) setCommentState({ rows: [], status: 'error' }); });
    return () => { active = false; };
  }, [mode, sharedToken, sharedPassword, sourceSite, site.id, commentAttempt]);

  useEffect(() => {
    if (!versions.some(entry => entry.id === versionId)) return;
    if (selectedRequest.current?.id === versionId && selectedRequest.current.commentId === commentId) return;
    selectedRequest.current = { id: versionId, commentId };
    void selectVersion(versionId, commentId);
  }, [versions, versionId, commentId, selectVersion]);
  const { setThreads, setDisplayMode } = review.annotations;
  useEffect(() => { setDisplayMode('standard'); }, [setDisplayMode]);
  useEffect(() => { setThreads(versionRows); }, [versionRows, setThreads]);
  const selectedComment = review.annotations.activeId ?? commentId;
  useEffect(() => {
    if (!selectedComment || !archiveReady || commentState.status !== 'ready') return;
    Array.from(commentList.current?.querySelectorAll<HTMLElement>('[data-review-history-thread]') ?? [])
      .find(element => element.dataset.reviewHistoryThread === selectedComment)?.scrollIntoView({ block: 'nearest' });
  }, [archiveReady, commentState.status, selectedComment]);
  useEffect(() => {
    setShowSkeleton(false);
    if (archiveReady || previewError) return;
    const timer = window.setTimeout(() => setShowSkeleton(true), 300);
    return () => window.clearTimeout(timer);
  }, [archiveReady, previewError, versionId]);

  const { trigger, stage, lastPosition } = placement;
  useLayoutEffect(() => {
    const anchor = { trigger, stage, lastPosition };
    const { toolbar, stage: region } = preferActiveAnchor(anchor);
    const sync = () => {
      const right = region?.getBoundingClientRect().right ?? window.innerWidth;
      const top = toolbar?.getBoundingClientRect().top ?? 0;
      setPosition(positionHistoryWindow(lastPosition.current ?? { x: right - 700, y: top + 68 }));
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (region) observer.observe(region);
    if (toolbar) observer.observe(toolbar);
    window.addEventListener('resize', sync);
    return () => { observer.disconnect(); window.removeEventListener('resize', sync); };
  }, [trigger, stage, lastPosition]);
  useLayoutEffect(() => {
    const reader = trigger.current?.closest<HTMLElement>('[data-theme]');
    if (!reader) return;
    const sync = () => setTheme(reader.dataset.theme === 'light' ? 'light' : 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(reader, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [trigger]);
  useLayoutEffect(() => {
    const regions = windowRef.current?.querySelectorAll('[data-history-dismissable]');
    regions?.forEach(region => region.toggleAttribute('inert', confirmOpen));
    if (confirmOpen) cancelButton.current?.focus();
  }, [confirmOpen]);

  const retry = () => {
    if (currentPreview.error) currentPreview.retry();
    else if (version && versions.length) void selectVersion(version.id, commentId);
    else void review.refresh();
  };
  const cancel = () => {
    setConfirmation(null);
    requestAnimationFrame(() => restoreButton.current?.focus());
  };
  const restore = async () => {
    if (!version || !eligible || restoring) return;
    const key = restoreKeys.current.get(version.id) ?? crypto.randomUUID();
    restoreKeys.current.set(version.id, key);
    if (await onRestore(key)) onClose();
  };

  const snapshotHtml = snapshotReady && review.preview?.html && review.site?.contentShape === 'self-contained-html' && canUseSrcDocPreview(review.preview.html)
    ? withPreviewBase(review.preview.html, review.previewBaseUrl!) : null;
  const inlineHtml = currentReady ? currentPreview.srcDoc : snapshotHtml;
  const html = inlineHtml ? withAnnotationRuntime(inlineHtml) : undefined;
  const frameUrl = currentReady ? currentSite?.siteUrl : review.site?.siteUrl;
  let panel: ReactNode;
  if (previewError) {
    panel = <div className="review-history-window-error" role="alert">
      <span aria-hidden="true"><CircleAlert size={18} /></span>
      <strong>{version?.versionLabel ?? '历史版本'} 载入失败</strong>
      <p>暂时无法取回正文与批注。当前页面的位置和草稿仍会保留。</p>
      <button type="button" className="review-history-button" onClick={retry}><RotateCcw size={14} />重试</button>
    </div>;
  } else if (!archiveReady || !version) {
    panel = <div className="review-history-window-pending" aria-busy="true" role="status">
      <span className="sr-only">正在载入历史版本</span>
      {showSkeleton && <><header className="review-history-window-strip">正在载入 {version?.versionLabel ?? '历史版本'} 的正文与批注…</header>
        <div className="review-history-window-skeleton" aria-hidden="true">{[40, 100, 92, 76, 30, 100, 85].map((width, index) =>
          <i key={index} style={{ width: `${width}%` }} />)}</div></>}
    </div>;
  } else {
    let number = 0;
    panel = <>
      <header className="review-history-window-strip">
        你在小窗中查看 <b>{version.versionLabel}</b>{version.publishedAt && <> · {formatHistoryDate(version.publishedAt)}</>}
        {isUnarchived ? <>。<b>这个版本发布时没有归档原文</b>，无法预览当时的页面，也不能恢复。历史讨论可以照常查看。</>
          : <>。只读，当前页的位置和草稿不变。</>}
      </header>
      <div key={version.id} className="review-history-window-content" tabIndex={0}>
        {isUnarchived ? <div className="review-history-window-unarchived"><History size={16} />原文未归档</div>
          : <div className="review-history-window-frame">
            <iframe ref={frame} title={`${version.versionLabel} 网页预览`} srcDoc={html} src={html ? undefined : frameUrl || undefined}
              sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(frameUrl ?? '')}
              referrerPolicy="no-referrer" onLoad={review.annotations.notifyFrame} />
          </div>}
        <section ref={commentList} className="review-history-window-opinions" aria-label={`${version.versionLabel} 的意见`}>
          {commentState.status === 'loading' ? <p role="status">正在载入 {version.versionLabel} 的意见…</p>
            : commentState.status === 'error' ? <div className="review-history-window-comment-error" role="alert">
              <p>暂时无法读取历史意见。</p><button type="button" className="review-history-button" onClick={() => setCommentAttempt(attempt => attempt + 1)}>重试</button>
            </div>
            : <>
              <h3>{versionRows.length ? `${version.versionLabel} 的意见 · ${versionRows.length} 条（仍归 ${version.versionLabel}）` : `${version.versionLabel} 没有意见`}</h3>
              {versionRows.map(row => {
                const expanded = expandedOpinion === row.id;
                const showReplies = expandedReplies === row.id;
                const responses = replies.get(row.id);
                return <div key={row.id} className="review-history-window-comment"
                  aria-current={selectedComment === row.id ? 'true' : undefined} data-review-history-thread={row.id}>
                  <span className="review-history-note-pin">{row.anchor ? ++number : '页'}</span>
                  <div><strong>{row.authorName}</strong> <span className={expanded ? 'review-history-window-opinion-full' : undefined}>
                    {expanded ? row.content : annotationPreviewText(row.content, historyOpinionPreviewLength)}</span>
                    {row.content.length > historyOpinionPreviewLength && <button type="button" className="review-history-window-expand"
                      aria-expanded={expanded} onClick={() => setExpandedOpinion(expanded ? null : row.id)}>{expanded ? '收起' : '展开全文'}</button>}
                    {renderAttachments(row)}
                    {responses && <button type="button" className="review-history-window-expand" aria-expanded={showReplies}
                      onClick={() => setExpandedReplies(showReplies ? null : row.id)}>{responses.length} 条回复</button>}
                    {showReplies && responses && <ul className="review-history-window-replies">
                      {responses.map(reply => <li key={reply.id}><strong>{reply.authorName}</strong> {reply.content}{renderAttachments(reply)}</li>)}
                    </ul>}
                  </div>
                </div>;
              })}
            </>}
        </section>
      </div>
    </>;
  }

  return <DialogPrimitive.Root open modal={false} onOpenChange={open => { if (!open && !restoring) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content ref={windowRef} className="review-history-window" data-theme={theme} style={{ left: position.x, top: position.y }}
        aria-describedby={undefined} onCloseAutoFocus={onReturnFocus} onEscapeKeyDown={event => {
          event.preventDefault();
          if (restoring) return;
          if (confirmOpen) cancel();
          else onClose();
        }} onInteractOutside={event => { event.preventDefault(); }}>
        <div className="review-history-window-header"
          onPointerDown={event => {
            if (confirmOpen || event.button !== 0 || event.pointerType === 'touch' || window.innerWidth < 768 || (event.target as Element).closest('button')) return;
            drag.current = { id: event.pointerId, origin: position, pointer: { x: event.clientX, y: event.clientY } };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            const next = positionHistoryWindow({ x: start.origin.x + event.clientX - start.pointer.x, y: start.origin.y + event.clientY - start.pointer.y });
            lastPosition.current = next;
            setPosition(next);
          }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}>
          <History size={16} aria-hidden="true" />
          <DialogPrimitive.Title>历史版本</DialogPrimitive.Title>
          <span>正在阅读 {current?.versionLabel} · 小窗关闭后回到原位置</span>
          <DialogPrimitive.Close aria-label="关闭历史版本" className="review-history-window-close" disabled={restoring || confirmOpen}><X size={16} /></DialogPrimitive.Close>
        </div>
        <div className="review-history-window-main" data-history-dismissable>
          <nav className="review-history-window-list" aria-label="历史版本列表">
            {entries.map(entry => {
              const from = restoredFrom(entry);
              const count = commentState.status === 'ready' ? commentsByVersion.get(entry.id)?.length ?? 0 : null;
              const date = formatHistoryDate(entry.publishedAt);
              return <button key={entry.id} type="button" aria-current={versionId === entry.id ? 'true' : undefined} disabled={restoring}
                onClick={() => { if (entry.id !== versionId) { setConfirmation(null); onVersionChange?.(entry.id); } }}>
                <strong>{entry.versionLabel}</strong>
                <small data-version-status={entry.isCurrent ? 'current' : !entry.canPreview ? 'unarchived' : undefined}>
                  {entry.isCurrent ? '当前' : !entry.canPreview ? '原文未归档' : from ? `由 ${from.versionLabel} 恢复` : '历史'}
                </small>
                {(date || entry.authorName) && <span>{[date, entry.authorName].filter(Boolean).join(' · ')}</span>}
                {entry.isCurrent && from && <span>由 {from.versionLabel} 恢复</span>}
                {count !== null && <span>{count ? <><b>{count}</b> 条意见</> : '无意见'}</span>}
              </button>;
            })}
          </nav>
          <div className="review-history-window-panel">{panel}</div>
        </div>
        <footer className="review-history-window-footer" data-history-dismissable>
          <span>{uploadError ? <span role="alert" className="review-history-window-upload-error">{uploadError}</span>
            : archiveReady && (isUnarchived ? '原文未归档的版本不能恢复' : version?.historyRestricted ? '当前权限只可阅读当前版本' : version?.isCurrent ? '这是当前版本'
              : eligible ? '恢复后会发布新的当前版本' : '只读权限：如需恢复，请联系文档所有者')}</span>
          {onUpload && <button type="button" className="review-history-button review-history-upload" disabled={restoring} onClick={onUpload}
            aria-label={uploading ? '正在上传新版本' : '上传新版本'}>
            {uploading ? <MapSpinner size={14} /> : <Upload size={14} />}{uploading ? '正在上传…' : '上传新版本'}
          </button>}
          <button type="button" className="review-history-button" disabled={restoring} onClick={onClose}>{eligible ? '返回' : '返回当前页'}</button>
          {eligible && <button ref={restoreButton} type="button" className="review-history-button is-primary" disabled={restoring}
            onClick={() => setConfirmation(version?.id ?? null)}><RotateCcw size={14} />恢复此版本</button>}
        </footer>
        {confirmOpen && version && <div className="review-history-window-confirm-shade">
          <section role="alertdialog" aria-modal="true" aria-labelledby={headingId} className="review-history-window-confirm" onKeyDown={event => {
            if (event.key !== 'Tab' || restoring) return;
            event.preventDefault();
            if (document.activeElement === cancelButton.current) confirmButton.current?.focus();
            else cancelButton.current?.focus();
          }}>
            <h3 id={headingId}>恢复 {version.versionLabel} 为新的当前版本？</h3>
            <ul>
              <li>将发布{nextLabel ? <> <b>{nextLabel}</b></> : '新版本'}，正文与 {version.versionLabel} 相同。</li>
              <li>{current?.versionLabel ?? '现有版本'}仍可在历史版本中查看。</li>
              <li>{commentState.status === 'ready' ? <>{version.versionLabel} 的 {versionRows.length} 条意见与 {current?.versionLabel} 的 {currentRows.length} 条意见仍归原版本。</> : '意见仍归原版本。'}</li>
            </ul>
            {restoreError && <p className="review-history-window-restore-error" role="alert">{restoreError}</p>}
            <div>
              <button ref={cancelButton} type="button" className="review-history-button" disabled={restoring} onClick={cancel}>取消</button>
              <button ref={confirmButton} type="button" className="review-history-button is-primary" disabled={restoring} onClick={() => void restore()}>
                {restoring ? '正在发布…' : `确认恢复并发布${nextLabel ? ' ' + nextLabel : ''}`}
              </button>
            </div>
          </section>
        </div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
