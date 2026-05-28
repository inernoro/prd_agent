/*
 * useSseConnection — 通用 SSE 长连接管理 hook
 *
 * 2026-05-28 抽提:之前每个组件自己 new EventSource + 自己处理 onerror。
 * Cloudflare 边缘偶发 400/502 时,浏览器内置每 ~3s 自动重试一次,N 个组件
 * 就是 N × ~20 次/min 的 400 红条堆积。useCdsEvents 已经吃了这个亏修过一次,
 * 现在抽成通用 hook,所有 SSE 都享受同样防御:
 *
 *   1. onerror 立即 close() 阻止浏览器原生重试
 *   2. 自家 exponential backoff: 5s, 10s, 20s,3 次后停
 *   3. 用户主动调 reconnect() 重置计数器再连
 *
 * 使用方式:
 *   const sse = useSseConnection({
 *     url: '/api/branches/stream?project=' + id,
 *     events: { snapshot: handleSnap, update: handleUp, keepalive: noop },
 *     enabled: !!id,
 *   });
 *   // sse.status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed'
 *   // sse.reconnect() — 强制重连
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface UseSseConnectionOptions {
  /** SSE URL,可带 query。若以 / 开头会过 apiUrl 改写为 /_cds/api/ */
  url: string;
  /** 事件名 → 处理函数。data 已是 raw string,处理函数负责 JSON.parse */
  events: Record<string, (evt: MessageEvent) => void>;
  /** 是否启用本连接。url / enabled 变了会重建连接 */
  enabled?: boolean;
  /** 可选的 onopen 回调(只在每次成功建立连接时触发一次) */
  onOpen?: () => void;
  /** 可选的 onError 回调(每次失败触发) */
  onError?: () => void;
  /** 最大自家重试次数,默认 3 */
  maxAttempts?: number;
}

export interface UseSseConnectionResult {
  status: SseStatus;
  /** 强制立刻重连(用户主动点击场景),会重置 attempt 计数 */
  reconnect: () => void;
  /** 当前 attempt 计数(0=首次连接,1+=重试中) */
  attempt: number;
}

export function useSseConnection(opts: UseSseConnectionOptions): UseSseConnectionResult {
  const { url, events, enabled = true, onOpen, onError, maxAttempts = 3 } = opts;

  const [status, setStatus] = useState<SseStatus>('idle');
  const [attempt, setAttempt] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);
  // 把最新的 events / 回调存 ref 避免 useEffect 依赖触发重建连接
  const eventsRef = useRef(events);
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);

  eventsRef.current = events;
  onOpenRef.current = onOpen;
  onErrorRef.current = onError;

  const closeConn = useCallback(() => {
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* tolerate */ }
      esRef.current = null;
    }
  }, []);

  const open = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (stoppedRef.current) return;
    closeConn();
    setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

    const finalUrl = url.startsWith('/api/') ? apiUrl(url) : url;
    let es: EventSource;
    try {
      es = new EventSource(finalUrl, { withCredentials: true });
    } catch (err) {
      setStatus('failed');
      // eslint-disable-next-line no-console
      console.warn('[useSseConnection] EventSource constructor failed:', (err as Error).message);
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      attemptRef.current = 0;
      setAttempt(0);
      setStatus('open');
      onOpenRef.current?.();
    };

    es.onerror = () => {
      // 关键:立即 close() 阻止浏览器内置每 3s 重连,把控制权交给自家 backoff。
      // 这是 cds-events 风暴的根治办法,通用 SSE 也走同样路径。
      onErrorRef.current?.();
      closeConn();
      attemptRef.current += 1;
      const cur = attemptRef.current;
      setAttempt(cur);
      if (cur > maxAttempts) {
        setStatus('failed');
        // eslint-disable-next-line no-console
        console.warn('[useSseConnection] giving up after', maxAttempts, 'attempts on', url);
        return;
      }
      const delay = Math.min(20_000, 5_000 * Math.pow(2, cur - 1));
      setStatus('reconnecting');
      if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        open();
      }, delay);
    };

    // 注册每个事件
    for (const [evName, handler] of Object.entries(eventsRef.current)) {
      es.addEventListener(evName, (evt) => {
        try {
          handler(evt as MessageEvent);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[useSseConnection] event handler error:', evName, (err as Error).message);
        }
      });
    }
  }, [url, maxAttempts, closeConn]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setAttempt(0);
    stoppedRef.current = false;
    if (reconnectTimer.current != null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    open();
  }, [open]);

  useEffect(() => {
    if (!enabled) {
      stoppedRef.current = true;
      closeConn();
      if (reconnectTimer.current != null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      setStatus('idle');
      return;
    }
    stoppedRef.current = false;
    attemptRef.current = 0;
    setAttempt(0);
    open();
    return () => {
      stoppedRef.current = true;
      closeConn();
      if (reconnectTimer.current != null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };
  }, [url, enabled, open, closeConn]);

  return { status, reconnect, attempt };
}
