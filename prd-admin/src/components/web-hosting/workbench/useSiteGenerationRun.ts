import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import {
  cancelDesignArtifactRun,
  createDesignArtifactRun,
  getDesignArtifactRun,
  getSite,
  getSiteContent,
  streamDesignArtifactRun,
} from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  DESIGN_PREVIEW_EVENT_SANDBOX,
  appendRunNarration,
  designPreviewEventDocument,
  elapsedSecondsSince,
  isNewerPreviewRevision,
  previewableAiStreamHtml,
} from '../siteEditPreview';
import {
  appendGenerationStage,
  closeGenerationStages,
  parseSiteGenerationProgressEvent,
  resolveGeneratedSiteId,
  resolveRunModelBadge,
  type GenerationStage,
} from '../siteGenerateProgress';

/**
 * 新建一个网页的整段任务：创建、流式进度、实时预览、断线恢复、停止。
 *
 * 从旧的分步生成弹窗原样搬来，只去掉了「第几步」：工作台只有一个对话和一个预览，
 * 状态由「是否在生成 / 是否已完成」直接推出来，不再有「选素材 → 写要求 → 生成」三屏。
 */

const ACTIVE_GENERATION_RUN_KEY = 'web-hosting-design-active-run-v1';
/** map-gateway 没有 preview 事件，用累计 delta 做预览时的刷新间隔。 */
const DELTA_PREVIEW_THROTTLE_MS = 500;

/**
 * sessionStorage 在隐私窗口、站点数据被禁、配额用尽时会**抛异常**，不是静默失败。
 * 这里的持久化只是一个便利（刷新后能接回正在跑的任务），而它夹在「服务端任务已创建」
 * 与「进入流式 try」之间——一抛，函数就地中断：服务端继续生成，界面永远停在
 * 「正在校验所选知识」，用户既看不到流也没有可恢复的 key。
 * 所以所有 storage 访问一律走这三个封装：存不下就当没存过，生成照跑。
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

/** 刷新后能不能接回一个进行中的任务：工作台打开时据此决定落在哪一屏。 */
export function hasRecoverableGenerationRun(): boolean {
  return readActiveRun() !== null;
}

export interface GenerationNotice {
  tone: 'error' | 'info';
  text: string;
}

export interface GenerationRequest {
  instruction: string;
  title?: string;
  runtimeId: string;
  sourceSurface: 'knowledge-base' | 'web-hosting';
  knowledge: KnowledgeEntrySelection[];
  styleId: string | null;
  attachmentIds: string[];
}

export interface CompletedGeneration {
  id: string;
  url?: string;
}

interface Options {
  /** 目标团队空间；在 {@link reset}（即打开工作台）那一刻冻结，随请求一起交给服务端。 */
  destinationTeamId: string | null | undefined;
  /** 恢复不到任务时说话要看表单里还剩什么：带着一篇知识打开的，知识还选着。 */
  hasInitialSource: boolean;
  onCreated: (siteId: string) => void;
}

export function useSiteGenerationRun({ destinationTeamId, hasInitialSource, onCreated }: Options) {
  const [notice, setNotice] = useState<GenerationNotice | null>(null);
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
  const [completedSite, setCompletedSite] = useState<CompletedGeneration | null>(null);
  /** 恢复时从服务端读回的标题：刷新之后对话里要能说出「正在生成的是哪一篇」。 */
  const [recoveredTitle, setRecoveredTitle] = useState('');
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const previewRevisionRef = useRef(-1);
  const abortRef = useRef<AbortController | null>(null);
  const onCreatedRef = useRef(onCreated);
  const hasInitialSourceRef = useRef(hasInitialSource);
  // 目标空间在「打开工作台」那一刻取一次就够——它随请求冻结到服务端，
  // 之后用户在页面上换空间也不该改变这一轮的归属。
  const destinationTeamIdRef = useRef(destinationTeamId);
  const liveDestinationTeamIdRef = useRef(destinationTeamId);

  useEffect(() => { onCreatedRef.current = onCreated; }, [onCreated]);
  useEffect(() => { hasInitialSourceRef.current = hasInitialSource; }, [hasInitialSource]);
  useEffect(() => { liveDestinationTeamIdRef.current = destinationTeamId; }, [destinationTeamId]);

  useEffect(() => {
    if (!generating || runStartedAtMs == null) return;
    const tick = () => setElapsedSeconds(elapsedSecondsSince(runStartedAtMs));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generating, runStartedAtMs]);

  useEffect(() => () => abortRef.current?.abort(), []);

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
    setPhase('网页已生成并保存到网页托管，只有你能看到');
    setGenerating(false);
    setActiveRunId(null);
    setStopRequested(false);
    forgetActiveRun();
    onCreatedRef.current(siteId);
  }, [applyPreviewHtml]);

  const failGeneration = useCallback((message: string) => {
    setGenerating(false);
    setActiveRunId(null);
    setStopRequested(false);
    setPhase(message);
    setNotice({ tone: 'error', text: message });
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
        // 都发不起来。修改面板早就这么处理了，这里是同一条判据的第二份（形状 3）。
        if (result.error?.code === 'NOT_FOUND') {
          // 不许承诺「直接重新生成」：打开工作台那一步已经把要求清空了，没有
          // initialSource 时连资料也清空了，发送按钮此刻是禁用的。说了能直接重来，
          // 用户点下去却点不动，就是又制造一次「白做一场」。
          const message = hasInitialSourceRef.current
            ? '上次的网页生成任务已经不在了。这一篇知识仍放着，再写一次要求就能重新生成'
            : '上次的网页生成任务已经不在了。重新放入资料、写明要求，就能再生成一次';
          setGenerating(false);
          setActiveRunId(null);
          setStopRequested(false);
          setPhase(message);
          setNotice({ tone: 'info', text: message });
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
        if (result.data.title) setRecoveredTitle((current) => current || result.data.title || '');
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

  /** 打开工作台时调用：清掉上一轮的一切，冻结目标空间，并接回刷新前没跑完的任务。 */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    // 目标空间在打开这一刻冻结：之后用户在页面上切空间，不该改变这一轮的归属
    // （与上传弹窗打开时快照 currentSpace 是同一个口径）。
    destinationTeamIdRef.current = liveDestinationTeamIdRef.current;
    setNotice(null);
    setPhase('');
    setProgress(0);
    setStages([]);
    setElapsedSeconds(0);
    setRunStartedAtMs(null);
    setLastEventAtMs(null);
    setActiveRunRuntime(null);
    setRunInfo(null);
    // 工作台常驻挂载：不在这里清掉，重开之后会把上一轮的模型当成本轮的显示出来。
    setResolvedModel(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewSandbox(AI_STREAM_PREVIEW_SANDBOX);
    setCompletedSite(null);
    setRecoveredTitle('');
    setActiveRunId(null);
    setStopRequested(false);
    setGenerating(false);
    streamRef.current = '';
    previewRevisionRef.current = -1;

    const runId = readActiveRun();
    if (!runId) return;
    const recovery = new AbortController();
    abortRef.current = recovery;
    setGenerating(true);
    setActiveRunId(runId);
    setPhase('正在恢复上次未完成的网页生成任务');
    void recoverActiveRun(runId, recovery.signal);
  }, [recoverActiveRun]);

  // 完成事件只带站点编号时（精细设计的完成事件就是这样），查一次站点把网址补上。
  useEffect(() => {
    if (!completedSite || completedSite.url) return;
    let active = true;
    const siteId = completedSite.id;
    void getSite(siteId).then((result) => {
      if (!active || !result.success || !result.data?.siteUrl) return;
      setCompletedSite((current) => (current && current.id === siteId && !current.url
        ? { ...current, url: result.data.siteUrl }
        : current));
    });
    return () => { active = false; };
  }, [completedSite]);

  // 完成时没有预览（刷新后恢复、或流里一次都没拿到整页），读一次已保存的正文补上。
  useEffect(() => {
    if (!completedSite || previewHtml) return;
    let active = true;
    void getSiteContent(completedSite.id).then((result) => {
      if (!active || !result.success || !result.data.html) return;
      applyPreviewHtml(designPreviewEventDocument(result.data.html), DESIGN_PREVIEW_EVENT_SANDBOX);
    });
    return () => { active = false; };
  }, [applyPreviewHtml, completedSite, previewHtml]);

  const start = async (request: GenerationRequest) => {
    const text = request.instruction.trim();
    if (!text || generating) return;
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setGenerating(true);
    // 与修改面板同一处判据：徽章必须在进入 generating 的同一拍清掉。排在创建请求之后，
    // 创建期间顶上挂的是上一轮的模型；创建失败时它更会被留在一次根本没发生的调用上。
    setResolvedModel(null);
    setStopRequested(false);
    setElapsedSeconds(0);
    setRunStartedAtMs(Date.now());
    setLastEventAtMs(null);
    setActiveRunRuntime(request.runtimeId);
    setRunInfo(null);
    setCompletedSite(null);
    setThinking('');
    setPreviewHtml('');
    setPreviewSandbox(AI_STREAM_PREVIEW_SANDBOX);
    previewRevisionRef.current = -1;
    setNotice(null);
    setProgress(1);
    const firstPhase = request.knowledge.length > 0 ? '正在校验所选知识' : '正在提交素材';
    setPhase(firstPhase);
    setStages(appendGenerationStage([], firstPhase, Date.now()));
    streamRef.current = '';

    if (request.knowledge.some((entry) => !entry.entryId || !entry.storeId)) {
      failGeneration('引用知识身份不完整，请重新选择');
      toast.error('无法校验引用知识', '请刷新知识列表后重新选择');
      return;
    }

    const knowledgeReferences = request.knowledge.map((entry) => ({
      entryId: entry.entryId,
      storeId: entry.storeId,
    }));
    const created = await createDesignArtifactRun({
      instruction: text,
      title: request.title?.trim() || undefined,
      runtime: request.runtimeId,
      sourceSurface: request.sourceSurface,
      // 目标空间跟着请求走，不再等完成回调——用户中途离开时那条回调根本不会执行。
      destinationTeamId: destinationTeamIdRef.current ?? null,
      knowledgeReferences,
      styleId: request.styleId,
      attachmentIds: request.attachmentIds,
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
            setThinking((previous) => appendRunNarration(previous, item.text, 600));
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

  const stop = async () => {
    if (!activeRunId || stopRequested) return;
    setStopRequested(true);
    setPhase('正在请求服务器停止生成，网页托管里不会多出半成品');
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
    setPhase('服务器正在停止生成，完成前不会保存页面');
  };

  return {
    notice,
    setNotice,
    phase,
    progress,
    stages,
    elapsedSeconds,
    lastEventAtMs,
    activeRunRuntime,
    runInfo,
    resolvedModel,
    thinking,
    previewHtml,
    previewSandbox,
    generating,
    activeRunId,
    stopRequested,
    completedSite,
    recoveredTitle,
    reset,
    start,
    stop,
  };
}

export type SiteGenerationRun = ReturnType<typeof useSiteGenerationRun>;
