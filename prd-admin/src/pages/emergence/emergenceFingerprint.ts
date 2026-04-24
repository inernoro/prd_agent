/**
 * 涌现树视觉指纹（Visual Fingerprint）
 *
 * 每棵涌现树从标题派生一个确定性的视觉特征：色相 / 轨道粒子数 / 热度偏移 / 图样种子。
 * 同一标题永远得到同一组视觉输出，用户二次回访时卡片保持一致；
 * 不同标题的卡片自然产生可辨识的差异，解决"所有树长得一模一样"的单调感。
 */

/** FNV-1a 32 位哈希：确定性 + 分布均匀，足以驱动 UI 指纹 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export interface TreeVisual {
  /** 主色相（0-360），用作渐变起点 */
  hue: number;
  /** 轨道粒子数量（2-8），随节点数量增长代表"成熟度" */
  orbits: number;
  /** 热度（0-1），最近更新越接近 1，越"温暖" */
  warmth: number;
  /** 旋转起始角（0-360），让不同树的轨道排布不同 */
  rotation: number;
  /** 图样种子（0-1），用于后续变体扩展（波形/花瓣数等） */
  pattern: number;
  /** 渐变第二色相（与主色相呈和谐关系） */
  hueSecondary: number;
}

/** 从标题 + 节点数 + 更新时间派生视觉指纹 */
export function getTreeVisual(title: string, nodeCount: number, updatedAt: string): TreeVisual {
  const h = hashString(title || 'untitled');
  const hue = h % 360;
  // 主色相偏移 35-120 度生成第二色（避免邻近同色也避免互补冲撞）
  const hueSecondary = (hue + 60 + ((h >> 8) % 60)) % 360;
  const pattern = ((h >> 16) % 1000) / 1000;
  const rotation = ((h >> 4) % 360);

  // 轨道数量：节点数 1 → 2 个轨道（种子期），节点数 20+ → 8 个轨道（茂盛期）
  const orbits = Math.min(8, Math.max(2, 2 + Math.floor(Math.log2(Math.max(1, nodeCount)) * 1.4)));

  // 热度：距今越近越热（0-1），24h 内 ≥ 0.8，7 天内 0.4-0.8，超过 7 天逐步衰减
  const now = Date.now();
  const t = new Date(updatedAt).getTime();
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  let warmth: number;
  if (ageHours <= 24) warmth = 1 - ageHours / 48; // 0.5 - 1
  else if (ageHours <= 24 * 7) warmth = 0.6 - (ageHours - 24) / (24 * 7) * 0.3; // 0.3 - 0.6
  else warmth = Math.max(0.08, 0.3 - Math.log10(ageHours / (24 * 7)) * 0.12);
  warmth = Math.max(0, Math.min(1, warmth));

  return { hue, hueSecondary, orbits, warmth, rotation, pattern };
}

/** HSL → 使用时直接拼字符串，避免额外依赖 */
export function hsla(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h % 360}, ${s}%, ${l}%, ${a})`;
}
