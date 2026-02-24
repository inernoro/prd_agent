export type AspectOptionId = '1:1' | '4:3' | '3:4' | '4:5' | '5:4' | '16:9' | '9:16' | '2:3' | '3:2' | '21:9';

export type AspectOption = {
  id: AspectOptionId;
  label: string;
  // 三档分辨率尺寸
  size1k: string;
  size2k: string;
  size4k: string;
  // 用于展示的小图标（w/h 比例）
  iconW: number;
  iconH: number;
};

// 根据 vveai API 文档 (https://api-gpt-ge.apifox.cn/7725435m0) 扩展到 10 种比例 × 3 档分辨率
// 优先主流尺寸（每个比例的第二个尺寸选项）
export const ASPECT_OPTIONS: AspectOption[] = [
  { id: '1:1', label: '1:1', 
    size1k: '1024x1024', size2k: '2048x2048', size4k: '4096x4096',
    iconW: 20, iconH: 20 },
  
  { id: '4:3', label: '4:3',
    size1k: '1200x896',   // 主流尺寸（文档中为 1184x864 或 1200x896）
    size2k: '2400x1792',
    size4k: '4800x3584',
    iconW: 22, iconH: 16 },
  
  { id: '3:4', label: '3:4',
    size1k: '896x1200',   // 主流尺寸
    size2k: '1792x2400',
    size4k: '3584x4800',
    iconW: 16, iconH: 22 },
  
  { id: '4:5', label: '4:5',
    size1k: '928x1152',   // 主流尺寸（文档中为 896x1152 或 928x1152）
    size2k: '1856x2304',
    size4k: '3712x4608',
    iconW: 16, iconH: 20 },
  
  { id: '5:4', label: '5:4',
    size1k: '1152x928',   // 主流尺寸
    size2k: '2304x1856',
    size4k: '4608x3712',
    iconW: 20, iconH: 16 },
  
  { id: '16:9', label: '16:9',
    size1k: '1376x768',   // 主流尺寸（文档中为 1344x768 或 1376x768）
    size2k: '2752x1536',
    size4k: '5504x3072',
    iconW: 24, iconH: 14 },
  
  { id: '9:16', label: '9:16',
    size1k: '768x1376',   // 主流尺寸（文档中为 768x1344 或 768x1376）
    size2k: '1536x2752',
    size4k: '3072x5504',
    iconW: 14, iconH: 24 },
  
  // 新增三种比例
  { id: '2:3', label: '2:3',
    size1k: '848x1264',   // 主流尺寸（文档中为 832x1248 或 848x1264）
    size2k: '1696x2528',
    size4k: '3392x5056',
    iconW: 14, iconH: 22 },
  
  { id: '3:2', label: '3:2',
    size1k: '1264x848',   // 主流尺寸（文档中为 1248x832 或 1264x848）
    size2k: '2528x1696',
    size4k: '5056x3392',
    iconW: 22, iconH: 14 },
  
  { id: '21:9', label: '21:9',
    size1k: '1584x672',   // 主流尺寸（文档中为 1536x672 或 1584x672）
    size2k: '3168x1344',
    size4k: '6336x2688',
    iconW: 26, iconH: 11 },
];

// 辅助函数：根据档位获取尺寸
export function getSizeForTier(aspectId: AspectOptionId, tier: '1k' | '2k' | '4k'): string {
  const opt = ASPECT_OPTIONS.find(x => x.id === aspectId);
  if (!opt) return '1024x1024';
  return tier === '1k' ? opt.size1k : tier === '2k' ? opt.size2k : opt.size4k;
}

// 辅助函数：从尺寸字符串解析档位
export function detectTierFromSize(size: string): '1k' | '2k' | '4k' | null {
  const s = (size || '').trim().toLowerCase();
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size1k.toLowerCase() === s) return '1k';
    if (opt.size2k.toLowerCase() === s) return '2k';
    if (opt.size4k.toLowerCase() === s) return '4k';
  }
  return null;
}

// 辅助函数：从尺寸字符串检测比例（精确匹配 ASPECT_OPTIONS）
export function detectAspectFromSize(size: string): AspectOptionId | null {
  const s = (size || '').trim().toLowerCase();
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size1k.toLowerCase() === s || opt.size2k.toLowerCase() === s || opt.size4k.toLowerCase() === s) {
      return opt.id;
    }
  }
  return null;
}

// 按分辨率分组的尺寸类型
export type SizesByResolution = Record<'1k' | '2k' | '4k', Array<{ size: string; aspectRatio: string }>>;

// 将扁平尺寸数组转换为按分辨率分组的格式
export function sizesToSizesByResolution(sizes: string[]): SizesByResolution {
  const result: SizesByResolution = { '1k': [], '2k': [], '4k': [] };
  for (const size of sizes) {
    const tier = detectTierFromSize(size);
    const aspect = detectAspectFromSize(size);
    if (tier && aspect) {
      result[tier].push({ size, aspectRatio: aspect });
    } else {
      // 未知尺寸：根据像素总数猜测档位，使用宽高比
      const [w, h] = size.split(/[xX×]/).map(Number);
      if (!w || !h) continue;
      const pixels = w * h;
      const guessedTier: '1k' | '2k' | '4k' = pixels > 6_000_000 ? '4k' : pixels > 2_000_000 ? '2k' : '1k';
      const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
      const g = gcd(w, h);
      result[guessedTier].push({ size, aspectRatio: `${w / g}:${h / g}` });
    }
  }
  return result;
}
