/**
 * 贴着触发器弹出的浮层该落在哪 —— 唯一算法。
 *
 * 为什么单独成文件：这套「按视口夹紧」的算术，本仓库同一个 PR 里就出现了两处
 * （首页模型选择器、背景设置面板），而且两处各写各的。抄第二份就会漂
 * （判据纪律形状 3），而漂掉的后果是**浮层跑到屏幕外，用户点不到**——
 * 页面照常渲染、测试照常绿，只有真人滚到某个位置才撞见。
 *
 * 具体撞过的那次：模型选择器恒定写 `top: rect.top - 8` 再用 CSS
 * `translateY(-100%)` 往上顶一整个面板高（最高 320px）。页面往下滚、工具行接近
 * 视口顶部时，面板整个跑到视口上方，一个选项都看不见；而且位置只在打开那一刻算一次，
 * 滚动/改窗口都不重算，浮层还会和触发器脱开（Codex PR #1476 P1）。
 *
 * 所以这里只做一件事：**纯算术**。不碰 DOM、不订阅事件，入参是量好的矩形和视口，
 * 出参是最终 top/left/width/maxHeight。这样它可以被单测直接喂各种极端视口，
 * 而不必去无头浏览器里滚页面。
 */

export type AnchorRect = { top: number; bottom: number; left: number; right: number };
export type PanelViewport = { width: number; height: number };

export type AnchoredPanelPlacement = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** 最终落在触发器的哪一侧。翻面发生时与 prefer 不同。 */
  side: 'above' | 'below';
};

export type AnchoredPanelOptions = {
  anchor: AnchorRect;
  viewport: PanelViewport;
  /** 首选方向。空间不够且另一侧更宽裕时会翻面。 */
  prefer: 'above' | 'below';
  /** 'start' = 与触发器左边对齐；'end' = 右边对齐。都会再夹回视口。 */
  align?: 'start' | 'end';
  /** 想要的宽度；视口更窄时按视口来。 */
  width: number;
  /** 想要的高度上限；不传 = 用满那一侧的可用空间。 */
  maxHeight?: number;
  /** 视口四周安全边。 */
  margin?: number;
  /** 面板与触发器之间的间隙。 */
  gap?: number;
  /** 高度不肯低于这个值——低于它的浮层已经没法用了，宁可压过安全边也要留住。 */
  minHeight?: number;
};

export function placeAnchoredPanel(opts: AnchoredPanelOptions): AnchoredPanelPlacement {
  const { anchor, viewport, prefer } = opts;
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 6;
  const minHeight = opts.minHeight ?? 120;
  const align = opts.align ?? 'start';

  // 宽度：视口比想要的还窄时按视口来（窄屏这一夹就是「点得到」与「点不到」的区别）。
  const width = Math.max(0, Math.min(opts.width, viewport.width - margin * 2));

  const rawLeft = align === 'end' ? anchor.right - width : anchor.left;
  // 夹回视口。右界可能小于左界（视口比面板还窄），所以先取 max 保证区间非空。
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const left = Math.min(Math.max(margin, rawLeft), maxLeft);

  const spaceAbove = anchor.top - gap - margin;
  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const desired = opts.maxHeight ?? Number.POSITIVE_INFINITY;

  // 翻面判据：首选那侧装不下**想要的高度**，且另一侧更宽裕，才翻。
  // 只比「哪边空间大」会在两边都够用时无谓地翻来翻去，位置就不稳定了。
  const preferSpace = prefer === 'above' ? spaceAbove : spaceBelow;
  const otherSpace = prefer === 'above' ? spaceBelow : spaceAbove;
  const wanted = Math.min(desired, Math.max(minHeight, 0));
  const side: 'above' | 'below' = preferSpace >= wanted || preferSpace >= otherSpace
    ? prefer
    : (prefer === 'above' ? 'below' : 'above');

  const space = side === 'above' ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(minHeight, Math.min(desired, space));
  const top = side === 'above' ? anchor.top - gap - maxHeight : anchor.bottom + gap;

  return { top, left, width, maxHeight, side };
}
