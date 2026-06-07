import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

// ============ Types ============

export interface PptSlide {
  title: string;
  bullets: string[];
}

export interface MdToPptConvertRequest {
  content: string;
}

export interface MdToPptRenderRequest {
  slides: PptSlide[];
  theme?: string;
  title?: string;
}

export interface MdToPptPublishRequest {
  slides: PptSlide[];
  theme?: string;
  title?: string;
  teamIds?: string[];
}

export interface MdToPptConvertResult {
  outline: string;
  slides: PptSlide[];
}

export interface MdToPptRenderResult {
  html: string;
}

export interface MdToPptPublishResult {
  siteId: string;
  siteUrl: string;
}

// ============ SSE Convert ============

export interface MdToPptConvertSseOptions {
  content: string;
  onStart?: () => void;
  onModel?: (info: { model: string; platform: string }) => void;
  onDelta?: (text: string) => void;
  onDone?: (result: MdToPptConvertResult) => void;
  onError?: (message: string) => void;
}

/**
 * 调用后端 /api/md-to-ppt/convert 端点，SSE 流式获取 PPT 大纲
 * 返回 cleanup 函数，调用后中止请求
 */
export function streamMdToPptConvert(options: MdToPptConvertSseOptions): () => void {
  const token = useAuthStore.getState().token;
  const abortController = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch('/api/md-to-ppt/convert', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: options.content }),
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
                options.onStart?.();
              } else if (currentEvent === 'model') {
                options.onModel?.({
                  model: (data.model as string) ?? '',
                  platform: (data.platform as string) ?? '',
                });
              } else if (currentEvent === 'delta') {
                options.onDelta?.((data.text as string) ?? '');
              } else if (currentEvent === 'done') {
                options.onDone?.({
                  outline: (data.outline as string) ?? '',
                  slides: (data.slides as PptSlide[]) ?? [],
                });
                return;
              } else if (currentEvent === 'error') {
                options.onError?.((data.message as string) ?? '生成失败');
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

// ============ Render ============

/**
 * 将幻灯片结构渲染为 reveal.js HTML 字符串
 */
export async function renderMdToPpt(req: MdToPptRenderRequest): Promise<{
  success: boolean;
  html?: string;
  error?: string;
}> {
  const res = await apiRequest<MdToPptRenderResult>('/api/md-to-ppt/render', {
    method: 'POST',
    body: req,
  });
  if (!res.success) {
    return { success: false, error: res.error?.message ?? '渲染失败' };
  }
  return { success: true, html: res.data?.html ?? '' };
}

// ============ Publish ============

/**
 * 将幻灯片发布为网页托管站点，返回站点 URL
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
