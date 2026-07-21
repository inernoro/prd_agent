/**
 * 将 hex 颜色转换为 rgba。支持 #RRGGBB / #RGB 简写；非法输入回退 TikTok 粉品牌色。
 * 主题视觉值由 tokens.css 单一维护，本文件不再计算或写入主题 CSS 变量。
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex) return `rgba(255,0,80,${alpha})`;
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,0,80,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
