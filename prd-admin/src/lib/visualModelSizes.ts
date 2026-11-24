/**
 * 模型 → 可用尺寸 → 纠正当前尺寸。
 *
 * 「选了模型，尺寸也得对应上」这件事的可判定部分都在这里：后端
 * `getVisualAgentAdapterInfo(modelCode)` 会返回该模型按分辨率档分组的尺寸，
 * 这个模块只做纯计算，好单测。
 *
 * 一条纪律：**拿不到就说拿不到**。适配器没命中、接口失败、模型声明「尺寸不适用」时，
 * 一律返回 null，让调用方退回静态尺寸表——而不是编一份「这个模型大概支持这些」。
 * 编出来的能力清单看着有根，其实是幻觉（no-rootless-tree）。
 */

export type SizeOption = { size: string; aspectRatio: string };
export type SizesByResolution = Record<'1k' | '2k' | '4k', SizeOption[]>;

export const RESOLUTION_TIERS = ['1k', '2k', '4k'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

/** 把 adapter-info 的返回归一成三档；任一档缺失当空数组，不抛。 */
export function normalizeSizesByResolution(raw: unknown): SizesByResolution {
  const src = (raw ?? {}) as Partial<Record<ResolutionTier, unknown>>;
  const pick = (tier: ResolutionTier): SizeOption[] => {
    const list = src[tier];
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const o = item as Partial<SizeOption>;
        const size = String(o?.size ?? '').trim();
        if (!size) return null;
        return { size, aspectRatio: String(o?.aspectRatio ?? '').trim() };
      })
      .filter((x): x is SizeOption => x !== null);
  };
  return { '1k': pick('1k'), '2k': pick('2k'), '4k': pick('4k') };
}

/** 三档拍平；用来判断「当前尺寸这个模型支不支持」。 */
export function flattenSizes(sizes: SizesByResolution): SizeOption[] {
  return [...sizes['1k'], ...sizes['2k'], ...sizes['4k']];
}

export function hasAnySize(sizes: SizesByResolution | null): boolean {
  return !!sizes && flattenSizes(sizes).length > 0;
}

function parseWH(size: string): { w: number; h: number } | null {
  const m = /^\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})\s*$/.exec(size);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * 换模型之后，把当前尺寸纠正到新模型支持的那一个。
 *
 * 判据不是「字符串相等」而是「先比例、后面积」：用户选的是 16:9 这个**意图**，
 * 换个模型后 1920x1080 变成 1792x1008 仍然是他要的那件事；只按字符串比，
 * 会把「同一个比例的另一档」判成不支持，然后一路退到方形——那正是用户会说
 * 「怎么我选的比例自己变了」的那种静默改写。
 *
 * 返回 null = 不需要改（当前尺寸本来就支持，或没有可用数据不该乱动）。
 */
export function reconcileSize(current: string, sizes: SizesByResolution | null): string | null {
  if (!hasAnySize(sizes)) return null;
  const all = flattenSizes(sizes!);
  const cur = String(current ?? '').trim().toLowerCase();
  if (all.some((o) => o.size.toLowerCase() === cur)) return null;

  const curWH = parseWH(current);
  if (!curWH) return all[0]!.size;
  const curRatio = curWH.w / curWH.h;
  const curArea = curWH.w * curWH.h;

  let best: { size: string; ratioDiff: number; areaDiff: number } | null = null;
  for (const opt of all) {
    const wh = parseWH(opt.size);
    if (!wh) continue;
    const ratioDiff = Math.abs(wh.w / wh.h - curRatio);
    const areaDiff = Math.abs(wh.w * wh.h - curArea);
    if (
      !best
      // 比例优先：比例差明显更小就换（1e-3 容差吸收 1792x1008 这类整数取整误差）
      || ratioDiff < best.ratioDiff - 1e-3
      // 比例打平再比面积，保住用户原来的清晰度档位
      || (Math.abs(ratioDiff - best.ratioDiff) <= 1e-3 && areaDiff < best.areaDiff)
    ) {
      best = { size: opt.size, ratioDiff, areaDiff };
    }
  }
  return best?.size ?? all[0]!.size;
}
