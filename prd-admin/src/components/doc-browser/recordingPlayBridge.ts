/**
 * 「立即播放这段录音」这一下的接线。
 *
 * 处理中那一屏的主操作按钮在状态卡上，真正的播放器在同一页下方好几层组件里
 * （阅读器 → 文件预览 → 跟读组件）。把一个回调从上往下穿过这三层，只为了让
 * 一个按钮能按到播放键，代价比收益大；反过来让状态卡直接去 DOM 里找播放键，
 * 又是那种「改个 class 就静默失效」的写法。
 *
 * 所以这里给一条**只有一个事件名、两端都显式登记**的窄通道：
 * 状态卡 request，播放器 subscribe。两端各自只认这一个常量，
 * 谁被删掉都能被守卫测试扫出来（predicate-and-wiring-discipline 形状 2）。
 */

export const RECORDING_PLAY_REQUEST_EVENT = 'map:recording-play-request';

/** 请求播放当前这段录音。没有播放器在监听时是安全的空操作。 */
export function requestRecordingPlay(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RECORDING_PLAY_REQUEST_EVENT));
}

/** 播放器订阅播放请求；返回退订函数。 */
export function onRecordingPlayRequest(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(RECORDING_PLAY_REQUEST_EVENT, handler);
  return () => window.removeEventListener(RECORDING_PLAY_REQUEST_EVENT, handler);
}
