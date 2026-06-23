import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

// ============ Outline（大纲先行对话式流程）============

export interface OutlineSlide {
  title: string;
  bullets: string[];
  /** 页级设计意图（版式/视觉装置/排字/强调），随大纲定稿喂给并行子智能体 */
  design?: string;
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
  kbContext?: string;
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
  const res = await apiRequest<MdToPptOutlineResult>('/api/md-to-ppt/outline', {
    method: 'POST',
    body: req,
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
}

export interface MdToPptOutlineStreamOptions extends MdToPptOutlineRequest {
  onMeta?: (meta: OutlineStreamMeta) => void;
  onPage?: (page: OutlineStreamPageEvent) => void;
  /** 服务器权威：大纲也是一次 Run，runId 用于刷新后取回结果 */
  onRun?: (runId: string) => void;
  onDone?: (info: { pages: number; runId?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * 流式大纲：后端按 JSONL 逐行解析模型输出，每解析成功一页立刻推 SSE。
 * 返回 cleanup 函数（中止请求）。
 */
export function streamMdToPptOutline(options: MdToPptOutlineStreamOptions): () => void {
  const abortController = new AbortController();
  (async () => {
    try {
      const response = await fetch('/api/md-to-ppt/outline-stream', {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          content: options.content,
          attachmentText: options.attachmentText,
          kbContext: options.kbContext,
          chatHistory: options.chatHistory,
          targetPages: options.targetPages,
        }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        options.onError?.(`HTTP ${response.status}`);
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
                if (data.runId) options.onRun?.(data.runId as string);
              } else if (currentEvent === 'meta') {
                options.onMeta?.({
                  totalPages: (data.totalPages as number) ?? 0,
                  summary: (data.summary as string) ?? '',
                  design: data.design as OutlineStreamMeta['design'],
                  clarify: data.clarify as ClarifyQuestion[] | undefined,
                });
              } else if (currentEvent === 'page') {
                options.onPage?.({
                  index: (data.index as number) ?? 0,
                  title: (data.title as string) ?? '',
                  bullets: Array.isArray(data.bullets) ? (data.bullets as string[]) : [],
                  design: (data.design as string) ?? undefined,
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
        options.onError?.('连接意外断开，请重试');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        options.onError?.((e as Error).message);
      }
    }
  })();
  return () => abortController.abort();
}

// ============ CDS 连接状态（未连接时整页禁用）============

/**
 * 当前是否存在可用的 active CDS 连接。PPT 生成完全依赖 CDS Agent，
 * 未连接时前端整页禁用并引导用户去「基础设施服务」完成 CDS 授权。
 * 查询失败时按「未连接」处理（保守：不放行到必然失败的生成）。
 */
export async function getMdToPptConnectionStatus(): Promise<boolean> {
  try {
    const res = await apiRequest<{ connected: boolean }>('/api/md-to-ppt/connection-status');
    return res.success && res.data?.connected === true;
  } catch {
    return false;
  }
}

// ============ Prewarm（大纲确认期间预热 CDS Agent 会话）============

/**
 * 预创建并启动 CDS Agent 会话（幂等、失败静默）。
 * 在大纲生成成功后 fire-and-forget 调用，把 5-15s 的 Agent 环境启动开销
 * 藏进用户阅读/确认大纲的时间里；Convert 时后端自动复用预热好的会话。
 */
export function prewarmMdToPpt(runtimeProfileId?: string | null): void {
  void apiRequest('/api/md-to-ppt/prewarm', {
    method: 'POST',
    body: { runtimeProfileId: runtimeProfileId ?? undefined },
  }).catch(() => {
    /* 预热只是优化，失败不打扰用户 */
  });
}

// ============ 模型运行配置（用户随时切换，2026-06-11 诉求 7） ============

export interface MdToPptProfileItem {
  id: string;
  name: string;
  model: string;
  runtime: string;
  isDefault: boolean;
  isEffectiveDefault: boolean;
  owned: boolean;
}

/** 当前用户可用的模型运行配置（与「基础设施 → 配置」同一数据源） */
export async function getMdToPptProfiles(): Promise<MdToPptProfileItem[]> {
  const res = await apiRequest<MdToPptProfileItem[]>('/api/md-to-ppt/profiles');
  return res.success && Array.isArray(res.data) ? res.data : [];
}

export interface MdToPptPoolModelItem {
  id: string;
  name: string;
  model: string;
  platform: string;
  isMain: boolean;
  ready: boolean;
  /** 凭据预检：false = 物化必失败（平台 key 缺失/解密失败），弹层置灰 */
  available?: boolean;
  unavailableReason?: string | null;
}

/** 模型池候选（弹层「从模型池直选」）：选中即物化为运行配置，配置原样传给 CDS */
export async function getMdToPptPoolModels(): Promise<MdToPptPoolModelItem[]> {
  const res = await apiRequest<MdToPptPoolModelItem[]>('/api/md-to-ppt/pool-models');
  return res.success && Array.isArray(res.data) ? res.data : [];
}

/** 把池内模型一键物化为运行配置（幂等，复用平台 baseUrl/key），返回可立即选中的配置项 */
export async function createMdToPptProfileFromPool(modelId: string): Promise<MdToPptProfileItem | null> {
  const res = await apiRequest<MdToPptProfileItem>('/api/md-to-ppt/profiles/from-pool', {
    method: 'POST',
    body: { modelId },
  });
  return res.success && res.data ? res.data : null;
}

// ============ Types ============

// 生成引擎只有 CDS Agent 一条路（2026-06-10 用户拍板移除 MAP 直出）。
// 类型保留用于历史 run 记录展示（旧 run 的 engine 字段可能是 'map'）。
export type MdToPptEngine = 'map' | 'agent';

export interface MdToPptConvertRequest {
  content: string;
  slideCount?: number;
  theme?: string;
}

export interface MdToPptPatchRequest {
  currentHtml: string;
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
}

export interface MdToPptPublishResult {
  siteId: string;
  siteUrl: string;
}

/** 诊断事件 payload（agent 路径专有） */
export interface MdToPptDiagEvent {
  stage: string;
  elapsedMs?: number;
  [key: string]: unknown;
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
  slideCount?: number;
  theme?: string;
  /** 自定义模板 ID（优先于 theme 生效，后端取模板风格规范作为生成参照） */
  templateId?: string;
  /** 结构化大纲（触发并行逐页生成：壳子确定后子智能体各画一页，page 事件实时进度） */
  outlinePages?: OutlineSlide[];
  /** PPT 一句话主题（逐页模式给子智能体的全局语境） */
  summary?: string;
  /** 模型运行配置 ID（用户在 PPT 页切换的模型；缺省走后端默认链） */
  runtimeProfileId?: string;
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
  /** degraded：退化为裸要点/范本兜底的页数；total：总页数（>0 时说明本次未全程走 Agent 设计） */
  onDone?: (result: { html: string; degraded?: number; total?: number }) => void;
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
      const response = await fetch('/api/md-to-ppt/convert', {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          content: options.content,
          slideCount: options.slideCount,
          theme: options.theme,
          templateId: options.templateId,
          outlinePages: options.outlinePages,
          summary: options.summary,
          runtimeProfileId: options.runtimeProfileId,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        options.onError?.(`HTTP ${response.status}`);
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
        onFrame: options.onFrame,
        onPage: options.onPage,
        onDone: (data) => {
          resolved = true;
          options.onDone?.({
            html: (data.html as string) ?? '',
            degraded: typeof data.degraded === 'number' ? data.degraded : undefined,
            total: typeof data.total === 'number' ? data.total : undefined,
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
  currentHtml: string;
  slideRequest: string;
  slideIndex?: number;
  /** 风格主题（patch 沿用当前风格 / 换风格重绘时传新值） */
  theme?: string;
  /** 自定义模板 ID（优先于 theme 生效） */
  templateId?: string;
  /** 模型运行配置 ID（用户在 PPT 页切换的模型） */
  runtimeProfileId?: string;
  onStart?: () => void;
  onRun?: (runId: string) => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDiag?: (data: MdToPptDiagEvent) => void;
  /** 推理模型思考过程增量 */
  onThinking?: (text: string) => void;
  onDelta?: (text: string) => void;
  onDone?: (result: { html: string }) => void;
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
      const response = await fetch('/api/md-to-ppt/patch', {
        method: 'POST',
        headers: buildSseHeaders(),
        body: JSON.stringify({
          currentHtml: options.currentHtml,
          slideRequest: options.slideRequest,
          slideIndex: options.slideIndex,
          theme: options.theme,
          templateId: options.templateId,
          runtimeProfileId: options.runtimeProfileId,
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
        onDone: (data) => {
          resolved = true;
          options.onDone?.({ html: (data.html as string) ?? '' });
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
  siteUrl?: string;
  siteId?: string;
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
    siteUrl: res.data?.siteUrl ?? '',
    siteId: res.data?.siteId ?? '',
  };
}

// ============ Runs（server-authority：刷新可重连/查看历史）============

export interface MdToPptRunDetail {
  id: string;
  status: 'running' | 'done' | 'error';
  engine: MdToPptEngine;
  op: string;
  title: string;
  html: string;
  /** op=outline 时填充：刷新恢复用的大纲结果 JSON（与 outlineDraft 同形） */
  outlineJson?: string | null;
  error?: string | null;
  model?: string | null;
  platform?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MdToPptRunSummary {
  id: string;
  status: 'running' | 'done' | 'error';
  engine: MdToPptEngine;
  op: string;
  title: string;
  contentPreview: string;
  hasHtml: boolean;
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
