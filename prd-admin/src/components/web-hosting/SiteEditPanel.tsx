import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Eye, History, ImagePlus, RefreshCw, RotateCcw, Send, Server, ShieldCheck, Square, WandSparkles, X } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import KnowledgeEntryPicker from '@/components/knowledge/KnowledgeEntryPicker';
import type { HostedSite, HostedSiteRevision } from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  DESIGN_PREVIEW_EVENT_SANDBOX,
  VERIFIED_PACKAGE_PREVIEW_SANDBOX,
  canPublishRevision,
  revisionChangeSummary,
  revisionLabel,
  runningGenerationActivity,
} from './siteEditPreview';
import { runProvenanceText } from './siteGenerateProgress';
import {
  DESIGN_ATTACHMENT_ACCEPT,
  MAX_EDIT_SCREENSHOTS,
} from './designAttachments';
import {
  GENERATION_STAGES,
  createRevisionMutationIdempotencyKey,
  formatRevisionTime,
  restoreRevisionMutationFocus,
  siteEditStageState,
  useSiteEditSession,
} from './workbench/useSiteEditSession';

export {
  createRevisionMutationIdempotencyKey,
  restoreRevisionMutationFocus,
  revisionHistoryErrorMessage,
  siteEditDisplayProgress,
  siteEditStageState,
} from './workbench/useSiteEditSession';


interface Props {
  site: HostedSite;
  onPublished: (site: HostedSite) => void;
  /** 由卡片或预览顶栏决定先看修改输入还是版本历史。 */
  focusSection?: 'compose' | 'history';
}

export default function SiteEditPanel({ site, onPublished, focusSection = 'compose' }: Props) {
  const {
    instruction,
    setInstruction,
    phase,
    progress,
    elapsedSeconds,
    resolvedModel,
    thinking,
    previewHtml,
    previewUrl,
    previewedRevision,
    draftRevisionId,
    draftRevisionStatus,
    revisions,
    loadingHistory,
    historyError,
    generating,
    mutatingId,
    mutatingAction,
    recentKnowledge,
    selectedKnowledge,
    setSelectedKnowledge,
    loadingKnowledge,
    capabilities,
    selectedRuntime,
    setSelectedRuntime,
    screenshots,
    previewFromEvent,
    runInfo,
    activeRunId,
    stopRequested,
    recoveryNotice,
    setRecoveryNotice,
    runtimeRecoveryGate,
    setRuntimeRecoveryGate,
    enabledRuntimes,
    activeRuntime,
    unavailableRuntimes,
    activeRuntimeFact,
    runtimeFallback,
    screenshotsSupported,
    addScreenshots,
    generationStageIndex,
    loadHistory,
    openRevision,
    generate,
    stopGeneration,
    publish,
    rollback,
    reject,
    retryRecovery,
  } = useSiteEditSession(site, { onPublished });
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingRollback, setPendingRollback] = useState<HostedSiteRevision | null>(null);
  const [pendingReject, setPendingReject] = useState<HostedSiteRevision | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const composeRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLElement | null>(null);
  // 点了「生成修改草稿」之后，进度区在表单下方、首屏之外；不带过去，用户看到的只有一个「停止生成」按钮，
  // 以为什么都没发生。开始执行时把进度区滚进视野。
  useEffect(() => {
    if (!generating) return;
    const frame = requestAnimationFrame(() => {
      progressRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [generating]);
  const rollbackConfirmRef = useRef<HTMLButtonElement | null>(null);
  const rollbackReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const rejectReasonRef = useRef<HTMLTextAreaElement | null>(null);
  const rejectReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const target = focusSection === 'history' ? historyRef.current : composeRef.current;
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSection]);

  useEffect(() => {
    if (!pendingRollback) return;
    const frame = window.requestAnimationFrame(() => rollbackConfirmRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRollback]);

  useEffect(() => {
    if (!pendingReject) return;
    const frame = window.requestAnimationFrame(() => rejectReasonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pendingReject]);
  const requestRollback = (revision: HostedSiteRevision, trigger: HTMLButtonElement) => {
    rollbackReturnFocusRef.current = trigger;
    setRecoveryNotice(null);
    setPendingReject(null);
    setPendingRollback(revision);
  };

  const cancelRollback = () => {
    setPendingRollback(null);
    window.requestAnimationFrame(() => rollbackReturnFocusRef.current?.focus());
  };

  const confirmRollback = () => {
    if (!pendingRollback) return;
    const revisionId = pendingRollback.id;
    const idempotencyKey = createRevisionMutationIdempotencyKey();
    setPendingRollback(null);
    void rollback(revisionId, idempotencyKey)
      .finally(() => restoreRevisionMutationFocus(
        rollbackReturnFocusRef.current,
        historyRef.current,
      ));
  };

  const requestReject = (revision: HostedSiteRevision, trigger: HTMLButtonElement) => {
    rejectReturnFocusRef.current = trigger;
    setRecoveryNotice(null);
    setPendingRollback(null);
    setRejectionReason('');
    setPendingReject(revision);
  };

  const cancelReject = () => {
    setPendingReject(null);
    setRejectionReason('');
    window.requestAnimationFrame(() => rejectReturnFocusRef.current?.focus());
  };

  const confirmReject = () => {
    if (!pendingReject) return;
    const revisionId = pendingReject.id;
    const reason = rejectionReason;
    setPendingReject(null);
    setRejectionReason('');
    void reject(revisionId, reason)
      .finally(() => restoreRevisionMutationFocus(
        rejectReturnFocusRef.current,
        historyRef.current,
      ));
  };


  const adjustFailedGeneration = () => {
    setRecoveryNotice(null);
    setRuntimeRecoveryGate(null);
    composeRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    window.requestAnimationFrame(() => document.getElementById(`site-edit-instruction-${site.id}`)?.focus());
  };

  const recoveryActionLabel = recoveryNotice?.action === 'history'
    ? '刷新版本记录'
    : recoveryNotice?.action === 'preview'
      ? '重新预览'
      : recoveryNotice?.action === 'publish'
        ? '重试发布'
        : recoveryNotice?.action === 'rollback'
          ? '重试回退'
          : recoveryNotice?.action === 'reject'
            ? '重试拒绝草稿'
          : runtimeRecoveryGate
            ? `正在回收运行环境，已检查 ${runtimeRecoveryGate.checks + 1} 次`
            : '按原要求重试';

  const recoverFromVersionConflict = (action: 'refresh' | 'regenerate') => {
    if (action === 'refresh') {
      setRecoveryNotice(null);
      void loadHistory();
      historyRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    composeRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (!instruction.trim()) {
      setRecoveryNotice({
        title: '请确认原修改要求',
        detail: '该版本没有可复用的修改要求。请在下方输入框补充后生成新草稿，当前线上版本没有变化。',
        action: 'generate',
      });
      window.requestAnimationFrame(() => document.getElementById(`site-edit-instruction-${site.id}`)?.focus());
      return;
    }
    setRecoveryNotice(null);
    void generate();
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-token-primary">
      {recoveryNotice && (
        <div role="alert" className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-token-primary">{recoveryNotice.title}</div>
              <p className="mt-1 text-[11px] leading-relaxed text-token-secondary">{recoveryNotice.detail}</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {recoveryNotice.versionConflict ? (
              <>
                <button
                  type="button"
                  onClick={() => recoverFromVersionConflict('refresh')}
                  disabled={loadingHistory || mutatingId !== null}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 text-[11px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <RefreshCw size={13} />刷新版本记录
                </button>
                <button
                  type="button"
                  onClick={() => recoverFromVersionConflict('regenerate')}
                  disabled={generating || mutatingId !== null}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg border border-amber-500/40 px-3 text-[11px] font-semibold text-token-primary hover:bg-amber-500/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  按原要求另存新草稿
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={retryRecovery}
                  disabled={generating || mutatingId !== null || runtimeRecoveryGate !== null}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 text-[11px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <RefreshCw size={13} className={runtimeRecoveryGate ? 'animate-spin' : ''} />{recoveryActionLabel}
                </button>
                {recoveryNotice.action === 'generate' && (
                  <button
                    type="button"
                    onClick={adjustFailedGeneration}
                    disabled={generating || mutatingId !== null}
                    className="inline-flex min-h-11 items-center justify-center rounded-lg border border-amber-500/40 px-3 text-[11px] font-semibold text-token-primary hover:bg-amber-500/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    调整要求或切换执行器
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => historyRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-[11px] font-medium text-token-secondary hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  查看版本记录
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {pendingRollback && (
        <div
          id={`rollback-confirm-${pendingRollback.id}`}
          role="alertdialog"
          aria-labelledby={`rollback-confirm-title-${pendingRollback.id}`}
          aria-describedby={`rollback-confirm-detail-${pendingRollback.id}`}
          className="shrink-0 border-b border-blue-500/40 bg-blue-500/10 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancelRollback();
          }}
        >
          <div id={`rollback-confirm-title-${pendingRollback.id}`} className="text-xs font-semibold text-token-primary">
            确认回退到 {revisionLabel(pendingRollback)}
          </div>
          <p id={`rollback-confirm-detail-${pendingRollback.id}`} className="mt-1 text-[11px] leading-relaxed text-token-secondary">
            目标版本：{revisionLabel(pendingRollback)} · {pendingRollback.id.slice(-6)}。确认后访客看到的线上页面会立即替换为该版本内容；系统会复制内容并创建一个可恢复的新版本，现有版本和历史记录都不会删除。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              ref={rollbackConfirmRef}
              type="button"
              onClick={confirmRollback}
              disabled={mutatingId !== null}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <RotateCcw size={13} />确认回退
            </button>
            <button
              type="button"
              onClick={cancelRollback}
              disabled={mutatingId !== null}
              className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-[11px] font-medium text-token-secondary hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {pendingReject && (
        <div
          id={`reject-confirm-${pendingReject.id}`}
          role="alertdialog"
          aria-labelledby={`reject-confirm-title-${pendingReject.id}`}
          aria-describedby={`reject-confirm-detail-${pendingReject.id}`}
          className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancelReject();
          }}
        >
          <div id={`reject-confirm-title-${pendingReject.id}`} className="text-xs font-semibold text-token-primary">
            确认拒绝这个草稿
          </div>
          <p id={`reject-confirm-detail-${pendingReject.id}`} className="mt-1 text-[11px] leading-relaxed text-token-secondary">
            拒绝后该草稿不能再发布，但版本记录会保留，访客看到的线上页面不会变化。
          </p>
          <label
            htmlFor={`reject-reason-${pendingReject.id}`}
            className="mt-2 block text-[11px] font-medium text-token-secondary"
          >
            拒绝原因（选填，最多 500 字）
          </label>
          <textarea
            ref={rejectReasonRef}
            id={`reject-reason-${pendingReject.id}`}
            value={rejectionReason}
            maxLength={500}
            rows={2}
            onChange={(event) => setRejectionReason(event.target.value)}
            placeholder="例如：版式方向不符合本次要求"
            className="mt-1 w-full resize-y rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary outline-none placeholder:text-token-muted focus:border-rose-500"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmReject}
              disabled={mutatingId !== null}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              <X size={13} />确认拒绝
            </button>
            <button
              type="button"
              onClick={cancelReject}
              disabled={mutatingId !== null}
              className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-[11px] font-medium text-token-secondary hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div
          ref={composeRef}
          tabIndex={-1}
          data-dialog-initial-focus={focusSection === 'compose' ? 'true' : undefined}
          className="scroll-mt-2 border-b border-token-subtle p-3 outline-none sm:p-4"
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            <WandSparkles size={16} />
            帮我修改
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
            先生成隔离草稿，再由你预览并发布。未点击发布前，访客看到的线上页面不会变化。
          </p>

          <ol aria-label="版本发布流程" className="mt-3 grid grid-cols-3 overflow-hidden rounded-lg border border-token-subtle bg-token-nested">
            {[
              ['1', '生成草稿', '线上不变'],
              ['2', '人工预览', '确认效果'],
              ['3', '发布上线', '保留历史'],
            ].map(([number, label, hint], index) => (
              <li key={label} className={`min-w-0 px-2 py-2 ${index > 0 ? 'border-l border-token-subtle' : ''}`}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-token-primary">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/15 text-blue-500">{number}</span>
                  <span className="truncate">{label}</span>
                </div>
                <p className="mt-1 truncate pl-6 text-[10px] text-token-muted">{hint}</p>
              </li>
            ))}
          </ol>

          {enabledRuntimes.length > 1 && (
            <select
              value={selectedRuntime}
              onChange={(event) => setSelectedRuntime(event.target.value)}
              disabled={generating}
              aria-label="页面修改执行器"
              className="mt-3 min-h-11 w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-base text-token-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-xs"
            >
              {enabledRuntimes.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          )}
          {runtimeFallback && (
            <p className="mt-2 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>
              {runtimeFallback}
            </p>
          )}
          {capabilities.length > 0 && (
            <details className="group mt-3 rounded-lg border border-token-subtle bg-token-nested text-[10px] leading-relaxed text-token-muted">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 font-medium text-token-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
                <span className="flex items-center gap-1.5"><Server size={12} />执行器与限制</span>
                <span className="max-w-36 truncate font-normal text-token-muted">{activeRuntime?.label || '当前执行器'}</span>
              </summary>
              <div className="border-t border-token-subtle px-2.5 pb-2.5 pt-2">
                <p>{activeRuntimeFact}</p>
                <p className="mt-1">
                  完整工作区会原样保留；只有清单和哈希一致的包内脚本、样式与图片可以运行，包外资源会被拒绝。
                </p>
                {unavailableRuntimes.length > 0 && (
                  <p className="mt-1">
                    {unavailableRuntimes.map((item) => `${item.label}：${item.reason || '未启用'}`).join('；')}
                  </p>
                )}
              </div>
            </details>
          )}
          <label htmlFor={`site-edit-instruction-${site.id}`} className="mt-3 block text-[11px] font-medium text-token-secondary">
            修改要求
          </label>
          <textarea
            id={`site-edit-instruction-${site.id}`}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={generating}
            maxLength={4000}
            rows={4}
            placeholder="例如：把首屏标题改得更直接，主按钮换成“立即体验”，保留其余内容不变。"
            className="mt-1.5 w-full resize-none rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-base leading-relaxed text-token-primary outline-none focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 sm:text-xs"
          />
          <div className="mt-3 rounded-lg border border-token-subtle bg-token-nested p-2.5">
            <KnowledgeEntryPicker
              recentEntries={recentKnowledge}
              selectedEntries={selectedKnowledge}
              onChange={setSelectedKnowledge}
              loadingRecent={loadingKnowledge}
              disabled={generating}
              compact
            />
          </div>
          <div className="mt-3 rounded-lg border border-token-subtle bg-token-nested p-2.5">
            <div className="flex items-center justify-between gap-2 text-[11px] text-token-primary">
              <span className="flex items-center gap-1.5 font-medium"><ImagePlus size={13} />附上截图</span>
              <span className="text-token-muted">{screenshots.items.length}/{MAX_EDIT_SCREENSHOTS}</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-token-muted">
              {screenshotsSupported
                ? '把有问题的地方截图圈出来，执行器会对照截图修改；也可以直接在这里粘贴截图。'
                : '截图需要精细设计（OpenDesign）：当前是快速修改，截图不会随这次修改提交。在上方切换执行器后可用。'}
            </p>
            <div
              className="mt-2 flex flex-wrap gap-2"
              style={{ opacity: screenshotsSupported ? 1 : 0.5 }}
              onPaste={(event) => {
                if (!screenshotsSupported) return;
                const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
                if (files.length === 0) return;
                event.preventDefault();
                addScreenshots(files);
              }}
            >
              {screenshots.items.map((item) => (
                <div
                  key={item.key}
                  className="relative h-16 w-24 overflow-hidden rounded-md border border-token-subtle bg-token-card"
                  title={item.status === 'failed' ? item.error : item.fileName}
                >
                  {item.thumbnailUrl && <img src={item.thumbnailUrl} alt={item.fileName} className="h-full w-full object-cover" />}
                  {item.status !== 'ready' && (
                    <span
                      className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[10px]"
                      style={{
                        background: 'var(--scrim-badge-bg)',
                        color: item.status === 'failed' ? 'var(--semantic-danger-text)' : 'var(--text-primary)',
                      }}
                    >
                      {item.status === 'uploading' ? `${item.progress}%` : item.status === 'reading' ? '保存中' : '失败'}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`删除截图 ${item.fileName}`}
                    disabled={generating}
                    onClick={() => screenshots.remove(item.key)}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-40"
                    style={{ background: 'var(--scrim-badge-bg)', color: 'var(--text-primary)' }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              {screenshots.items.length < MAX_EDIT_SCREENSHOTS && (
                <button
                  type="button"
                  disabled={generating || !screenshotsSupported}
                  title={screenshotsSupported ? undefined : '截图需要精细设计'}
                  onClick={() => screenshotInputRef.current?.click()}
                  className="flex h-16 w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-token-subtle text-[10px] text-token-muted transition-colors hover-bg-soft disabled:opacity-50"
                >
                  <ImagePlus size={15} />
                  添加截图
                </button>
              )}
              <input
                ref={screenshotInputRef}
                type="file"
                multiple
                accept={DESIGN_ATTACHMENT_ACCEPT.image}
                className="hidden"
                onChange={(event) => {
                  addScreenshots(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </div>
          </div>
          {generating ? (
            <button
              type="button"
              onClick={() => void stopGeneration()}
              disabled={!activeRunId || stopRequested}
              className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs font-medium text-rose-500 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              {stopRequested ? <MapSpinner size={14} /> : <Square size={13} fill="currentColor" />}
              {stopRequested ? '正在停止，线上未改变' : '停止生成'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={instruction.trim().length === 0}
              className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Send size={14} />
              生成修改草稿
            </button>
          )}
        </div>

        {(generating || previewHtml) && (
          <section
            ref={progressRef}
            aria-label="AI 修改进度"
            className="border-b border-token-subtle p-3 sm:p-4"
          >
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-token-primary">
                    {generating ? 'AI 正在生成隔离草稿' : recoveryNotice ? '未完成的草稿预览' : '版本预览已就绪'}
                  </div>
                  <span role="status" aria-live="polite" className="sr-only">{phase}</span>
                  {resolvedModel && (
                    <p className="mt-1 font-mono text-[11px] text-token-muted">
                      {/* ai-model-visibility：换了模型结果就会不同，所以摆在这一块最上面，不藏进折叠区。 */}
                      <span aria-hidden="true">●</span> {resolvedModel.model} · {resolvedModel.platform}
                    </p>
                  )}
                  {runProvenanceText(runInfo) && (
                    <p className="mt-1 text-[11px] text-token-muted">{runProvenanceText(runInfo)}</p>
                  )}
                  <p aria-hidden="true" className="mt-1 text-[11px] leading-relaxed text-token-muted">
                    {generating ? runningGenerationActivity(phase, elapsedSeconds) : phase}
                  </p>
                </div>
                <div className="shrink-0 text-right text-[10px] text-token-muted">
                  <div className="max-w-28 truncate text-token-secondary">{activeRuntime?.label || '设计执行器'}</div>
                  <div className="mt-0.5 tabular-nums">{generating ? '任务运行中' : `${progress}% · ${elapsedSeconds} 秒`}</div>
                </div>
              </div>

              <ol className="mt-3 grid grid-cols-4 gap-1" aria-label="草稿生成阶段">
                {GENERATION_STAGES.map((item, index) => {
                  const { complete, current } = siteEditStageState(
                    index,
                    generationStageIndex,
                    generating,
                    progress,
                  );
                  return (
                    <li key={item.label} aria-current={current ? 'step' : undefined} className="min-w-0 text-center">
                      <span className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold ${complete ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500' : current ? 'border-blue-500 bg-blue-500/15 text-blue-500' : 'border-token-subtle bg-token-nested text-token-muted'}`}>
                        {complete ? <Check size={12} /> : index + 1}
                      </span>
                      <span className={`mt-1 block truncate text-[9px] ${current ? 'font-semibold text-token-primary' : 'text-token-muted'}`}>{item.label}</span>
                    </li>
                  );
                })}
              </ol>

              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-token-card"
                role="progressbar"
                aria-label="草稿生成进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={generating ? undefined : progress}
                aria-valuetext={generating ? '任务正在执行' : `${progress}%`}
              >
                <div
                  className={generating
                    ? 'h-full w-1/3 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none'
                    : 'h-full bg-blue-500 transition-all duration-300 motion-reduce:transition-none'}
                  style={generating ? undefined : { width: `${progress}%` }}
                />
              </div>
              {thinking && generating && (
                <div className="mt-2 rounded-lg bg-token-nested px-2.5 py-2 text-[10px] leading-relaxed text-token-muted">
                  <span className="font-medium text-token-secondary">正在分析：</span>{thinking}
                </div>
              )}
            </div>

            {generating && !previewHtml && (
              <div
                data-testid="safe-preview-placeholder"
                role="status"
                aria-live="polite"
                className="mt-3 overflow-hidden rounded-lg border border-blue-500/25 bg-token-nested"
              >
                <div className="flex min-h-12 items-center justify-between gap-3 border-b border-token-subtle px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      <ShieldCheck size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-token-primary">正在验证页面结构</div>
                      <div className="mt-0.5 truncate text-[10px] text-token-muted">验证完成后显示真实页面</div>
                    </div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/5 px-2 py-1 text-[10px] text-blue-500">
                    <MapSpinner size={11} />
                    {GENERATION_STAGES[generationStageIndex]?.label || '准备'}
                  </span>
                </div>
                <div className="relative aspect-[16/9] min-h-44 overflow-hidden bg-token-card p-4" aria-hidden="true">
                  <div className="flex h-full flex-col overflow-hidden rounded-lg border border-token-subtle bg-token-nested opacity-80">
                    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-token-subtle px-2.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-token-muted/40" />
                      <span className="h-1.5 w-1.5 rounded-full bg-token-muted/30" />
                      <span className="h-1.5 w-1.5 rounded-full bg-token-muted/20" />
                    </div>
                    <div className="grid flex-1 grid-cols-[minmax(0,1fr)_28%] gap-3 p-3">
                      <div className="flex flex-col gap-2">
                        <div className="h-3 w-2/3 animate-pulse rounded bg-blue-500/20 motion-reduce:animate-none" />
                        <div className="h-2 w-full rounded bg-token-muted/15" />
                        <div className="h-2 w-5/6 rounded bg-token-muted/15" />
                        <div className="mt-auto h-7 w-24 rounded-md bg-blue-500/15" />
                      </div>
                      <div className="animate-pulse rounded-md border border-blue-500/15 bg-blue-500/5 motion-reduce:animate-none" />
                    </div>
                  </div>
                  <div className="pointer-events-none absolute inset-x-4 bottom-4 h-px animate-pulse bg-gradient-to-r from-transparent via-blue-500/70 to-transparent motion-reduce:animate-none" />
                </div>
              </div>
            )}

            {previewHtml ? (
              <div className="mt-3 overflow-hidden rounded-lg border border-token-subtle">
              <div className="flex min-h-12 items-center justify-between gap-2 bg-token-nested px-2.5 py-1.5 text-[11px] text-token-muted">
                <div className="min-w-0">
                  <span className="flex items-center gap-1 font-medium text-token-primary">
                    <Eye size={12} />{previewedRevision ? revisionLabel(previewedRevision) : '安全预览'}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px]">当前仅预览，线上内容不会因此改变</span>
                </div>
                {draftRevisionId && (
                  <div className="flex shrink-0 items-center gap-1">
                    {draftRevisionStatus === 'draft' && previewedRevision && (
                      <button
                        type="button"
                        title="拒绝这个草稿"
                        aria-label="拒绝这个草稿"
                        aria-haspopup="dialog"
                        aria-expanded={pendingReject?.id === draftRevisionId}
                        aria-controls={pendingReject?.id === draftRevisionId ? `reject-confirm-${draftRevisionId}` : undefined}
                        disabled={mutatingId === draftRevisionId}
                        onClick={(event) => requestReject(previewedRevision, event.currentTarget)}
                        className="flex min-h-11 items-center gap-1 rounded-md px-2.5 font-medium text-rose-500 hover:bg-rose-500/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                      >
                        {mutatingId === draftRevisionId && mutatingAction === 'reject'
                          ? <MapSpinner size={12} />
                          : <X size={12} />}
                        拒绝
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={mutatingId === draftRevisionId}
                      onClick={() => void publish(draftRevisionId)}
                      className="flex min-h-11 items-center gap-1 rounded-md bg-emerald-600 px-3 font-medium text-white hover:bg-emerald-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      {mutatingId === draftRevisionId && mutatingAction === 'publish'
                        ? <MapSpinner size={12} />
                        : <Check size={12} />}
                      {draftRevisionStatus === 'publishing' ? '重试发布' : '确认并发布'}
                    </button>
                  </div>
                )}
              </div>
              <iframe
                src={previewUrl || undefined}
                srcDoc={previewUrl ? undefined : previewHtml}
                sandbox={previewUrl ? VERIFIED_PACKAGE_PREVIEW_SANDBOX : previewFromEvent ? DESIGN_PREVIEW_EVENT_SANDBOX : AI_STREAM_PREVIEW_SANDBOX}
                referrerPolicy="no-referrer"
                title={previewedRevision ? `${revisionLabel(previewedRevision)}预览` : '修改草稿预览'}
                className="h-64 w-full bg-white"
              />
              </div>
            ) : generating ? (
              <div className="mt-3 h-64 overflow-hidden rounded-lg border border-token-subtle bg-token-nested">
                <MapSectionLoader text="页面结构出现后会立即显示在这里" />
              </div>
            ) : null}
          </section>
        )}

        <div
          ref={historyRef}
          tabIndex={-1}
          data-dialog-initial-focus={focusSection === 'history' ? 'true' : undefined}
          className="scroll-mt-2 p-3 outline-none sm:p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2 text-xs font-medium">
            <div>
              <span className="flex items-center gap-2"><History size={14} />版本记录</span>
              <p className="mt-1 text-[10px] font-normal text-token-muted">回退会复制所选历史内容并发布为新版本，不会删除任何记录。</p>
            </div>
            <button
              type="button"
              title="刷新版本记录"
              aria-label="刷新版本记录"
              disabled={loadingHistory}
              onClick={() => void loadHistory()}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-token-secondary hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <RefreshCw size={12} className={loadingHistory ? 'animate-spin' : ''} />
            </button>
          </div>
          {historyError && (
            <div role="alert" className="mb-3 flex items-start gap-2 text-[11px] leading-relaxed text-token-secondary">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
              <p>{historyError}{revisions.length > 0 ? ' 以下为上次读取的记录。' : ''}</p>
            </div>
          )}
          {loadingHistory ? (
            <MapSectionLoader text="正在读取版本记录" />
          ) : revisions.length === 0 ? (
            !historyError && <p className="text-[11px] text-token-muted">尚无版本记录。</p>
          ) : (
            <div className="space-y-2">
              {revisions.map((item) => {
                const selected = previewedRevision?.id === item.id;
                const parentRevision = item.parentRevisionId
                  ? revisions.find((candidate) => candidate.id === item.parentRevisionId)
                  : null;
                const rollbackTargetRevision = item.rollbackTargetRevisionId
                  ? revisions.find((candidate) => candidate.id === item.rollbackTargetRevisionId)
                  : null;
                const sourceVersion = item.source === 'rollback' && item.rollbackTargetRevisionId
                  ? rollbackTargetRevision
                    ? `回退目标：${revisionLabel(rollbackTargetRevision)}`
                    : '回退目标：所选历史版本'
                  : !item.parentRevisionId
                  ? '初始版本'
                  : parentRevision
                    ? `基于：${revisionLabel(parentRevision)}`
                    : '基于：历史线上版本';
                const sourceAction = item.source === 'ai-edit'
                  ? 'AI 修改'
                  : item.source === 'rollback'
                    ? '回退复制'
                    : '首次建立';
                const statusClass = item.isCurrent
                  ? 'border-emerald-500/60 bg-emerald-500/5'
                  : selected
                    ? 'border-blue-500/70 bg-blue-500/5 ring-1 ring-blue-500/30'
                    : item.status === 'draft' || item.status === 'publishing'
                      ? 'border-amber-500/40 bg-amber-500/5'
                      : item.status === 'rejected'
                        ? 'border-rose-500/30 bg-rose-500/5'
                      : 'border-token-subtle bg-token-nested';
                const statusDescription = item.isCurrent
                  ? '访客当前看到的线上内容'
                  : item.status === 'draft' || item.status === 'publishing'
                    ? '仅你可见，尚未影响线上页面'
                    : item.status === 'rejected'
                      ? '草稿已拒绝，未影响线上页面'
                    : '历史快照，可预览或回退到此版本';
                const changeSummary = revisionChangeSummary(item, rollbackTargetRevision);
                return (
                <div key={item.id} aria-current={item.isCurrent ? 'true' : undefined} className={`rounded-lg border p-2.5 ${statusClass}`}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="text-xs font-semibold">{revisionLabel(item)}</div>
                        {selected && <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-500">预览中</span>}
                      </div>
                      <p className="mt-1 text-[11px] text-token-secondary">{statusDescription}</p>
                      <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-relaxed text-token-primary">{changeSummary}</p>
                      {item.status === 'rejected' && item.rejectionReason && (
                        <p className="mt-1 text-[10px] leading-relaxed text-rose-500">拒绝原因：{item.rejectionReason}</p>
                      )}
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-token-muted">
                        <Clock3 size={10} />{formatRevisionTime(item.rejectedAt || item.publishedAt || item.createdAt)}
                      </div>
                      {item.knowledgeEntryIds.length > 0 && (
                        <p className="mt-1 text-[10px] text-token-muted">引用了 {item.knowledgeEntryIds.length} 篇知识</p>
                      )}
                      <details className="mt-1 text-[10px] text-token-muted">
                        <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">技术信息</summary>
                        <p>执行来源：{sourceAction} · {sourceVersion}</p>
                        <p className="mt-0.5 break-all">版本标识：{item.id}</p>
                      </details>
                    </div>
                    <div className="flex w-full shrink-0 items-center gap-1 overflow-x-auto sm:w-auto sm:overflow-visible">
                      <button
                        type="button"
                        title="预览这个版本"
                        aria-label="预览这个版本"
                        onClick={() => void openRevision(item.id)}
                        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-token-secondary hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <Eye size={13} />
                        预览
                      </button>
                      {item.status === 'published' && !item.isCurrent && (
                        <button
                          type="button"
                          title="把这个版本重新发布为最新版"
                          aria-label="把这个版本重新发布为最新版"
                          aria-haspopup="dialog"
                          aria-expanded={pendingRollback?.id === item.id}
                          aria-controls={pendingRollback?.id === item.id ? `rollback-confirm-${item.id}` : undefined}
                          disabled={mutatingId === item.id}
                          onClick={(event) => requestRollback(item, event.currentTarget)}
                          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-token-secondary hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          {mutatingId === item.id && mutatingAction === 'rollback'
                            ? <MapSpinner size={13} />
                            : <RotateCcw size={13} />}
                          回退到此版
                        </button>
                      )}
                      {item.status === 'draft' && (
                        <button
                          type="button"
                          title="拒绝这个草稿"
                          aria-label="拒绝这个草稿"
                          aria-haspopup="dialog"
                          aria-expanded={pendingReject?.id === item.id}
                          aria-controls={pendingReject?.id === item.id ? `reject-confirm-${item.id}` : undefined}
                          disabled={mutatingId === item.id}
                          onClick={(event) => requestReject(item, event.currentTarget)}
                          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-rose-500 hover:bg-rose-500/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                        >
                          {mutatingId === item.id && mutatingAction === 'reject'
                            ? <MapSpinner size={13} />
                            : <X size={13} />}
                          拒绝草稿
                        </button>
                      )}
                      {canPublishRevision(item) && (
                        <button
                          type="button"
                          title={item.status === 'publishing' ? '重试未完成的发布' : '发布这个草稿'}
                          aria-label={item.status === 'publishing' ? '重试未完成的发布' : '发布这个草稿'}
                          disabled={mutatingId === item.id}
                          onClick={() => void publish(item.id)}
                          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-emerald-600 hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                          {mutatingId === item.id && mutatingAction === 'publish'
                            ? <MapSpinner size={13} />
                            : <Check size={13} />}
                          确认并发布
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
