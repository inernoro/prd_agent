/**
 * 计数格式化的唯一入口。
 *
 * 由来：分享数据抽屉直接写 `link.viewCount.toLocaleString()`，而后端投影里
 * `viewCount` / `uniqueIpCount` 都是可缺省字段（老数据、聚合失败、部分投影都可能不带）。
 * 缺字段时整屏抛 `Cannot read properties of undefined (reading 'toLocaleString')`，
 * 抽屉白屏——一个数字没取到就把整块面板炸掉，是这一屏最贵的失败方式。
 *
 * 统一走这个函数：拿不到就当 0，而不是崩。真的需要区分「零」和「没这个数」的地方，
 * 调用方自己判空后传 dash。
 */
export function fmtCount(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  return n.toLocaleString();
}
