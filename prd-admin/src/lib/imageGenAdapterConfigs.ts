/**
 * 生图模型适配器配置（前端本地版本）
 * 用于在模型选择器中预览匹配的适配器信息
 * 基于模型名匹配，适用于所有平台
 */

export type AdapterConfig = {
  modelIdPattern: string;
  displayName: string;
  provider: string;
  sizeConstraintType: 'whitelist' | 'range' | 'aspect_ratio';
  allowedRatios: string[];
  notes: string[];
};

/**
 * 生图模型适配器配置列表
 */
export const IMAGE_GEN_ADAPTER_CONFIGS: AdapterConfig[] = [
  {
    modelIdPattern: 'nano-banana*',
    displayName: 'Gemini Nano-Banana',
    provider: 'Google',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    notes: ['支持 1K, 2K, 4K 三个档位'],
  },
  {
    modelIdPattern: 'gemini-3-pro-image-preview*',
    displayName: 'Gemini 3 Pro Image Preview',
    provider: 'Google',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    notes: ['支持 1K, 2K, 4K 三个档位'],
  },
  {
    modelIdPattern: 'dall-e-3',
    displayName: 'DALL-E 3',
    provider: 'OpenAI',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '9:16', '16:9'],
    notes: ['仅支持 1024x1024, 1024x1792, 1792x1024'],
  },
  {
    modelIdPattern: 'dall-e-2',
    displayName: 'DALL-E 2',
    provider: 'OpenAI',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1'],
    notes: ['仅支持正方形尺寸'],
  },
  {
    modelIdPattern: 'flux*',
    displayName: 'Flux Pro',
    provider: 'Black Forest Labs',
    sizeConstraintType: 'range',
    allowedRatios: [],
    notes: ['宽高需在 256-1440 之间，且为 32 的倍数'],
  },
  {
    modelIdPattern: 'jimeng*',
    displayName: '即梦 AI',
    provider: '字节跳动',
    sizeConstraintType: 'aspect_ratio',
    allowedRatios: ['1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2'],
    notes: ['通过 aspect_ratio 和 resolution 参数控制尺寸'],
  },
  {
    modelIdPattern: 'qwen-image*',
    displayName: '通义万相',
    provider: '阿里云',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    notes: ['最高 200 万像素'],
  },
  {
    modelIdPattern: 'grok-2-image*',
    displayName: 'Grok-2 Image',
    provider: 'xAI',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '9:16', '16:9'],
    notes: ['支持参数较 DALL-E 更少'],
  },
  {
    modelIdPattern: 'stable-diffusion*',
    displayName: 'Stable Diffusion 3.5',
    provider: 'Stability AI',
    sizeConstraintType: 'whitelist',
    allowedRatios: ['1:1', '9:7', '7:9', '16:9', '9:16', '3:4', '4:3', '8:5', '5:8'],
    notes: ['仅支持枚举中的尺寸'],
  },
  {
    modelIdPattern: 'kling*',
    displayName: '可灵 AI',
    provider: '快手',
    sizeConstraintType: 'aspect_ratio',
    allowedRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    notes: ['通过 aspect_ratio 参数控制比例'],
  },
  // ===== 豆包 Seedream 系列（火山引擎）=====
  {
    modelIdPattern: 'doubao-seedream-4-5*',
    displayName: '豆包 Seedream 4.5',
    provider: '字节跳动 (火山引擎)',
    sizeConstraintType: 'range',
    allowedRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    notes: ['支持 2K/4K 档位', '不支持 1K 档位'],
  },
  {
    modelIdPattern: 'doubao-seedream-4-0*',
    displayName: '豆包 Seedream 4.0',
    provider: '字节跳动 (火山引擎)',
    sizeConstraintType: 'range',
    allowedRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    notes: ['支持 1K/2K/4K 全档位'],
  },
  {
    modelIdPattern: 'doubao-seedream-3*',
    displayName: '豆包 Seedream 3.0',
    provider: '字节跳动 (火山引擎)',
    sizeConstraintType: 'range',
    allowedRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    notes: ['仅支持约 1K 档位'],
  },
];

/**
 * 根据模型名匹配适配器配置
 */
export function matchAdapterConfig(modelName: string | null | undefined): AdapterConfig | null {
  if (!modelName) return null;
  const name = modelName.trim().toLowerCase();

  for (const config of IMAGE_GEN_ADAPTER_CONFIGS) {
    const pattern = config.modelIdPattern.trim().toLowerCase();

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (name.startsWith(prefix)) {
        return config;
      }
    } else {
      if (name === pattern) {
        return config;
      }
    }
  }

  return null;
}
