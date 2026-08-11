/**
 * 图层的透明裁剪：把满幅 RGBA 收成「有内容的最小矩形」。
 *
 * 为什么必须有：模型返回的每一层都是**和原图一样大的满幅图**，透明区占了绝大部分。
 * 直接这么用会同时坏掉三件事：
 * - 画布上每块的选中框都是整幅大小，想拖 logo 却按到一整张空气；
 * - PSD 里每层都写满幅像素，文件大好几倍，且在 Photoshop 里每层的变换框都套着整张画布，
 *   「把人物靠左一点」得先自己找边界；
 * - 「这层到底装了多少东西」没法一眼看出来。
 *
 * 裁剪出来的是**相对原图坐标系的包围盒**，所以各层裁完仍能按原位精确拼回去——
 * 这正是「拆完还是原来那张图，只是每块能单独挪」的前提。
 */

export type LayerBounds = {
  /** 相对图层图像左上角的像素坐标。 */
  left: number;
  top: number;
  /** 右/下为开区间（right - left === width）。 */
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** alpha 高于此值才算「有内容」，与内容判定用同一口径，滤掉羽化边缘的极淡像素。 */
export const TRIM_ALPHA_THRESHOLD = 8;

/**
 * 求 RGBA 里不透明像素的包围盒。
 *
 * 整幅全透明时返回 null——调用方必须自己决定怎么办（当空层标注、跳过导出），
 * 绝不能回退成「整幅」，那会让一个空层在 PSD 里占满画布。
 */
export function computeAlphaBounds(
  data: ArrayLike<number>,
  width: number,
  height: number,
  threshold = TRIM_ALPHA_THRESHOLD,
): LayerBounds | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if ((data[rowStart + x * 4 + 3] ?? 0) <= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0 || bottom < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1, width: right + 1 - left, height: bottom + 1 - top };
}

/**
 * 按包围盒裁出子图。返回的像素与 bounds 尺寸一致。
 * 越界的 bounds 直接判无效返回 null——宁可不裁，也不要产出一张错位的图。
 */
export function cropRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  bounds: LayerBounds,
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const { left, top, width: w, height: h } = bounds;
  if (w <= 0 || h <= 0) return null;
  if (left < 0 || top < 0 || left + w > width || top + h > height) return null;

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const from = ((top + y) * width + left) * 4;
    const to = y * w * 4;
    for (let i = 0; i < w * 4; i += 1) out[to + i] = data[from + i] ?? 0;
  }
  return { data: out, width: w, height: h };
}

/**
 * 求包围盒时的最大扫描边长。
 *
 * 与内容判定那 48×48 的采样**不是一回事**：判定只要知道「大体长什么样」，
 * 而包围盒直接决定部件在画布上的落位，48 格的粒度换算到 1024 的原图是 ±21px 的误差，
 * 肉眼一眼就能看出「框没贴着内容」。所以这里按原图尺寸扫，只在超大图时才降采样。
 */
export const TRIM_SCAN_MAX_SIDE = 1024;

/**
 * 把「图层图像坐标系」的包围盒换算到「画布上原图那块矩形」的坐标系。
 *
 * 模型返回的图层未必和原图同分辨率（实测原图 1024、图层 640），所以必须按比例换算，
 * 否则各块拼回去会整体偏移——这是「原位叠放」最容易错的一步。
 */
export function boundsToCanvasRect(input: {
  bounds: LayerBounds;
  layerWidth: number;
  layerHeight: number;
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
}): { x: number; y: number; w: number; h: number } {
  const sx = input.canvasW / Math.max(1, input.layerWidth);
  const sy = input.canvasH / Math.max(1, input.layerHeight);
  return {
    x: input.canvasX + input.bounds.left * sx,
    y: input.canvasY + input.bounds.top * sy,
    w: Math.max(1, input.bounds.width * sx),
    h: Math.max(1, input.bounds.height * sy),
  };
}
