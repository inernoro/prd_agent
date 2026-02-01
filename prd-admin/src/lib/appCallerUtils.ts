/**
 * 应用调用者工具函数
 * 用于解析和分组 App Caller Key
 */

import type { ComponentType } from 'react';
import { 
  ArrowUpDown,    // 重排序
  Brain,          // 意图识别
  Code2,          // 代码生成
  Eye,            // 视觉理解
  FileCode,       // appCallerKey 标识
  HelpCircle,     // 未知
  Layers,         // 向量嵌入
  MessageSquare,  // 对话模型
  Palette,        // 图像生成
  ScrollText,     // 长上下文
} from 'lucide-react';

/**
 * AppCallerKey 图标组件
 * 用于标识 appCallerKey/requestPurpose 字段
 */
export const AppCallerKeyIcon = FileCode;

export interface ParsedAppCallerKey {
  app: string;              // 应用名称，如 desktop, visual-agent
  features: string[];       // 功能路径，如 ['chat', 'sendmessage']
  modelType: string;        // 模型类型，如 chat, vision, generation
  fullPath: string;         // 完整功能路径，如 chat.sendmessage
}

/**
 * 将后端/历史/别名的 modelType 归一到“期望值枚举”（固定值，前端 UI 按此设定图标与展示名）
 *
 * 期望值来自 ModelAppGroupPage 的固定枚举：
 * - chat / intent / vision / generation / code / long-context / embedding / rerank
 */
export type ExpectedModelType =
  | 'chat'
  | 'intent'
  | 'vision'
  | 'generation'
  | 'code'
  | 'long-context'
  | 'embedding'
  | 'rerank'
  | 'unknown';

export function normalizeModelType(rawModelType: string | null | undefined): ExpectedModelType {
  const raw = String(rawModelType ?? '').trim();
  if (!raw) return 'unknown';

  const v = raw.toLowerCase().replace(/[\s_]/g, '-');

  // 对话
  if (v === 'chat' || v === 'conversation' || v === 'llm') return 'chat';

  // 意图
  if (v === 'intent' || v === 'intent-detect' || v === 'intent-detection') return 'intent';

  // 视觉
  if (v === 'vision' || v === 'image-vision' || v === 'imagevision' || v === 'vl') return 'vision';

  // 生图：历史/后端常见别名 generation/imageGen/image_generation
  if (
    v === 'generation' ||
    v === 'image-gen' ||
    v === 'imagegen' ||
    v === 'image-generate' ||
    v === 'image-generation' ||
    v === 'img-gen'
  ) {
    return 'generation';
  }

  // 代码
  if (v === 'code' || v === 'coding' || v === 'code-gen' || v === 'codegen') return 'code';

  // 长上下文
  if (v === 'long-context' || v === 'longcontext' || v === 'long-ctx' || v === 'context') return 'long-context';

  // 向量
  if (v === 'embedding' || v === 'embeddings' || v === 'embed') return 'embedding';

  // 重排
  if (v === 'rerank' || v === 're-rank' || v === 'ranking' || v === 'rank') return 'rerank';

  return 'unknown';
}

/**
 * 解析 App Caller Key
 * 
 * @param key - 格式：{app}.{feature}[.{subfeature}...]::modelType
 * @example
 * parseAppCallerKey('desktop.chat.sendmessage::chat')
 * // => { app: 'desktop', features: ['chat', 'sendmessage'], modelType: 'chat', fullPath: 'chat.sendmessage' }
 */
export function parseAppCallerKey(key: string): ParsedAppCallerKey {
  const [path, modelType] = key.split('::');
  const parts = path.split('.');
  
  return {
    app: parts[0] || '',
    features: parts.slice(1),
    modelType: modelType || 'chat',
    fullPath: parts.slice(1).join('.'),
  };
}

/**
 * 应用分组
 */
export interface AppGroup {
  app: string;
  appName: string;
  features: FeatureGroup[];
}

/**
 * 功能分组
 */
export interface FeatureGroup {
  feature: string;
  featureName: string;
  items: AppCallerItem[];
}

/**
 * 应用调用者项
 */
export interface AppCallerItem {
  id: string;
  appCallerKey: string;
  displayName: string;
  parsed: ParsedAppCallerKey;
  modelRequirements: any[];
  stats?: any;
}

/**
 * 将应用调用者列表分组
 * 
 * @param callers - 应用调用者列表
 * @returns 分组后的应用树
 */
export function groupAppCallers(callers: any[]): AppGroup[] {
  // 解析所有 key
  const parsed = callers.map((caller: any) => ({
    ...caller,
    parsed: parseAppCallerKey(caller.appCode || caller.appCallerKey || ''),
  }));

  // 按应用分组
  const byApp = parsed.reduce((acc: Record<string, any[]>, caller: any) => {
    const app = caller.parsed.app;
    if (!acc[app]) acc[app] = [];
    acc[app].push(caller);
    return acc;
  }, {} as Record<string, any[]>);

  // 每个应用内按第一层功能分组
  return Object.entries(byApp).map(([app, items]: [string, any[]]) => {
    const byFeature = items.reduce((acc: Record<string, any[]>, item: any) => {
      const feature = item.parsed.features[0] || 'default';
      if (!acc[feature]) acc[feature] = [];
      acc[feature].push(item);
      return acc;
    }, {} as Record<string, any[]>);

    return {
      app,
      appName: getAppDisplayName(app),
      features: Object.entries(byFeature).map(([feature, items]: [string, any[]]) => ({
        feature,
        featureName: getFeatureDisplayName(feature),
        items: items.map((item: any) => ({
          id: item.id,
          appCallerKey: item.appCode || item.appCallerKey,
          displayName: item.displayName,
          parsed: item.parsed,
          modelRequirements: item.modelRequirements || [],
          stats: {
            totalCalls: item.totalCalls || 0,
            successCalls: item.successCalls || 0,
            failedCalls: item.failedCalls || 0,
          },
        })),
      })),
    };
  });
}

/**
 * 获取应用的显示名称
 */
function getAppDisplayName(app: string): string {
  const names: Record<string, string> = {
    desktop: 'Desktop 桌面端',
    'prd-agent-desktop': 'Desktop 桌面端',
    'visual-agent': 'Visual Agent 视觉创作',
    'literary-agent': 'Literary Agent 文学创作',
    'open-platform': 'Open Platform 开放平台',
    'open-platform-agent': 'Open Platform 开放平台',
    admin: 'Admin 管理后台',
    'prd-agent-web': 'Admin 管理后台',
  };
  return names[app] || app;
}

/**
 * 获取功能的显示名称
 */
function getFeatureDisplayName(feature: string): string {
  const names: Record<string, string> = {
    'chat': '聊天',
    'prd': 'PRD',
    'gap': 'Gap',
    'image': '图片',
    'content': '内容',
    'illustration': '配图',
    'proxy': '代理',
    'lab': '实验室',
  };
  return names[feature] || feature;
}

/**
 * 获取模型类型的显示名称
 */
export function getModelTypeDisplayName(modelType: string): string {
  const mt = normalizeModelType(modelType);
  const names: Record<string, string> = {
    'chat': '对话模型',
    'intent': '意图识别',
    'vision': '视觉理解',
    'generation': '图像生成',
    'code': '代码生成',
    'long-context': '长上下文',
    'embedding': '向量嵌入',
    'rerank': '重排序',
    'unknown': '未知类型',
  };
  return names[mt] || '未知类型';
}

/**
 * 获取模型类型的图标组件（禁止使用 emoji / 字符替代）
 */
export function getModelTypeIcon(modelType: string): ComponentType<any> {
  const mt = normalizeModelType(modelType);

  // 固定期望值 -> 固定图标
  // 使用符合 AI 模型类型语义的图标
  const icons: Record<ExpectedModelType, ComponentType<any>> = {
    'chat': MessageSquare,    // 对话气泡 - 对话/推理模型
    'intent': Brain,          // 大脑 - 意图识别/理解
    'vision': Eye,            // 眼睛 - 视觉理解
    'generation': Palette,    // 调色板 - 图像生成/创作
    'code': Code2,            // 代码符号 - 代码生成
    'long-context': ScrollText, // 长文档 - 长上下文
    'embedding': Layers,      // 层叠 - 向量嵌入
    'rerank': ArrowUpDown,    // 上下箭头 - 重排序
    'unknown': HelpCircle,
  };

  return icons[mt] || HelpCircle;
}

