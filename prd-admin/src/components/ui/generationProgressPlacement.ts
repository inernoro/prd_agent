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

/**
 * 把 generationProgressPlacement 的屏幕像素结果换算成挂在卡片根节点上的 style（世界像素）。
 *
 * placement.left 是底边那行的**中心点**相对卡片左缘的偏移（上面的算法按中心夹紧），
 * 不是左边缘。2026-09-14 稳定冒烟：宿主把它直接当 left 用，1001 世界像素的方图在 0.5 倍下
 * 那行字的右缘落到 590.75 屏幕像素，而卡片右缘在 501——整整半行字挂在画框外面。
 * 所以换算只能在这一个函数里做，两个宿主都从这里拿 left / bottom / width。
 */
export function generationProgressMetaStyle(
  placement: { left: number; bottom: number; width: number },
  scale: number,
) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    left: (placement.left - placement.width / 2) / safeScale,
    bottom: placement.bottom / safeScale,
    width: placement.width / safeScale,
  };
}
