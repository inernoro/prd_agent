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

/**
 * 音频时长从播放器往上报。设计稿要求处理中那一屏的「保存音频」行写明时长，
 * 但时长只有加载完音频的播放器知道，条目元数据里没有这个字段。
 * 与其为了一个数字去后端加字段，不如让已经知道它的那一端说出来。
 */
export const RECORDING_DURATION_EVENT = 'map:recording-duration';

/*
 * 「进入结果页并开始播放」这一下，请求会早于播放器挂载：发事件那一刻还没有人订阅。
 * 此前靠 `setTimeout(120)` 等播放器挂上来，代价是把用户手势的活跃期一起等没了——
 * 移动端 Safari 于是拒掉 play()，界面退成「无法播放 + 下载兜底」，而那段录音其实好好的。
 *
 * 改成一个只活 REQUEST_TTL_MS 的闩：没人在听就先记下，播放器一订阅立刻消费掉。
 * 调用方因此可以在手势那一拍里同步发出请求，不必等。
 */
const REQUEST_TTL_MS = 15_000;
let listenerCount = 0;
let pendingRequestAt = 0;

/** 请求播放当前这段录音。播放器还没挂上来时会被闩住，等它订阅时补发一次。 */
export function requestRecordingPlay(): void {
  if (typeof window === 'undefined') return;
  if (listenerCount === 0) pendingRequestAt = Date.now();
  window.dispatchEvent(new CustomEvent(RECORDING_PLAY_REQUEST_EVENT));
}

/** 播放器订阅播放请求；返回退订函数。订阅时会消费掉挂载前发出的那一次请求。 */
export function onRecordingPlayRequest(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(RECORDING_PLAY_REQUEST_EVENT, handler);
  listenerCount += 1;
  // 闩只补发一次，且过期不补：十几秒前那一下再响，用户已经不记得是自己点的了
  if (pendingRequestAt > 0 && Date.now() - pendingRequestAt <= REQUEST_TTL_MS) {
    pendingRequestAt = 0;
    handler();
  } else if (pendingRequestAt > 0) {
    pendingRequestAt = 0;
  }
  return () => {
    window.removeEventListener(RECORDING_PLAY_REQUEST_EVENT, handler);
    listenerCount = Math.max(0, listenerCount - 1);
  };
}

/** 仅供测试：清掉闩与订阅计数，避免用例之间互相串。 */
export function __resetRecordingPlayBridge(): void {
  listenerCount = 0;
  pendingRequestAt = 0;
}

/** 播放器把它读到的音频时长（秒）广播出去。 */
export function announceRecordingDuration(seconds: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  window.dispatchEvent(new CustomEvent(RECORDING_DURATION_EVENT, { detail: seconds }));
}

/** 订阅音频时长；返回退订函数。 */
export function onRecordingDuration(handler: (seconds: number) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => {
    const seconds = (event as CustomEvent<number>).detail;
    if (Number.isFinite(seconds) && seconds > 0) handler(seconds);
  };
  window.addEventListener(RECORDING_DURATION_EVENT, listener);
  return () => window.removeEventListener(RECORDING_DURATION_EVENT, listener);
}
