import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { useSystemErrorStore } from '../stores/systemErrorStore';
import { isSystemErrorCode, systemErrorTitle } from './systemError';

type InvokeArgs = Record<string, unknown> | undefined;
type UnlistenFn = () => void;

export function isTauri(): boolean {
  const g = globalThis as unknown as Record<string, any>;
  // 兼容不同版本/注入形态
  return Boolean(g.__TAURI_INTERNALS__?.invoke || g.__TAURI__?.invoke);
}

/**
 * 统一封装 Tauri invoke：
 * - 在 Tauri 环境正常调用
 * - 在浏览器/非 Tauri 环境给出可读错误，避免 TypeError: ... undefined (reading 'invoke')
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (!isTauri()) {
    throw new Error('当前运行在非桌面(Tauri)环境，无法调用原生命令。请使用桌面窗口打开，或使用“演示模式”。');
  }

  try {
    const result = await tauriInvoke<T>(cmd, args);

    // 系统级错误拦截：若返回体符合 ApiResponse 且 success=false 且 code 属于系统性错误，则弹窗接管
    if (isApiResponseLike(result) && result.success === false) {
      const code = result.error?.code ?? null;
      const message = result.error?.message ?? '请求失败';
      if (isSystemErrorCode(code)) {
        useSystemErrorStore.getState().open({
          title: systemErrorTitle(code),
          code,
          message: code === 'UNAUTHORIZED' ? '登录已过期或无效，请重新登录' : message,
          details: `command: ${cmd}`,
        });
      }
    }

    return result;
  } catch (err) {
    const details = errorDetails(err);
    useSystemErrorStore.getState().open({
      title: '请求失败',
      code: null,
      message: '请求失败，请检查网络或服务器状态',
      details: `command: ${cmd}\n${details}`,
    });
    throw err;
  }
}

/**
 * 统一封装 Tauri listen：
 * - 在 Tauri 环境正常订阅事件
 * - 在浏览器/非 Tauri 环境降级为 no-op（返回一个可调用的取消函数）
 */
export async function listen<T>(
  event: string,
  handler: (event: { event: string; payload: T; id: number }) => void
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {};
  }
  return tauriListen<T>(event, handler as any) as unknown as UnlistenFn;
}

type ApiResponseLike = {
  success: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

function isApiResponseLike(v: unknown): v is ApiResponseLike {
  if (!v || typeof v !== 'object') return false;
  const anyV = v as any;
  if (typeof anyV.success !== 'boolean') return false;

  // success=true 时不强制要求 data/error
  if (anyV.success === true) return true;

  // success=false 时要求 error 是 {code:string,message:string}
  if (!anyV.error || typeof anyV.error !== 'object') return false;
  return typeof anyV.error.code === 'string' && typeof anyV.error.message === 'string';
}

function errorDetails(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.stack || err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}



