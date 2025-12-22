/**
 * 背景控制三事件：
 * - START：请求背景进入“运行态”（亮起 + 转动）
 * - STOP：请求背景进入“刹车态”（内部减速，最终停止）
 * - STOPPED：背景确认已“完全停止”（用于 UI 串联：先停背景再弹窗等）
 *
 * 说明：调用方只发命令，不做强制停帧；停止节奏由背景组件内部执行。
 */
export const BACKDROP_BUSY_START_EVENT = 'prd-admin:backdrop-motion-start';
export const BACKDROP_BUSY_END_EVENT = 'prd-admin:backdrop-motion-stop';
export const BACKDROP_BUSY_STOPPED_EVENT = 'prd-admin:backdrop-motion-stopped';

export function emitBackdropBusyStart() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BACKDROP_BUSY_START_EVENT));
}

export function emitBackdropBusyEnd(): string {
  if (typeof window === 'undefined') return '';
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  window.dispatchEvent(new CustomEvent(BACKDROP_BUSY_END_EVENT, { detail: { id } }));
  return id;
}

export function emitBackdropBusyStopped(id: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BACKDROP_BUSY_STOPPED_EVENT, { detail: { id } }));
}

export function waitForBackdropBusyStopped(id: string, timeoutMs = 2600): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const onEvt = (e: Event) => {
      const ce = e as CustomEvent;
      const evtId = (ce.detail?.id as string | undefined) ?? '';
      if (!evtId || evtId !== id) return;
      cleanup();
    };
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener(BACKDROP_BUSY_STOPPED_EVENT, onEvt);
      if (t) window.clearTimeout(t);
      resolve();
    };
    window.addEventListener(BACKDROP_BUSY_STOPPED_EVENT, onEvt);
    const t = window.setTimeout(() => cleanup(), Math.max(0, timeoutMs));
  });
}


