/**
 * 画布自动落盘的调度时序。
 *
 * 抽成纯函数是为了让它**可测**：原来这段逻辑长在一个 useEffect 里，要证明
 * 「撞上频控时改期而不是丢弃」，得在真实浏览器里构造出「一次落盘被丢弃且此后
 * 再无画布变化」的时序——冒烟里做不出稳定复现，于是这条修复只能挂在验收债务上。
 * 换个层次就测得了：输入是两个时刻，输出是「还要等多久」。
 *
 * 判据纪律：`.claude/rules/predicate-and-wiring-discipline.md`。
 */

/** 画布变动后等这么久才落盘，把连续改动合并成一次。 */
export const CANVAS_SAVE_DEBOUNCE_MS = 1200;

/**
 * 两次落盘之间的最小间隔。
 *
 * 撞上它时**必须改期**，不能直接放弃这一次：放弃之后若没有新的画布变化，
 * 就再也没有人来救它，最后一次改动永远不落盘。分层收尾会连着刷好几次画布
 * （点亮图层 → 裁剪落位 → 内容判定），最后一批正好落进这个窗口。
 */
export const CANVAS_SAVE_COOLDOWN_MS = 800;

/**
 * 现在能不能落盘；不能的话还要等多久。
 *
 * @returns 0 = 立刻可落盘；正数 = 还需等待的毫秒数（调用方据此改期，**不是**丢弃）
 */
export function canvasSaveCooldownRemaining(input: {
  now: number;
  /** 上一次真正落盘的时刻；从未落过传 0。 */
  lastSavedAt: number;
  cooldownMs?: number;
}): number {
  // 没传 = 用默认；传了负数 = 明确表示「不要冷却」，钳到 0。
  // 不能把负数当「没传」退回默认——那会让「我不要冷却」被静默改成「等 800ms」。
  const cooldown = Number.isFinite(input.cooldownMs)
    ? Math.max(0, input.cooldownMs as number)
    : CANVAS_SAVE_COOLDOWN_MS;
  const now = Number.isFinite(input.now) ? input.now : 0;
  const last = Number.isFinite(input.lastSavedAt) ? input.lastSavedAt : 0;
  // 时钟回拨或未落过盘：直接放行，绝不算出一个负数或天文数字的等待。
  if (last <= 0 || now < last) return 0;
  const elapsed = now - last;
  return elapsed >= cooldown ? 0 : cooldown - elapsed;
}
