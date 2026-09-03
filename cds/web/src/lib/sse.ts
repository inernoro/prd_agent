/*
 * 前端消费 CDS 的 SSE 型 POST 接口（部署 / 单服务部署等）的最小读取器。
 * 从 BranchDetailPage 抽出（2026-09-02）：引用分区「重新部署受影响服务」需要同一段逻辑，
 * 不再在组件里复制第四份。BranchListPage / MaintenanceTab 各自的变体与此并不相同，暂未合并。
 */
import { ApiError, apiUrl } from '@/lib/api';

export function parseSseBlock(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return { event, data: null };
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

export async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  // 与 apiRequest 同一条控制面路径：预览域名上 /api/* 要改写成 /_cds/api/* 送回 CDS，
  // 直接 fetch(path) 会打到预览应用自己（Codex 四轮 P1）
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed && (parsed as { message: unknown }).message
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `${path} -> ${res.status}`;
    throw new ApiError(res.status, parsed, message);
  }

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.trim() && !block.startsWith(':')) {
          const parsed = parseSseBlock(block);
          if (parsed) onEvent(parsed.event, parsed.data);
        }
        index = buffer.indexOf('\n\n');
      }
    }
    if (done) break;
  }
}

/** 把一条 SSE 事件压成一行可读文字（进度条 / 日志行用） */
export function sseEventText(event: string, data: unknown): string {
  if (typeof data === 'string') return data.trim() || event;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.chunk === 'string') return obj.chunk.trim() || event;
    if (typeof obj.step === 'string') return obj.step;
  }
  return event;
}
