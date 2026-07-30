export interface FloatingPanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export interface FloatingPanelAnchor {
  left: number;
  bottom: number;
}

/**
 * 把顶部浮层限制在当前视口内。
 *
 * 不能只写 `right: 0`：信息中心宿主在不同页面可能位于顶部栏左侧或右侧，固定向
 * 左展开会让靠左宿主产生负坐标。这里以视口为边界夹紧位置，手机和桌面共用。
 */
export function floatingPanelPosition(
  anchor: FloatingPanelAnchor,
  viewport: { width: number; height: number },
  options: { maxWidth?: number; margin?: number; gap?: number } = {},
): FloatingPanelPosition {
  const margin = Math.max(0, options.margin ?? 8);
  const gap = Math.max(0, options.gap ?? 8);
  const maxWidth = Math.max(0, options.maxWidth ?? 520);
  const width = Math.max(0, Math.min(maxWidth, viewport.width - margin * 2));
  const maxLeft = Math.max(margin, viewport.width - margin - width);
  const left = Math.min(Math.max(margin, anchor.left), maxLeft);
  const top = Math.min(Math.max(margin, anchor.bottom + gap), Math.max(margin, viewport.height - margin));

  return {
    left,
    top,
    width,
    maxHeight: Math.max(0, viewport.height - top - margin),
  };
}
