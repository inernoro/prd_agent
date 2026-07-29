/**
 * 右下角浮层安全偏移（SSOT）。
 *
 * 右下角的**唯一**系统提醒区是 AppShell 的 `.cds-global-action-stack`（index.css）：
 * 授权请求 / 导入审批 / 版本更新徽章 / 「提交缺陷」入口都是它的成员，由它竖向排布，
 * 成员之间天然不会互相遮挡。
 *
 * 历史教训（2026-07-28）：新增「提交缺陷」入口时没有加入这个坞，而是自己
 * `fixed bottom-4 right-4` 另起一套定位，与坞里的更新徽章几何完全重合、被压住半句。
 * 教训是——右下角已经有主人了，新浮层一律加入坞，不要再造第二套定位约定。
 *
 * 本文件现在只剩一个职责：让 z-index 更低的**页面级 toast** 让开坞的底部一格，
 * 否则 toast 会被坞压住（被遮的恰恰是必须看清的失败原因）。禁止用「toast 出现时
 * 藏坞」这种靠时序的方案——两者分属不同组件树，没有可靠的协调点。
 */

/** 坞距屏幕底部的距离（对应 index.css 的 bottom: 1rem）。 */
export const BUG_PILL_BOTTOM_PX = 16;

/** 坞里最底部那个成员（提交缺陷入口）的高度保守估计：px-3 py-2 + text-xs 约 34px，取 36 留冗余。 */
export const BUG_PILL_HEIGHT_PX = 36;

/** 坞与 toast 之间的视觉间隙。 */
export const BOTTOM_RIGHT_GAP_PX = 8;

/**
 * 右下角安全高度：低于这个值的浮层会与坞抢地盘。toast 一律从这个高度往上排。
 */
export const BOTTOM_RIGHT_SAFE_PX =
  BUG_PILL_BOTTOM_PX + BUG_PILL_HEIGHT_PX + BOTTOM_RIGHT_GAP_PX;

/** 页面级 toast 的定位样式：让开坞占据的那一格。 */
export const bottomRightToastStyle = {
  bottom: `${BOTTOM_RIGHT_SAFE_PX}px`,
  right: '20px',
} as const;
