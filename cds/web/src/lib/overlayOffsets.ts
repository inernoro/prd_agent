/**
 * 右下角浮层安全偏移（SSOT）。
 *
 * 右下角同时住着两类东西：
 *   1. 常驻的「提交缺陷」pill（BugReportDialog 的入口，z-index 120）；
 *   2. 各页面保存/失败后的操作反馈 toast（z-index 50）。
 *
 * 两者几何位置几乎重合而层级差一个数量级，pill 会把 toast 压住半句——被遮的恰恰是
 * 必须看清的失败原因。这里给出一份共享的安全偏移：pill 用它定位自己，toast 用它
 * 上移，二者互不重叠。禁止用「toast 出现时藏 pill」这种靠时序的方案（时序脆弱，
 * 且 toast 与 pill 分属不同组件树，没有可靠的协调点）。
 *
 * 修改任一常量前先想清楚：pill 的实际高度（px-3 py-2 + text-xs 行高）约 34px，
 * 这里按 36px 取整留冗余。
 */

/** pill 距屏幕底部的距离（对应 Tailwind bottom-4）。 */
export const BUG_PILL_BOTTOM_PX = 16;

/** pill 自身高度（含上下内边距）的保守估计。 */
export const BUG_PILL_HEIGHT_PX = 36;

/** pill 与 toast 之间的视觉间隙。 */
export const BOTTOM_RIGHT_GAP_PX = 8;

/**
 * 右下角安全高度：低于这个值的浮层会与常驻 pill 抢地盘。
 * toast 一律从这个高度往上排。
 */
export const BOTTOM_RIGHT_SAFE_PX =
  BUG_PILL_BOTTOM_PX + BUG_PILL_HEIGHT_PX + BOTTOM_RIGHT_GAP_PX;

/** 常驻 pill 的定位样式（与 toast 共用同一套常量）。 */
export const bugPillAnchorStyle = {
  bottom: `${BUG_PILL_BOTTOM_PX}px`,
  right: `${BUG_PILL_BOTTOM_PX}px`,
} as const;

/** 页面级 toast 的定位样式：让开 pill 占据的那一格。 */
export const bottomRightToastStyle = {
  bottom: `${BOTTOM_RIGHT_SAFE_PX}px`,
  right: '20px',
} as const;
