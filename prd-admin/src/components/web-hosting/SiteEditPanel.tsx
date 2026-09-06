import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Check, Clock3, Eye, History, RefreshCw, RotateCcw, Send, Server, WandSparkles, X } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createHostedSiteEditRun,
  getDesignRuntimeCapabilities,
  getHostedSiteEditRun,
  listHostedSiteRevisions,
  previewHostedSiteRevision,
  publishHostedSiteRevision,
  rollbackHostedSiteRevision,
  streamHostedSiteEditRun,
  type HostedSite,
  type HostedSiteRevision,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  activeSiteEditRunStorageKey,
  canPublishRevision,
  chooseDesignRuntime,
  displayedDesignRuntime,
  elapsedSecondsSince,
  previewableAiStreamHtml,
  revisionLabel,
} from './siteEditPreview';

interface Props {
  site: HostedSite;
  onPublished: (site: HostedSite) => void;
  /** 由卡片或预览顶栏决定先看修改输入还是版本历史。 */
  focusSection?: 'compose' | 'history';
}

interface PhaseEvent {
  progress?: number;
  message?: string;
}

type RecoveryAction = 'generate' | 'history' | 'preview' | 'publish' | 'rollback';

interface RecoveryNotice {
  title: string;
  detail: string;
  action: RecoveryAction;
  revisionId?: string;
  versionConflict?: boolean;
}

const GENERATION_STAGES = [
  { label: '建立任务', threshold: 1 },
  { label: '读取与分析', threshold: 20 },
  { label: '生成页面', threshold: 60 },
  { label: '人工确认', threshold: 100 },
] as const;

function formatRevisionTime(value?: string | null) {
  if (!value) return '尚未发布';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

export default function SiteEditPanel({ site, onPublished, focusSection = 'compose' }: Props) {
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState('告诉我你想改什么，系统会先生成草稿，不会直接覆盖线上页面。');
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [activeRunRuntime, setActiveRunRuntime] = useState<string | null>(null);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewedRevision, setPreviewedRevision] = useState<HostedSiteRevision | null>(null);
  const [draftRevisionId, setDraftRevisionId] = useState<string | null>(null);
  const [draftRevisionStatus, setDraftRevisionStatus] = useState<'draft' | 'publishing' | null>(null);
  const [revisions, setRevisions] = useState<HostedSiteRevision[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(true);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState('map-gateway');
  const [recoveringRunId, setRecoveringRunId] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const [pendingRollback, setPendingRollback] = useState<HostedSiteRevision | null>(null);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const composeRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const rollbackConfirmRef = useRef<HTMLButtonElement | null>(null);
  const rollbackReturnFocusRef = useRef<HTMLButtonElement | null>(null);

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
    if (!generating || runStartedAtMs == null) return;
    const tick = () => setElapsedSeconds(elapsedSecondsSince(runStartedAtMs));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generating, runStartedAtMs]);

  useEffect(() => {
    if (!pendingRollback) return;
    const frame = window.requestAnimationFrame(() => rollbackConfirmRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRollback]);
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
      setRecoveryNotice((current) => current?.action === 'history' ? null : current);
    } else {
      const detail = result.error?.message || '请稍后重试';
      setRecoveryNotice({ title: '版本记录读取失败', detail, action: 'history' });
      toast.error('版本记录读取失败', detail);
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

  const toggleKnowledge = (entryId: string) => {
    setSelectedKnowledgeIds((current) => {
      if (current.includes(entryId)) return current.filter((id) => id !== entryId);
      if (current.length >= 3) {
        toast.info('首版一次最多引用 3 篇知识');
        return current;
      }
      return [...current, entryId];
    });
  };

  const openRevision = useCallback(async (revisionId: string) => {
    const result = await previewHostedSiteRevision(site.id, revisionId);
    if (!result.success) {
      const detail = result.error?.message || '请稍后重试';
      setRecoveryNotice({ title: '版本预览失败', detail, action: 'preview', revisionId });
      toast.error('版本预览失败', detail);
      return;
    }
    setRecoveryNotice((current) => current?.action === 'preview' ? null : current);
    setPreviewHtml(result.data.html);
    setPreviewedRevision(result.data.revision);
    const publishable = canPublishRevision(result.data.revision);
    if (publishable && result.data.revision.instruction) {
      setInstruction((current) => current.trim() ? current : result.data.revision.instruction || current);
    }
    setDraftRevisionId(publishable ? revisionId : null);
    setDraftRevisionStatus(
      result.data.revision.status === 'draft' || result.data.revision.status === 'publishing'
        ? result.data.revision.status
        : null,
    );
    setPhase(revisionLabel(result.data.revision));
    setProgress(publishable ? 95 : 100);
  }, [site.id]);

  useEffect(() => {
    try {
      setRecoveringRunId(sessionStorage.getItem(activeSiteEditRunStorageKey(site.id)));
    } catch {
      setRecoveringRunId(null);
    }
  }, [site.id]);

  useEffect(() => {
    if (!recoveringRunId) return;
    let active = true;
    let timer: number | undefined;
    const clearRecovery = () => {
      try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
      if (active) setRecoveringRunId(null);
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
      setProgress(result.data.progress);
      setActiveRunRuntime(result.data.runtime);
      setRunStartedAtMs(Date.parse(result.data.createdAt));
      const status = result.data.status.toLowerCase();
      if (status === 'done' && result.data.artifactRevisionId) {
        clearRecovery();
        setGenerating(false);
        await openRevision(result.data.artifactRevisionId);
        await loadHistory();
        return;
      }
      if (status === 'error' || status === 'cancelled') {
        clearRecovery();
        setGenerating(false);
        const detail = result.data.error || result.data.phase || '页面修改失败';
        setPhase(detail);
        setRecoveryNotice({
          title: '页面修改未完成',
          detail: `${detail}。线上版本没有变化，修改要求已保留。`,
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
  }, [loadHistory, openRevision, recoveringRunId, site.id]);

  const generate = async () => {
    const text = instruction.trim();
    if (!text || generating) return;
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
    setGenerating(true);
    setElapsedSeconds(0);
    setRunStartedAtMs(Date.now());
    setActiveRunRuntime(requestRuntime.id);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewedRevision(null);
    setRecoveryNotice(null);
    setProgress(1);
    setPhase('正在创建修改任务');
    streamRef.current = '';
    setRecoveringRunId(null);

    const selectedEntries = selectedKnowledgeIds
      .map((entryId) => recentKnowledge.find((item) => item.id === entryId))
      .filter((entry): entry is RecentDocumentEntry => !!entry);
    if (selectedEntries.length !== selectedKnowledgeIds.length || selectedEntries.some((entry) => !entry.storeId)) {
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
    const knowledgeReferences = selectedEntries.map((entry) => ({
      entryId: entry.id,
      storeId: entry.storeId,
    }));
    const created = await createHostedSiteEditRun(site.id, text, knowledgeReferences, requestRuntime.id);
    if (!created.success) {
      setGenerating(false);
      setActiveRunRuntime(null);
      const detail = created.error?.message || '请稍后重试';
      setPhase(detail);
      setRecoveryNotice({
        title: '无法开始修改',
        detail: `${detail}。线上版本没有变化，修改要求已保留。`,
        action: 'generate',
      });
      toast.error('无法开始修改', detail);
      return;
    }
    setActiveRunRuntime(created.data.runtime);
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
            if (typeof item.progress === 'number') setProgress(item.progress);
            return;
          }
          if (event.event === 'thinking' && typeof data.text === 'string') {
            setThinking((prev) => `${prev}${data.text}`.slice(-500));
            return;
          }
          if (event.event === 'delta' && typeof data.text === 'string') {
            streamRef.current += data.text;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= 250) {
              const html = previewableAiStreamHtml(streamRef.current);
              if (html) setPreviewHtml(html);
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (event.event === 'done' && typeof data.revisionId === 'string') {
            reachedTerminal = true;
            try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
            setDraftRevisionId(data.revisionId);
            setDraftRevisionStatus('draft');
            setProgress(100);
            setPhase('草稿已生成，请预览确认后再发布');
            setRecoveryNotice(null);
            void openRevision(data.revisionId);
            void loadHistory();
            return;
          }
          if (event.event === 'error') {
            reachedTerminal = true;
            const message = typeof data.message === 'string' ? data.message : '页面修改失败';
            try { sessionStorage.removeItem(activeSiteEditRunStorageKey(site.id)); } catch { /* ignore unavailable storage */ }
            setGenerating(false);
            setPhase(message);
            setRecoveryNotice({
              title: '页面修改未完成',
              detail: `${message}。线上版本没有变化，修改要求已保留。`,
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

  const publish = async (revisionId: string) => {
    setMutatingId(revisionId);
    const result = await publishHostedSiteRevision(site.id, revisionId);
    setMutatingId(null);
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
      await loadHistory();
      if (draftRevisionId === revisionId) await openRevision(revisionId);
      return;
    }
    onPublished(result.data.site);
    setRecoveryNotice(null);
    setPreviewedRevision(result.data.revision);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setPhase('新版本已经发布');
    toast.success('新版本已经发布');
    await loadHistory();
  };

  const rollback = async (revisionId: string) => {
    setMutatingId(revisionId);
    const result = await rollbackHostedSiteRevision(site.id, revisionId);
    setMutatingId(null);
    if (!result.success) {
      const detail = result.error?.message || '请刷新后重试';
      setRecoveryNotice({
        title: '回退未完成',
        detail: result.error?.code === 'REVISION_CONFLICT'
          ? `${detail}。当前线上版本没有变化。请先刷新版本记录，或按原要求另存一个新草稿。`
          : `${detail}。当前线上版本没有变化，可再次尝试。`,
        action: 'rollback',
        revisionId,
        versionConflict: result.error?.code === 'REVISION_CONFLICT',
      });
      toast.error('回退失败', detail);
      return;
    }
    onPublished(result.data.site);
    setRecoveryNotice(null);
    setPreviewHtml('');
    setPreviewedRevision(null);
    setDraftRevisionId(null);
    setDraftRevisionStatus(null);
    setPhase('旧内容已作为一个新版本重新发布');
    toast.success('已经回退并发布为新版本');
    await loadHistory();
  };

  const requestRollback = (revision: HostedSiteRevision, trigger: HTMLButtonElement) => {
    rollbackReturnFocusRef.current = trigger;
    setRecoveryNotice(null);
    setPendingRollback(revision);
  };

  const cancelRollback = () => {
    setPendingRollback(null);
    window.requestAnimationFrame(() => rollbackReturnFocusRef.current?.focus());
  };

  const confirmRollback = () => {
    if (!pendingRollback) return;
    const revisionId = pendingRollback.id;
    setPendingRollback(null);
    void rollback(revisionId);
  };

  const retryRecovery = () => {
    if (!recoveryNotice) return;
    const revisionId = recoveryNotice.revisionId;
    if (recoveryNotice.action === 'generate') void generate();
    else if (recoveryNotice.action === 'history') void loadHistory();
    else if (recoveryNotice.action === 'preview' && revisionId) void openRevision(revisionId);
    else if (recoveryNotice.action === 'publish' && revisionId) void publish(revisionId);
    else if (recoveryNotice.action === 'rollback' && revisionId) void rollback(revisionId);
  };

  const recoveryActionLabel = recoveryNotice?.action === 'history'
    ? '刷新版本记录'
    : recoveryNotice?.action === 'preview'
      ? '重新预览'
      : recoveryNotice?.action === 'publish'
        ? '重试发布'
        : recoveryNotice?.action === 'rollback'
          ? '重试回退'
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
                  disabled={generating || mutatingId !== null}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 text-[11px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <RefreshCw size={13} />{recoveryActionLabel}
                </button>
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
          {capabilities.length > 0 && (
            <details className="group mt-3 rounded-lg border border-token-subtle bg-token-nested text-[10px] leading-relaxed text-token-muted">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 font-medium text-token-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
                <span className="flex items-center gap-1.5"><Server size={12} />执行器与限制</span>
                <span className="max-w-36 truncate font-normal text-token-muted">{activeRuntime?.label || '当前执行器'}</span>
              </summary>
              <div className="border-t border-token-subtle px-2.5 pb-2.5 pt-2">
                <p>{activeRuntimeFact}</p>
                <p className="mt-1">
                  首版仅支持声明式自包含 HTML，含脚本、外链或 ZIP 资源会在任务创建前提示。
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
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-1.5 font-medium"><BookOpen size={13} />引用知识库</span>
              <span className="text-token-muted">{selectedKnowledgeIds.length}/3</span>
            </div>
            {loadingKnowledge ? (
              <p className="mt-2 text-[10px] text-token-muted" role="status" aria-live="polite">正在读取最近知识</p>
            ) : recentKnowledge.length === 0 ? (
              <p className="mt-2 text-[10px] text-token-muted">最近没有可引用的知识。</p>
            ) : (
              <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {recentKnowledge.map((item) => {
                  const selected = selectedKnowledgeIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={generating}
                      onClick={() => toggleKnowledge(item.id)}
                      title={`${item.storeName} / ${item.title}`}
                      className={`flex min-h-11 max-w-full items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}
                    >
                      <span className="truncate">{item.title}</span>
                      {selected && <X size={10} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating || instruction.trim().length === 0}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {generating ? <MapSpinner size={14} /> : <Send size={14} />}
            {generating ? '草稿生成中，线上未改变' : '生成修改草稿'}
          </button>
        </div>

        {(generating || previewHtml) && (
          <section
            aria-label="AI 修改进度"
            className="border-b border-token-subtle p-3 sm:p-4"
          >
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-token-primary">
                    {generating ? 'AI 正在生成隔离草稿' : recoveryNotice ? '未完成的草稿预览' : '版本预览已就绪'}
                  </div>
                  <p role="status" aria-live="polite" aria-atomic="true" className="mt-1 text-[11px] leading-relaxed text-token-muted">{phase}</p>
                </div>
                <div className="shrink-0 text-right text-[10px] text-token-muted">
                  <div className="max-w-28 truncate text-token-secondary">{activeRuntime?.label || '设计执行器'}</div>
                  <div className="mt-0.5 tabular-nums">{progress}% · {elapsedSeconds} 秒</div>
                </div>
              </div>

              <ol className="mt-3 grid grid-cols-4 gap-1" aria-label="草稿生成阶段">
                {GENERATION_STAGES.map((item, index) => {
                  const complete = index < generationStageIndex
                    || (index === generationStageIndex && !generating && !!previewHtml);
                  const current = index === generationStageIndex && !complete;
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
                aria-valuenow={progress}
              >
                <div className="h-full bg-blue-500 transition-all duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
              </div>
              {thinking && generating && (
                <div className="mt-2 rounded-lg bg-token-nested px-2.5 py-2 text-[10px] leading-relaxed text-token-muted">
                  <span className="font-medium text-token-secondary">正在分析：</span>{thinking}
                </div>
              )}
            </div>

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
                  <button
                    type="button"
                    disabled={mutatingId === draftRevisionId}
                    onClick={() => void publish(draftRevisionId)}
                    className="flex min-h-11 items-center gap-1 rounded-md bg-emerald-600 px-3 font-medium text-white hover:bg-emerald-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    {mutatingId === draftRevisionId ? <MapSpinner size={12} /> : <Check size={12} />}
                    {draftRevisionStatus === 'publishing' ? '重试发布' : '确认并发布'}
                  </button>
                )}
              </div>
              <iframe
                srcDoc={previewHtml}
                sandbox={AI_STREAM_PREVIEW_SANDBOX}
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
          {loadingHistory ? (
            <MapSectionLoader text="正在读取版本记录" />
          ) : revisions.length === 0 ? (
            <p className="text-[11px] text-token-muted">尚无版本记录。</p>
          ) : (
            <div className="space-y-2">
              {revisions.map((item) => {
                const selected = previewedRevision?.id === item.id;
                const parentRevision = item.parentRevisionId
                  ? revisions.find((candidate) => candidate.id === item.parentRevisionId)
                  : null;
                const sourceVersion = !item.parentRevisionId
                  ? '初始版本'
                  : parentRevision
                    ? `${revisionLabel(parentRevision)} · ${parentRevision.id.slice(-6)}`
                    : `历史版本 · ${item.parentRevisionId.slice(-6)}`;
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
                      : 'border-token-subtle bg-token-nested';
                const statusDescription = item.isCurrent
                  ? '访客当前看到的线上内容'
                  : item.status === 'draft' || item.status === 'publishing'
                    ? '仅你可见，尚未影响线上页面'
                    : '历史快照，可预览或回退到此版本';
                return (
                <div key={item.id} aria-current={item.isCurrent ? 'true' : undefined} className={`rounded-lg border p-2.5 ${statusClass}`}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="text-xs font-semibold">{revisionLabel(item)}</div>
                        {selected && <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-500">预览中</span>}
                      </div>
                      <p className="mt-1 text-[11px] text-token-secondary">{statusDescription}</p>
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-token-muted">
                        <Clock3 size={10} />{formatRevisionTime(item.publishedAt || item.createdAt)}
                      </div>
                      <p className="mt-1 text-[10px] text-token-muted">
                        来源动作：{sourceAction} · 来源版本：{sourceVersion}
                      </p>
                      {item.instruction && <p className="mt-1 line-clamp-2 text-[10px] text-token-muted">{item.instruction}</p>}
                      {item.knowledgeEntryIds.length > 0 && (
                        <p className="mt-1 text-[10px] text-token-muted">引用了 {item.knowledgeEntryIds.length} 篇知识</p>
                      )}
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
                          {mutatingId === item.id ? <MapSpinner size={13} /> : <RotateCcw size={13} />}
                          回退到此版
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
                          {mutatingId === item.id ? <MapSpinner size={13} /> : <Check size={13} />}
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
