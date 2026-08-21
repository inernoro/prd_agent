/**
 * 上传等待期的「在做什么 + 还要多久」（设计稿屏 3 上传中态）。
 *
 * 抽成纯函数的理由和 resolveVisitorGate 一样：这里全是**该不该说**的判断
 * ——样本不够就不许报 ETA、字节发完了就不能再说「正在上传」——
 * 写在组件里只能靠断言文案字面量，改一个字测试就红，改错逻辑测试反而不红。
 */

export type UploadPhase =
  /** 还没开始发字节 */
  | 'connecting'
  /** 正在往服务端送字节，有真实的 loaded/total */
  | 'sending'
  /** 字节发完了，服务端在解包 / 找入口 —— 这一段没有进度通道，只能报已用时 */
  | 'processing';

export interface UploadProgressView {
  phase: UploadPhase;
  /** 0~1；processing 阶段恒为 1 */
  ratio: number;
  /** 每秒字节数；样本不足时为 null */
  bytesPerSec: number | null;
  /** 预计剩余毫秒；算不出来就是 null，不许编一个 */
  etaMs: number | null;
  /** 主文案：此刻在做什么 */
  title: string;
  /** 副文案：还要多久 / 已经等了多久 */
  detail: string;
}

/** 低于这个已发字节数不报速率——刚开头那几百毫秒算出来的速率会离谱到没有参考价值 */
const MIN_SAMPLE_BYTES = 64 * 1024;
/** 低于这个已用时间同样不报——分母太小，速率会跳 */
const MIN_SAMPLE_MS = 700;

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`;
}

export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

/**
 * @param loaded    已发送字节；未拿到进度事件时传 0
 * @param total     文件总字节；lengthComputable 为 false 时传 0
 * @param elapsedMs 从点「上传」到现在的真实毫秒
 */
export function buildUploadProgress(loaded: number, total: number, elapsedMs: number): UploadProgressView {
  // 字节已经全部送达（或者压根拿不到进度事件但请求还没回来）→ 服务端在解包。
  // 这一段没有任何进度信号，报百分比就是编，只能如实报已用时。
  if (total > 0 && loaded >= total) {
    return {
      phase: 'processing',
      ratio: 1,
      bytesPerSec: null,
      etaMs: null,
      title: '文件已送达，服务端正在解包并识别入口',
      detail: `已用时 ${fmtDuration(elapsedMs)}（这一步没有进度可报，完成即跳转）`,
    };
  }

  if (loaded <= 0 || total <= 0) {
    return {
      phase: 'connecting',
      ratio: 0,
      bytesPerSec: null,
      etaMs: null,
      title: '正在建立上传连接',
      detail: '马上开始传输',
    };
  }

  const ratio = Math.min(1, loaded / total);
  const enoughSample = loaded >= MIN_SAMPLE_BYTES && elapsedMs >= MIN_SAMPLE_MS;
  const bytesPerSec = enoughSample ? (loaded / elapsedMs) * 1000 : null;
  const etaMs = bytesPerSec && bytesPerSec > 0 ? ((total - loaded) / bytesPerSec) * 1000 : null;

  return {
    phase: 'sending',
    ratio,
    bytesPerSec,
    etaMs,
    title: `正在上传 ${Math.round(ratio * 100)}%`,
    detail: etaMs === null
      ? '正在测速…'
      : `约还需 ${fmtDuration(etaMs)}${bytesPerSec ? ` · ${fmtRate(bytesPerSec)}` : ''}`,
  };
}
