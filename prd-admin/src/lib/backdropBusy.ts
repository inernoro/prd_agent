export const BACKDROP_BUSY_START_EVENT = 'prd-admin:backdrop-busy-start';
export const BACKDROP_BUSY_END_EVENT = 'prd-admin:backdrop-busy-end';
/** busy 结束后，强制背景先“停住”一小段时间，再允许其它动效接管（避免弹窗/内容抢镜） */
export const BACKDROP_POST_BUSY_HOLD_MS = 480;

export function emitBackdropBusyStart() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BACKDROP_BUSY_START_EVENT));
}

export function emitBackdropBusyEnd() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BACKDROP_BUSY_END_EVENT));
}


