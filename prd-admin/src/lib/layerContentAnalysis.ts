/**
 * 分层产物的内容判定：哪一层其实是整张原图、哪一层几乎是空的。
 *
 * 上游一次返回 N 张图，但它们并不都是「语义图层」：
 * - 用户实测里最后一张是**整张合成图**（原图全貌）。它混在图层列表里的后果很隐蔽——
 *   合成预览「看着对」其实是被这张完整图盖出来的，把下面几层全关掉预览也不会变。
 * - 另有一层几乎全透明（近乎空层），白占一个位置。
 *
 * 判定的难点在于「整图」和「背景层」都可能是满覆盖，光看 alpha 覆盖率区分不了。
 * 所以整图判定不看覆盖率，看**它是不是就等于原图**：把两张都缩到很小逐像素比，
 * 差异极小才判为整图。背景层因为缺了叠在上面的主体，与原图差异必然显著，不会被误判。
 *
 * 所有判定都是可见且可纠正的：面板上单独一行标出来，用户一键就能改回普通图层。
 * 判据可以不准，但不准的后果必须是用户看得见、点一下能纠正，绝不静默剔除。
 */

export type LayerContentKind = 'layer' | 'empty' | 'source-reference';

/**
 * 近乎空层的覆盖率上限（0.1%）。
 *
 * 取这么低是因为「自动隐藏」要站得住脚：低于 0.1% 覆盖的图层对合成的贡献本就可以忽略，
 * 隐藏它不会让画面发生可见变化，所以自动隐藏是安全的。反过来，稀疏但有用的图层
 * （例如用户截图里那层细线稿）覆盖率通常在 0.5% 以上，远高于此，不会被吞掉。
 */
export const EMPTY_COVERAGE_MAX = 0.001;

/** 整图参考层：必须几乎处处不透明。背景层也可能满足这条，所以它只是必要条件。 */
export const SOURCE_REFERENCE_MIN_COVERAGE = 0.98;

/**
 * 与原图的平均逐通道差异上限（0-255 标度）。
 *
 * 6 约等于 2.4% 的色差容差，足够吸收 PNG 重编码与缩放采样的误差，
 * 又远小于「背景层 vs 原图」那种因为少了主体而产生的结构性差异。
 */
export const SOURCE_REFERENCE_MAX_DIFF = 6;

/** 判定用的采样边长。缩到这么小才逐像素比，避免大图逐像素扫卡住主线程。 */
export const ANALYSIS_SAMPLE_SIZE = 48;

/** 不透明像素占比。alpha 高于 8 才算「有内容」，滤掉羽化边缘的极淡像素。 */
export function computeAlphaCoverage(data: ArrayLike<number>): number {
  const total = Math.floor(data.length / 4);
  if (total <= 0) return 0;
  let opaque = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if ((data[offset] ?? 0) > 8) opaque += 1;
  }
  return opaque / total;
}

/**
 * 两张同尺寸 RGBA 的平均逐通道差异（0-255）。
 * 按 alpha 预乘后再比：透明区域的 RGB 是未定义的，不预乘会被噪声主导。
 */
export function computeMeanAbsDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  if (length < 4) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 3 < length; offset += 4) {
    const alphaA = (a[offset + 3] ?? 0) / 255;
    const alphaB = (b[offset + 3] ?? 0) / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      sum += Math.abs((a[offset + channel] ?? 0) * alphaA - (b[offset + channel] ?? 0) * alphaB);
      count += 1;
    }
    sum += Math.abs((a[offset + 3] ?? 0) - (b[offset + 3] ?? 0));
    count += 1;
  }
  return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

/**
 * 归类一个图层。
 *
 * sourceDifference 传 null 表示拿不到原图（无法比对），此时**不判整图**——
 * 宁可把整图当普通层放着（用户看得见、可以自己关掉），也不要靠覆盖率去猜，
 * 那会把背景层误杀。
 */
export function classifyLayerContent(input: {
  coverage: number;
  sourceDifference: number | null;
}): LayerContentKind {
  const coverage = Number.isFinite(input.coverage) ? input.coverage : 0;
  if (coverage <= EMPTY_COVERAGE_MAX) return 'empty';

  const diff = input.sourceDifference;
  if (diff !== null && Number.isFinite(diff)
    && coverage >= SOURCE_REFERENCE_MIN_COVERAGE
    && diff <= SOURCE_REFERENCE_MAX_DIFF) {
    return 'source-reference';
  }
  return 'layer';
}

/** 判定结果是否默认不可见。两类都不参与合成，但都保留在列表里可手动打开。 */
export function isHiddenByDefault(kind: LayerContentKind): boolean {
  return kind === 'empty' || kind === 'source-reference';
}

/** 面板上给这一类图层的说明；普通图层返回空串表示不加说明。 */
export function describeLayerContent(kind: LayerContentKind): string {
  if (kind === 'empty') return '几乎空层，已默认隐藏';
  if (kind === 'source-reference') return '整张原图，不参与合成';
  return '';
}

/**
 * 把一张图缩到 ANALYSIS_SAMPLE_SIZE 见方后取 RGBA。
 *
 * 判定只需要「大体长什么样」，缩到 48x48 (=2304 像素) 就够，且把逐像素扫描的成本
 * 压到可以忽略——不缩的话一张 4K 图要扫上千万像素，会卡住主线程。
 * 读图沿用导出链路那套同源地址解析，避开对象存储的 CORS。
 */
export async function sampleLayerRgba(
  source: string,
  sha256?: string | null,
): Promise<Uint8ClampedArray | null> {
  const { resolveReadableImageUrl } = await import('./layeredPsd');
  const url = resolveReadableImageUrl(source, sha256);
  if (!url) return null;

  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('decode failed'));
        image.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = ANALYSIS_SAMPLE_SIZE;
      canvas.height = ANALYSIS_SAMPLE_SIZE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.clearRect(0, 0, ANALYSIS_SAMPLE_SIZE, ANALYSIS_SAMPLE_SIZE);
      context.drawImage(image, 0, 0, ANALYSIS_SAMPLE_SIZE, ANALYSIS_SAMPLE_SIZE);
      return context.getImageData(0, 0, ANALYSIS_SAMPLE_SIZE, ANALYSIS_SAMPLE_SIZE).data;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    // 判定失败不该影响主流程：拿不到样本就当普通图层，用户仍能自己开关。
    return null;
  }
}
