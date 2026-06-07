import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

// ============ Types ============

export type MdToPptEngine = 'map' | 'agent';

export interface MdToPptConvertRequest {
  content: string;
  slideCount?: number;
  theme?: string;
  engine?: MdToPptEngine;
}

export interface MdToPptPatchRequest {
  currentHtml: string;
  slideRequest: string;
  slideIndex?: number;
  engine?: MdToPptEngine;
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
  engine?: MdToPptEngine;
  onStart?: (info: { slideCount?: number; theme?: string }) => void;
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
          engine: options.engine ?? 'map',
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        options.onError?.(`HTTP ${response.status}`);
        return;
      }

      await readSseStream(response, {
        onStart: (data) => {
          options.onStart?.({
            slideCount: data.slideCount as number | undefined,
            theme: data.theme as string | undefined,
          });
        },
        onModel: options.onModel,
        onDiag: options.onDiag,
        onDelta: options.onDelta,
        onDone: (data) => {
          options.onDone?.({ html: (data.html as string) ?? '' });
        },
        onError: options.onError,
      });
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
  engine?: MdToPptEngine;
  onStart?: () => void;
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
          engine: options.engine ?? 'map',
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        options.onError?.(`HTTP ${response.status}`);
        return;
      }

      await readSseStream(response, {
        onStart: () => options.onStart?.(),
        onModel: options.onModel,
        onDiag: options.onDiag,
        onDelta: options.onDelta,
        onDone: (data) => {
          options.onDone?.({ html: (data.html as string) ?? '' });
        },
        onError: options.onError,
      });
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
