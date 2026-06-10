import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

// ============ Outline（大纲先行对话式流程）============

export interface OutlineSlide {
  title: string;
  bullets: string[];
}

export interface MdToPptOutlineResult {
  totalPages: number;
  summary: string;
  outline: OutlineSlide[];
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

// ============ Prewarm（大纲确认期间预热 CDS Agent 会话）============

/**
 * 预创建并启动 CDS Agent 会话（幂等、失败静默）。
 * 在大纲生成成功后 fire-and-forget 调用，把 5-15s 的 Agent 环境启动开销
 * 藏进用户阅读/确认大纲的时间里；Convert 时后端自动复用预热好的会话。
 */
export function prewarmMdToPpt(): void {
  void apiRequest('/api/md-to-ppt/prewarm', { method: 'POST', body: {} }).catch(() => {
    /* 预热只是优化，失败不打扰用户 */
  });
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
    onDelta?: (text: string) => void;
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
  onStart?: (info: { slideCount?: number; theme?: string }) => void;
  onRun?: (runId: string) => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDiag?: (data: MdToPptDiagEvent) => void;
  onDelta?: (text: string) => void;
  onDone?: (result: { html: string }) => void;
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
  onStart?: () => void;
  onRun?: (runId: string) => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDiag?: (data: MdToPptDiagEvent) => void;
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
