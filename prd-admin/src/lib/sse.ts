export type SseEvent = { event?: string; data?: string };

/**
 * 读取标准 SSE（text/event-stream）响应体。
 * - 以 \\n\\n 分隔事件
 * - 支持 event: / data: 多行
 * - 忽略 keepalive（如以 ':' 开头的行）
 */
export async function readSseStream(
  res: Response,
  onEvent: (evt: SseEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder('utf-8');
  let buf = '';

  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = raw.split('\n').map((l) => l.trimEnd());
      let event: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(':')) continue; // keepalive/comment
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
      }

      onEvent({ event, data: dataLines.length ? dataLines.join('\n') : undefined });
    }
  }
}


