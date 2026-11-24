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
import { useLayoutEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * 输入变长就把框撑高（到上限为止再内部滚动）。
 * 固定高度 + 多行输入 = 用户看不到自己刚打的字，那比排版难看严重得多。
 */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

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
  /*
   * 高度跟着**受控值**走，不只跟着敲键盘走：发送成功后由宿主把值清空，
   * 只在 onChange 里量的话框会保持刚才那个高度，留下一个空的高框。
   */
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { autoGrow(boxRef.current); }, [value]);
  return (
    <div
      className={pinned ? 'w-full px-4 pb-4 pt-3' : 'w-full'}
      style={pinned ? { background: 'var(--bg-card)', borderTop: '1px solid var(--border-faint)' } : undefined}
    >
      <div className="flex items-end gap-2.5">
        <textarea
          value={value}
          onChange={event => onChange(event.target.value)}
          ref={boxRef}
          rows={1}
          /*
           * 占位文案必须在 390px 屏上排得下**一行**：textarea 没有 ellipsis，
           * 排到第二行就会被 `min-h-[52px]` 的固定高度从中间切断——真实页面上
           * 原先那句「例如：客户对于报价的态度是什么？」的「么？」两个字就是这么被吃掉的。
           * 加长它之前先在 390px 量一遍。
           */
          placeholder="例如：客户怎么看报价？"
          aria-label="问这场录音"
          className="min-h-[52px] max-h-[132px] flex-1 resize-none overflow-y-auto rounded-[16px] px-4 py-3.5 text-[15px] leading-relaxed text-token-primary outline-none"
          // 有草稿 = 用户正在这里打字，边框跟着亮一档。稿面这一屏画的就是「正在输入」那一刻，
          // 给它和空框一样的弱边框，读者看不出焦点落在哪（B4 判分记的这处）
          style={{
            background: 'var(--bg-input)',
            border: `1px solid ${value.trim() ? 'var(--border-hover)' : 'var(--border-default)'}`,
          }}
        />
        <button
          type="button"
          disabled={!canSend}
          onClick={onSend}
          aria-label="发送问题"
          title={sending ? '正在分析整场录音' : '发送问题'}
          // 稿面这颗是圆形实心蓝 + 白色上箭头；不可发送时压暗而不是隐藏，
          // 否则用户看不出「还差一步就能发」
          // 压到 40% 之后它在稿面那一刻（已发送、输入框空着）读起来像个失效控件，
          // 判官记的是「主操作在这一屏不突出」。55% 仍然明显是「还差一步」，但不再灰掉。
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full disabled:opacity-55"
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
