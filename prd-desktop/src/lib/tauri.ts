import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { useSystemErrorStore } from '../stores/systemErrorStore';
import { useSystemNoticeStore } from '../stores/systemNoticeStore';
import { useConnectionStore } from '../stores/connectionStore';
import { isSystemErrorCode, systemErrorTitle } from './systemError';

type InvokeArgs = Record<string, unknown> | undefined;
type UnlistenFn = () => void;

export function isTauri(): boolean {
  const g = globalThis as unknown as Record<string, any>;
  // 兼容不同版本/注入形态
  return Boolean(g.__TAURI_INTERNALS__?.invoke || g.__TAURI__?.invoke);
}

/**
 * 裸调用：用于连接探活/自检等场景，避免递归触发 invoke 的全局错误弹窗逻辑
 */
export async function rawInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (!isTauri()) {
    throw new Error('当前运行在非桌面(Tauri)环境，无法调用原生命令。');
  }
  return tauriInvoke<T>(cmd, args);
}

function looksLikeDisconnected(details: string): boolean {
  const s = String(details || '').toLowerCase();
  // 覆盖常见：端口关闭 / 连接被拒绝 / 超时 / DNS / 代理错误等
  const needles = [
    'connection refused',
    'econnrefused',
    'failed to connect',
    'could not connect',
    'connection error',
    'network error',
    'failed to fetch',
    'dns',
    'timed out',
    'timeout',
    'os error',
    'connection reset',
    'connection closed',
    'tcp connect error',
    'empty response from server',
  ];
  return needles.some((x) => s.includes(x));
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
      const code = typeof result.error?.code === 'string' ? result.error.code : null;
      const message = typeof result.error?.message === 'string' ? result.error.message : '请求失败';

      // 兜底：部分网络/代理/网关场景会返回 403 + 空 body，被我们映射成 PERMISSION_DENIED。
      // 对这些“疑似断连”的情况，先做一次轻量探活，若不可达则切到断连态并避免弹“无权限”误导用户。
      if (code === 'PERMISSION_DENIED') {
        try {
          const ok = await useConnectionStore.getState().probeOnce();
          if (!ok) {
            useSystemNoticeStore.getState().push('已断开连接，正在重连…', {
              level: 'warning',
              ttlMs: 4000,
              signature: 'conn:disconnected',
            });
            return result;
          }
        } catch {
          // ignore probe errors; fall through
        }
      }

      // UNAUTHORIZED 常见于启动/登录阶段的并发竞态或 token 同步窗口期：
      // - 不要在 invoke 层弹“系统错误”打扰用户
      // - 真正登录过期会由 Rust 侧 emit `auth-expired` 事件触发 logout（见 App.tsx）
      //
      // PERMISSION_DENIED：
      // - 很容易被网关/代理的 403（甚至空 body）误触发，导致用户误以为“账号无权限”
      // - 真实的权限不足应优先由业务 UI（按钮禁用/提示语）表达，而不是系统弹窗刷屏
      if (isSystemErrorCode(code) && code !== 'UNAUTHORIZED' && code !== 'PERMISSION_DENIED') {
        useSystemErrorStore.getState().open({
          title: systemErrorTitle(code),
          code,
          message,
          details: `command: ${cmd}`,
        });
      }
    }

    // 任意成功响应都可视为“连接正常”（避免需要额外心跳）
    useConnectionStore.getState().markConnected();
    return result;
  } catch (err) {
    const details = errorDetails(err);
    if (looksLikeDisconnected(details)) {
      useConnectionStore.getState().markDisconnected(details);
      useSystemNoticeStore.getState().push('已断开连接，正在重连…', {
        level: 'warning',
        ttlMs: 4500,
        signature: 'conn:disconnected',
      });
      // 断连场景不弹系统错误弹窗（避免刷屏/误导成权限不足）
      throw err;
    }

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



