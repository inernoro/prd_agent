/**
 * 官方技能卡（PixelCard 变体）的稳定调色板生成。
 *
 * 输入：skill 的标识键（如 `findmapskills` / `cds-deploy-pipeline`）
 * 输出：3 个 hex 颜色组成的 PixelCard `colors` 字符串
 *
 * 设计目标：
 * - 同一个技能键 → 永远同一组颜色（用户认得出"这是 CDS 系"）
 * - 不同技能 → 色相相隔足够远，肉眼能分辨
 * - 整体偏冷亮蓝紫青系，统一于平台「液态玻璃」基调（不要红/黄等暖色调）
 */

function hash32(s: string): number {
  // djb2 —— 比 hashCode 分布略好，且无符号 32 位返回，方便后续取模
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 返回 PixelCard 的 `colors` prop。
 *
 * 色相限定在「青/蓝/紫/品红」一段（180~300°），避开暖色，
 * 这样多张官方卡放一起仍然像同一家产品。
 */
export function officialSkillPalette(key: string): string {
  const h = hash32(key);
  const hueBase = 180 + (h % 120);         // 180~299
  const hue1 = hueBase;
  const hue2 = (hueBase + 25) % 360;
  const hue3 = (hueBase + 50) % 360;
  return [
    `hsl(${hue1} 78% 72%)`,
    `hsl(${hue2} 68% 60%)`,
    `hsl(${hue3} 58% 48%)`,
  ].join(',');
}

/**
 * 给「无封面普通卡」的渐变 fallback 用，同样基于 key 哈希出色相，
 * 但落在更暖的可用区，和官方卡的冷色调形成天然区分。
 */
export function genericSkillGradient(key: string): { from: string; to: string } {
  const h = hash32(key);
  const hue = h % 360;
  return {
    from: `hsl(${hue} 55% 38%)`,
    to: `hsl(${(hue + 40) % 360} 45% 22%)`,
  };
}
