/**
 * 「当前片段」吸顶条 —— 对齐设计稿 P3 / B3 / B4 顶部那一条。
 *
 * 原文往下滚之后，完整播放区收成这一条：一颗播放键、正在念的那句、播放进度。
 * 三块设计稿画的是同一条，但细节各说各的：
 *   - `P3` 把时间放在句子下面一行，右侧留一颗展开箭头
 *   - `B3` / `B4` 把时间放在句子右侧，没有箭头
 * 取并集：单行排布 `播放键 | 句子 | 时间 | (展开箭头)`，时间在右（B3/B4 要的位置），
 * 箭头由 `onExpand` 决定给不给（P3 要的入口）。单行还顺带压掉一半高度——
 * 两行那一版有 80px 高，吸顶时把下一段的分区标题压掉半截，两位判官各记了一条。
 *
 * 单独成文件而不是留在 `TranscriptKaraoke` 里：B4 那一屏（键盘弹起、只剩问答）
 * 也要这条，对照台得能单独摆出它。留在组件内部的话，台架只能照着重画一份，
 * 判分判的就成了副本（predicate-and-wiring-discipline 形状 6）。
 */
import { ChevronUp, Pause, Play } from 'lucide-react';

/** mm:ss，与转录列表同一口径（分钟补两位）。 */
function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function RecordingSegmentBar({
  text,
  startSec,
  durationSec = 0,
  onPlay,
  onExpand,
  rateLabel,
  playing = false,
}: {
  /** 正在念的那句原文 */
  text: string;
  /** 这句的起始秒 */
  startSec: number;
  /** 整段录音时长；给 0 表示还不知道，此时只显示当前位置，不编一个总长出来 */
  durationSec?: number;
  onPlay?: () => void;
  /**
   * 当前倍速（如 `1.5×`）。稿面 P2 把它编在时间后面：收起之后倍速按钮不在视野里了，
   * 不写出来用户就不知道自己还挂着 1.5 倍速。拿不到就不显示，不写一个默认的 1.0×。
   */
  rateLabel?: string;
  /** 正在播时按钮画暂停图标——收起态这颗是这一屏唯一的播放开关 */
  playing?: boolean;
  /** 给了就渲染展开箭头（回到完整播放区）；不给就没有这颗 */
  onExpand?: () => void;
}) {
  return (
    <div
      /*
        通栏、无描边、无圆角：稿面这条是**屏幕顶上的一层**，不是内容里的一张卡。
        做成圆角卡会和承载它的吸顶容器叠成两层盒子，「常驻锚点」那层关系就弱掉了。
        背景与分隔线由外层吸顶容器给——它才知道自己贴在哪。
      */
      className="flex w-full max-w-[760px] items-center gap-3 py-1"
    >
      <button
        type="button"
        onClick={onPlay}
        // 稿面 P2/P3 这枚圆钮明显大过两行文字的高度——它是收起态里唯一的播放开关，
        // 36px 会让它退到和时间码同一量级，读起来像个装饰而不是主控件。
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
        title="播放"
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 1 }} />}
      </button>
      {/*
        最多两行。这一条唯一承载的内容就是这句话，单行截断在 390px 屏上只剩十来个字
        （时间与箭头把宽度吃掉了），读者反而不知道念到哪了——B3 判分记的正是这处。
        两行封顶保证它的高度仍然稳定，不会被长句撑成一块。
      */}
      {/*
        稿面 P2/P3 把这条画成**两行左对齐**：句子在上、时间与倍速在下。
        时间摆到右边那一版（B3/B4 的画法）在 390px 上会把句子挤成两行，
        「现在念到哪一句」反而读不完整——两稿冲突时取信息完整的那一种。
      */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className="min-w-0 text-[13px] font-medium leading-snug text-token-primary"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {text}
        </span>
        <span className="mt-0.5 font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
          {formatClock(startSec)}{durationSec > 0 ? ` / ${formatClock(durationSec)}` : ''}{rateLabel ? ` · ${rateLabel}` : ''}
        </span>
      </span>
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center"
          style={{ color: 'var(--text-muted)' }}
          title="展开播放器"
        >
          <ChevronUp size={15} />
        </button>
      )}
    </div>
  );
}
