/**
 * 客户端错误上报 —— 全局捕获 window.error + unhandledrejection + React 渲染错误。
 *
 * 目标：不再依赖用户手动反馈"页面黑屏"。错误自动进入 sessionStorage 环形缓冲，
 * /_dev/mobile-audit 页面可以一眼查出本次会话中哪个路由崩溃、崩在哪一行。
 *
 * V1：仅客户端存储。V2（后续）：叠加 POST 到后端 /api/client-error-logs 做跨会话归档。
 */

export type ClientErrorKind = 'render' | 'window-error' | 'unhandled-rejection' | 'console-error';

export interface ClientErrorEntry {
  id: string;
  ts: number;
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  viewport: string;
  /** source file if available */
  source?: string;
  line?: number;
  column?: number;
}

const STORAGE_KEY = 'map.client-errors.v1';
const MAX_ENTRIES = 50;

function readBuffer(): ClientErrorEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClientErrorEntry[]) : [];
  } catch {
    return [];
  }
}

function writeBuffer(entries: ClientErrorEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota exceeded etc. —— 丢掉最旧的一半再试
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-Math.floor(MAX_ENTRIES / 2))));
    } catch {
      // silently give up
    }
  }
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function recordClientError(partial: Omit<ClientErrorEntry, 'id' | 'ts'>): void {
  const entry: ClientErrorEntry = {
    id: genId(),
    ts: Date.now(),
    ...partial,
  };
  const buf = readBuffer();
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  writeBuffer(buf);

  // 同时 console.error 方便 DevTools 查看
  console.error('[ClientError]', entry.kind, entry.message, entry);
}

export function getClientErrors(): ClientErrorEntry[] {
  return readBuffer();
}

export function clearClientErrors(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

let installed = false;

/**
 * 在 main.tsx 启动阶段调用一次。重复调用安全（幂等）。
 */
export function installGlobalErrorReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (ev) => {
    // 资源加载错误（img/script/link failed）—— 有 target 但没 error 对象
    const target = ev.target as (HTMLElement | Window | null);
    if (target && target !== window && (target as HTMLElement).tagName) {
      const tag = (target as HTMLElement).tagName.toLowerCase();
      if (tag === 'img' || tag === 'script' || tag === 'link') {
        const src =
          (target as HTMLImageElement).src ||
          (target as HTMLLinkElement).href ||
          '(unknown)';
        recordClientError({
          kind: 'window-error',
          message: `Resource load failed: ${tag} ${src}`,
          url: window.location.href,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        });
        return;
      }
    }
    recordClientError({
      kind: 'window-error',
      message: ev.message || 'Unknown error',
      stack: ev.error?.stack,
      source: ev.filename,
      line: ev.lineno,
      column: ev.colno,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : (() => {
              try {
                return JSON.stringify(reason);
              } catch {
                return String(reason);
              }
            })();
    recordClientError({
      kind: 'unhandled-rejection',
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  });

  // 劫持 console.error —— 可选，但对"静默错误"有帮助。控制频率：只记带 Error 的。
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const firstErr = args.find((a) => a instanceof Error) as Error | undefined;
      if (firstErr) {
        recordClientError({
          kind: 'console-error',
          message: firstErr.message,
          stack: firstErr.stack,
          url: window.location.href,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        });
      }
    } catch {
      // never let reporting itself crash
    }
    origConsoleError(...args);
  };
}
