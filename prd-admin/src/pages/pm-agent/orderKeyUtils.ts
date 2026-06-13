/**
 * 拖拽排序 orderKey 计算：在两个相邻项之间取中值插入。
 * 注意：后端 orderKey 是 long（目标/里程碑用 Ticks 量级），经 JSON 走 number，
 * 大数下有量化误差，但相邻项差值远大于量化粒度，取中值仍能稳定落在两者之间。
 */
export function midOrderKey(before?: number | null, after?: number | null): number {
  const b = before ?? null;
  const a = after ?? null;
  if (b == null && a == null) return Date.now();
  if (b == null) return (a as number) - 1000; // 插到最前
  if (a == null) return (b as number) + 1000; // 插到最后
  return (b + a) / 2;
}
