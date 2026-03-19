import { useState, useRef, useCallback, useEffect } from 'react';
import { readSseStream, type SseEvent } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';

export type SsePhase = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';

export interface UseSseStreamOptions<T = unknown> {
  /** SSE 端点 URL（可被 start() 覆盖） */
  url: string;
  /** HTTP 方法（默认 GET） */
  method?: 'GET' | 'POST';
  /** POST 请求体（可被 start() 覆盖） */
  body?: unknown;
  /** 额外请求头 */
  headers?: Record<string, string>;
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

/** start() 可传入的覆盖参数 */
export interface SseStartOverrides {
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
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
  /** 启动 SSE 连接（可传入覆盖参数） */
  start: (overrides?: SseStartOverrides) => Promise<void>;
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
    method: defaultMethod = 'GET',
    body: defaultBody,
    headers: defaultHeaders,
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

  const start = useCallback(async (overrides?: SseStartOverrides) => {
    abort();
    setPhase('connecting');
    setPhaseMessage('连接中…');
    setTyping('');

    const ac = new AbortController();
    abortRef.current = ac;

    const finalUrl = overrides?.url ?? url;
    const finalBody = overrides?.body ?? defaultBody;
    const finalHeaders = { ...defaultHeaders, ...overrides?.headers };

    try {
      const token = useAuthStore.getState().token;
      const isPost = defaultMethod === 'POST' || finalBody !== undefined;

      const reqHeaders: Record<string, string> = {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(isPost ? { 'Content-Type': 'application/json' } : {}),
        ...finalHeaders,
      };

      const res = await fetch(finalUrl, {
        method: isPost ? 'POST' : defaultMethod,
        headers: reqHeaders,
        ...(isPost && finalBody !== undefined ? { body: JSON.stringify(finalBody) } : {}),
        signal: ac.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const errMsg = errText || `请求失败 (${res.status})`;
        setPhase('error');
        setPhaseMessage(errMsg);
        onError?.(errMsg);
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
            } else if (evt.event === typingEvent || (evt.event === undefined && data.type === 'delta')) {
              // 兼容标准 typing 事件和 {type:'delta', content} 格式
              const text = data.text || data.content || '';
              setTyping((prev) => prev + text);
              onTyping?.(text);
            } else if (evt.event === itemEvent || evt.event === 'score') {
              onItem?.(data as T);
            } else if (evt.event === 'done' || (evt.event === undefined && data.type === 'done')) {
              setPhase('done');
              setPhaseMessage(data.message || '完成');
              onDone?.(data);
            } else if (evt.event === 'error' || (evt.event === undefined && data.type === 'error')) {
              setPhase('error');
              const msg = data.message || data.errorMessage || '出错';
              setPhaseMessage(msg);
              onError?.(msg);
            }

            // 自定义事件处理
            if (evt.event && onEvent?.[evt.event]) {
              onEvent[evt.event](data);
            }
            // 无 event 字段时，用 data.type 作为事件名分发
            if (!evt.event && data.type && onEvent?.[data.type]) {
              onEvent[data.type](data);
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
  }, [url, defaultMethod, defaultBody, defaultHeaders, onEvent, onTyping, onItem, onPhase, onDone, onError, typingEvent, itemEvent, phaseEvent, abort]);

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

// ─── 服务层 SSE 工具函数 ───────────────────────────────

export interface ConnectSseOptions {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  onEvent: (evt: SseEvent) => void;
  signal: AbortSignal;
  /** 跳过自动 token 注入（默认 false） */
  skipAuth?: boolean;
}

/**
 * 服务层 SSE 连接工具 — 封装 fetch + auth + 401 处理 + readSseStream
 *
 * 用于 service 文件中替代重复的 SSE 连接样板代码。
 * 返回 { success, errorCode?, errorMessage? }
 */
export async function connectSse(opts: ConnectSseOptions): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const { url, method = 'GET', body, headers = {}, onEvent, signal, skipAuth } = opts;

  const token = skipAuth ? null : useAuthStore.getState().token;
  if (!skipAuth && !token) return { success: false, errorCode: 'UNAUTHORIZED', errorMessage: '未登录' };

  const isPost = method === 'POST' || body !== undefined;

  const reqHeaders: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isPost ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: isPost ? 'POST' : method,
      headers: reqHeaders,
      ...(isPost && body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return { success: true };
    return { success: false, errorCode: 'NETWORK_ERROR', errorMessage: e instanceof Error ? e.message : '网络错误' };
  }

  if (res.status === 401) {
    const authStore = useAuthStore.getState();
    if (authStore.isAuthenticated) {
      authStore.logout();
      window.location.href = '/login';
    }
    return { success: false, errorCode: 'UNAUTHORIZED', errorMessage: '未登录' };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { success: false, errorCode: 'UNKNOWN', errorMessage: t || `HTTP ${res.status} ${res.statusText}` };
  }

  try {
    await readSseStream(res, onEvent, signal);
  } catch (e) {
    if (signal.aborted) return { success: true };
    return { success: false, errorCode: 'NETWORK_ERROR', errorMessage: e instanceof Error ? e.message : 'SSE 读取失败' };
  }

  return { success: true };
}
