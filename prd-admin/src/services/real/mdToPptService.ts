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
  htmlContent: string;
  title?: string;
  description?: string;
  tags?: string[];
  teamIds?: string[];
}

// ============ Client-side reveal.js HTML 渲染 ============
// 纯确定性转换(slides → reveal.js HTML),不调后端,前端直接生成:
// 预览(iframe srcDoc)与发布(htmlContent)共用同一份,免去 /render 网络往返(更快、无代理层 400)。

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REVEAL_THEMES = new Set(['black', 'white', 'league', 'beige', 'sky', 'night', 'serif', 'simple', 'solarized', 'blood', 'moon']);

export function buildRevealHtml(slides: PptSlide[], theme?: string, title?: string): string {
  const t = (theme || 'black').trim().toLowerCase();
  const safeTheme = REVEAL_THEMES.has(t) ? t : 'black';
  const sections = slides.map((s) => {
    const bullets = (s.bullets || []).filter((b) => b && b.trim());
    const ul = bullets.length > 0
      ? `  <ul>\n${bullets.map((b) => `    <li>${escapeHtml(b)}</li>`).join('\n')}\n  </ul>`
      : '';
    return `<section>\n  <h2>${escapeHtml(s.title || '')}</h2>\n${ul}\n</section>`;
  }).join('\n');
  const pageTitle = escapeHtml((title && title.trim()) ? title : '网页 PPT');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reset.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/${safeTheme}.css">
  <style>
    .reveal ul { list-style: disc; text-align: left; padding-left: 1.5em; }
    .reveal li { margin: 0.4em 0; font-size: 0.85em; line-height: 1.5; }
    .reveal h2 { font-size: 1.4em; margin-bottom: 0.6em; }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
${sections}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js"></script>
  <script>
    Reveal.initialize({ hash: true, controls: true, progress: true, slideNumber: true, transition: 'slide', plugins: [] });
  </script>
</body>
</html>`;
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
