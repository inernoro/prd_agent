/**
 * 压测面板的纯展示计算（曲线路径、耗时文案、错误分类文案）。
 *
 * 单独成文件是为了能在 cds/tests 里直接单测：图表画错不会让编译失败，只会让用户
 * 拿着一张错的曲线去下结论——比不画更坏，所以这几个函数必须有回归。
 */

/** 目标线条配色：与复制集画布同族（禁红禁琥珀——红=错误、黄=草稿预期）。 */
export const LOADTEST_LINE_COLORS = ['#6366f1', '#14b8a6', '#0ea5e9', '#8b5cf6', '#22c55e', '#ec4899'] as const;

export function lineColor(index: number): string {
  const i = Number.isFinite(index) ? Math.abs(Math.floor(index)) : 0;
  return LOADTEST_LINE_COLORS[i % LOADTEST_LINE_COLORS.length];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 折线点串（纯 SVG，不引图表库）。
 *
 * - 空序列返回空串，调用方据此渲染「正在采集第一个采样点」而不是画一条假线；
 * - 单点画成一条水平线（一秒钟的采样也该看得见，而不是消失）；
 * - y 轴按传入的最大值归一，超过 max 的值夹到顶（不许溢出画布）。
 */
export function polylinePoints(values: number[], width: number, height: number, max: number): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  const top = max > 0 ? max : 1;
  const clamp = (v: number): number => Math.min(Math.max(v, 0), top);
  if (values.length === 1) {
    const y = round1(height - (clamp(values[0]) / top) * height);
    return `0,${y} ${width},${y}`;
  }
  const step = width / (values.length - 1);
  return values
    .map((v, i) => `${round1(i * step)},${round1(height - (clamp(v) / top) * height)}`)
    .join(' ');
}

/** 「已耗时 / 预计剩余」文案：任何时刻都答得上「还要多久」（预期管理）。 */
export function formatEta(elapsedSec: number, etaSec: number, status: string): string {
  if (status !== 'running') return `总耗时 ${Math.max(0, Math.round(elapsedSec))}s`;
  return `已跑 ${Math.max(0, Math.round(elapsedSec))}s · 预计还需 ${Math.max(0, Math.round(etaSec))}s`;
}

/** 错误分类文案：全 0 时明说「无」，不留一排 0 让人自己数。 */
export function describeErrors(errors: Record<string, number> | undefined): string {
  const names: Record<string, string> = {
    timeout: '超时', connect: '连接失败', http5xx: '5xx', http4xx: '4xx', cancelled: '已取消', other: '其他',
  };
  const parts = Object.entries(errors || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => `${names[kind] || kind} ${count}`);
  return parts.length > 0 ? parts.join(' · ') : '无';
}
