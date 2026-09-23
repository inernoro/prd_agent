import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Library,
  RefreshCw,
  Settings2,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createDesignArtifactRun,
  cancelDesignArtifactRun,
  getDesignArtifactRun,
  getDesignGenerationSettings,
  getDesignRuntimeCapabilities,
  getSiteContent,
  streamDesignArtifactRun,
  updateSite,
  type DesignGenerationStyle,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  DESIGN_PREVIEW_EVENT_SANDBOX,
  chooseDesignRuntime,
  designPreviewEventDocument,
  displayedDesignRuntime,
  elapsedSecondsSince,
  isNewerPreviewRevision,
  previewableAiStreamHtml,
  runtimeFallbackNotice,
} from './siteEditPreview';
import {
  appendGenerationStage,
  closeGenerationStages,
  formatGenerationClock,
  parseSiteGenerationProgressEvent,
  remainingEstimateText,
  resolveGeneratedSiteId,
  resolveRunModelBadge,
  runProvenanceText,
  type GenerationStage,
} from './siteGenerateProgress';
import {
  DESIGN_ATTACHMENT_ACCEPT,
  MAX_GENERATE_ATTACHMENTS,
  attachmentBadge,
  formatAttachmentSize,
  summarizeAttachments,
  useDesignAttachmentUploads,
  type DesignAttachmentItem,
} from './designAttachments';
import KnowledgeInlineBrowser from './KnowledgeInlineBrowser';
import {
  PRESET_REQUESTS,
  RUNTIME_CARD_REGISTRY,
  orderRuntimeCards,
  runtimeCardTitle,
  titleFromFileName,
} from './siteGenerateOptions';

export interface SiteGenerateSource {
  entryId: string;
  storeId: string;
  title: string;
  storeName?: string;
}

/** 从「生成网页」下拉进来时落在哪个页签。 */
export type SiteGenerateSourceTab = 'knowledge' | 'upload';

interface Props {
  open: boolean;
  initialSource?: SiteGenerateSource | null;
  initialTab?: SiteGenerateSourceTab;
  /**
   * 发起时所在的团队空间，随请求一起冻结到服务端；个人空间传 null。
   * 归属由服务端在建站时应用——浏览器可能早就不在了。
   */
  destinationTeamId?: string | null;
  onClose: () => void;
  onCreated: (siteId: string) => void;
  /** 可选的目标文件夹（与上传弹窗同一份列表）。 */
  folders?: string[];
  /** 完成页「帮我修改」：交给页面打开改写面板。 */
  onEditSite?: (siteId: string) => void;
  /** 「风格与提示词」入口：交给页面打开网页生成设置。 */
  onOpenSettings?: () => void;
}

type Step = 'source' | 'options' | 'running' | 'done';

interface Notice {
  tone: 'error' | 'info';
  text: string;
}

const ACTIVE_GENERATION_RUN_KEY = 'web-hosting-design-active-run-v1';
/** map-gateway 没有 preview 事件，用累计 delta 做预览时的刷新间隔。 */
const DELTA_PREVIEW_THROTTLE_MS = 500;
const PASTED_TEXT_FILE_NAME = '粘贴的文字.md';

/**
 * sessionStorage 在隐私窗口、站点数据被禁、配额用尽时会**抛异常**，不是静默失败。
 * 这里的持久化只是一个便利（刷新后能接回正在跑的任务），而它夹在「服务端任务已创建」
 * 与「进入流式 try」之间——一抛，函数就地中断：服务端继续生成，弹窗永远停在
 * 「正在校验所选知识」，用户既看不到流也没有可恢复的 key。
 * 所以所有 storage 访问一律走这两个封装：存不下就当没存过，生成照跑。
 */
function rememberActiveRun(runId: string): void {
  try { sessionStorage.setItem(ACTIVE_GENERATION_RUN_KEY, runId); } catch { /* 存不下不影响生成 */ }
}

function forgetActiveRun(): void {
  try { sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY); } catch { /* 同上 */ }
}

function readActiveRun(): string | null {
  try { return sessionStorage.getItem(ACTIVE_GENERATION_RUN_KEY); } catch { return null; }
}

// ─── 小组件 ───

const STEP_LABELS = ['选素材', '写要求', '生成'] as const;

function stepIndex(step: Step): number {
  if (step === 'source') return 0;
  if (step === 'options') return 1;
  if (step === 'running') return 2;
  return 3;
}

function Stepper({ step }: { step: Step }) {
  const current = stepIndex(step);
  return (
    <ol className="flex items-center gap-2.5 whitespace-nowrap text-[13px]" aria-label="生成步骤">
      {STEP_LABELS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex items-center gap-2.5" aria-current={active ? 'step' : undefined}>
            {index > 0 && <span aria-hidden className="h-px w-7" style={{ background: 'var(--border-default)' }} />}
            <span className="flex items-center gap-1.5" style={{ color: active ? 'var(--text-primary)' : done ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              <span
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[12px] font-bold"
                style={active
                  ? { background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }
                  : done
                    ? { background: 'var(--semantic-success-soft)', color: 'var(--semantic-success-text)' }
                    : { border: '1px solid var(--border-default)' }}
              >
                {done ? <Check size={12} strokeWidth={3} /> : index + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function PrimaryButton({ children, disabled, onClick, title }: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-bold transition-opacity disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2"
      style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, disabled, onClick }: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-[14px] transition-colors hover-bg-soft disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2"
      style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
    >
      {children}
    </button>
  );
}

function SourceChip({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex max-w-[240px] items-center gap-1 truncate rounded-lg px-2.5 py-1 text-[13px]"
      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
    >
      {children}
    </span>
  );
}

function AttachmentRow({ item, onRemove, disabled }: {
  item: DesignAttachmentItem;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const statusText = item.status === 'uploading'
    ? `正在上传 ${item.progress}%`
    : item.status === 'reading'
      ? '已传完，服务器正在读取正文'
      : item.status === 'ready'
        ? '可以用'
        : item.error || '上传失败';
  return (
    <div className="flex items-center gap-3 rounded-xl px-3.5 py-3" style={{ background: 'var(--bg-card)' }}>
      <span
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-[10px] font-bold"
        style={{ background: 'var(--semantic-info-soft)', color: 'var(--semantic-info-text)' }}
      >
        {attachmentBadge(item.fileName)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate text-[14px] font-medium text-token-primary" title={item.fileName}>{item.fileName}</span>
        {item.status === 'uploading' || item.status === 'reading' ? (
          <span className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
            <span
              className={`block h-full rounded-full transition-[width] duration-300 ${item.status === 'reading' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
              style={{ width: `${Math.max(4, item.progress)}%`, background: 'var(--accent-primary)' }}
            />
          </span>
        ) : (
          <span className="text-[12px] text-token-muted">{formatAttachmentSize(item.size)}</span>
        )}
      </span>
      <span
        className="flex shrink-0 items-center gap-1 text-[12px]"
        style={{ color: item.status === 'ready' ? 'var(--semantic-success-text)' : item.status === 'failed' ? 'var(--semantic-danger-text)' : 'var(--text-secondary)' }}
      >
        {item.status === 'ready' && <Check size={14} strokeWidth={2.4} />}
        {item.status === 'reading' && <MapSpinner size={12} />}
        {statusText}
      </span>
      <button
        type="button"
        aria-label={`移除 ${item.fileName}`}
        onClick={onRemove}
        disabled={disabled}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-token-muted transition-colors hover-bg-soft disabled:opacity-40"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function PreviewFrame({ html, sandbox, title, placeholder }: {
  html: string;
  sandbox: string;
  title: string;
  placeholder: ReactNode;
}) {
  return (
    <div className="relative h-full min-h-[220px] overflow-hidden rounded-[14px]" style={{ border: '1px solid var(--border-subtle)' }}>
      {html ? (
        <iframe
          key={sandbox}
          srcDoc={html}
          sandbox={sandbox}
          referrerPolicy="no-referrer"
          title={title}
          className="h-full w-full bg-white"
        />
      ) : (
        <div className="surface-reading flex h-full flex-col gap-2.5 p-5 text-crisp" aria-hidden="true">
          {placeholder}
        </div>
      )}
    </div>
  );
}

/** 首稿到达之前的占位：画一页网页的骨架在呼吸，而不是一个居中转圈。 */
function PageSkeleton({ caption }: { caption: string }) {
  const bar = (width: string, height = 7) => (
    <div className="animate-pulse rounded motion-reduce:animate-none" style={{ width, height, background: 'var(--skeleton-base)' }} />
  );
  return (
    <>
      <div className="text-[12px] text-token-muted">{caption}</div>
      {bar('40%', 9)}
      {bar('88%', 22)}
      {bar('92%')}
      {bar('70%')}
      <div className="mt-2 grid grid-cols-3 gap-2">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-16 animate-pulse rounded-lg motion-reduce:animate-none" style={{ background: 'var(--skeleton-base)' }} />
        ))}
      </div>
      <div className="h-24 animate-pulse rounded-lg motion-reduce:animate-none" style={{ background: 'var(--skeleton-base)' }} />
    </>
  );
}

export default function SiteGenerateDialog({
  open,
  initialSource,
  initialTab = 'knowledge',
  destinationTeamId,
  onClose,
  onCreated,
  folders = [],
  onEditSite,
  onOpenSettings,
}: Props) {
  const [step, setStep] = useState<Step>('source');
  const [sourceTab, setSourceTab] = useState<SiteGenerateSourceTab>(initialTab);
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntrySelection[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const uploads = useDesignAttachmentUploads('document', MAX_GENERATE_ATTACHMENTS);
  const [pastedText, setPastedText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [settingsDefaultRuntime, setSettingsDefaultRuntime] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState('open-design');
  const [styles, setStyles] = useState<DesignGenerationStyle[]>([]);
  const [stylesError, setStylesError] = useState<string | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [instruction, setInstruction] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(0);
  const [stages, setStages] = useState<GenerationStage[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [lastEventAtMs, setLastEventAtMs] = useState<number | null>(null);
  const [activeRunRuntime, setActiveRunRuntime] = useState<string | null>(null);
  const [runInfo, setRunInfo] = useState<{ styleName?: string | null; promptFingerprint?: string | null } | null>(null);
  const [resolvedModel, setResolvedModel] = useState<{ model: string; platform: string } | null>(null);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSandbox, setPreviewSandbox] = useState(AI_STREAM_PREVIEW_SANDBOX);
  const [generating, setGenerating] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [completedSite, setCompletedSite] = useState<{ id: string; url?: string } | null>(null);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const previewRevisionRef = useRef(-1);
  const abortRef = useRef<AbortController | null>(null);
  const folderRef = useRef('');

  useEffect(() => {
    if (!generating || runStartedAtMs == null) return;
    const tick = () => setElapsedSeconds(elapsedSecondsSince(runStartedAtMs));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generating, runStartedAtMs]);
  const onCreatedRef = useRef(onCreated);
  // 恢复失败时要如实说清「现在表单里还剩什么」。打开弹窗会清空 instruction、
  // 并且只有带 initialSource 时才预选知识——用 ref 是为了不把 initialSource 塞进
  // recoverActiveRun 的依赖里（那会让它在恢复途中被重建）。
  const initialSourceRef = useRef(initialSource);
  // 目标空间在「发起生成」那一刻取一次就够——它随请求冻结到服务端，
  // 之后用户在页面上换空间也不该改变这一轮的归属。
  const destinationTeamIdRef = useRef(destinationTeamId);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    initialSourceRef.current = initialSource;
  }, [initialSource]);

  useEffect(() => {
    folderRef.current = folder;
  }, [folder]);

  const applyPreviewHtml = useCallback((html: string, sandbox: string) => {
    setPreviewSandbox(sandbox);
    setPreviewHtml(html);
  }, []);

  const finishGeneration = useCallback((siteId: string, siteUrl?: string, destinationError?: string | null) => {
    // 建站成功、归属失败是一种部分成功。不提示的话，用户在团队空间里找不到它，
    // 只会以为生成丢了——「坏的那条路」不许长得跟完全成功一样。
    if (destinationError) {
      toast.error('已生成，但归属团队失败', `${destinationError}（网页暂在个人空间，可在卡片上手动移动）`);
    }
    // 服务端推过 preview 事件时以它为准；只有直连流才从累计的 delta 里取最后一版。
    if (previewRevisionRef.current < 0) {
      const finalPreview = previewableAiStreamHtml(streamRef.current);
      if (finalPreview) applyPreviewHtml(finalPreview, AI_STREAM_PREVIEW_SANDBOX);
    }
    const now = Date.now();
    setStages((current) => closeGenerationStages(current, now));
    setCompletedSite({ id: siteId, url: siteUrl });
    setProgress(100);
    setPhase('网页已生成并保存，可在网页托管中继续修改和发布分享');
    setGenerating(false);
    setActiveRunId(null);
    setStopRequested(false);
    setStep('done');
    forgetActiveRun();
    // 文件夹不在生成契约里：完成时补一次。失败只提示，网页本身已经在了。
    const targetFolder = folderRef.current.trim();
    if (targetFolder) {
      void updateSite(siteId, { folder: targetFolder }).then((result) => {
        if (!result.success) toast.error('已生成，但放入文件夹失败', result.error?.message || '可在卡片上手动移动');
      });
    }
    onCreatedRef.current(siteId);
  }, [applyPreviewHtml]);

  const failGeneration = useCallback((message: string, backTo: Step = 'options') => {
    setGenerating(false);
    setActiveRunId(null);
    setStopRequested(false);
    setPhase(message);
    setNotice({ tone: 'error', text: message });
    setStep(backTo);
    forgetActiveRun();
  }, []);

  const recoverActiveRun = useCallback(async (runId: string, signal: AbortSignal) => {
    let failedReads = 0;
    while (!signal.aborted) {
      const result = await getDesignArtifactRun(runId);
      if (signal.aborted) return;
      if (!result.success) {
        // NOT_FOUND 是终态，不是断线：任务记录没了（或 sessionStorage 里那个 id 已经过期），
        // 再怎么轮询都不会变。当成瞬时故障会卡住 generating、留着旧 key，用户连下一次生成
        // 都发不起来。改写面板早就这么处理了，这里是同一条判据的第二份（形状 3）。
        if (result.error?.code === 'NOT_FOUND') {
          // 不许承诺「直接重新生成」：打开弹窗那一步已经把要求清空了，没有
          // initialSource 时连知识也清空了，生成按钮此刻是禁用的。说了能直接重来，
          // 用户点下去却点不动，就是又制造一次「白做一场」。
          const message = initialSourceRef.current
            ? '上次的网页生成任务已经不在了。这一篇知识仍选着，再写一次要求就能重新生成'
            : '上次的网页生成任务已经不在了。重新选择素材、写明要求，就能再生成一次';
          setGenerating(false);
          setActiveRunId(null);
          setStopRequested(false);
          setPhase(message);
          setNotice({ tone: 'info', text: message });
          setStep(initialSourceRef.current ? 'options' : 'source');
          forgetActiveRun();
          return;
        }
        failedReads += 1;
        setGenerating(true);
        setPhase(failedReads === 1
          ? '实时连接已中断，正在从服务器恢复任务状态'
          : '仍在等待服务器恢复任务状态');
      } else {
        failedReads = 0;
        const nextPhase = result.data.phase || '正在恢复网页生成进度';
        setPhase(nextPhase);
        setStages((current) => appendGenerationStage(current, nextPhase, Date.now()));
        setProgress(result.data.progress);
        setActiveRunRuntime(result.data.runtime);
        setResolvedModel(resolveRunModelBadge(result.data));
        setRunInfo({ styleName: result.data.styleName, promptFingerprint: result.data.promptFingerprint });
        setRunStartedAtMs(Date.parse(result.data.createdAt));
        if (result.data.title) setTitle((current) => current || result.data.title || '');
        const status = result.data.status.toLowerCase();
        const siteId = resolveGeneratedSiteId(result.data);
        if (status === 'done' && siteId) {
          finishGeneration(siteId, undefined, result.data.destinationApplyError);
          return;
        }
        if (status === 'done') {
          failGeneration('网页任务已结束，但未找到可打开的产物，请重新生成');
          return;
        }
        if (status === 'error' || status === 'cancelled') {
          failGeneration(status === 'cancelled'
            ? '网页生成已取消，未保存或发布新页面'
            : result.data.error || '网页生成未完成，请重新发起');
          return;
        }
        setGenerating(true);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
    }
  }, [failGeneration, finishGeneration]);

  const resetUploads = uploads.reset;
  useEffect(() => {
    if (!open) return;
    setLoadingKnowledge(true);
    setTitle(initialSource?.title || '');
    // 目标空间在打开这一刻冻结：之后用户在页面上切空间，不该改变这一轮的归属
    // （与上传弹窗打开时快照 currentSpace 是同一个口径）。
    destinationTeamIdRef.current = destinationTeamId;
    setInstruction('');
    setStep(initialSource ? 'options' : 'source');
    setSourceTab(initialTab);
    setNotice(null);
    setPhase('');
    setProgress(0);
    setStages([]);
    setElapsedSeconds(0);
    setRunStartedAtMs(null);
    setLastEventAtMs(null);
    setActiveRunRuntime(null);
    setRunInfo(null);
    // 这个弹窗常驻挂载：不在这里清掉，重开之后会把上一轮的模型当成本轮的显示出来。
    setResolvedModel(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewSandbox(AI_STREAM_PREVIEW_SANDBOX);
    setCompletedSite(null);
    setActiveRunId(null);
    setStopRequested(false);
    setPastedText('');
    setFolder('');
    resetUploads();
    setSelectedKnowledge(initialSource ? [{
      entryId: initialSource.entryId,
      storeId: initialSource.storeId,
      title: initialSource.title,
      storeName: initialSource.storeName || '当前知识库',
    }] : []);
    let active = true;
    void Promise.all([
      listRecentDocumentEntries(16),
      getDesignRuntimeCapabilities(),
      getDesignGenerationSettings(),
    ]).then(([recent, runtimes, settings]) => {
      if (!active) return;
      const items = recent.success ? [...recent.data.items] : [];
      if (initialSource && !items.some((item) => item.id === initialSource.entryId)) {
        items.unshift({
          id: initialSource.entryId,
          storeId: initialSource.storeId,
          storeName: initialSource.storeName || '当前知识库',
          title: initialSource.title,
          contentType: 'text/markdown',
          tags: [],
          createdAt: '',
          updatedAt: '',
          isNew: false,
        });
      }
      setRecentKnowledge(items);
      if (runtimes.success) {
        setCapabilities(runtimes.data.runtimes);
        setSettingsDefaultRuntime(runtimes.data.defaultRuntime);
        const runtimeId = chooseDesignRuntime(
          runtimes.data.runtimes,
          runtimes.data.defaultRuntime,
        );
        if (runtimeId) setSelectedRuntime(runtimeId);
      }
      if (settings.success) {
        const enabled = settings.data.styles.filter((style) => style.enabled);
        setStyles(enabled);
        setStylesError(null);
        setSelectedStyleId((enabled.find((style) => style.isDefault) ?? enabled[0])?.id ?? null);
      } else {
        setStyles([]);
        setSelectedStyleId(null);
        setStylesError(settings.error?.message || '风格列表暂时读不到');
      }
      setLoadingKnowledge(false);
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [initialSource, open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开那一刻快照 initialTab / 目标空间，之后变化不影响这一轮

  useEffect(() => {
    if (!open) return;
    const runId = readActiveRun();
    if (!runId) return;
    const recovery = new AbortController();
    abortRef.current?.abort();
    abortRef.current = recovery;
    setStep('running');
    setGenerating(true);
    setActiveRunId(runId);
    setStopRequested(false);
    setPhase('正在恢复上次未完成的网页生成任务');
    void recoverActiveRun(runId, recovery.signal);
    return () => {
      recovery.abort();
    };
  }, [open, recoverActiveRun]);

  // 完成页没有预览时（刷新后恢复、或流里一次都没拿到整页），读一次已保存的正文补上。
  useEffect(() => {
    if (step !== 'done' || !completedSite || previewHtml) return;
    let active = true;
    void getSiteContent(completedSite.id).then((result) => {
      if (!active || !result.success || !result.data.html) return;
      applyPreviewHtml(designPreviewEventDocument(result.data.html), DESIGN_PREVIEW_EVENT_SANDBOX);
    });
    return () => { active = false; };
  }, [applyPreviewHtml, completedSite, previewHtml, step]);

  const enabledRuntime = capabilities.find((item) => item.id === selectedRuntime && item.enabled)
    ?? capabilities.find((item) => item.enabled);
  const visibleRuntime = displayedDesignRuntime(
    capabilities,
    enabledRuntime?.id ?? selectedRuntime,
    generating ? activeRunRuntime : null,
  ) ?? capabilities[0];
  const runtimeCards = useMemo(() => orderRuntimeCards(capabilities), [capabilities]);
  const fallbackNotice = runtimeFallbackNotice(capabilities, settingsDefaultRuntime, enabledRuntime?.id);
  const hasSources = selectedKnowledge.length > 0 || uploads.readyIds.length > 0;
  const canLeaveSource = selectedKnowledge.length > 0
    || uploads.items.some((item) => item.status !== 'failed')
    || pastedText.trim().length > 0;
  const activeRuntimeCopy = RUNTIME_CARD_REGISTRY[enabledRuntime?.id ?? ''];
  const materialNames = [
    ...selectedKnowledge.map((entry) => entry.title),
    ...uploads.items.filter((item) => item.status !== 'failed').map((item) => item.fileName),
  ];

  const addFiles = (files: File[]) => {
    const rejected = uploads.addFiles(files);
    if (rejected.length > 0) toast.error('有文件没有加入', rejected.join('；'));
  };

  const goToOptions = () => {
    const pasted = pastedText.trim();
    if (pasted) {
      // 粘贴的文字按一篇 Markdown 附件上传，和拖进来的文件走同一条路，服务端同样当作事实来源。
      const file = new File([pasted], PASTED_TEXT_FILE_NAME, { type: 'text/markdown' });
      const rejected = uploads.addFiles([file]);
      if (rejected.length > 0) {
        toast.error('粘贴的文字没有加入', rejected.join('；'));
        return;
      }
      setPastedText('');
    }
    if (!title.trim()) {
      const firstTitle = selectedKnowledge[0]?.title ?? uploads.items[0]?.fileName ?? '';
      if (firstTitle) setTitle(titleFromFileName(firstTitle));
    }
    setNotice(null);
    setStep('options');
  };

  const generate = async (runtimeOverride?: string) => {
    const text = instruction.trim();
    if (!text || !hasSources || uploads.busy || generating) return;
    const requestRuntime = (runtimeOverride
      ? capabilities.find((item) => item.id === runtimeOverride && item.enabled)
      : null) ?? enabledRuntime;
    if (!requestRuntime) {
      toast.error('没有可用的设计执行器', '请检查执行器部署状态后重试');
      return;
    }
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setGenerating(true);
    // 与改写面板同一处判据：徽章必须在进入 generating 的同一拍清掉。排在创建请求之后，
    // 创建期间顶上挂的是上一轮的模型；创建失败时它更会被留在一次根本没发生的调用上。
    setResolvedModel(null);
    setStopRequested(false);
    setElapsedSeconds(0);
    setRunStartedAtMs(Date.now());
    setLastEventAtMs(null);
    setActiveRunRuntime(requestRuntime.id);
    setSelectedRuntime(requestRuntime.id);
    setRunInfo(null);
    setCompletedSite(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewSandbox(AI_STREAM_PREVIEW_SANDBOX);
    previewRevisionRef.current = -1;
    setNotice(null);
    setProgress(1);
    const firstPhase = selectedKnowledge.length > 0 ? '正在校验所选知识' : '正在提交素材';
    setPhase(firstPhase);
    setStages(appendGenerationStage([], firstPhase, Date.now()));
    setStep('running');
    streamRef.current = '';

    if (selectedKnowledge.some((entry) => !entry.entryId || !entry.storeId)) {
      failGeneration('引用知识身份不完整，请重新选择', 'source');
      toast.error('无法校验引用知识', '请刷新知识列表后重新选择');
      return;
    }

    const knowledgeReferences = selectedKnowledge.map((entry) => ({
      entryId: entry.entryId,
      storeId: entry.storeId,
    }));
    const created = await createDesignArtifactRun({
      instruction: text,
      title: title.trim() || selectedKnowledge[0]?.title || titleFromFileName(uploads.items[0]?.fileName ?? '') || undefined,
      runtime: requestRuntime.id,
      sourceSurface: initialSource ? 'knowledge-base' : 'web-hosting',
      // 目标空间跟着请求走，不再等完成回调——用户中途离开时那条回调根本不会执行。
      destinationTeamId: destinationTeamIdRef.current ?? null,
      knowledgeReferences,
      styleId: selectedStyleId,
      attachmentIds: uploads.readyIds,
    });
    if (!created.success) {
      setActiveRunRuntime(null);
      failGeneration(created.error?.message || '网页生成任务创建失败');
      toast.error('无法开始生成', created.error?.message || '请稍后重试');
      return;
    }
    setActiveRunRuntime(created.data.runtime);
    setActiveRunId(created.data.runId);
    setRunInfo({ styleName: created.data.styleName, promptFingerprint: created.data.promptFingerprint });
    setRunStartedAtMs(Date.parse(created.data.createdAt));
    rememberActiveRun(created.data.runId);

    let terminalObserved = false;
    try {
      await streamDesignArtifactRun({
        runId: created.data.runId,
        signal: abort.signal,
        onEvent: (event) => {
          const item = parseSiteGenerationProgressEvent(event);
          if (item.kind !== 'unknown') setLastEventAtMs(Date.now());
          if (item.kind === 'phase') {
            if (item.message) {
              setPhase(item.message);
              setStages((current) => appendGenerationStage(current, item.message, Date.now()));
            }
            if (typeof item.progress === 'number') setProgress(item.progress);
            return;
          }
          if (item.kind === 'model') {
            setResolvedModel({ model: item.model, platform: item.platform });
            return;
          }
          if (item.kind === 'thinking') {
            setThinking((previous) => `${previous}${item.text}`.slice(-600));
            return;
          }
          if (item.kind === 'preview') {
            // 整页替换；断线重放的旧 revision 不许把新页面盖回去。
            if (!isNewerPreviewRevision(item.revision, previewRevisionRef.current)) return;
            previewRevisionRef.current = item.revision;
            const html = designPreviewEventDocument(item.html);
            if (html) applyPreviewHtml(html, DESIGN_PREVIEW_EVENT_SANDBOX);
            return;
          }
          if (item.kind === 'delta') {
            streamRef.current += item.text;
            // 已经有 preview 事件的执行器以它为准，delta 只是模型原文，不再拿来画预览。
            if (previewRevisionRef.current >= 0) return;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= DELTA_PREVIEW_THROTTLE_MS) {
              const html = previewableAiStreamHtml(streamRef.current);
              if (html) applyPreviewHtml(html, AI_STREAM_PREVIEW_SANDBOX);
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (item.kind === 'done') {
            terminalObserved = true;
            finishGeneration(item.siteId, item.siteUrl, item.destinationApplyError);
            return;
          }
          if (item.kind === 'error') {
            terminalObserved = true;
            failGeneration(item.message);
            toast.error('网页生成失败', item.message);
            return;
          }
          if (item.kind === 'cancelled') {
            terminalObserved = true;
            setPreviewHtml('');
            streamRef.current = '';
            failGeneration(item.message);
          }
        },
      });
      if (!terminalObserved && !abort.signal.aborted) {
        setPhase('实时连接已结束，正在核对服务器中的任务状态');
        await recoverActiveRun(created.data.runId, abort.signal);
      }
    } catch {
      if (!abort.signal.aborted) {
        setPhase('实时连接已中断，正在从服务器恢复任务状态');
        await recoverActiveRun(created.data.runId, abort.signal);
      }
    } finally {
      if (abort.signal.aborted) setGenerating(false);
    }
  };

  const stopGeneration = async () => {
    if (!activeRunId || stopRequested) return;
    setStopRequested(true);
    setPhase('正在请求服务器停止生成，线上页面不会改变');
    const result = await cancelDesignArtifactRun(activeRunId);
    if (!result.success) {
      setStopRequested(false);
      setPhase(result.error?.message || '停止请求未成功，任务仍由服务器继续执行');
      toast.error('无法停止生成', result.error?.message || '请刷新任务状态后重试');
      return;
    }
    if (result.data.status.toLowerCase() === 'cancelled') {
      abortRef.current?.abort();
      setPreviewHtml('');
      streamRef.current = '';
      failGeneration('网页生成已取消，未保存或发布新页面');
      return;
    }
    setPhase('服务器正在停止生成，完成前不会保存或发布页面');
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败', '请在新窗口打开后从地址栏复制');
    }
  };

  // ─── 渲染 ───

  const header = step === 'running'
    ? `正在生成：${title.trim() || '网页'}`
    : step === 'done'
      ? '生成完成'
      : '生成网页';

  const dialogTitle = (
    <span className="flex min-w-0 items-center gap-3">
      <span
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]"
        style={{ background: 'var(--selection-bg)', color: 'var(--accent-primary)' }}
      >
        <Sparkles size={18} />
      </span>
      <span className="max-w-[52vw] truncate text-[17px] font-bold lg:max-w-[230px]">{header}</span>
    </span>
  );

  const noticeBanner = notice && (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className="mb-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px]"
      style={notice.tone === 'error'
        ? { background: 'var(--semantic-danger-soft)', border: '1px solid var(--semantic-danger-border)', color: 'var(--semantic-danger-text)' }
        : { background: 'var(--semantic-info-soft)', border: '1px solid var(--semantic-info-border)', color: 'var(--semantic-info-text)' }}
    >
      <span className="min-w-0 flex-1 leading-relaxed">{notice.text}</span>
      <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );

  const sourceStep = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {noticeBanner}
      <div className="flex shrink-0 gap-1.5" role="tablist" aria-label="素材来源">
        {([
          ['knowledge', '引用知识库', <Library key="i" size={16} />],
          ['upload', '直接上传', <Upload key="i" size={16} />],
        ] as const).map(([value, label, icon]) => {
          const active = sourceTab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSourceTab(value)}
              className="flex items-center gap-2 rounded-t-xl px-[18px] py-2.5 text-[15px] transition-colors"
              style={active
                ? { background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderBottom: 0, fontWeight: 700, color: 'var(--text-primary)' }
                : { color: 'var(--text-secondary)' }}
            >
              <span style={{ color: active ? 'var(--accent-primary)' : undefined }}>{icon}</span>
              {label}
            </button>
          );
        })}
      </div>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: sourceTab === 'knowledge' ? '0 14px 14px 14px' : '14px',
        }}
      >
        {sourceTab === 'knowledge' ? (
          <KnowledgeInlineBrowser
            recentEntries={recentKnowledge}
            loadingRecent={loadingKnowledge}
            selectedEntries={selectedKnowledge}
            onChange={setSelectedKnowledge}
            onLimitReached={() => toast.info('最多引用 3 篇', '取消一篇后再选；更多资料可以改用直接上传')}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col gap-4 p-5" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                addFiles(Array.from(event.dataTransfer.files));
              }}
              className="flex shrink-0 cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[14px] px-4 py-8 text-center transition-colors"
              style={{
                border: `1.5px dashed ${dragOver ? 'var(--accent-primary)' : 'rgba(var(--accent-primary-rgb), 0.55)'}`,
                background: dragOver ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'rgba(var(--accent-primary-rgb), 0.06)',
              }}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-[14px]" style={{ background: 'var(--selection-bg)', color: 'var(--accent-primary)' }}>
                <Upload size={22} />
              </span>
              <span className="text-[16px] font-bold text-token-primary">把文件拖到这里，或点击选择</span>
              <span className="text-[13px] text-token-secondary">支持 Word、PDF、Markdown、TXT、HTML，单个 20 MB 以内，最多 {MAX_GENERATE_ATTACHMENTS} 个</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={DESIGN_ATTACHMENT_ACCEPT.document}
                className="hidden"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </div>
            {uploads.items.length > 0 && (
              <div className="flex flex-col gap-2">
                {uploads.items.map((item) => (
                  <AttachmentRow key={item.key} item={item} onRemove={() => uploads.remove(item.key)} />
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="design-paste-text" className="text-[13px] text-token-secondary">没有文件？也可以直接粘贴文字</label>
              <textarea
                id="design-paste-text"
                value={pastedText}
                onChange={(event) => setPastedText(event.target.value)}
                placeholder="粘贴会议纪要、需求说明或任意一段文字，下一步时会作为一份素材上传"
                rows={3}
                className="resize-none rounded-xl px-3 py-2.5 text-[14px] text-token-primary outline-none placeholder:text-token-muted"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 pt-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-[14px] text-token-secondary">
            {selectedKnowledge.length > 0 ? `已选 ${selectedKnowledge.length} 篇知识` : '还没有选知识'}
            {uploads.items.length > 0 ? ` · ${summarizeAttachments(uploads.items)}` : ''}
          </span>
          {selectedKnowledge.map((entry) => (
            <SourceChip key={`${entry.storeId}:${entry.entryId}`}>
              <span className="truncate" title={`${entry.storeName} / ${entry.title}`}>{entry.title}</span>
            </SourceChip>
          ))}
        </div>
        <span className="hidden max-w-[220px] text-[12px] leading-relaxed text-token-muted md:block">
          引用会记住来源，知识和上传可以一起用
        </span>
        <PrimaryButton disabled={!canLeaveSource} onClick={goToOptions}>
          下一步：写要求<ChevronRight size={16} strokeWidth={2.4} />
        </PrimaryButton>
      </div>
    </div>
  );

  const optionsStep = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 pr-1" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {noticeBanner}
        <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-token-secondary">
          <span>素材</span>
          {materialNames.length === 0 ? <span className="text-token-muted">还没有素材</span> : materialNames.map((name) => (
            <SourceChip key={name}><FileText size={12} className="shrink-0 text-token-muted" /><span className="truncate">{name}</span></SourceChip>
          ))}
          {uploads.busy && <span className="flex items-center gap-1 text-token-muted"><MapSpinner size={12} />文件还在读取</span>}
          <button type="button" onClick={() => setStep('source')} className="font-medium" style={{ color: 'var(--accent-primary)' }}>修改</button>
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          <label htmlFor="design-site-instruction" className="text-[15px] font-bold text-token-primary">想做成什么样的网页</label>
          <div className="flex flex-wrap gap-2">
            {PRESET_REQUESTS.map((preset) => {
              const active = instruction.trim() === preset.text;
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setInstruction(preset.text)}
                  className="rounded-full px-3 py-1.5 text-[13px] transition-colors hover-bg-soft"
                  style={active
                    ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--accent-primary)' }
                    : { border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <textarea
            id="design-site-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="点上面的预设一键填入，或用两句话说明：给谁看、希望达到什么效果、风格偏好。"
            className="resize-none rounded-xl px-3.5 py-3 text-[14px] leading-relaxed text-token-primary outline-none placeholder:text-token-muted"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
          />
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[15px] font-bold text-token-primary">风格</span>
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="inline-flex items-center gap-1 text-[12px] text-token-muted hover:text-token-primary">
                <Settings2 size={13} />风格与提示词设置
              </button>
            )}
          </div>
          {stylesError ? (
            <p className="text-[12px] text-token-muted">{stylesError}，本次按默认风格生成。</p>
          ) : styles.length === 0 ? (
            <p className="text-[12px] text-token-muted">{loadingKnowledge ? '正在读取风格…' : '管理员还没有启用任何风格，本次按默认风格生成。'}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="风格">
              {styles.map((style) => {
                const active = style.id === selectedStyleId;
                return (
                  <button
                    key={style.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSelectedStyleId(style.id)}
                    title={style.description}
                    className="flex min-w-0 flex-col gap-2 rounded-xl p-2.5 text-left transition-colors hover-bg-soft"
                    style={active
                      ? { border: '1.5px solid var(--accent-primary)', background: 'var(--selection-bg)' }
                      : { border: '1px solid var(--border-default)' }}
                  >
                    <span className="flex h-8 overflow-hidden rounded-md" style={{ border: '1px solid var(--border-subtle)' }} aria-hidden>
                      {(style.swatches.length > 0 ? style.swatches : ['var(--bg-tertiary)']).slice(0, 3).map((swatch, index) => (
                        <span key={`${swatch}-${index}`} className="flex-1" style={{ background: swatch }} />
                      ))}
                    </span>
                    <span className="flex items-center gap-1 text-[13px] font-semibold text-token-primary">
                      <span className="truncate">{style.name}</span>
                      {style.isDefault && <span className="shrink-0 text-[10px] font-normal text-token-muted">默认</span>}
                    </span>
                    <span className="line-clamp-2 text-[11px] leading-snug text-token-muted">{style.description}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          <span className="text-[15px] font-bold text-token-primary">生成方式</span>
          {fallbackNotice && (
            <p className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>{fallbackNotice}</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="设计执行器">
            {runtimeCards.length === 0 ? (
              <p className="text-[12px] text-token-muted">正在检测可用的执行器…</p>
            ) : runtimeCards.map((runtime) => {
              const copy = RUNTIME_CARD_REGISTRY[runtime.id];
              const active = enabledRuntime?.id === runtime.id;
              return (
                <button
                  key={runtime.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!runtime.enabled}
                  onClick={() => setSelectedRuntime(runtime.id)}
                  className="flex flex-col gap-2.5 rounded-[14px] px-[18px] py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55"
                  style={active
                    ? { border: '1.5px solid var(--accent-primary)', background: 'rgba(var(--accent-primary-rgb), 0.08)' }
                    : { border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
                      style={{ border: `1.5px solid ${active ? 'var(--accent-primary)' : 'var(--border-strong)'}` }}
                      aria-hidden
                    >
                      {active && <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent-primary)' }} />}
                    </span>
                    <span className="text-[16px] font-bold text-token-primary">{runtimeCardTitle(runtime)}</span>
                    {copy?.badge && (
                      <span
                        className="rounded-md px-2 py-0.5 text-[12px]"
                        style={active
                          ? { background: 'var(--selection-bg)', color: 'var(--accent-primary)' }
                          : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                      >
                        {copy.badge}
                      </span>
                    )}
                  </span>
                  {copy && (
                    <span className="flex gap-[18px] text-[13px] text-token-secondary">
                      {copy.facts.map((fact) => (
                        <span key={fact.unit}><b className="text-[18px] text-token-primary">{fact.value}</b> {fact.unit}</span>
                      ))}
                    </span>
                  )}
                  <span className="text-[13px] leading-relaxed text-token-muted">
                    {runtime.enabled ? (copy?.description ?? runtime.label) : `暂不可用：${runtime.reason || '未启用'}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-token-secondary" htmlFor="design-site-title">
            网页标题
            <input
              id="design-site-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="默认使用第一份素材的标题"
              className="h-[42px] rounded-[10px] px-3 text-[14px] text-token-primary outline-none placeholder:text-token-muted"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-token-secondary" htmlFor="design-site-folder">
            放到文件夹
            <select
              id="design-site-folder"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className="h-[42px] rounded-[10px] px-3 text-[14px] text-token-primary outline-none"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
            >
              <option value="">不放文件夹</option>
              {folders.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 pt-4">
        <SecondaryButton onClick={() => setStep('source')}><ChevronLeft size={16} />上一步</SecondaryButton>
        <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-token-muted">
          {!hasSources
            ? '还没有可用的素材：选一篇知识，或等文件读完。'
            : !instruction.trim()
              ? '写一两句要求，或点一个预设。'
              : activeRuntimeCopy?.footnote ?? '生成完成后会保存到网页托管。'}
        </span>
        <PrimaryButton
          disabled={!enabledRuntime || !instruction.trim() || !hasSources || uploads.busy}
          onClick={() => void generate()}
        >
          <Sparkles size={16} />开始生成
        </PrimaryButton>
      </div>
    </div>
  );

  const nowMs = Date.now();
  const stageList = (
    <ol className="flex flex-col gap-0.5" aria-label="生成阶段">
      {stages.map((stage, index) => {
        const current = stage.endedAtMs == null && generating;
        const done = stage.endedAtMs != null;
        const seconds = Math.max(0, Math.round(((stage.endedAtMs ?? nowMs) - stage.startedAtMs) / 1000));
        return (
          <li
            key={`${stage.label}-${index}`}
            aria-current={current ? 'step' : undefined}
            className="flex items-start gap-3.5 rounded-xl px-3.5 py-3"
            style={{ background: current ? 'rgba(var(--accent-primary-rgb), 0.08)' : undefined }}
          >
            {done ? (
              <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--semantic-success-soft)', color: 'var(--semantic-success-text)' }}>
                <Check size={14} strokeWidth={3} />
              </span>
            ) : (
              <span
                className={`h-[26px] w-[26px] shrink-0 rounded-full ${current ? 'animate-spin motion-reduce:animate-none' : ''}`}
                style={{ border: '2.5px solid var(--accent-primary)', borderRightColor: 'transparent' }}
                aria-hidden
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-bold" style={{ color: current ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{stage.label}</span>
              {stage.detail !== stage.label && (
                <span className="text-[13px] leading-relaxed text-token-muted">{stage.detail}</span>
              )}
            </span>
            <span className="shrink-0 text-[13px] tabular-nums text-token-muted">{formatGenerationClock(seconds)}</span>
          </li>
        );
      })}
    </ol>
  );

  const heartbeat = lastEventAtMs != null
    ? `最近一次回应 ${Math.max(0, Math.round((nowMs - lastEventAtMs) / 1000))} 秒前`
    : '正在等待执行器的第一条回应';
  const provenance = runProvenanceText(runInfo);

  const runningStep = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3.5" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="flex flex-wrap items-end gap-4">
            <span className="text-[44px] font-bold leading-none tabular-nums text-token-primary">{formatGenerationClock(elapsedSeconds)}</span>
            <span className="pb-1 text-[14px] text-token-secondary">已用时 · {remainingEstimateText(activeRunRuntime, elapsedSeconds)}</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-tertiary)' }}
            role="progressbar"
            aria-label="网页生成进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-valuetext={`${progress}%`}
          >
            <div
              className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none"
              style={{ width: `${Math.max(3, Math.min(100, progress))}%`, background: 'var(--accent-primary)' }}
            />
          </div>
          <span role="status" aria-live="polite" className="sr-only">{phase}</span>
          {stageList}
          {thinking && (
            <p className="line-clamp-2 rounded-lg px-3 py-2 text-[12px] leading-relaxed text-token-muted" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="font-medium text-token-secondary">正在思考：</span>{thinking}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-token-muted">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--semantic-success-text)' }} aria-hidden />
            {heartbeat}
            {resolvedModel && (
              // ai-model-visibility：用户会因为换了模型直接感到结果不同，所以跟着进度一起露出。
              <span className="font-mono text-[12px]">· {resolvedModel.model} · {resolvedModel.platform}</span>
            )}
            {visibleRuntime && <span>· {runtimeCardTitle(visibleRuntime)}</span>}
            {provenance && <span>· {provenance}</span>}
          </div>
        </div>
        <div className="flex min-h-[260px] min-w-0 flex-col gap-2.5">
          <span className="text-[13px] text-token-secondary">实时预览（第一版写出后出现）</span>
          <div className="min-h-0 flex-1">
            <PreviewFrame
              html={previewHtml}
              sandbox={previewSandbox}
              title="生成中的网页预览"
              placeholder={<PageSkeleton caption="页面结构写出后会立即在这里出现" />}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 pt-4">
        <SecondaryButton disabled={!activeRunId || stopRequested} onClick={() => void stopGeneration()}>
          {stopRequested ? <MapSpinner size={14} /> : <X size={15} />}
          {stopRequested ? '正在停止，线上未改变' : '取消生成'}
        </SecondaryButton>
        <span className="min-w-0 flex-1 text-[13px] text-token-muted">关掉窗口也会继续，重新打开「生成网页」可接着看进度</span>
        <SecondaryButton onClick={onClose}>后台运行</SecondaryButton>
      </div>
    </div>
  );

  const otherRuntime = capabilities.find((item) => item.enabled && item.id !== (activeRunRuntime ?? selectedRuntime));
  const materialCount = [
    selectedKnowledge.length > 0 ? `${selectedKnowledge.length} 篇` : '',
    uploads.readyIds.length > 0 ? `${uploads.readyIds.length} 个文件` : '',
  ].filter(Boolean).join(' + ') || '—';

  const doneStep = (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-h-[280px] min-w-0">
        <PreviewFrame
          html={previewHtml}
          sandbox={previewSandbox}
          title="生成完成的网页预览"
          placeholder={<PageSkeleton caption="正在读取已保存的页面" />}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-3.5" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <div className="flex items-center gap-2 text-[15px] font-bold" style={{ color: 'var(--semantic-success-text)' }}>
          <Check size={18} strokeWidth={2.4} />已保存到网页托管
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            ['用时', formatGenerationClock(elapsedSeconds)],
            ['引用素材', materialCount],
            ['生成方式', visibleRuntime ? runtimeCardTitle(visibleRuntime) : '—'],
            ['风格', runInfo?.styleName || styles.find((style) => style.id === selectedStyleId)?.name || '默认'],
          ].map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] px-3 py-2.5" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[12px] text-token-muted">{label}</span>
              <span className="truncate text-[16px] font-bold text-token-primary" title={value}>{value}</span>
            </div>
          ))}
        </div>
        {provenance && <p className="text-[12px] text-token-muted">{provenance}</p>}
        {resolvedModel && (
          <p className="font-mono text-[11px] text-token-muted">{resolvedModel.model} · {resolvedModel.platform}</p>
        )}
        {completedSite?.url ? (
          <PrimaryButton onClick={() => window.open(completedSite.url, '_blank', 'noopener')}>
            <ExternalLink size={15} />打开网页
          </PrimaryButton>
        ) : (
          <p className="text-[12px] text-token-muted">网页已在列表里，可从卡片打开或分享。</p>
        )}
        {completedSite?.url && (
          <SecondaryButton onClick={() => void copyLink(completedSite.url as string)}><Copy size={15} />复制链接</SecondaryButton>
        )}
        {onEditSite && completedSite && (
          <SecondaryButton onClick={() => onEditSite(completedSite.id)}><WandSparkles size={15} />帮我修改</SecondaryButton>
        )}
        {otherRuntime ? (
          <SecondaryButton onClick={() => void generate(otherRuntime.id)}>
            <RefreshCw size={15} />用「{runtimeCardTitle(otherRuntime)}」再出一版对比
          </SecondaryButton>
        ) : (
          <SecondaryButton onClick={() => void generate()}><RefreshCw size={15} />再生成一版</SecondaryButton>
        )}
        {materialNames.length > 0 && (
          <p className="text-[12px] leading-relaxed text-token-muted">来源：{materialNames.join('、')}。</p>
        )}
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={dialogTitle}
      // 步骤条居中摆在标题栏里；窄于 lg 时会和标题挤在一起，改由正文顶部那一行显示。
      titleCenter={<span className="hidden lg:block"><Stepper step={step} /></span>}
      maxWidth={960}
      contentClassName="sm:p-2"
      contentStyle={{
        width: 'min(960px, calc(100vw - 16px))',
        maxWidth: 'calc(100vw - 16px)',
        height: 'min(780px, calc(100vh - 24px))',
      }}
      content={(
        <div className="flex h-full min-h-0 min-w-0 flex-col pt-2">
          <div className="mb-3 shrink-0 overflow-x-auto lg:hidden"><Stepper step={step} /></div>
          {step === 'source' && sourceStep}
          {step === 'options' && optionsStep}
          {step === 'running' && runningStep}
          {step === 'done' && doneStep}
        </div>
      )}
    />
  );
}
