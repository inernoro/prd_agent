/**
 * 录音采集屏（设计稿 v2-R1/R2/R3 与 cap-A1/A2/A3）的取值与措辞判据。
 *
 * 为什么单独一个文件：这几屏的每一行字都挂着一个真实数量——本机存了多少、
 * 传上去多少、实时原文停在第几句、还有几秒重试。判据混在 1000 行的面板组件里，
 * 既没法单测，也很容易在下一次改版里被换成一个「看起来对」的近似值
 * （predicate-and-wiring-discipline 形状 6）。所以取值全部收在这里，组件只负责画。
 */

/** 一句实时原文，以及它是在录音的第几秒第一次出现的。 */
export type LiveSentence = { text: string; atSec: number };

/**
 * 把实时转写的整段文本切成句。
 *
 * 服务端推的是**累计全文**（不是增量句），所以「第几句」只能由前端切。
 * 切句点取中文句读与换行；没有句读的长段落原样算一句——宁可少切，
 * 也不要按长度硬截出一句稿面上不存在的话。
 */
export function splitLiveSentences(text: string): string[] {
  return (text ?? '')
    .split(/(?<=[。！？!?；;\n])/)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * 累积「每句第一次出现的时刻」。
 *
 * 稿面 cap-A3 的展开列表左边是一列时间（10:02 / 10:24 …）。实时转写协议里
 * **没有**逐句时间戳，所以这个时间只能是「这句话第一次出现在实时原文里的录音时刻」，
 * 而不是从稿面抄一组好看的数字（no-rootless-tree）。最后一句还在生长，
 * 每次刷新都要用最新文本覆盖它，但**保留它最早出现的时刻**。
 */
export function advanceLiveSentenceLog(
  previous: readonly LiveSentence[],
  text: string,
  atSec: number,
): LiveSentence[] {
  const sentences = splitLiveSentences(text);
  const next: LiveSentence[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const prior = previous[i];
    // 同一位置的句子只要还是同一个开头，就认作「同一句在长」，沿用它的首现时刻。
    const sameSentence = prior
      && (sentences[i].startsWith(prior.text) || prior.text.startsWith(sentences[i]));
    next.push({ text: sentences[i], atSec: sameSentence ? prior.atSec : atSec });
  }
  return next;
}

export type CaptureChipTone = 'success' | 'info' | 'warning' | 'neutral';
export type CaptureChipIcon = 'shield' | 'drive' | 'upload' | 'check' | 'clock';
export type CaptureChip = {
  key: string;
  label: string;
  tone: CaptureChipTone;
  icon: CaptureChipIcon;
};

/** 1.0 MB 以下给一位小数，再小就给 KB——0.0 MB 是一句什么都没说的话。 */
export function formatCapturedSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 已上传百分比。
 *
 * 分母是**本机已经录下来的字节**，不是 19MB 那个录制上限——上限是「录到这里自动收尾」，
 * 拿它当分母会让进度永远停在个位数。分片上传天然滞后于录制，所以未收尾前封顶 99%，
 * 避免出现「100% 却还在传」。
 */
export function capturedUploadPercent(uploadedBytes: number, localBytes: number): number {
  if (localBytes <= 0) return 0;
  const pct = Math.floor((uploadedBytes / localBytes) * 100);
  return Math.max(0, Math.min(99, pct));
}

/**
 * 上传「跟上了没有」——**带迟滞**的判定。
 *
 * 录音每秒产生一个分片，`localBytes` 每秒往上跳一格，上传随即追平。
 * 直接用 `uploadedBytes >= localBytes` 这个瞬时比较去选文案、选进度条宽度，
 * 它就会每秒翻一次；而这个判据在采集屏被消费了三处（凭据 chip 的措辞、
 * 进度条是满条还是百分比、那句「录音还在继续，新片段会接着传」出不出现），
 * 于是同一屏每秒抖三下——窄屏上那句话进出还会把下面整块顶上顶下一行
 * （用户报的就是这个）。
 *
 * 迟滞的意思：**追平后要落后得足够多才算「没跟上」**。落后不到一个分片的量
 * （或占比很小）仍然算跟上——那本来就是「刚录下来的这一秒还在路上」，
 * 不是真的掉队。这样录音期间它稳定为 true，只有真的堆积了才翻成 false。
 */
/*
 * 容忍量按**分片**定，不按比例。录制是 64kbps、每秒一个分片，也就是约 8KB/秒；
 * 32KB 约等于四个分片，足够吸收「刚录下来的这一两秒还在路上」，又不会把真正的堆积
 * 说成跟上了。
 * 按比例定是错的：19MB 的录音里落后 700KB 只有 3.7%，听着很小，其实落后一分半——
 * 那时候界面绝不该说「已跟上录音进度」（这条是既有用例替我挡下来的）。
 */
export const UPLOAD_LAG_TOLERANCE_BYTES = 32 * 1024;

export function isUploadKeepingUp(uploadedBytes: number, localBytes: number): boolean {
  if (localBytes <= 0) return true;
  if (uploadedBytes >= localBytes) return true;
  return localBytes - uploadedBytes <= UPLOAD_LAG_TOLERANCE_BYTES;
}

export function describeCaptureChips(input: {
  localBytes: number;
  uploadedBytes: number;
  protection: 'pending' | 'active' | 'local';
  paused: boolean;
  /**
   * 本机保险箱**写成功过吗**。IndexedDB 不可用、隐私模式、配额满时写入会被拒，
   * 而录制照常进行、字节数照常涨——此时「已保护 · 无丢失」「本机已存 X」两块凭据
   * 都是假的：分片只在内存里，刷新、崩溃、关标签页就没了（Codex P1）。
   * 拿不到这个信号（旧调用方）按 true 处理，行为与此前一致。
   */
  vaultPersisted?: boolean;
}): CaptureChip[] {
  const persisted = input.vaultPersisted !== false;
  const chips: CaptureChip[] = persisted
    // 本机保险箱在录音开始那一刻就生效，所以「无丢失」不依赖网络是否可用。
    ? [{ key: 'guarded', label: '已保护 · 无丢失', tone: 'success', icon: 'shield' }]
    /*
      落不住盘就不许说「无丢失」。这一档只承诺「还在录」，并把用户唯一能做的事说清楚：
      别关这一页。上传那条链路仍然照常展示——它是这一档里真正的活路。
    */
    : [{ key: 'guarded', label: '本机存不下 · 请勿关闭本页', tone: 'warning', icon: 'shield' }];
  if (input.localBytes > 0 && persisted) {
    chips.push({
      key: 'local',
      label: `本机已存 ${formatCapturedSize(input.localBytes)}`,
      tone: 'success',
      icon: 'drive',
    });
  }
  if (input.protection === 'local') {
    chips.push({ key: 'upload', label: '上传等待中', tone: 'warning', icon: 'clock' });
    return chips;
  }
  if (input.protection === 'pending' || input.localBytes <= 0) {
    chips.push({ key: 'upload', label: '正在建立实时上传', tone: 'neutral', icon: 'clock' });
    return chips;
  }
  const percent = capturedUploadPercent(input.uploadedBytes, input.localBytes);
  // 暂停后不再产生新分片，队列追平就是真的全部传完了；录音中永远还有在途分片。
  if (input.paused && input.uploadedBytes >= input.localBytes) {
    chips.push({ key: 'upload', label: '已全部上传', tone: 'success', icon: 'check' });
    return chips;
  }
  /*
    录音**还在继续**、而队列已经追平：这一刻的真话是「已录的都传上去了」，
    不是「99%」。此前一律显示 percent，于是同屏出现「46 KB / 46 KB」配「99%」，
    两处口径互相打脸（cap-S2 判分记的正是这处）。99% 那个上限本意是不许在录音期间
    宣称「全部完成」——换成一句「已跟上录音进度」既守住了这条，又不再自相矛盾。
  */
  if (isUploadKeepingUp(input.uploadedBytes, input.localBytes)) {
    chips.push({
      key: 'upload',
      label: `实时上传 ${formatCapturedSize(input.uploadedBytes)} · 已跟上录音进度`,
      tone: 'info',
      icon: 'upload',
    });
    return chips;
  }
  chips.push({
    key: 'upload',
    label: `实时上传 ${formatCapturedSize(input.uploadedBytes)} · ${percent}%`,
    tone: 'info',
    icon: 'upload',
  });
  return chips;
}

export type LiveTranscriptView = 'connecting' | 'live' | 'finalizing' | 'completed' | 'degraded';

/** 实时原文卡的标题：状态 + 句数，一行说清「现在是不是在转、停在哪」。 */
export function describeLiveTranscriptTitle(input: {
  state: LiveTranscriptView;
  paused: boolean;
  expanded: boolean;
  sentenceCount: number;
}): string {
  if (input.state === 'degraded') return '实时原文暂时不可用';
  if (input.paused) return `实时原文 · 已停在 ${input.sentenceCount} 句`;
  if (input.expanded) return `实时原文 · 全部 ${input.sentenceCount} 句`;
  if (input.state === 'live') return '实时原文 · 正常';
  if (input.state === 'completed') return '实时原文 · 已完成';
  if (input.state === 'finalizing') return '实时原文 · 正在确认最后一句';
  return '实时原文 · 连接中';
}

/**
 * 重连退避。
 *
 * 原先三次都是 800ms：弱网下 2.4 秒内连挂三次，然后永久降级——用户看到的是
 * 「刚断网就再也不恢复了」。改成 800ms / 4s / 15s，让后两次落在网络真的可能恢复的窗口里，
 * 顺带让稿面 cap-A2 那句「N 秒后重试」有真实的数可以显示。
 */
const LIVE_RETRY_DELAYS_MS = [800, 4_000, 15_000] as const;

export function liveTranscriptionRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return LIVE_RETRY_DELAYS_MS[0];
  return LIVE_RETRY_DELAYS_MS[Math.min(attempt, LIVE_RETRY_DELAYS_MS.length) - 1];
}

/** 倒计时秒数：只在真有一次已排期的重连时才有值，否则不许显示「N 秒后重试」。 */
export function describeRetryCountdown(nextRetryAt: number | null, now: number): string | null {
  if (nextRetryAt == null) return null;
  const seconds = Math.ceil((nextRetryAt - now) / 1000);
  if (seconds <= 0) return '正在重连';
  return `${seconds}s 后重试`;
}
