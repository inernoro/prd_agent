import { apiRequest, resolveApiUrl } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

export interface MdToPptKnowledgeReferenceInput {
  entryId: string;
  storeId: string;
  contentHash?: string;
}

export interface ResolvedMdToPptKnowledgeReference extends MdToPptKnowledgeReferenceInput {
  contentHash: string;
  storeName?: string;
  title?: string;
}

async function resolveMdToPptKnowledgeReferences(
  references: MdToPptKnowledgeReferenceInput[],
) {
  if (references.length === 0) {
    return {
      success: true as const,
      data: { items: [] as ResolvedMdToPptKnowledgeReference[] },
      error: null,
    };
  }
  if (references.every((item) => /^[0-9a-f]{64}$/i.test(item.contentHash ?? ''))) {
    return {
      success: true as const,
      data: {
        items: references.map((item) => ({ ...item, contentHash: item.contentHash! })),
      },
      error: null,
    };
  }
  return apiRequest<{ items: ResolvedMdToPptKnowledgeReference[] }>(
    '/api/md-to-ppt/knowledge-references/resolve',
    {
      method: 'POST',
      body: {
        knowledgeReferences: references.map(({ entryId, storeId }) => ({ entryId, storeId })),
      },
    },
  );
}

// ============ Outline（大纲先行对话式流程）============

export interface OutlineSlide {
  title: string;
  bullets: string[];
  /** 页级设计意图（版式/视觉装置/排字/强调），随大纲定稿喂给并行页面生成器 */
  design?: string;
  /** 随页面移动的服务端冻结来源标识；合法性与完整覆盖由服务端校验。 */
  sourceBlockIds?: string[];
}

/** 澄清问卷（opendesign 式：大纲阶段消歧，右侧填写后回传 AI） */
export interface ClarifyQuestion {
  id: string;
  question: string;
  type: 'single' | 'multi' | 'text';
  options?: string[];
}

export interface MdToPptOutlineResult {
  totalPages: number;
  summary: string;
  outline: OutlineSlide[];
  /** 仅当需求确有歧义时模型才返回（最多 3 题） */
  clarify?: ClarifyQuestion[];
}

export interface MdToPptOutlineRequest {
  content?: string;
  attachmentText?: string;
  knowledgeReferences?: Array<{
    entryId: string;
    storeId: string;
    contentHash?: string;
  }>;
  chatHistory?: string;
  targetPages?: number;
}

/**
 * 请求 PPT 大纲（JSON，非 SSE）。
 * 返回 { totalPages, summary, outline[] } 供用户确认后再生成 HTML。
 */
export async function getMdToPptOutline(
  req: MdToPptOutlineRequest
): Promise<{ success: true; data: MdToPptOutlineResult } | { success: false; error: string }> {
  const resolved = await resolveMdToPptKnowledgeReferences(req.knowledgeReferences ?? []);
  if (!resolved.success) {
    return { success: false, error: resolved.error.message };
  }
  const res = await apiRequest<MdToPptOutlineResult>('/api/md-to-ppt/outline', {
    method: 'POST',
    body: {
      ...req,
      knowledgeReferences: resolved.data.items.map(({ entryId, storeId, contentHash }) => ({
        entryId,
        storeId,
        contentHash,
      })),
    },
  });
  if (!res.success) {
    return { success: false, error: res.error?.message ?? '大纲生成失败' };
  }
  if (!res.data) {
    return { success: false, error: '大纲数据为空' };
  }
  return { success: true, data: res.data };
}

// ============ Outline Stream（流式逐页大纲：第一页几秒内可见）============

export interface OutlineStreamMeta {
  totalPages: number;
  summary: string;
  design?: { palette?: string; typography?: string; mood?: string };
  clarify?: ClarifyQuestion[];
}

export interface OutlineStreamPageEvent {
  index: number;
  title: string;
  bullets: string[];
  design?: string;
  sourceBlockIds?: string[];
}

export interface MdToPptOutlineStreamOptions extends MdToPptOutlineRequest {
  onMeta?: (meta: OutlineStreamMeta) => void;
  onPage?: (page: OutlineStreamPageEvent) => void;
  /** 服务器权威：大纲也是一次 Run，runId 用于刷新后取回结果 */
  onRun?: (runId: string) => void;
  onKnowledgeResolved?: (items: ResolvedMdToPptKnowledgeReference[]) => void;
  onDone?: (info: { pages: number; runId?: string }) => void;
  /** 已取得 runId 后仅传输断开；服务器任务仍可能继续，调用方必须保留恢复游标。 */
  onDisconnect?: (message: string) => void;
  onError?: (message: string) => void;
}

/**
 * 流式大纲：后端按 JSONL 逐行解析模型输出，每解析成功一页立刻推 SSE。
 * 返回 cleanup 函数（中止请求）。
 */
export function streamMdToPptOutline(options: MdToPptOutlineStreamOptions): () => void {
  const abortController = new AbortController();
  (async () => {
    let runObserved = false;
    const reportConnectionFailure = (message: string) => {
      if (runObserved && options.onDisconnect) {
        options.onDisconnect(message);
        return;
      }
      options.onError?.(message);
    };
    try {
      const resolvedKnowledge = await resolveMdToPptKnowledgeReferences(options.knowledgeReferences ?? []);
      if (!resolvedKnowledge.success) {
        options.onError?.(resolvedKnowledge.error.message);
        return;
      }
      options.onKnowledgeResolved?.(resolvedKnowledge.data.items);
      if (abortController.signal.aborted) return;
      const response = await fetch(resolveApiUrl('/api/md-to-ppt/outline-stream'), {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          content: options.content,
          attachmentText: options.attachmentText,
          knowledgeReferences: resolvedKnowledge.data.items.map(({ entryId, storeId, contentHash }) => ({
            entryId,
            storeId,
            contentHash,
          })),
          chatHistory: options.chatHistory,
          targetPages: options.targetPages,
        }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        await handleMdToPptRejectedResponse(response, options.onError);
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        options.onError?.('无法读取响应流');
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';
      let resolved = false;
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData = line.slice(5).trim();
          else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData) as Record<string, unknown>;
              if (currentEvent === 'run') {
                if (data.runId) {
                  runObserved = true;
                  options.onRun?.(data.runId as string);
                }
              } else if (currentEvent === 'meta') {
                options.onMeta?.({
                  totalPages: (data.totalPages as number) ?? 0,
                  summary: (data.summary as string) ?? '',
                  design: data.design as OutlineStreamMeta['design'],
                  clarify: data.clarify as ClarifyQuestion[] | undefined,
                });
              } else if (currentEvent === 'page') {
                const sourceBlockIds = data.sourceBlockIds;
                if (sourceBlockIds !== undefined &&
                    (!Array.isArray(sourceBlockIds) || !sourceBlockIds.every((id) => typeof id === 'string'))) {
                  resolved = true;
                  options.onError?.('大纲来源信息不完整，请重新生成大纲。');
                  break outer;
                }
                options.onPage?.({
                  index: (data.index as number) ?? 0,
                  title: (data.title as string) ?? '',
                  bullets: Array.isArray(data.bullets) ? (data.bullets as string[]) : [],
                  design: (data.design as string) ?? undefined,
                  sourceBlockIds,
                });
              } else if (currentEvent === 'done') {
                resolved = true;
                options.onDone?.({ pages: (data.pages as number) ?? 0, runId: data.runId as string | undefined });
                break outer;
              } else if (currentEvent === 'error') {
                resolved = true;
                options.onError?.((data.message as string) ?? '大纲生成失败');
                break outer;
              }
            } catch { /* 单事件解析失败不致命 */ }
            currentEvent = '';
            currentData = '';
          }
        }
      }
      if (!resolved && !abortController.signal.aborted) {
        reportConnectionFailure('连接意外断开');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        reportConnectionFailure((e as Error).message);
      }
    }
  })();
  return () => abortController.abort();
}

export async function handleMdToPptRejectedResponse(
  response: Response,
  onError?: (message: string) => void,
): Promise<void> {
  let message = `请求未被接受（${response.status}）`;
  try {
    const payload = await response.json() as {
      error?: string | { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    const errorMessage = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message;
    message = errorMessage || payload.message || message;
  } catch {
    // Non-JSON proxy responses are intentionally collapsed to a stable user-facing error.
  }
  onError?.(message);
}

// ============ Types ============

// 历史 run 的 engine 字段可能是 'map'，读取类型保持兼容；新成品统一走 OpenDesign。
export type MdToPptEngine = 'map' | 'agent';

export interface MdToPptConvertRequest {
  content: string;
  attachmentText?: string;
  slideCount?: number;
  theme?: string;
  sourceSurface?: 'html-ppt' | 'knowledge-base';
  parentOutlineRunId?: string;
  knowledgeReferences?: Array<{
    entryId: string;
    storeId: string;
    contentHash?: string;
  }>;
}

export interface MdToPptPatchRequest {
  parentRunId: string;
  currentHtml: string;
  /** 隔离编辑器产生的非可信草稿；服务端只会把它冻结为 OpenDesign 修改提案。 */
  manualEditHtml?: string;
  slideRequest: string;
  slideIndex?: number;
  /** 风格主题：换风格走 patch 由 AI 按该风格重绘（不是前端 CSS 换皮） */
  theme?: string;
}

export interface MdToPptPublishRequest {
  htmlContent: string;
  title?: string;
  description?: string;
  tags?: string[];
  teamIds?: string[];
  runId: string;
}

export interface MdToPptPublishResult {
  runId: string;
  siteId: string;
  siteUrl: string;
  html: string;
  contentHash: string;
}

/** 诊断事件 payload（agent 路径专有） */
export interface MdToPptDiagEvent {
  stage: string;
  elapsedMs?: number;
  [key: string]: unknown;
}

export interface MdToPptPhaseEvent {
  phaseCode: string;
  progress: number;
  message: string;
  runtimeModelCallCount: number;
}

// ============ SSE helpers ============

function buildSseHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function readSseStream(
  response: Response,
  handlers: {
    onStart?: (data: Record<string, unknown>) => void;
    onRun?: (runId: string) => void;
    onModel?: (info: { model: string; platform: string }) => void;
    onDiag?: (data: MdToPptDiagEvent) => void;
    onThinking?: (text: string) => void;
    onDelta?: (text: string) => void;
    onPhase?: (data: MdToPptPhaseEvent) => void;
    onPreview?: (data: { html: string; revision: number }) => void;
    onFrame?: (data: { head: string; suffix?: string; total: number; anchored?: boolean }) => void;
    onPage?: (data: { index: number; total: number; html: string; done: number }) => void;
    onDone?: (data: Record<string, unknown>) => void;
    onError?: (message: string) => void;
  }
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    handlers.onError?.('无法读取响应流');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '' && currentEvent && currentData) {
        try {
          const data = JSON.parse(currentData) as Record<string, unknown>;
          if (currentEvent === 'start') {
            handlers.onStart?.(data);
          } else if (currentEvent === 'run') {
            handlers.onRun?.((data.runId as string) ?? '');
          } else if (currentEvent === 'model') {
            handlers.onModel?.({
              model: (data.model as string) ?? '',
              platform: (data.platform as string) ?? '',
            });
          } else if (currentEvent === 'diag') {
            handlers.onDiag?.(data as MdToPptDiagEvent);
          } else if (currentEvent === 'thinking') {
            handlers.onThinking?.((data.text as string) ?? '');
          } else if (currentEvent === 'phase') {
            handlers.onPhase?.({
              phaseCode: (data.phaseCode as string) ?? '',
              progress: (data.progress as number) ?? 0,
              message: (data.message as string) ?? '',
              runtimeModelCallCount: Math.max(0, (data.runtimeModelCallCount as number) ?? 0),
            });
          } else if (currentEvent === 'preview') {
            handlers.onPreview?.({
              html: (data.html as string) ?? '',
              revision: (data.revision as number) ?? 0,
            });
          } else if (currentEvent === 'frame') {
            handlers.onFrame?.({ head: (data.head as string) ?? '', suffix: (data.suffix as string) ?? undefined, total: (data.total as number) ?? 0, anchored: data.anchored === true });
          } else if (currentEvent === 'page') {
            handlers.onPage?.({
              index: (data.index as number) ?? 0,
              total: (data.total as number) ?? 0,
              html: (data.html as string) ?? '',
              done: (data.done as number) ?? 0,
            });
          } else if (currentEvent === 'delta') {
            handlers.onDelta?.((data.text as string) ?? '');
          } else if (currentEvent === 'done') {
            handlers.onDone?.(data);
            return;
          } else if (currentEvent === 'error') {
            handlers.onError?.((data.message as string) ?? '生成失败');
            return;
          }
        } catch (e) {
          console.error('解析 SSE 事件失败:', e);
        }
        currentEvent = '';
        currentData = '';
      }
    }
  }
}

// ============ Convert SSE ============

export interface MdToPptConvertSseOptions {
  content: string;
  /** 仅来自明确文件选择器的冻结资料正文；不得与普通需求 content 混合。 */
  attachmentText?: string;
  slideCount?: number;
  theme?: string;
  /** 自定义模板 ID（优先于 theme 生效，后端取模板风格规范作为生成参照） */
  templateId?: string;
  /** 结构化大纲（触发并行逐页生成：壳子确定后页面生成器各画一页，page 事件实时进度） */
  outlinePages?: OutlineSlide[];
  /** PPT 一句话主题（逐页模式给页面生成器的全局语境） */
  summary?: string;
  sourceSurface?: 'html-ppt' | 'knowledge-base';
  parentOutlineRunId?: string;
  knowledgeReferences?: Array<{
    entryId: string;
    storeId: string;
    contentHash?: string;
  }>;
  /** 壳子就绪（head 含完整设计系统，实况渲染用） */
  onFrame?: (data: { head: string; suffix?: string; total: number; anchored?: boolean }) => void;
  /** 单页完成（并行，真实进度） */
  onPage?: (data: { index: number; total: number; html: string; done: number }) => void;
  onStart?: (info: { slideCount?: number; theme?: string }) => void;
  onRun?: (runId: string) => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDiag?: (data: MdToPptDiagEvent) => void;
  /** 推理模型思考过程增量（先想后写的模型，等待期展示思考内容） */
  onThinking?: (text: string) => void;
  onDelta?: (text: string) => void;
  onPhase?: (data: MdToPptPhaseEvent) => void;
  onPreview?: (data: { html: string; revision: number }) => void;
  /** degraded：退化为裸要点/范本兜底的页数；total：总页数（>0 时说明本次未全程走 Agent 设计） */
  onDone?: (result: { html: string; degraded?: number; total?: number; siteUrl?: string; siteId?: string; revisionId?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * 调用后端 /api/md-to-ppt/convert，SSE 流式接收完整 reveal.js HTML PPT 生成
 * 返回 cleanup 函数，调用后中止请求
 */
export function streamMdToPptConvert(options: MdToPptConvertSseOptions): () => void {
  const abortController = new AbortController();

  (async () => {
    try {
      const resolvedKnowledge = await resolveMdToPptKnowledgeReferences(options.knowledgeReferences ?? []);
      if (!resolvedKnowledge.success) {
        options.onError?.(resolvedKnowledge.error.message);
        return;
      }
      if (abortController.signal.aborted) return;
      if (options.parentOutlineRunId && options.outlinePages?.length) {
        const confirmation = await fetch(
          resolveApiUrl(`/api/md-to-ppt/outline/${encodeURIComponent(options.parentOutlineRunId)}/confirm`),
          {
            method: 'POST',
            headers: buildSseHeaders(),
            body: JSON.stringify({
              content: options.content,
              attachmentText: options.attachmentText,
              outlinePages: options.outlinePages,
              summary: options.summary,
            }),
            signal: abortController.signal,
          },
        );
        if (!confirmation.ok) {
          await handleMdToPptRejectedResponse(confirmation, options.onError);
          return;
        }
      }
      if (abortController.signal.aborted) return;
      const response = await fetch(resolveApiUrl('/api/md-to-ppt/convert'), {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          content: options.content,
          attachmentText: options.attachmentText,
          slideCount: options.slideCount,
          theme: options.theme,
          templateId: options.templateId,
          outlinePages: options.outlinePages,
          summary: options.summary,
          sourceSurface: options.sourceSurface,
          parentOutlineRunId: options.parentOutlineRunId,
          knowledgeReferences: resolvedKnowledge.data.items.map(({ entryId, storeId, contentHash }) => ({
            entryId,
            storeId,
            contentHash,
          })),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        await handleMdToPptRejectedResponse(response, options.onError);
        return;
      }

      let resolved = false;
      await readSseStream(response, {
        onStart: (data) => {
          options.onStart?.({
            slideCount: data.slideCount as number | undefined,
            theme: data.theme as string | undefined,
          });
        },
        onRun: options.onRun,
        onModel: options.onModel,
        onDiag: options.onDiag,
        onThinking: options.onThinking,
        onDelta: options.onDelta,
        onPhase: options.onPhase,
        onPreview: options.onPreview,
        onFrame: options.onFrame,
        onPage: options.onPage,
        onDone: (data) => {
          resolved = true;
          options.onDone?.({
            html: (data.html as string) ?? '',
            degraded: typeof data.degraded === 'number' ? data.degraded : undefined,
            total: typeof data.total === 'number' ? data.total : undefined,
            siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : undefined,
            siteId: typeof data.siteId === 'string' ? data.siteId : undefined,
            revisionId: typeof data.revisionId === 'string' ? data.revisionId : undefined,
          });
        },
        onError: (msg) => {
          resolved = true;
          options.onError?.(msg);
        },
      });
      // stream ended without done/error — unblock the UI
      if (!resolved && !abortController.signal.aborted) {
        options.onError?.('连接意外断开，请重试');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('MD to PPT SSE error:', e);
        options.onError?.((e as Error).message);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}

// ============ Patch SSE ============

export interface MdToPptPatchSseOptions {
  parentRunId: string;
  currentHtml: string;
  manualEditHtml?: string;
  slideRequest: string;
  slideIndex?: number;
  /** 风格主题（patch 沿用当前风格 / 换风格重绘时传新值） */
  theme?: string;
  /** 自定义模板 ID（优先于 theme 生效） */
  templateId?: string;
  onStart?: () => void;
  onRun?: (runId: string) => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDiag?: (data: MdToPptDiagEvent) => void;
  /** 推理模型思考过程增量 */
  onThinking?: (text: string) => void;
  onDelta?: (text: string) => void;
  onPhase?: (data: MdToPptPhaseEvent) => void;
  onPreview?: (data: { html: string; revision: number }) => void;
  onDone?: (result: { html: string; siteUrl?: string; siteId?: string; revisionId?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * 调用后端 /api/md-to-ppt/patch，SSE 流式接收局部修改结果
 * 返回 cleanup 函数，调用后中止请求
 */
export function streamMdToPptPatch(options: MdToPptPatchSseOptions): () => void {
  const abortController = new AbortController();

  (async () => {
    try {
      const response = await fetch(resolveApiUrl('/api/md-to-ppt/patch'), {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          parentRunId: options.parentRunId,
          currentHtml: options.currentHtml,
          manualEditHtml: options.manualEditHtml,
          slideRequest: options.slideRequest,
          slideIndex: options.slideIndex,
          theme: options.theme,
          templateId: options.templateId,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        options.onError?.(`HTTP ${response.status}`);
        return;
      }

      let resolved = false;
      await readSseStream(response, {
        onStart: () => options.onStart?.(),
        onRun: options.onRun,
        onModel: options.onModel,
        onDiag: options.onDiag,
        onThinking: options.onThinking,
        onDelta: options.onDelta,
        onPhase: options.onPhase,
        onPreview: options.onPreview,
        onDone: (data) => {
          resolved = true;
          options.onDone?.({
            html: (data.html as string) ?? '',
            siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : undefined,
            siteId: typeof data.siteId === 'string' ? data.siteId : undefined,
            revisionId: typeof data.revisionId === 'string' ? data.revisionId : undefined,
          });
        },
        onError: (msg) => {
          resolved = true;
          options.onError?.(msg);
        },
      });
      // stream ended without done/error — unblock the UI
      if (!resolved && !abortController.signal.aborted) {
        options.onError?.('连接意外断开，请重试');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('MD to PPT Patch SSE error:', e);
        options.onError?.((e as Error).message);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}

// ============ Publish ============

/**
 * 将 HTML PPT 发布为网页托管站点，返回站点 URL
 */
export async function publishMdToPpt(req: MdToPptPublishRequest): Promise<{
  success: boolean;
  runId?: string;
  siteUrl?: string;
  siteId?: string;
  html?: string;
  error?: string;
}> {
  const res = await apiRequest<MdToPptPublishResult>('/api/md-to-ppt/publish', {
    method: 'POST',
    body: req,
  });
  if (!res.success) {
    return { success: false, error: res.error?.message ?? '发布失败' };
  }
  return {
    success: true,
    runId: res.data?.runId ?? req.runId,
    siteUrl: res.data?.siteUrl ?? '',
    siteId: res.data?.siteId ?? '',
    html: res.data?.html ?? '',
  };
}

// ============ Runs（server-authority：刷新可重连/查看历史）============

export interface MdToPptRunDetail {
  id: string;
  parentRunId?: string | null;
  parentOutlineRunId?: string | null;
  parentHtmlHash?: string | null;
  status: 'running' | 'done' | 'error';
  engine: MdToPptEngine;
  runtime?: string;
  provider?: string;
  op: string;
  title: string;
  html: string;
  htmlHash?: string | null;
  publishedHtmlHash?: string | null;
  publishedSiteId?: string | null;
  publishedVersionId?: string | null;
  siteUrl?: string | null;
  /** op=outline 时填充：刷新恢复用的大纲结果 JSON（与 outlineDraft 同形） */
  outlineJson?: string | null;
  inputAuthority?: 'user-supplied' | 'mixed-user-and-server-knowledge';
  userSuppliedContentHash?: string | null;
  knowledgeReferences?: Array<{
    entryId: string;
    storeId?: string | null;
    storeName?: string | null;
    title: string;
    contentHash: string;
  }>;
  error?: string | null;
  model?: string | null;
  platform?: string | null;
  resolvedModels?: string[];
  resolvedPlatforms?: string[];
  /** 退化为「标题+要点」兜底的页数（>0 时恢复路径也要如实告警，与 done 事件一致） */
  degraded?: number;
  /** 总页数（与 degraded 配对还原「共 N 页其中 X 页降级」文案） */
  total?: number;
  progress?: number | null;
  phaseCode?: string | null;
  phaseMessage?: string | null;
  runtimeModelCallCount?: number | null;
  latestPreviewRevision?: number | null;
  latestPreviewHtml?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MdToPptRunSummary {
  id: string;
  status: 'running' | 'done' | 'error';
  engine: MdToPptEngine;
  runtime?: string;
  provider?: string;
  op: string;
  title: string;
  contentPreview: string;
  hasHtml: boolean;
  model?: string | null;
  platform?: string | null;
  resolvedModels?: string[];
  resolvedPlatforms?: string[];
  createdAt: string;
}

/** 按 runId 拉取一次生成运行（刷新/断线后重连） */
export async function getMdToPptRun(id: string): Promise<MdToPptRunDetail | null> {
  const res = await apiRequest<MdToPptRunDetail>(`/api/md-to-ppt/runs/${encodeURIComponent(id)}`);
  return res.success ? (res.data ?? null) : null;
}

/** 最近生成历史 */
export async function getRecentMdToPptRuns(): Promise<MdToPptRunSummary[]> {
  const res = await apiRequest<MdToPptRunSummary[]>('/api/md-to-ppt/runs');
  return res.success ? (res.data ?? []) : [];
}

// ============ 自定义模板（上传参考图 → 视觉模型提取风格规范）============

export interface MdToPptTemplateItem {
  id: string;
  name: string;
  /** 风格规范摘要（前 160 字） */
  styleSpec: string;
  bgColor: string;
  accentColor: string;
  createdAt: string;
}

/** 当前用户的自定义模板列表（官方模板在前端常量 THEME_OPTIONS） */
export async function getMdToPptTemplates(): Promise<MdToPptTemplateItem[]> {
  const res = await apiRequest<MdToPptTemplateItem[]>('/api/md-to-ppt/templates');
  return res.success ? (res.data ?? []) : [];
}

/** 上传参考图创建自定义模板（视觉模型提取风格规范，约 5-15s） */
export async function createMdToPptTemplate(req: { name: string; imageDataUrl: string }): Promise<
  { success: true; template: MdToPptTemplateItem } | { success: false; error: string }
> {
  const res = await apiRequest<MdToPptTemplateItem>('/api/md-to-ppt/templates', {
    method: 'POST',
    body: req,
  });
  if (!res.success || !res.data) {
    return { success: false, error: res.error?.message ?? '模板创建失败' };
  }
  return { success: true, template: res.data };
}

/** 删除自定义模板 */
export async function deleteMdToPptTemplate(id: string): Promise<boolean> {
  const res = await apiRequest<{ deleted: boolean }>(`/api/md-to-ppt/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res.success;
}
