/**
 * 分层产物的内容判定：每一层到底装了什么。
 *
 * 为什么需要它：上游一次返回 N 张图，但它们并不都是「看得出内容的语义图层」。
 * 用户实测里出现过整张原图混进列表（合成预览「看着对」其实是被它盖出来的）、
 * 以及一张什么都看不出来的白方块占着一个位置。
 *
 * 判定口径全部来自真实产物的实测（2026-08-10，对 fal qwen-image-layered 的真实
 * 4 层输出在 Chromium 里逐像素量过，数值见 __tests__/layerContentAnalysis.test.ts 的 fixture）：
 *
 * | 层            | 覆盖率 | 可见像素色彩标准差 | 色桶数 | 与原图差异 |
 * |---------------|--------|--------------------|--------|-----------|
 * | 背景层        | 1.000  | 4.6                | 10     | 18.3      |
 * | 主体+文字层   | 0.240  | 51.2               | 109    | 81.7      |
 * | 器件层        | 0.276  | 30.5               | 39     | 78.4      |
 * | 细碎点缀层    | 0.072  | 34.1               | 32     | 99.1      |
 *
 * 两条从实测里学到的教训，直接决定了下面的判据形状：
 *
 * 1. **「近乎纯色」不等于「废层」。** 背景层就是近乎纯色（标准差 4.6、只有 10 个色桶），
 *    但它承载整块底色，自动隐藏它等于把画面掀掉。所以 flat 只标注、**不**默认隐藏。
 * 2. **「空」不能只看 alpha。** 用户截图里那个白方块是**不透明**的白，覆盖率≈1，
 *    只看 alpha 的判据结构上就抓不到它。抓它的是「近乎纯色」这条，而它落在 flat 类里，
 *    由用户自己一键关掉——这比替用户猜「你不要这层」更安全。
 *
 * 所有判定都是可见且可纠正的：面板上每行都把事实（覆盖率 + 归类）摆出来，
 * 用户一眼能认出哪层是废的，点一下就能改。判据可以不准，但不准的后果必须是
 * 用户看得见、点一下能纠正，绝不静默剔除。
 */

import { computeInkBounds, TRIM_INK_ALPHA_THRESHOLD, TRIM_SCAN_MAX_SIDE, type LayerBounds } from './layerTrim';

export type LayerContentKind = 'layer' | 'empty' | 'solid' | 'flat' | 'source-reference';

/**
 * 近乎空层的覆盖率上限（0.1%）。
 *
 * 取这么低是因为「自动隐藏」要站得住脚：低于 0.1% 覆盖的图层对合成的贡献本就可以忽略，
 * 隐藏它不会让画面发生可见变化。实测里最稀疏的有效图层覆盖率 7.2%，离这条线很远。
 */
export const EMPTY_COVERAGE_MAX = 0.001;

/** 整图参考层：必须几乎处处不透明。背景层也满足这条，所以它只是必要条件。 */
export const SOURCE_REFERENCE_MIN_COVERAGE = 0.98;

/**
 * 与原图的平均逐通道差异上限（0-255 标度）。
 *
 * 6 约等于 2.4% 的色差容差，足够吸收 PNG 重编码与缩放采样的误差。实测中最接近原图的
 * 背景层差异是 18.3，仍在三倍以上的安全距离外，不会被误判成整图。
 */
export const SOURCE_REFERENCE_MAX_DIFF = 6;

/**
 * 「近乎纯色」的两条阈值：可见像素的色彩标准差 + 粗色桶数量。
 *
 * 实测背景层 4.6 / 10 桶，最接近的有效内容层 30.5 / 39 桶——两侧都留了三倍余量。
 * 两条同时满足才算 flat：只看标准差会把「一大片同色 + 少量高对比细节」误判，
 * 只看色桶会把低对比度但有结构的层误判。
 */
export const FLAT_STDEV_MAX = 10;
export const FLAT_COLOR_BUCKETS_MAX = 16;

/**
 * 「单一实色填充」——比 flat 更严的一档，可以放心自动隐藏。
 *
 * 为什么要分出这一档：flat 之所以只标注不隐藏，是因为真实背景层也近乎纯色
 * （实测 stdev 4.6 / 10 个色桶），自动隐藏它等于把画面掀掉。但模型为了凑够 num_layers
 * 而补出来的垃圾层是**真·一种颜色**——纯黑方块、纯白方块，stdev≈0、色桶就 1 个。
 * 两者差着一个数量级，中间留得下一条安全的线。
 *
 * 阈值取 stdev ≤ 2、色桶 ≤ 2：距实测背景层（4.6 / 10）还有一倍以上余量，
 * 距真正的实色块（0 / 1）也有余量。判错的后果仍然可纠正——面板照样列出这一行，
 * 写明「单一实色，已默认隐藏」，点一下眼睛就能开回来。
 *
 * 2026-08-11 用户截图：拆 4 层，其中一层是纯黑方块；此前一次是纯白方块。
 * 它们覆盖率 100%（不透明），只看 alpha 的空层判据结构上就抓不到。
 */
export const SOLID_STDEV_MAX = 2;
export const SOLID_COLOR_BUCKETS_MAX = 2;

/**
 * 「实墨」覆盖率的空层线。
 *
 * 只看 alpha>8 的覆盖率抓不到这一类：模型返回的层常带一层几乎看不见的雾
 * （alpha 十几二十、散布整幅），按老口径覆盖率能到百分之几，于是被当成正常内容层，
 * 在画布上变成一个占满画布的空盒子（2026-08-11 用户圈图：「还是有透明的」）。
 *
 * 改看**实墨**（alpha ≥ 64，约 25% 不透明度，肉眼开始看得见）的覆盖率：
 * 低于 0.2% 就判空。实测最稀疏的有效图层实墨覆盖率在 5% 以上，离这条线很远。
 */
export const EMPTY_INK_COVERAGE_MAX = 0.002;

/** 实墨像素占比：alpha ≥ TRIM_INK_ALPHA_THRESHOLD 才算数。 */
export function computeInkCoverage(data: ArrayLike<number>): number {
  const total = Math.floor(data.length / 4);
  if (total <= 0) return 0;
  let ink = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if ((data[offset] ?? 0) >= TRIM_INK_ALPHA_THRESHOLD) ink += 1;
  }
  return ink / total;
}

/** 判定用的采样边长。缩到这么小才逐像素比，避免大图逐像素扫卡住主线程。 */
export const ANALYSIS_SAMPLE_SIZE = 48;

export type LayerContentStats = {
  /** 不透明像素占比（0-1）。 */
  coverage: number;
  /** 可见像素 RGB 的标准差；越小越接近单一颜色。无可见像素时为 0。 */
  stdev: number;
  /** 可见像素落进的粗色桶数量（每通道 16 级）；越少越接近纯色。 */
  colorBuckets: number;
};

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
 * 一次扫描算齐覆盖率 + 色彩离散度。
 *
 * 只统计**可见**像素：透明区域的 RGB 是未定义的，算进来会被噪声主导，
 * 让一张稀疏但花哨的图层看起来像纯色。
 */
export function computeContentStats(data: ArrayLike<number>): LayerContentStats {
  const total = Math.floor(data.length / 4);
  if (total <= 0) return { coverage: 0, stdev: 0, colorBuckets: 0 };

  const visible: number[] = [];
  const buckets = new Set<number>();
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    if ((data[offset + 3] ?? 0) <= 8) continue;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    visible.push(r, g, b);
    sumR += r;
    sumG += g;
    sumB += b;
    buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }

  const count = visible.length / 3;
  if (count <= 0) return { coverage: 0, stdev: 0, colorBuckets: 0 };
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  let variance = 0;
  for (let i = 0; i < visible.length; i += 3) {
    variance += (visible[i]! - meanR) ** 2 + (visible[i + 1]! - meanG) ** 2 + (visible[i + 2]! - meanB) ** 2;
  }
  return {
    coverage: count / total,
    stdev: Math.sqrt(variance / (count * 3)),
    colorBuckets: buckets.size,
  };
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
  /** 实墨覆盖率；不传就只按老口径判（旧调用方保持原行为）。 */
  inkCoverage?: number;
  stdev?: number;
  colorBuckets?: number;
  sourceDifference: number | null;
}): LayerContentKind {
  const coverage = Number.isFinite(input.coverage) ? input.coverage : 0;
  if (coverage <= EMPTY_COVERAGE_MAX) return 'empty';
  // 一层几乎看不见的雾：老口径的覆盖率不低，但没有一处是看得见的墨。
  if (Number.isFinite(input.inkCoverage) && (input.inkCoverage as number) <= EMPTY_INK_COVERAGE_MAX) {
    return 'empty';
  }

  const diff = input.sourceDifference;
  if (diff !== null && Number.isFinite(diff)
    && coverage >= SOURCE_REFERENCE_MIN_COVERAGE
    && diff <= SOURCE_REFERENCE_MAX_DIFF) {
    return 'source-reference';
  }

  const stdev = Number.isFinite(input.stdev) ? input.stdev! : Number.POSITIVE_INFINITY;
  const colorBuckets = Number.isFinite(input.colorBuckets) ? input.colorBuckets! : Number.POSITIVE_INFINITY;
  // 先判更严的那一档：单一实色几乎必然是模型为凑层数补的垃圾层，可以自动隐藏。
  if (stdev <= SOLID_STDEV_MAX && colorBuckets <= SOLID_COLOR_BUCKETS_MAX) return 'solid';
  if (stdev <= FLAT_STDEV_MAX && colorBuckets <= FLAT_COLOR_BUCKETS_MAX) return 'flat';

  return 'layer';
}

/**
 * 判定结果是否默认不可见。
 *
 * flat 不在此列：实测证明背景层就是 flat，自动隐藏它会把画面掀掉。
 * flat 只在面板上标出来，关不关由用户点。
 */
export function isHiddenByDefault(kind: LayerContentKind): boolean {
  return kind === 'empty' || kind === 'solid' || kind === 'source-reference';
}

/**
 * 面板上给这一行的事实说明。
 *
 * 每行都返回非空串：这一行**必须**承载能把各层区分开的信息。
 * 上一版把源提示词放在这里，结果所有行显示同一串文字（源只有一个），
 * 等于白占一行——分辨图层要靠内容事实，不是靠来源。
 */
export function describeLayerContent(kind: LayerContentKind, coverage?: number): string {
  // 判定跑过但拿不到像素（跨域读图被拦、图还没落到本站）：如实说未识别，别装作还在跑。
  if (kind === 'layer' && !Number.isFinite(coverage)) return '内容未识别';
  const pct = Number.isFinite(coverage) ? formatCoverage(coverage!) : '';
  const head = pct ? `覆盖 ${pct}` : '';
  const tail = kind === 'empty' ? '几乎空层，已默认隐藏'
    : kind === 'solid' ? '单一实色填充，已默认隐藏'
      : kind === 'source-reference' ? '整张原图，不参与合成'
        : kind === 'flat' ? '近乎纯色，可能是空白层'
          : '内容层';
  return head ? `${head} · ${tail}` : tail;
}

/**
 * 覆盖率的人类读法。
 *
 * 两头都不能退化：极小值不能显示成 0%（会和真空层长得一样）；中间段取整会让
 * 13.8% 和 14.2% 两层显示成同一个「14%」——这一行的职责就是把各层区分开，
 * 撞成同一串字就等于白占一行（冒烟实测撞过，见 scripts/smoke/visual-layering.mjs）。
 * 所以 0 与 100% 取整，其余保留一位小数。
 */
export function formatCoverage(coverage: number): string {
  const value = Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : 0;
  if (value <= 0) return '0%';
  if (value >= 1) return '100%';
  if (value < 0.001) return '不足 0.1%';
  return `${(value * 100).toFixed(1)}%`;
}

export type LayerContentVerdict = {
  key: string;
  kind: LayerContentKind;
  /** 采样失败时为 null：判不出来要如实说「未识别」，不能让那行永远停在「正在识别…」。 */
  stats: LayerContentStats | null;
  hidden: boolean;
};

/**
 * 对一组图层跑完整判定，返回要写回画布的补丁。
 *
 * 抽成独立函数是为了让「采样 → 判定 → 回写」这条链本身可测：
 * 判定函数各自单测全绿、这条链却根本没被调用，是最典型的静默失效
 * （见 .claude/rules/predicate-and-wiring-discipline.md 形状 2）。
 * sampler 由调用方注入，测试里喂真实产物的像素，生产里就是 sampleLayerRgba。
 *
 * 每一层都会产出补丁（包括普通层），因为面板每行都要显示覆盖率；
 * 只回写异常层会让普通层那一行没有可显示的事实。
 */
export async function buildLayerContentVerdicts(input: {
  layers: Array<{ key: string; src: string; sha256?: string | null }>;
  source?: { src: string; sha256?: string | null } | null;
  sampler: (src: string, sha256?: string | null) => Promise<ArrayLike<number> | null>;
}): Promise<LayerContentVerdict[]> {
  const sourceRgba = input.source?.src
    ? await input.sampler(input.source.src, input.source.sha256 ?? null)
    : null;

  const verdicts: LayerContentVerdict[] = [];
  for (const layer of input.layers) {
    if (!layer.src) continue;
    const rgba = await input.sampler(layer.src, layer.sha256 ?? null);
    // 采样失败也要出一条：判不出来就如实标「内容未识别」。
    // 早先这里是 continue，结果那一行永远停在「正在识别内容…」——一个不会结束的进行时
    // 比一句「没识别出来」更糟，用户根本不知道它是在跑还是已经死了（2026-08-10 用户截图）。
    if (!rgba) {
      verdicts.push({ key: layer.key, kind: 'layer', stats: null, hidden: false });
      continue;
    }
    const stats = computeContentStats(rgba);
    const kind = classifyLayerContent({
      coverage: stats.coverage,
      inkCoverage: computeInkCoverage(rgba),
      stdev: stats.stdev,
      colorBuckets: stats.colorBuckets,
      sourceDifference: sourceRgba ? computeMeanAbsDifference(rgba, sourceRgba) : null,
    });
    verdicts.push({ key: layer.key, kind, stats, hidden: isHiddenByDefault(kind) });
  }
  return verdicts;
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
  return withLayerImage(source, sha256, (image) => drawToRgba(image, ANALYSIS_SAMPLE_SIZE, ANALYSIS_SAMPLE_SIZE));
}

export type TrimmedLayer = {
  /** 整幅全透明：模型给了一层但里面什么都没有。调用方必须如实标注，不能当普通层摆上去。 */
  empty: boolean;
  /** 相对图层图像的包围盒（按 scanWidth/scanHeight 的坐标系）。empty 时为 null。 */
  bounds: LayerBounds | null;
  scanWidth: number;
  scanHeight: number;
  /** 裁剪后的 PNG（data URL），按原始分辨率裁，不降质。empty 时为空串。 */
  dataUrl: string;
  /** 裁剪后的像素尺寸。 */
  width: number;
  height: number;
};

/**
 * 把一张满幅图层裁成**最小非透明外接矩形**，并给出裁剪后的 PNG。
 *
 * 这是「部件是透明裁剪后的最小矩形」的真正落地：只算出包围盒是不够的，
 * 必须让**产物本身**变成那个矩形——否则画布上框住的仍是一整张满是空气的方图，
 * 想拖 logo 却按到一大片透明（2026-08-11 用户圈图指出）。
 *
 * 包围盒在降采样后的坐标系里算（上限 TRIM_SCAN_MAX_SIDE），但裁剪按**原始分辨率**做，
 * 所以不会掉清晰度；边缘按比例外扩 1 像素，避免降采样的取整把羽化边切掉一线。
 */
export async function trimLayerToContent(
  source: string,
  sha256?: string | null,
): Promise<TrimmedLayer | null> {
  return withLayerImage(source, sha256, (image) => {
    const naturalW = image.naturalWidth || image.width;
    const naturalH = image.naturalHeight || image.height;
    if (!naturalW || !naturalH) return null;
    const side = Math.max(naturalW, naturalH);
    const scale = side > TRIM_SCAN_MAX_SIDE ? TRIM_SCAN_MAX_SIDE / side : 1;
    const scanWidth = Math.max(1, Math.round(naturalW * scale));
    const scanHeight = Math.max(1, Math.round(naturalH * scale));

    const rgba = drawToRgba(image, scanWidth, scanHeight);
    if (!rgba) return null;
    // 按「实墨」求框：几粒几乎看不见的雾不该决定部件边界（文字层的框比字大一圈就是这么来的）。
    const bounds = computeInkBounds(rgba, scanWidth, scanHeight);
    if (!bounds) {
      return { empty: true, bounds: null, scanWidth, scanHeight, dataUrl: '', width: 0, height: 0 };
    }

    // 换算回原始分辨率，并各留 1 个扫描像素的余量（降采样取整可能吃掉最外一线羽化）。
    const sx = naturalW / scanWidth;
    const sy = naturalH / scanHeight;
    const left = Math.max(0, Math.floor((bounds.left - 1) * sx));
    const top = Math.max(0, Math.floor((bounds.top - 1) * sy));
    const right = Math.min(naturalW, Math.ceil((bounds.right + 1) * sx));
    const bottom = Math.min(naturalH, Math.ceil((bounds.bottom + 1) * sy));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, left, top, width, height, 0, 0, width, height);
    return {
      empty: false,
      // 把包围盒也换算成原始分辨率坐标，调用方据此算画布落位，口径与裁剪完全一致。
      bounds: { left, top, right, bottom, width, height },
      scanWidth: naturalW,
      scanHeight: naturalH,
      dataUrl: canvas.toDataURL('image/png'),
      width,
      height,
    };
  });
}

/** 把图画进指定尺寸的离屏 canvas 并取 RGBA。 */
function drawToRgba(image: HTMLImageElement, width: number, height: number): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * 读图 → 解码 → 交给回调用，用完立刻释放。
 *
 * 抽成一份是因为判定与裁剪只在「拿到图之后做什么」这一处不同；抄成两份迟早在鉴权、
 * CORS、对象地址解析上漂移（.claude/rules/predicate-and-wiring-discipline.md 形状 3）。
 */
async function withLayerImage<T>(
  source: string,
  sha256: string | null | undefined,
  consume: (image: HTMLImageElement) => T | null,
): Promise<T | null> {
  const { resolveReadableImageUrl, readableImageFetchHeaders } = await import('./layeredPsd');
  const url = resolveReadableImageUrl(source, sha256);
  if (!url) return null;

  try {
    // 同源资产端点是 [Authorize] 的，不带 token 一律 401，判定会静默失败。
    const response = await fetch(url, { mode: 'cors', headers: readableImageFetchHeaders(url) });
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
      return consume(image);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    // 判定失败不该影响主流程：拿不到样本就当普通图层，用户仍能自己开关。
    return null;
  }
}
