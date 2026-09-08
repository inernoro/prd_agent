import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, Send, Server, Square } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import KnowledgeEntryPicker, { type KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createDesignArtifactRun,
  cancelDesignArtifactRun,
  getDesignArtifactRun,
  getDesignRuntimeCapabilities,
  streamDesignArtifactRun,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  chooseDesignRuntime,
  displayedDesignRuntime,
  elapsedSecondsSince,
  previewableAiStreamHtml,
  runningGenerationActivity,
} from './siteEditPreview';
import {
  parseSiteGenerationProgressEvent,
  resolveGeneratedSiteId,
} from './siteGenerateProgress';

export interface SiteGenerateSource {
  entryId: string;
  storeId: string;
  title: string;
  storeName?: string;
}

interface Props {
  open: boolean;
  initialSource?: SiteGenerateSource | null;
  onClose: () => void;
  onCreated: (siteId: string) => void;
}

const ACTIVE_GENERATION_RUN_KEY = 'web-hosting-design-active-run-v1';

export default function SiteGenerateDialog({ open, initialSource, onClose, onCreated }: Props) {
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntrySelection[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState('map-gateway');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState('选择知识，再用两句话说明页面给谁看、希望达到什么效果。');
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [activeRunRuntime, setActiveRunRuntime] = useState<string | null>(null);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [generating, setGenerating] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [completedSite, setCompletedSite] = useState<{ id: string; url?: string } | null>(null);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!generating || runStartedAtMs == null) return;
    const tick = () => setElapsedSeconds(elapsedSecondsSince(runStartedAtMs));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generating, runStartedAtMs]);
  const onCreatedRef = useRef(onCreated);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  const finishGeneration = useCallback((siteId: string, siteUrl?: string) => {
    const finalPreview = previewableAiStreamHtml(streamRef.current);
    if (finalPreview) setPreviewHtml(finalPreview);
    setCompletedSite({ id: siteId, url: siteUrl });
    setProgress(100);
    setPhase('网页已生成并保存，可在网页托管中继续修改和发布分享');
    setGenerating(false);
    setActiveRunId(null);
    setStopRequested(false);
    sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
    onCreatedRef.current(siteId);
  }, []);

  const recoverActiveRun = useCallback(async (runId: string, signal: AbortSignal) => {
    let failedReads = 0;
    while (!signal.aborted) {
      const result = await getDesignArtifactRun(runId);
      if (signal.aborted) return;
      if (!result.success) {
        failedReads += 1;
        setGenerating(true);
        setPhase(failedReads === 1
          ? '实时连接已中断，正在从服务器恢复任务状态'
          : '仍在等待服务器恢复任务状态');
      } else {
        failedReads = 0;
        setPhase(result.data.phase || '正在恢复网页生成进度');
        setProgress(result.data.progress);
        setActiveRunRuntime(result.data.runtime);
        setRunStartedAtMs(Date.parse(result.data.createdAt));
        const status = result.data.status.toLowerCase();
        const siteId = resolveGeneratedSiteId(result.data);
        if (status === 'done' && siteId) {
          finishGeneration(siteId);
          return;
        }
        if (status === 'done') {
          setGenerating(false);
          setPhase('网页任务已结束，但未找到可打开的产物，请重新生成');
          sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
          return;
        }
        if (status === 'error' || status === 'cancelled') {
          const message = status === 'cancelled'
            ? '网页生成已取消，未保存或发布新页面'
            : result.data.error || '网页生成未完成，请重新发起';
          setGenerating(false);
          setActiveRunId(null);
          setStopRequested(false);
          setPhase(message);
          sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
          return;
        }
        setGenerating(true);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
    }
  }, [finishGeneration]);

  useEffect(() => {
    if (!open) return;
    setLoadingKnowledge(true);
    setTitle(initialSource?.title || '');
    setInstruction('');
    setPhase('选择知识，再用两句话说明页面给谁看、希望达到什么效果。');
    setProgress(0);
    setElapsedSeconds(0);
    setRunStartedAtMs(null);
    setActiveRunRuntime(null);
    setThinking('');
    setPreviewHtml('');
    setCompletedSite(null);
    setActiveRunId(null);
    setStopRequested(false);
    setSelectedKnowledge(initialSource ? [{
      entryId: initialSource.entryId,
      storeId: initialSource.storeId,
      title: initialSource.title,
      storeName: initialSource.storeName || '当前知识库',
    }] : []);
    let active = true;
    void Promise.all([listRecentDocumentEntries(16), getDesignRuntimeCapabilities()]).then(([recent, runtimes]) => {
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
        const runtimeId = chooseDesignRuntime(
          runtimes.data.runtimes,
          runtimes.data.defaultRuntime,
        );
        if (runtimeId) setSelectedRuntime(runtimeId);
      }
      setLoadingKnowledge(false);
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [initialSource, open]);

  useEffect(() => {
    if (!open) return;
    const runId = sessionStorage.getItem(ACTIVE_GENERATION_RUN_KEY);
    if (!runId) return;
    const recovery = new AbortController();
    abortRef.current?.abort();
    abortRef.current = recovery;
    setGenerating(true);
    setActiveRunId(runId);
    setStopRequested(false);
    setPhase('正在恢复上次未完成的网页生成任务');
    void recoverActiveRun(runId, recovery.signal);
    return () => {
      recovery.abort();
    };
  }, [open, recoverActiveRun]);

  const enabledRuntime = capabilities.find((item) => item.id === selectedRuntime && item.enabled)
    ?? capabilities.find((item) => item.enabled);
  const visibleRuntime = displayedDesignRuntime(
    capabilities,
    enabledRuntime?.id ?? selectedRuntime,
    generating ? activeRunRuntime : null,
  ) ?? capabilities[0];
  const unavailableRuntimes = useMemo(
    () => capabilities.filter((item) => !item.enabled),
    [capabilities],
  );

  const generate = async () => {
    const text = instruction.trim();
    if (!text || selectedKnowledge.length === 0 || generating) return;
    if (!enabledRuntime) {
      toast.error('没有可用的设计执行器', '请检查执行器部署状态后重试');
      return;
    }
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setGenerating(true);
    setStopRequested(false);
    setElapsedSeconds(0);
    setRunStartedAtMs(Date.now());
    setActiveRunRuntime(enabledRuntime.id);
    setCompletedSite(null);
    setThinking('');
    setPreviewHtml('');
    setProgress(1);
    setPhase('正在校验所选知识');
    streamRef.current = '';

    if (selectedKnowledge.some((entry) => !entry.entryId || !entry.storeId)) {
      setGenerating(false);
      setActiveRunId(null);
      setPhase('引用知识身份不完整，请重新选择');
      toast.error('无法校验引用知识', '请刷新知识列表后重新选择');
      return;
    }

    const knowledgeReferences = selectedKnowledge.map((entry) => ({
      entryId: entry.entryId,
      storeId: entry.storeId,
    }));
    const created = await createDesignArtifactRun({
      instruction: text,
      title: title.trim() || selectedKnowledge[0].title,
      runtime: enabledRuntime.id,
      sourceSurface: initialSource ? 'knowledge-base' : 'web-hosting',
      knowledgeReferences,
    });
    if (!created.success) {
      setGenerating(false);
      setActiveRunRuntime(null);
      setPhase(created.error?.message || '网页生成任务创建失败');
      toast.error('无法开始生成', created.error?.message || '请稍后重试');
      return;
    }
    setActiveRunRuntime(created.data.runtime);
    setActiveRunId(created.data.runId);
    setRunStartedAtMs(Date.parse(created.data.createdAt));
    sessionStorage.setItem(ACTIVE_GENERATION_RUN_KEY, created.data.runId);

    let terminalObserved = false;
    try {
      await streamDesignArtifactRun({
        runId: created.data.runId,
        signal: abort.signal,
        onEvent: (event) => {
          const item = parseSiteGenerationProgressEvent(event);
          if (item.kind === 'phase') {
            if (item.message) setPhase(item.message);
            if (typeof item.progress === 'number') setProgress(item.progress);
            return;
          }
          if (item.kind === 'thinking') {
            setThinking((previous) => `${previous}${item.text}`.slice(-600));
            return;
          }
          if (item.kind === 'delta') {
            streamRef.current += item.text;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= 200) {
              const html = previewableAiStreamHtml(streamRef.current);
              if (html) setPreviewHtml(html);
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (item.kind === 'done') {
            terminalObserved = true;
            finishGeneration(item.siteId, item.siteUrl);
            return;
          }
          if (item.kind === 'error') {
            terminalObserved = true;
            setGenerating(false);
            setActiveRunId(null);
            setStopRequested(false);
            setPhase(item.message);
            sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
            toast.error('网页生成失败', item.message);
            return;
          }
          if (item.kind === 'cancelled') {
            terminalObserved = true;
            setGenerating(false);
            setActiveRunId(null);
            setStopRequested(false);
            setPreviewHtml('');
            streamRef.current = '';
            setPhase(item.message);
            sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
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
      setGenerating(false);
      setActiveRunId(null);
      setStopRequested(false);
      setPreviewHtml('');
      streamRef.current = '';
      setPhase('网页生成已取消，未保存或发布新页面');
      sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
      return;
    }
    setPhase('服务器正在停止生成，完成前不会保存或发布页面');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="引用知识生成网页"
      description="知识内容负责事实，补充要求负责受众、目的和风格。生成结果会直接保存在网页托管。"
      maxWidth={1080}
      contentClassName="p-4 sm:p-6"
      contentStyle={{
        width: 'min(1080px, calc(100vw - 16px))',
        maxWidth: 'calc(100vw - 16px)',
        height: 'min(760px, calc(100vh - 24px))',
      }}
      content={(
        <div className="grid h-full min-h-0 min-w-0 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 min-w-0 overflow-y-auto rounded-xl border border-token-subtle bg-token-nested p-4">
            <label className="text-xs font-semibold text-token-primary" htmlFor="design-site-title">网页标题</label>
            <input
              id="design-site-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={generating}
              maxLength={200}
              placeholder="默认使用第一篇知识的标题"
              className="mt-2 w-full rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary outline-none focus:border-blue-500 disabled:opacity-60"
            />

            <div className="mt-4">
              <KnowledgeEntryPicker
                recentEntries={recentKnowledge}
                selectedEntries={selectedKnowledge}
                onChange={setSelectedKnowledge}
                loadingRecent={loadingKnowledge}
                disabled={generating}
              />
            </div>

            <label className="mt-4 block text-xs font-semibold text-token-primary" htmlFor="design-site-instruction">补充两句话</label>
            <textarea
              id="design-site-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={generating}
              maxLength={4000}
              rows={5}
              placeholder="例如：做成给潜在客户看的产品介绍页。重点突出三个价值和落地案例，风格克制、可信。"
              className="mt-2 w-full resize-none rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary outline-none focus:border-blue-500 disabled:opacity-60"
            />

            <div className="mt-4 rounded-lg border border-token-subtle bg-token-card p-3 text-[11px]">
              <div className="flex items-center gap-1.5 font-medium text-token-primary"><Server size={13} />执行器事实</div>
              {capabilities.filter((item) => item.enabled).length > 1 ? (
                <select
                  value={selectedRuntime}
                  onChange={(event) => setSelectedRuntime(event.target.value)}
                  disabled={generating}
                  aria-label="设计执行器"
                  className="mt-2 w-full rounded-md border border-token-subtle bg-token-nested px-2 py-1.5 text-[11px] text-token-primary"
                >
                  {capabilities.filter((item) => item.enabled).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-token-secondary">当前使用：{visibleRuntime?.label || '正在检测'}</p>
              )}
              {visibleRuntime && (
                <p className="mt-1 leading-relaxed text-token-muted">
                  执行归属：{visibleRuntime.executionOwner === 'cds-remote-agent' ? 'CDS Remote Agent' : 'MAP'}；
                  隔离边界：{visibleRuntime.isolationMode === 'session-container' ? '会话级容器' : 'MAP 服务进程'}。
                </p>
              )}
              {unavailableRuntimes.length > 0 && (
                <p className="mt-1 leading-relaxed text-token-muted">
                  {unavailableRuntimes.map((item) => `${item.label}：${item.reason || '未启用'}`).join('；')}
                </p>
              )}
            </div>

            {generating ? (
              <Button
                className="sticky bottom-0 z-10 mt-4 w-full justify-center shadow-lg"
                size="sm"
                variant="secondary"
                disabled={!activeRunId || stopRequested}
                onClick={() => void stopGeneration()}
              >
                {stopRequested ? <MapSpinner size={14} /> : <Square size={13} fill="currentColor" />}
                <span className="ml-1.5">{stopRequested ? '正在停止，线上未改变' : '停止生成'}</span>
              </Button>
            ) : (
              <Button
                className="sticky bottom-0 z-10 mt-4 w-full justify-center shadow-lg"
                size="sm"
                variant="primary"
                disabled={!enabledRuntime || !instruction.trim() || selectedKnowledge.length === 0}
                onClick={() => void generate()}
              >
                <Send size={14} />
                <span className="ml-1.5">生成并保存网页</span>
              </Button>
            )}
          </div>

          <div className={`${generating || previewHtml || completedSite ? 'flex' : 'hidden lg:flex'} min-h-[220px] min-w-0 flex-col overflow-hidden rounded-xl border border-token-subtle bg-token-nested lg:min-h-0`}>
            <div className="shrink-0 border-b border-token-subtle px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-xs text-token-secondary">
                <span role="status" aria-live="polite" className="sr-only">{phase}</span>
                <span aria-hidden="true">
                  {generating ? runningGenerationActivity(phase, elapsedSeconds) : phase}
                </span>
                <span className="shrink-0 tabular-nums">{generating ? '任务运行中' : `${progress}%`}</span>
              </div>
              <div
                className="mt-2 h-1 overflow-hidden rounded-full bg-token-card"
                role="progressbar"
                aria-label="网页生成进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={generating ? undefined : progress}
                aria-valuetext={generating ? '任务正在执行' : `${progress}%`}
              >
                <div
                  className={generating
                    ? 'h-full w-1/3 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none'
                    : 'h-full bg-blue-500 transition-all duration-300'}
                  style={generating ? undefined : { width: `${progress}%` }}
                />
              </div>
              {thinking && generating && <p className="mt-2 line-clamp-2 text-[11px] text-token-muted">{thinking}</p>}
            </div>
            <div className="relative min-h-0 flex-1">
              {previewHtml ? (
                <iframe
                  srcDoc={previewHtml}
                  sandbox={AI_STREAM_PREVIEW_SANDBOX}
                  referrerPolicy="no-referrer"
                  title="知识生成网页预览"
                  className="h-full w-full bg-white"
                />
              ) : (
                <div className="surface-reading flex h-full items-center justify-center text-crisp">
                  <MapSectionLoader text={generating ? '页面结构出现后会立即在这里生长' : '生成前，这里会展示实时网页'} />
                </div>
              )}
              {completedSite && (
                <div className="surface-reading absolute bottom-4 right-4 flex items-center gap-2 rounded-lg border border-token-subtle p-2 shadow-lg">
                  <span className="flex items-center gap-1.5 text-xs text-token-primary"><Check size={14} />已保存到网页托管</span>
                  {completedSite.url && (
                    <Button size="xs" variant="secondary" onClick={() => window.open(completedSite.url, '_blank', 'noopener')}>
                      <ExternalLink size={12} /><span className="ml-1">打开网页</span>
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    />
  );
}
