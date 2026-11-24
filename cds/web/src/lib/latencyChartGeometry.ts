/*
 * 响应曲线的画布几何。
 *
 * 单独拎出来是因为这里出过一个不报错、也测不出来的坑：SVG 写死
 * `viewBox="0 0 640 180"` 配上 `class="h-44 w-full"`，两者的宽高比对不上，
 * 浏览器按默认的 `preserveAspectRatio="xMidYMid meet"` 把图整体缩放居中，
 * 于是——
 *
 *   1. 内容只占容器中间一段，两侧各留一块空白 → 看起来「图表只画了一半」；
 *   2. 鼠标坐标按「整个元素宽 = viewBox 宽」换算，与真实落点差了一个留白宽度
 *      → 悬浮竖线跟鼠标差了两公分。
 *
 * 一个根因，两个症状（2026-09-10 用户反馈的第 2、4 条）。治法是让 viewBox 的
 * 宽高**都取元素的实测像素值**，缩放系数恒为 1。
 *
 * 为什么高度也要实测而不是写个常数：整站按 85% 根字号呈现（cds-theme-tokens
 * 的「rem 唯一」），`h-44` 实际解析出来是 149.6px 而不是 176px。写死常数
 * 会重新制造同一个错配，只是换了个方向。
 */

/** 元素还没布局出来时的兜底画布，够画下刻度与两端时间标签。 */
export const CHART_FALLBACK_WIDTH_PX = 640;
export const CHART_FALLBACK_HEIGHT_PX = 176;

/** 绘图区内边距：左侧留给 Y 轴刻度，底部留给时间轴。 */
export const CHART_PAD = { top: 12, right: 12, bottom: 22, left: 44 } as const;

/** 再窄 / 再矮也不许算出负的绘图区。 */
export const CHART_MIN_WIDTH_PX = 240;
export const CHART_MIN_HEIGHT_PX = 80;

export interface ChartBox {
  /** viewBox 宽度 = 元素实测像素宽度 */
  w: number;
  /** viewBox 高度 = 元素实测像素高度 */
  h: number;
  /** 绘图区宽 / 高（扣掉内边距） */
  plotW: number;
  plotH: number;
}

/**
 * 刻意不取整：`h-44` 在 85% 根字号下是 149.6px，取整成 150 就把宽高比又拧歪了
 * 0.3%（800px 宽下约 2.7px 的留白）—— 正是这条规则要根除的那种错配，只是变小了。
 * SVG 的 viewBox 本来就收浮点数。
 */
function usable(value: number, min: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, value);
}

/**
 * 由实测尺寸算出画布。`w / h` 必须恒等于元素的 `宽 / 高`，
 * 否则 preserveAspectRatio 会把图缩放居中，坐标与视觉双双出错。
 */
export function chartBox(measuredWidth: number, measuredHeight: number): ChartBox {
  const w = usable(measuredWidth, CHART_MIN_WIDTH_PX, CHART_FALLBACK_WIDTH_PX);
  const h = usable(measuredHeight, CHART_MIN_HEIGHT_PX, CHART_FALLBACK_HEIGHT_PX);
  return {
    w,
    h,
    plotW: w - CHART_PAD.left - CHART_PAD.right,
    plotH: h - CHART_PAD.top - CHART_PAD.bottom,
  };
}

/**
 * 鼠标的客户端横坐标 → viewBox 横坐标。
 * 在 `chartBox` 的前提下 rectWidth 与 viewBoxWidth 相等，这里退化成减法；
 * 仍按比例写，是为了让浏览器的分数像素缩放（页面 zoom、DPR）也成立。
 */
export function pointerViewBoxX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  viewBoxWidth: number,
): number {
  if (!(rectWidth > 0)) return 0;
  return ((clientX - rectLeft) / rectWidth) * viewBoxWidth;
}
