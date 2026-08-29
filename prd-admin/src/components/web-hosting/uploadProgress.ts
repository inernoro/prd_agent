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

/**
 * 服务端解包的一帧（后端 GET /api/web-pages/upload-progress/{id} 的返回）。
 * 全部来自解包循环里的真实计数，算不出来的就是 null。
 */
export interface UnpackFrame {
  doneFiles?: number;
  totalFiles?: number;
  entryFile?: string | null;
  currentPath?: string | null;
  currentSize?: number;
  finished?: boolean;
}

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
  /**
   * 解包阶段的分步清单（设计稿屏 3 那三行）。
   * 拿不到服务端进度就是空数组——不编一份假清单出来。
   */
  steps: UnpackStep[];
}

export interface UnpackStep {
  state: 'done' | 'active';
  text: string;
  /** 第二行小字（当前文件的路径与大小） */
  sub?: string;
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

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
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
export function buildUploadProgress(
  loaded: number,
  total: number,
  elapsedMs: number,
  unpack?: UnpackFrame | null,
): UploadProgressView {
  // 字节已经全部送达（或者压根拿不到进度事件但请求还没回来）→ 服务端在解包。
  // 这一段没有任何进度信号，报百分比就是编，只能如实报已用时。
  //
  // 「服务端已经在报解包进度」本身就是字节送完了的证据，所以它单独也算数：重传走的是
  // 不带上传进度事件的 fetch，loaded 恒为 0，只看 loaded >= total 的话那一屏会从头到尾
  // 停在「正在建立上传连接」——服务端明明已经在一个个吐文件名了，界面一个字都不显示。
  const serverStarted = (unpack?.totalFiles ?? 0) > 0 || (unpack?.doneFiles ?? 0) > 0
    || !!unpack?.currentPath || !!unpack?.entryFile;
  if ((total > 0 && loaded >= total) || serverStarted) {
    const done = unpack?.doneFiles ?? 0;
    const all = unpack?.totalFiles ?? 0;
    // 服务端报得出「第几个 / 共几个」时就用真实比例；报不出来（Redis 不可用、
    // 单文件站没有解包这一步）才退回「没有进度可报」的诚实说法
    const hasCount = all > 0;
    const steps: UnpackStep[] = [];
    if (hasCount) {
      steps.push({ state: 'done', text: `已解包 ${done.toLocaleString()} / ${all.toLocaleString()} 个文件` });
    }
    if (unpack?.entryFile) {
      steps.push({ state: 'done', text: `识别到入口文件 ${unpack.entryFile}` });
    }
    if (hasCount && unpack?.currentPath && done < all) {
      steps.push({
        state: 'active',
        text: `正在上传第 ${(done + 1).toLocaleString()} 个`,
        sub: `${unpack.currentPath}${unpack.currentSize ? ` · ${fmtBytes(unpack.currentSize)}` : ''}`,
      });
    }

    return {
      phase: 'processing',
      ratio: hasCount ? Math.min(1, done / all) : 1,
      bytesPerSec: null,
      etaMs: null,
      title: hasCount ? `正在解包 ${Math.round((done / all) * 100)}%` : '文件已送达，服务端正在解包并识别入口',
      detail: hasCount
        ? `已用时 ${fmtDuration(elapsedMs)}`
        : `已用时 ${fmtDuration(elapsedMs)}（这一步没有进度可报，完成即跳转）`,
      steps,
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
      steps: [],
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
    steps: [],
  };
}

/**
 * 这一发该不该显示上传进度那一屏。
 *
 * 抽出来的理由与本文件其余部分一致：它此前写在组件的三元条件里，写成了 `saving && !isEdit`
 * ——把重传整个挡在门外。轮询照跑、解包帧照收、`buildUploadProgress` 也照算，
 * 只有渲染这一段没接上，屏幕上从头到尾是一个不动的「处理中...」。这种「链路只建一半」
 * 删掉不会红，所以判据必须有个能被直接调用的落点。
 *
 * @param saving  正在提交
 * @param isEdit  编辑既有站点（重传或改元信息），而非新建
 * @param hasFile 这一发挑了文件
 */
export function showsUploadProgress(
  { saving, isEdit, hasFile }: { saving: boolean; isEdit: boolean; hasFile: boolean },
): boolean {
  if (!saving) return false;
  // 纯改元信息没有文件要传，这一屏无从谈起；其余（新建、重传）都要显示。
  return !isEdit || hasFile;
}
