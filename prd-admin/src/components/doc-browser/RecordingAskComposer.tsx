/**
 * 「问这场录音」的提问区 —— 对齐设计稿 B4 底部那一条。
 *
 * 稿面是「一个圆角输入框 + 右侧一颗圆形蓝色发送键」，贴在屏幕底部，
 * 键盘弹起时仍然完整可见。发送键做成圆形而不是文字按钮，是因为它要贴着输入框，
 * 一个方形文字按钮在这个位置会把输入框挤成半截。
 *
 * 说明文案与「打开多轮问答」排在输入行下方——它们是解释与旁路，
 * 不该和主输入抢那一行的宽度。
 *
 * 单独成文件：B4 那一屏要把它贴到底并单独取证，留在 `TranscriptKaraoke` 内部的话
 * 对照台只能照着重画一份（predicate-and-wiring-discipline 形状 6）。
 */
import { ArrowUp } from 'lucide-react';

export function RecordingAskComposer({
  value,
  onChange,
  onSend,
  sending = false,
  onOpenMultiTurn,
  pinned = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  /** 正在问：发送键禁用并换文案，不给一个点了没反应的按钮 */
  sending?: boolean;
  /** 打开多轮问答（旁路入口）；不传就不渲染 */
  onOpenMultiTurn?: () => void;
  /** 贴底形态（稿面 B4）：加一条上分隔线，与上方对话区切开 */
  pinned?: boolean;
}) {
  const canSend = !sending && value.trim().length > 0;
  return (
    <div
      className={pinned ? 'w-full px-4 pb-4 pt-3' : 'w-full'}
      style={pinned ? { background: 'var(--bg-card)', borderTop: '1px solid var(--border-faint)' } : undefined}
    >
      <div className="flex items-end gap-2.5">
        <textarea
          value={value}
          onChange={event => onChange(event.target.value)}
          rows={1}
          placeholder="例如：客户对于报价的态度是什么？"
          aria-label="问这场录音"
          className="min-h-11 flex-1 resize-none rounded-[14px] px-3.5 py-2.5 text-[14px] leading-relaxed text-token-primary outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
        />
        <button
          type="button"
          disabled={!canSend}
          onClick={onSend}
          aria-label="发送问题"
          title={sending ? '正在分析整场录音' : '发送问题'}
          // 稿面这颗是圆形实心蓝 + 白色上箭头；不可发送时压暗而不是隐藏，
          // 否则用户看不出「还差一步就能发」
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full disabled:opacity-40"
          style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}
        >
          <ArrowUp size={18} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-token-muted">答案会引用时间段；点击时间可从对应录音片段播放</p>
        {onOpenMultiTurn && (
          <button type="button" onClick={onOpenMultiTurn} className="min-h-9 rounded-[8px] px-2 text-[11px] text-token-muted">
            打开多轮问答
          </button>
        )}
      </div>
      {sending && <p className="mt-2 animate-pulse text-[12px] text-token-muted motion-reduce:animate-none">正在读取原文并核对时间轴</p>}
    </div>
  );
}
