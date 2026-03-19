import { useState, useRef, useCallback, useEffect } from 'react';
import { readSseStream, type SseEvent } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';

export type SsePhase = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';

export interface UseSseStreamOptions<T = unknown> {
  /** SSE 端点 URL */
  url: string;
  /** 事件处理映射：{ eventName: handler } */
  onEvent?: Record<string, (data: unknown) => void>;
  /** 收到 typing/delta 事件时的文本追加回调 */
  onTyping?: (text: string) => void;
  /** 收到结构化数据项（score/item/result）时的回调 */
  onItem?: (item: T) => void;
  /** 阶段变更回调 */
  onPhase?: (message: string) => void;
  /** 完成回调 */
  onDone?: (data: unknown) => void;
  /** 错误回调 */
  onError?: (message: string) => void;
  /** 自定义 typing 事件名称（默认: "typing"） */
  typingEvent?: string;
  /** 自定义 item 事件名称（默认: "item"） */
  itemEvent?: string;
  /** 自定义阶段事件名称（默认: "phase"） */
  phaseEvent?: string;
}

export interface UseSseStreamReturn {
  /** 当前阶段 */
  phase: SsePhase;
  /** 当前阶段描述文本 */
  phaseMessage: string;
  /** LLM 流式打字文本 */
  typing: string;
  /** 是否正在流式传输 */
  isStreaming: boolean;
  /** 是否已完成 */
  isDone: boolean;
  /** 启动 SSE 连接 */
  start: () => Promise<void>;
  /** 中止 SSE 连接 */
  abort: () => void;
  /** 重置状态 */
  reset: () => void;
}

/**
 * 通用 SSE 流式 hook — 封装连接管理、认证、状态追踪
 *
 * 使用方式：
 * ```tsx
 * const { phase, typing, start, abort } = useSseStream<ScoreItem>({
 *   url: `/api/xxx/stream`,
 *   onTyping: (text) => console.log(text),
 *   onItem: (item) => setItems(prev => [...prev, item]),
 *   onPhase: (msg) => console.log(msg),
 * });
 * ```
 */
export function useSseStream<T = unknown>(
  options: UseSseStreamOptions<T>,
): UseSseStreamReturn {
  const [phase, setPhase] = useState<SsePhase>('idle');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [typing, setTyping] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const {
    url,
    onEvent,
    onTyping,
    onItem,
    onPhase,
    onDone,
    onError,
    typingEvent = 'typing',
    itemEvent = 'item',
    phaseEvent = 'phase',
  } = options;

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase('idle');
    setPhaseMessage('');
    setTyping('');
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const start = useCallback(async () => {
    abort();
    setPhase('connecting');
    setPhaseMessage('连接中…');
    setTyping('');

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: ac.signal,
      });

      if (!res.ok) {
        setPhase('error');
        setPhaseMessage(`请求失败 (${res.status})`);
        onError?.(`请求失败 (${res.status})`);
        return;
      }

      setPhase('streaming');

      await readSseStream(
        res,
        (evt: SseEvent) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);

            // 内置事件处理
            if (evt.event === phaseEvent) {
              const msg = data.message || data.phase || '';
              setPhaseMessage(msg);
              onPhase?.(msg);
            } else if (evt.event === typingEvent) {
              const text = data.text || data.content || '';
              setTyping((prev) => prev + text);
              onTyping?.(text);
            } else if (evt.event === itemEvent || evt.event === 'score') {
              onItem?.(data as T);
            } else if (evt.event === 'done') {
              setPhase('done');
              setPhaseMessage(data.message || '完成');
              onDone?.(data);
            } else if (evt.event === 'error') {
              setPhase('error');
              setPhaseMessage(data.message || '出错');
              onError?.(data.message || '出错');
            }

            // 自定义事件处理
            if (evt.event && onEvent?.[evt.event]) {
              onEvent[evt.event](data);
            }
          } catch {
            /* ignore JSON parse errors */
          }
        },
        ac.signal,
      );

      // stream ended naturally
      if (phase !== 'done' && phase !== 'error') {
        setPhase('done');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setPhase('error');
        setPhaseMessage('连接失败');
        onError?.('连接失败');
      }
    }
  }, [url, onEvent, onTyping, onItem, onPhase, onDone, onError, typingEvent, itemEvent, phaseEvent, abort]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    phase,
    phaseMessage,
    typing,
    isStreaming: phase === 'connecting' || phase === 'streaming',
    isDone: phase === 'done',
    start,
    abort,
    reset,
  };
}
