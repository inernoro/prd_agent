import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

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

  return tauriInvoke<T>(cmd, args);
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



