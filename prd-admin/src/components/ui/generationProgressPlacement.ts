type Rect = { left: number; top: number; right: number; bottom: number };

/** 输入和输出均为屏幕像素，由宿主在最后一步换算为画布坐标。 */
export function generationProgressPlacement(node: Rect, viewport: Rect, barHeight: number) {
  const left = Math.max(node.left, viewport.left);
  const right = Math.min(node.right, viewport.right);
  const top = Math.max(node.top, viewport.top);
  const bottom = Math.min(node.bottom, viewport.bottom);
  if (right - left < 200 || bottom - top < Math.max(120, barHeight + 24)) return null;

  const width = Math.min((node.right - node.left) * 0.86, 340, right - left - 24);
  const center = Math.max(left + 12 + width / 2,
    Math.min((node.left + node.right) / 2, right - 12 - width / 2));
  const naturalBottom = node.bottom - Math.max(8, (node.bottom - node.top) * 0.1);
  const barBottom = Math.max(top + 12 + barHeight, Math.min(naturalBottom, bottom - 12));
  return { left: center - node.left, bottom: node.bottom - barBottom, width };
}
