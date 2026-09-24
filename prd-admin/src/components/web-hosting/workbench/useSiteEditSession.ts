import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createHostedSiteEditRun,
  createHostedSiteRevisionPreviewAccess,
  cancelHostedSiteEditRun,
  getDesignRuntimeCapabilities,
  getHostedSiteEditRun,
  listHostedSiteRevisions,
  previewHostedSiteRevision,
  publishHostedSiteRevision,
  rejectHostedSiteRevision,
  rollbackHostedSiteRevision,
  streamHostedSiteEditRun,
  type HostedSite,
  type HostedSiteRevision,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import {
  activeSiteEditRunStorageKey,
  appendRunNarration,
  canPublishRevision,
  chooseDesignRuntime,
  designPreviewEventDocument,
  isLatestPreviewRequest,
  isNewerPreviewRevision,
  displayedDesignRuntime,
  elapsedSecondsSince,
  previewableAiStreamHtml,
  revisionLabel,
  runtimeFallbackNotice,
} from '../siteEditPreview';
import { GATEWAY_PLATFORM_FALLBACK, resolveRunModelBadge } from '../siteGenerateProgress';
import {
  MAX_EDIT_SCREENSHOTS,
  screenshotRuntimeSupported,
  useDesignAttachmentUploads,
} from '../designAttachments';

/**
 * 修改一个已有网页的整套任务逻辑：草稿生成（流式 + 断线恢复）、版本记录、预览访问续期、
 * 发布 / 回退 / 拒绝，以及失败后的恢复入口。
 *
 * 旧的「帮我修改」面板（分享页仍在用）和生成工作台共用这一份——修改协议只能有一套，
 * 否则断线恢复、徽章清零、并发预览这些判据会各自漂移。这里只放状态与动作；
 * 聚焦、滚动、确认弹层这些界面细节留在各自的组件里。
 */

interface PhaseEvent {
  progress?: number;
  message?: string;
}


/**
 * 修改任务的交接：创建请求在路上时工作台被关掉又重开，旧实例拿到的 runId 写进存储时，
 * 新实例早已读过存储、看到是空的，于是停在空表单，第一条修改在后台隐身运行，用户还能再发一条
 * （Codex P2，与生成那边 handOffOrphanedGenerationRun 同一做法）。旧实例拿到结果先看自己是否已被关掉，
 * 是就把 runId 写进存储并通知眼前同一站点的空闲实例接管，自己不再往下走。
 */
type OrphanedEditRunListener = (siteId: string, runId: string) => void;
const orphanedEditRunListeners = new Set<OrphanedEditRunListener>();

export function subscribeOrphanedEditRun(listener: OrphanedEditRunListener): () => void {
  orphanedEditRunListeners.add(listener);
  return () => { orphanedEditRunListeners.delete(listener); };
}

export function handOffOrphanedEditRun(siteId: string, runId: string): void {
  try { sessionStorage.setItem(activeSiteEditRunStorageKey(siteId), runId); } catch { /* 存不下不影响任务 */ }
  orphanedEditRunListeners.forEach((listener) => listener(siteId, runId));
}

export type RecoveryAction = 'generate' | 'history' | 'preview' | 'publish' | 'rollback' | 'reject';
export type RevisionMutationAction = 'publish' | 'rollback' | 'reject';

export interface RecoveryNotice {
  title: string;
  detail: string;
  action: RecoveryAction;
  revisionId?: string;
  rejectionReason?: string;
  idempotencyKey?: string;
  versionConflict?: boolean;
}

export function createRevisionMutationIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

type FocusTarget = Pick<HTMLElement, 'focus' | 'isConnected'>;

export function restoreRevisionMutationFocus(
  primary: FocusTarget | null,
  fallback: FocusTarget | null,
  schedule: (callback: () => void) => unknown = (callback) => window.requestAnimationFrame(callback),
) {
  schedule(() => (primary?.isConnected ? primary : fallback)?.focus());
}

export interface RuntimeRecoveryGate {
  runtimeId: string;
  checks: number;
}

export const GENERATION_STAGES = [
  { label: '建立任务', threshold: 1 },
  { label: '读取与分析', threshold: 20 },
  { label: '生成页面', threshold: 60 },
  { label: '人工确认', threshold: 100 },
] as const;

type SiteEditProgressState = 'draft-ready' | 'published' | 'incomplete';

export function siteEditDisplayProgress(state: SiteEditProgressState, reportedProgress = 0) {
  if (state === 'incomplete') return Math.min(reportedProgress, 95);
  return state === 'published' ? 100 : 95;
}

export function siteEditStageState(index: number, activeIndex: number, generating: boolean, progress: number) {
  const threshold = GENERATION_STAGES[index]?.threshold ?? 100;
  const complete = index < activeIndex
    || (index === activeIndex && !generating && progress >= threshold);
  return { complete, current: index === activeIndex && !complete };
}

export function formatRevisionTime(value?: string | null) {
  if (!value) return '尚未发布';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function generationRecoveryDetail(detail: string) {
  const safetyFailure = /脚本|外链|表单|嵌入|导航|离线安全|安全校验/u.test(detail);
  const nextStep = safetyFailure
    ? '请移除包外资源、外部网络地址或嵌套页面，只保留工作区内可核对的网页文件后再试。'
    : '你可以缩小修改范围、换一种说法或切换执行器后再试。';
  return `${detail}。线上版本没有变化，修改要求已保留。${nextStep}`;
}

export function revisionHistoryErrorMessage(error: unknown): string {
  return toUserReadableErrorMessage(error, {
    fallbackMessage: '版本记录暂时无法读取',
    recoveryMessage: '请刷新版本记录；若仍失败，请联系管理员检查网页文件。',
  });
}

export interface SiteEditSessionOptions {
  onPublished: (site: HostedSite) => void;
  /**
   * 打开一个待发布草稿时，把它当时的修改要求回填进输入框（默认开）。
   * 旧面板靠它「按原要求再来一次」；工作台里那一轮已经作为对话气泡摆着，再回填就是重复，所以关掉。
   */
  prefillInstructionFromDraft?: boolean;
}

export function useSiteEditSession(site: HostedSite, { onPublished, prefillInstructionFromDraft = true }: SiteEditSessionOptions) {
  const [instruction, setInstruction] = useState('');
  const prefillFromDraftRef = useRef(prefillInstructionFromDraft);
  prefillFromDraftRef.current = prefillInstructionFromDraft;
  const [phase, setPhase] = useState('告诉我你想改什么，系统会先生成草稿，不会直接覆盖线上页面。');
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [activeRunRuntime, setActiveRunRuntime] = useState<string | null>(null);
  const [resolvedModel, setResolvedModel] = useState<{ model: string; platform: string } | null>(null);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewExpiresAt, setPreviewExpiresAt] = useState<string | null>(null);
  const [previewedRevision, setPreviewedRevision] = useState<HostedSiteRevision | null>(null);
  const [draftRevisionId, setDraftRevisionId] = useState<string | null>(null);
  const [draftRevisionStatus, setDraftRevisionStatus] = useState<'draft' | 'publishing' | null>(null);
  const [revisions, setRevisions] = useState<HostedSiteRevision[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // 同步可读的「手上有没有任务」：接管别人交出的修改前要判，state 来不及。
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = generating; }, [generating]);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutatingAction, setMutatingAction] = useState<RevisionMutationAction | null>(null);
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntrySelection[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(true);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState('open-design');
  const [defaultRuntime, setDefaultRuntime] = useState<string | null>(null);
  // 「附上截图」：用户圈出问题的图片，随修改任务一起交给执行器（最多 3 张）。
  const screenshots = useDesignAttachmentUploads('image', MAX_EDIT_SCREENSHOTS);
  // 预览来自服务端 preview 事件（执行器写出的整页，允许脚本）还是来自直连流的 delta（严格清洗、不许脚本）。
  const [previewFromEvent, setPreviewFromEvent] = useState(false);
  const previewRevisionRef = useRef(-1);
  const [runInfo, setRunInfo] = useState<{ styleName?: string | null; promptFingerprint?: string | null } | null>(null);
  const [recoveringRunId, setRecoveringRunId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const [runtimeRecoveryGate, setRuntimeRecoveryGate] = useState<RuntimeRecoveryGate | null>(null);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const capabilitiesRef = useRef<DesignRuntimeCapability[]>([]);
  const previewRequestRef = useRef(0);

  useEffect(() => {
    capabilitiesRef.current = capabilities;
  }, [capabilities]);

  const beginRuntimeRecovery = useCallback((runtimeId: string | null | undefined) => {
    if (!runtimeId) return;
    const runtime = capabilitiesRef.current.find((item) => item.id === runtimeId);
    if (runtime?.isolationMode !== 'session-container') return;
    setRuntimeRecoveryGate({ runtimeId, checks: 0 });
  }, []);

  useEffect(() => {
    if (!generating || runStartedAtMs == null) return;
    const tick = () => setElapsedSeconds(elapsedSecondsSince(runStartedAtMs));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generating, runStartedAtMs]);
  const enabledRuntimes = capabilities.filter((item) => item.enabled);
  const activeRuntime = displayedDesignRuntime(
    capabilities,
    selectedRuntime,
    generating ? activeRunRuntime : null,
  );
  const unavailableRuntimes = capabilities.filter((item) => !item.enabled);
  const activeRuntimeFact = activeRuntime
    ? `当前使用：${activeRuntime.label}；执行归属：${activeRuntime.executionOwner === 'cds-remote-agent' ? 'CDS Remote Agent' : 'MAP'}；隔离边界：${activeRuntime.isolationMode === 'session-container' ? '会话级容器' : 'MAP 服务进程'}；产物范围：声明式 HTML 与内联 CSS，不执行脚本。`
    : '当前没有可用执行器，请根据下方原因完成配置。';
  const runtimeFallback = runtimeFallbackNotice(capabilities, defaultRuntime, selectedRuntime);
  // 截图参考只有精细设计（OpenDesign）能用：快速修改带截图后端会 400，所以这里直接置灰并说清原因。
  const selectedEditRuntimeId = (enabledRuntimes.find((item) => item.id === selectedRuntime) ?? enabledRuntimes[0])?.id;
  const screenshotsSupported = screenshotRuntimeSupported(selectedEditRuntimeId);
  const addScreenshots = (files: File[]) => {
    const rejected = screenshots.addFiles(files);
    if (rejected.length > 0) toast.error('有截图没有加入', rejected.join('；'));
  };
  const generationStageIndex = previewHtml && !generating
    ? GENERATION_STAGES.length - 1
    : GENERATION_STAGES.reduce(
      (activeIndex, item, index) => progress >= item.threshold ? index : activeIndex,
      0,
    );

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    const result = await listHostedSiteRevisions(site.id);
    if (result.success) {
      setRevisions(result.data);
      setHistoryError(null);
      setRecoveryNotice((current) => current?.action === 'history' ? null : current);
    } else {
      setHistoryError(revisionHistoryErrorMessage(result.error));
    }
    setLoadingHistory(false);
  }, [site.id]);

  useEffect(() => {
    void loadHistory();
    return () => abortRef.current?.abort();
  }, [loadHistory]);

  useEffect(() => {
    let active = true;
    void Promise.all([listRecentDocumentEntries(12), getDesignRuntimeCapabilities()]).then(([result, runtimes]) => {
      if (!active) return;
      if (result.success) setRecentKnowledge(result.data.items);
      if (runtimes.success) {
        const supported = runtimes.data.runtimes.filter((item) => item.operations.includes('edit'));
        setCapabilities(supported);
        // 默认值由「网页生成设置」决定（服务端写进 defaultRuntime）；不可用时回落并在界面上写明原因。
        setDefaultRuntime(runtimes.data.defaultRuntime);
        const runtimeId = chooseDesignRuntime(
          supported,
          runtimes.data.defaultRuntime,
        );
        if (runtimeId) setSelectedRuntime(runtimeId);
      }
      setLoadingKnowledge(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const runtimeId = runtimeRecoveryGate?.runtimeId;
    if (!runtimeId || recoveryNotice?.action !== 'generate') return;
    let active = true;
    let timer: number | undefined;
    const inspect = async () => {
      const result = await getDesignRuntimeCapabilities();
      if (!active) return;
      if (result.success) {
        const supported = result.data.runtimes.filter((item) => item.operations.includes('edit'));
        setCapabilities(supported);
        const recovered = supported.find((item) => item.id === runtimeId)?.enabled === true;
        if (recovered) {
          setRuntimeRecoveryGate(null);
          setRecoveryNotice((current) => current?.action === 'generate'
            ? {
                ...current,
                detail: `${current.detail} 运行环境已回收，可以按原要求重试。`,
              }
            : current);
          return;
        }
      }
      setRuntimeRecoveryGate((current) => current?.runtimeId === runtimeId
        ? { ...current, checks: current.checks + 1 }
        : current);
      timer = window.setTimeout(inspect, 2000);
    };
    void inspect();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [recoveryNotice?.action, runtimeRecoveryGate?.runtimeId]);

  const openRevision = useCallback(async (revisionId: string) => {
    const requestId = ++previewRequestRef.current;
    setPreviewUrl(null);
    setPreviewExpiresAt(null);
    setPreviewHtml('');
    setPreviewedRevision(null);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    const [result, access] = await Promise.all([
      previewHostedSiteRevision(site.id, revisionId),
      createHostedSiteRevisionPreviewAccess(site.id, revisionId),
    ]);
    if (!isLatestPreviewRequest(requestId, previewRequestRef.current)) return;
    if (!result.success) {
      const detail = result.error?.message || '请稍后重试';
      setRecoveryNotice({ title: '版本预览失败', detail, action: 'preview', revisionId });
      toast.error('版本预览失败', detail);
      return;
    }
    if (!access.success) {
      const detail = access.error?.message || '请稍后重试';
      setRecoveryNotice({ title: '完整版本预览失败', detail, action: 'preview', revisionId });
      toast.error('完整版本预览失败', detail);
      return;
    }
    setRecoveryNotice((current) => current?.action === 'preview' ? null : current);
    setPreviewFromEvent(false);
    setPreviewHtml(result.data.html);
    setPreviewUrl(access.data.available ? access.data.previewUrl || null : null);
    setPreviewExpiresAt(access.data.available ? access.data.expiresAt || null : null);
    setPreviewedRevision(result.data.revision);
    const publishable = canPublishRevision(result.data.revision);
    if (prefillFromDraftRef.current && publishable && result.data.revision.instruction) {
      setInstruction((current) => current.trim() ? current : result.data.revision.instruction || current);
    }
    setDraftRevisionId(publishable ? revisionId : null);
    setDraftRevisionStatus(
      result.data.revision.status === 'draft' || result.data.revision.status === 'publishing'
        ? result.data.revision.status
        : null,
    );
    setPhase(revisionLabel(result.data.revision));
    setProgress(siteEditDisplayProgress(
      result.data.revision.status === 'published' ? 'published' : 'draft-ready',
    ));
  }, [site.id]);

  useEffect(() => {
    if (!previewUrl || !previewExpiresAt || !previewedRevision) return;
    const revisionId = previewedRevision.id;
    const requestId = previewRequestRef.current;
    const expiresAtMs = Date.parse(previewExpiresAt);
    const delay = Number.isFinite(expiresAtMs)
      ? Math.max(1_000, expiresAtMs - Date.now() - 60_000)
      : 1_000;
    const timer = window.setTimeout(() => {
      void createHostedSiteRevisionPreviewAccess(site.id, revisionId).then((access) => {
        if (requestId !== previewRequestRef.current
          || previewedRevision.id !== revisionId) return;
        if (!access.success || !access.data.available || !access.data.previewUrl) {
          setRecoveryNotice({
            title: '完整版本预览已失效',
            detail: access.success ? '请重新打开这个版本' : access.error?.message || '请重新打开这个版本',
            action: 'preview',
            revisionId,
          });
          return;
        }
        setPreviewUrl(access.data.previewUrl);
        setPreviewExpiresAt(access.data.expiresAt || null);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [previewExpiresAt, previewUrl, previewedRevision, site.id]);

  // 别的实例交出来的同一站点的修改：自己空着就接过来，忙着就只留在存储里，下次打开再接。
  useEffect(() => subscribeOrphanedEditRun((siteId, runId) => {
    if (siteId !== site.id || busyRef.current) return;
    busyRef.current = true;
    setGenerating(true);
    setRecoveringRunId(runId);
    setActiveRunId(runId);
  }), [site.id]);

  useEffect(() => {
    try {
      const storedRunId = sessionStorage.getItem(activeSiteEditRunStorageKey(site.id));
      setRecoveringRunId(storedRunId);
      setActiveRunId(storedRunId);
    } catch {
      setRecoveringRunId(null);
      setActiveRunId(null);
    }
  }, [site.id]);

  useEffect(() => {
    if (!recoveringRunId) return;
    let active = true;
    let timer: number | undefined;
    const clearRecovery = () => {
      try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
      if (active) {
        setRecoveringRunId(null);
        setActiveRunId(null);
        setStopRequested(false);
      }
    };
    const recover = async () => {
      const result = await getHostedSiteEditRun(site.id, recoveringRunId);
      if (!active) return;
      if (!result.success) {
        if (result.error?.code === 'NOT_FOUND') {
          clearRecovery();
          setGenerating(false);
          setPhase('修改任务不存在，请从版本记录确认是否已经生成草稿');
          setRecoveryNotice({
            title: '未找到上次修改任务',
            detail: '任务可能已经结束或被清理。先刷新版本记录；如果没有草稿，原修改要求仍保留，可再次生成。',
            action: 'history',
          });
          return;
        }
        setGenerating(true);
        setPhase('暂时无法读取修改进度，正在自动重试');
        timer = window.setTimeout(recover, 2000);
        return;
      }

      setPhase(result.data.phase);
      setProgress(siteEditDisplayProgress('incomplete', result.data.progress));
      setActiveRunRuntime(result.data.runtime);
      setResolvedModel(resolveRunModelBadge(result.data));
      setRunInfo({ styleName: result.data.styleName, promptFingerprint: result.data.promptFingerprint });
      setRunStartedAtMs(Date.parse(result.data.createdAt));
      const status = result.data.status.toLowerCase();
      if (status === 'done' && result.data.artifactRevisionId) {
        clearRecovery();
        setGenerating(false);
        await openRevision(result.data.artifactRevisionId);
        await loadHistory();
        return;
      }
      if (status === 'cancelled') {
        clearRecovery();
        setGenerating(false);
        setThinking('');
        setPreviewHtml('');
        setPreviewUrl(null);
        streamRef.current = '';
        setPhase('修改任务已停止，线上版本没有变化');
        setRecoveryNotice(null);
        return;
      }
      if (status === 'error') {
        clearRecovery();
        setGenerating(false);
        beginRuntimeRecovery(result.data.runtime);
        const detail = result.data.error || result.data.phase || '页面修改失败';
        setProgress((current) => siteEditDisplayProgress('incomplete', current));
        setPhase(detail);
        setRecoveryNotice({
          title: '页面修改未完成',
          detail: generationRecoveryDetail(detail),
          action: 'generate',
        });
        return;
      }

      setGenerating(true);
      timer = window.setTimeout(recover, 1500);
    };
    void recover();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [beginRuntimeRecovery, loadHistory, openRevision, recoveringRunId, site.id]);

  const generate = async () => {
    const text = instruction.trim();
    if (!text || generating) return;
    if (screenshots.busy) {
      toast.info('截图还在上传', '等缩略图显示「可以用」后再生成');
      return;
    }
    const requestRuntime = enabledRuntimes.find((item) => item.id === selectedRuntime) ?? enabledRuntimes[0];
    if (!requestRuntime) {
      setRecoveryNotice({
        title: '没有可用的设计执行器',
        detail: '执行器当前未就绪，线上版本没有变化。请稍后刷新页面再试。',
        action: 'generate',
      });
      toast.error('没有可用的设计执行器', '请检查执行器部署状态后重试');
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    busyRef.current = true;
    setGenerating(true);
    setElapsedSeconds(0);
    setRunStartedAtMs(Date.now());
    setActiveRunRuntime(requestRuntime.id);
    // 徽章必须在进入 generating 的同一拍清掉。原先它排在 createHostedSiteEditRun 之后，
    // 于是新任务创建期间顶上挂的是上一轮的模型；创建失败时那个模型更会被留在一次
    // 根本没发生的调用上——「读不到模型」长得跟「这次用的是它」一模一样。
    setResolvedModel(null);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewFromEvent(false);
    previewRevisionRef.current = -1;
    setRunInfo(null);
    setPreviewUrl(null);
    setPreviewedRevision(null);
    setRecoveryNotice(null);
    setRuntimeRecoveryGate(null);
    setProgress(1);
    setPhase('正在创建修改任务');
    streamRef.current = '';
    setRecoveringRunId(null);
    setActiveRunId(null);
    setStopRequested(false);

    if (selectedKnowledge.some((entry) => !entry.entryId || !entry.storeId)) {
      setGenerating(false);
      setPhase('引用知识身份不完整，请重新选择');
      setRecoveryNotice({
        title: '引用知识需要重新确认',
        detail: '知识条目已经变化。请取消失效条目或刷新页面后重新选择，线上版本没有变化。',
        action: 'generate',
      });
      toast.error('无法校验引用知识', '请刷新知识列表后重新选择');
      return;
    }
    const knowledgeReferences = selectedKnowledge.map((entry) => ({
      entryId: entry.entryId,
      storeId: entry.storeId,
    }));
    const created = await createHostedSiteEditRun(site.id, text, knowledgeReferences, requestRuntime.id, {
      // 只有精细设计收截图；换成快速修改时已加的截图保留在面板上，但不随这次请求提交。
      screenshotAttachmentIds: screenshotRuntimeSupported(requestRuntime.id) ? screenshots.readyIds : [],
    });
    // 创建期间工作台被关掉或重开：这个实例已经不是用户眼前那一个，交出去，别再往下走。
    if (abort.signal.aborted) {
      if (created.success) handOffOrphanedEditRun(site.id, created.data.runId);
      return;
    }
    if (!created.success) {
      setGenerating(false);
      if (created.error?.code === 'RUNTIME_NOT_READY') beginRuntimeRecovery(requestRuntime.id);
      setActiveRunRuntime(created.error?.code === 'RUNTIME_NOT_READY' ? requestRuntime.id : null);
      const detail = created.error?.message || '请稍后重试';
      setPhase(detail);
      setRecoveryNotice({
        title: '无法开始修改',
        detail: generationRecoveryDetail(detail),
        action: 'generate',
      });
      toast.error('无法开始修改', detail);
      return;
    }
    setActiveRunRuntime(created.data.runtime);
    setActiveRunId(created.data.runId);
    setRunInfo({ styleName: created.data.styleName, promptFingerprint: created.data.promptFingerprint });
    try { sessionStorage.setItem(activeSiteEditRunStorageKey(site.id), created.data.runId); } catch { /* ignore unavailable storage */ }

    let reachedTerminal = false;
    let handedOffToRecovery = false;
    try {
      await streamHostedSiteEditRun({
        siteId: site.id,
        runId: created.data.runId,
        signal: abort.signal,
        onEvent: (event) => {
          if (!event.data) return;
          let data: Record<string, unknown>;
          try { data = JSON.parse(event.data) as Record<string, unknown>; }
          catch { return; }

          if (event.event === 'phase') {
            const item = data as PhaseEvent;
            if (typeof item.message === 'string') setPhase(item.message);
            if (typeof item.progress === 'number') {
              setProgress(siteEditDisplayProgress('incomplete', item.progress));
            }
            return;
          }
          // 实际执行的模型只在流的开头来一次；顶部展示，值来自后端不推断
          //（.claude/rules/ai-model-visibility.md）。
          if (event.event === 'model' && typeof data.model === 'string' && data.model.trim()) {
            setResolvedModel({
              model: data.model,
              platform: typeof data.platform === 'string' && data.platform.trim() ? data.platform : GATEWAY_PLATFORM_FALLBACK,
            });
            return;
          }
          if (event.event === 'thinking' && typeof data.text === 'string') {
            const narration = data.text;
            setThinking((prev) => appendRunNarration(prev, narration, 500));
            return;
          }
          if (event.event === 'preview' && typeof data.html === 'string' && data.html.trim()) {
            // OpenDesign 写出或更新页面时推整页正文：整页替换，旧 revision（断线重放）丢弃。
            const revision = typeof data.revision === 'number' ? data.revision : 0;
            if (!isNewerPreviewRevision(revision, previewRevisionRef.current)) return;
            previewRevisionRef.current = revision;
            const html = designPreviewEventDocument(data.html);
            if (html) {
              setPreviewUrl(null);
              setPreviewFromEvent(true);
              setPreviewHtml(html);
            }
            return;
          }
          if (event.event === 'delta' && typeof data.text === 'string') {
            streamRef.current += data.text;
            // 已有 preview 事件时以它为准，delta 只是模型原文。
            if (previewRevisionRef.current >= 0) return;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= 250) {
              const html = previewableAiStreamHtml(streamRef.current);
              if (html) {
                setPreviewUrl(null);
                setPreviewHtml(html);
              }
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (event.event === 'done' && typeof data.revisionId === 'string') {
            reachedTerminal = true;
            try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
            setActiveRunId(null);
            setStopRequested(false);
            setDraftRevisionId(data.revisionId);
            setDraftRevisionStatus('draft');
            setProgress(siteEditDisplayProgress('draft-ready'));
            setPhase('草稿已生成，请预览确认后再发布');
            setRecoveryNotice(null);
            void openRevision(data.revisionId);
            void loadHistory();
            return;
          }
          if (event.event === 'cancelled'
            || (event.event === 'error' && data.code === 'DESIGN_ARTIFACT_CANCELLED')) {
            reachedTerminal = true;
            try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
            setActiveRunId(null);
            setStopRequested(false);
            setGenerating(false);
            setThinking('');
            setPreviewHtml('');
            setPreviewUrl(null);
            streamRef.current = '';
            setPhase('修改任务已停止，线上版本没有变化');
            setRecoveryNotice(null);
            toast.info('修改任务已停止', '没有生成或发布新版本');
            return;
          }
          if (event.event === 'error') {
            reachedTerminal = true;
            const message = typeof data.message === 'string' ? data.message : '页面修改失败';
            beginRuntimeRecovery(requestRuntime.id);
            try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
            setGenerating(false);
            setProgress((current) => siteEditDisplayProgress('incomplete', current));
            setPhase(message);
            setRecoveryNotice({
              title: '页面修改未完成',
              detail: generationRecoveryDetail(message),
              action: 'generate',
            });
            toast.error('页面修改失败', message);
          }
        },
      });
      if (!abort.signal.aborted && !reachedTerminal) {
        handedOffToRecovery = true;
        setPhase('进度连接已结束，正在继续确认任务结果');
        setRecoveringRunId(created.data.runId);
      }
    } catch {
      if (!abort.signal.aborted && !reachedTerminal) {
        handedOffToRecovery = true;
        setPhase('修改进度连接中断，正在自动恢复');
        toast.error('修改进度中断', '任务仍在服务器执行，系统会自动找回进度和草稿');
        setRecoveringRunId(created.data.runId);
      }
    } finally {
      if (!handedOffToRecovery) setGenerating(false);
    }
  };

  const stopGeneration = async () => {
    if (!activeRunId || stopRequested) return;
    setStopRequested(true);
    setPhase('正在安全停止设计任务');
    const result = await cancelHostedSiteEditRun(site.id, activeRunId);
    if (!result.success) {
      setStopRequested(false);
      const detail = result.error?.message || '停止请求未送达，任务仍在服务器执行';
      setPhase('停止请求未完成，正在继续确认任务结果');
      toast.error('暂时无法停止', detail);
      return;
    }
    if (result.data.status.toLowerCase() === 'cancelled') {
      abortRef.current?.abort();
      try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
      setActiveRunId(null);
      setRecoveringRunId(null);
      setGenerating(false);
      setStopRequested(false);
      setThinking('');
      setPreviewHtml('');
      setPreviewUrl(null);
      streamRef.current = '';
      setPhase('修改任务已停止，线上版本没有变化');
      setRecoveryNotice(null);
      toast.info('修改任务已停止', '没有生成或发布新版本');
      return;
    }
    setPhase('停止请求已送达，正在结束当前设计步骤');
  };

  const publish = async (revisionId: string) => {
    setMutatingId(revisionId);
    setMutatingAction('publish');
    const result = await publishHostedSiteRevision(site.id, revisionId);
    setMutatingId(null);
    setMutatingAction(null);
    if (!result.success) {
      const detail = result.error?.message || '请刷新后重试';
      setRecoveryNotice({
        title: '发布未完成',
        detail: result.error?.code === 'REVISION_CONFLICT'
          ? `${detail}。当前线上版本仍然有效。请先刷新版本记录，或按原修改要求另存一个新草稿。`
          : `${detail}。当前线上版本仍然有效，可直接重试发布。`,
        action: 'publish',
        revisionId,
        versionConflict: result.error?.code === 'REVISION_CONFLICT',
      });
      toast.error('发布失败', detail);
      setProgress((current) => siteEditDisplayProgress('incomplete', current));
      await loadHistory();
      if (draftRevisionId === revisionId) await openRevision(revisionId);
      return;
    }
    onPublished(result.data.site);
    setRecoveryNotice(null);
    setPreviewedRevision(result.data.revision);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setProgress(siteEditDisplayProgress('published'));
    setPhase('新版本已经发布');
    toast.success('新版本已经发布');
    await loadHistory();
  };

  const rollback = async (revisionId: string, idempotencyKey: string) => {
    setMutatingId(revisionId);
    setMutatingAction('rollback');
    const result = await rollbackHostedSiteRevision(site.id, revisionId, idempotencyKey);
    setMutatingId(null);
    setMutatingAction(null);
    if (!result.success) {
      const detail = result.error?.message || '请刷新后重试';
      setRecoveryNotice({
        title: '回退未完成',
        detail: result.error?.code === 'REVISION_CONFLICT'
          ? `${detail}。当前线上版本没有变化。请先刷新版本记录，或按原要求另存一个新草稿。`
          : `${detail}。当前线上版本没有变化，可再次尝试。`,
        action: 'rollback',
        revisionId,
        idempotencyKey,
        versionConflict: result.error?.code === 'REVISION_CONFLICT',
      });
      toast.error('回退失败', detail);
      setProgress((current) => siteEditDisplayProgress('incomplete', current));
      return;
    }
    onPublished(result.data.site);
    setRecoveryNotice(null);
    setPreviewHtml('');
    setPreviewUrl(null);
    setPreviewedRevision(null);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setProgress(siteEditDisplayProgress('published'));
    setPhase('旧内容已作为一个新版本重新发布');
    toast.success('已经回退并发布为新版本');
    await loadHistory();
  };

  const reject = async (revisionId: string, reason: string) => {
    setMutatingId(revisionId);
    setMutatingAction('reject');
    const result = await rejectHostedSiteRevision(site.id, revisionId, reason);
    setMutatingId(null);
    setMutatingAction(null);
    if (!result.success) {
      const detail = result.error?.message || '请刷新后重试';
      setRecoveryNotice({
        title: '拒绝草稿未完成',
        detail: result.error?.code === 'REVISION_CONFLICT'
          ? `${detail}。线上版本没有变化，请刷新版本记录确认草稿当前状态。`
          : `${detail}。线上版本没有变化，可再次尝试。`,
        action: result.error?.code === 'REVISION_CONFLICT' ? 'history' : 'reject',
        revisionId,
        rejectionReason: reason,
      });
      toast.error('拒绝草稿失败', detail);
      await loadHistory();
      return;
    }
    setRecoveryNotice(null);
    if (draftRevisionId === revisionId) {
      setPreviewHtml('');
      setPreviewUrl(null);
      setPreviewedRevision(null);
      setDraftRevisionId(null);
      setDraftRevisionStatus(null);
    }
    setPhase(result.data.changed ? '草稿已拒绝，线上版本没有变化' : '该草稿已经处于拒绝状态');
    toast.success(result.data.changed ? '草稿已拒绝' : '草稿此前已经拒绝');
    await loadHistory();
  };


  const retryRecovery = () => {
    if (!recoveryNotice) return;
    const revisionId = recoveryNotice.revisionId;
    if (recoveryNotice.action === 'generate') void generate();
    else if (recoveryNotice.action === 'history') void loadHistory();
    else if (recoveryNotice.action === 'preview' && revisionId) void openRevision(revisionId);
    else if (recoveryNotice.action === 'publish' && revisionId) void publish(revisionId);
    else if (recoveryNotice.action === 'rollback' && revisionId && recoveryNotice.idempotencyKey)
      void rollback(revisionId, recoveryNotice.idempotencyKey);
    else if (recoveryNotice.action === 'reject' && revisionId) {
      void reject(revisionId, recoveryNotice.rejectionReason || '');
    }
  };

  return {
    instruction,
    setInstruction,
    phase,
    setPhase,
    progress,
    setProgress,
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
    defaultRuntime,
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
  };
}

export type SiteEditSession = ReturnType<typeof useSiteEditSession>;
