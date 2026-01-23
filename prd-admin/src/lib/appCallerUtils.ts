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
  HelpCircle,     // 未知
  Layers,         // 向量嵌入
  MessageSquare,  // 对话模型
  Palette,        // 图像生成
  ScrollText,     // 长上下文
} from 'lucide-react';

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
 * - chat / intent / vision / image-gen / code / long-context / embedding / rerank
 */
export type ExpectedModelType =
  | 'chat'
  | 'intent'
  | 'vision'
  | 'image-gen'
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
    v === 'image-gen' ||
    v === 'imagegen' ||
    v === 'image-generate' ||
    v === 'image-generation' ||
    v === 'generation' ||
    v === 'img-gen'
  ) {
    return 'image-gen';
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
    'image-gen': '图像生成',
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
    'image-gen': Palette,     // 调色板 - 图像生成/创作
    'code': Code2,            // 代码符号 - 代码生成
    'long-context': ScrollText, // 长文档 - 长上下文
    'embedding': Layers,      // 层叠 - 向量嵌入
    'rerank': ArrowUpDown,    // 上下箭头 - 重排序
    'unknown': HelpCircle,
  };

  return icons[mt] || HelpCircle;
}

/**
 * 从 requestPurpose 获取功能描述（用于日志页面）
 *
 * @param requestPurpose - 如 "prd-agent-desktop.chat.sendmessage::chat"（新格式）或 "chat.sendMessage"（旧格式）
 * @returns 中文描述，如 "桌面端：用户发送聊天消息"
 */
export function getFeatureDescriptionFromRequestPurpose(requestPurpose: string | null | undefined): string {
  const rp = (requestPurpose ?? '').trim();
  if (!rp) return '未知';

  // 应用名称映射
  const appSubjectMap: Record<string, string> = {
    'prd-agent-desktop': '桌面端',
    'prd-agent-web': '管理后台',
    'visual-agent': '视觉创作',
    'literary-agent': '文学创作',
    'open-platform': '开放平台',
    'open-platform-agent': '开放平台',
    'desktop': '桌面端',
    'admin': '管理后台',
  };

  // 完整 AppCallerCode 映射（新格式：app.feature.action::modelType）
  const fullCodeMap: Record<string, string> = {
    // Desktop
    'prd-agent-desktop.chat.sendmessage::chat': '桌面端：用户发送聊天消息',
    'prd-agent-desktop.chat.sendmessage::intent': '桌面端：消息意图识别',
    'prd-agent-desktop.chat::vision': '桌面端：图片理解',
    'prd-agent-desktop.prd.analysis::chat': '桌面端：PRD 智能分析',
    'prd-agent-desktop.prd.preview::chat': '桌面端：PRD 预览问答',
    'prd-agent-desktop.gap.detection::chat': '桌面端：Gap 差异检测',
    'prd-agent-desktop.gap.summarization::chat': '桌面端：Gap 差异总结',
    'prd-agent-desktop.group-name.suggest::intent': '桌面端：群组名称建议',
    'prd-agent-desktop.preview-ask.section::chat': '桌面端：预览章节问答',
    // Visual Agent
    'visual-agent.image::generation': '视觉创作：生成图片',
    'visual-agent.image::vision': '视觉创作：图片分析',
    'visual-agent.image::chat': '视觉创作：创意对话',
    // Literary Agent
    'literary-agent.content::chat': '文学创作：内容生成',
    'literary-agent.content.polishing::chat': '文学创作：内容润色',
    'literary-agent.illustration::generation': '文学创作：配图生成',
    // Open Platform
    'open-platform-agent.proxy::chat': '开放平台：聊天代理',
    'open-platform-agent.proxy::embedding': '开放平台：向量嵌入',
    'open-platform-agent.proxy::rerank': '开放平台：重排序',
    // Admin
    'prd-agent-web.lab::chat': '管理后台：实验室对话测试',
    'prd-agent-web.lab::vision': '管理后台：实验室视觉测试',
    'prd-agent-web.lab::generation': '管理后台：实验室生图测试',
    'prd-agent-web::model-lab.run': '管理后台：模型实验室',
    'prd-agent-web::image-gen.plan': '管理后台：图片生成规划',
    'prd-agent-web::image-gen.generate': '管理后台：图片生成',
    'prd-agent-web::image-gen.batch-generate': '管理后台：批量图片生成',
    'prd-agent-web::image-gen.run': '管理后台：图片生成任务',
  };

  // 先检查完整 AppCallerCode 精确匹配
  if (fullCodeMap[rp]) {
    return fullCodeMap[rp];
  }

  // 精确匹配映射（用于不含 :: 的纯应用名）
  const exactMap: Record<string, string> = {
    'visual-agent': '视觉创作',
    'literary-agent': '文学创作',
    'model-health-check': '模型健康检查',
    'admin.platforms.reclassify': '管理后台：模型重分类',
    'admin.platforms.fetch-models': '管理后台：拉取模型列表',
    'admin.platforms.available-models': '管理后台：查询可用模型',
    'admin.platforms.refresh-models': '管理后台：刷新模型列表',
    'admin.platforms.reclassify.fetch-models': '管理后台：重分类拉取模型',
  };

  if (exactMap[rp]) {
    return exactMap[rp];
  }

  // 新格式解析：app.feature.action::modelType 或 app::feature
  if (rp.includes('::')) {
    const [pathPart, modelType] = rp.split('::');
    const parts = pathPart.split('.');

    // 尝试识别应用名（可能是多段的，如 prd-agent-desktop）
    let appName = '';
    let featureParts: string[] = [];

    // 检查第一段是否是已知应用
    if (appSubjectMap[parts[0]]) {
      appName = appSubjectMap[parts[0]];
      featureParts = parts.slice(1);
    } else if (parts.length >= 2) {
      // 可能是 prd-agent-desktop 这样的格式
      const potentialApp = parts[0];
      if (appSubjectMap[potentialApp]) {
        appName = appSubjectMap[potentialApp];
        featureParts = parts.slice(1);
      } else {
        appName = parts[0];
        featureParts = parts.slice(1);
      }
    }

    // 构建功能描述
    const featureDesc = featureParts.length > 0 ? featureParts.join('.') : modelType;
    const modelTypeDesc = getModelTypeDisplayName(modelType);

    if (appName && featureDesc) {
      return `${appName}：${featureDesc} (${modelTypeDesc})`;
    }
  }

  // 旧格式兼容映射（camelCase）
  const oldFormatMap: Record<string, string> = {
    'chat.sendMessage': '桌面端：用户发送聊天消息',
    'modelLab.run': '实验室：模型测试',
    'prd.analyze': '桌面端：PRD 智能分析',
    'prd.preview': '桌面端：PRD 预览问答',
    'gap.detect': '桌面端：Gap 差异检测',
    'imageGen.generate': '视觉创作：生成配图',
  };

  return oldFormatMap[rp] || rp;
}

/**
 * 获取功能的详细描述（谁在使用、怎么使用）
 * 
 * @param parsed - 解析后的 App Caller Key
 * @returns 中文描述，如 "桌面端：用户发送聊天消息"
 */
export function getFeatureDescription(parsed: ParsedAppCallerKey): string {
  const { app, features, modelType } = parsed;
  
  // 应用主体
  const appSubject: Record<string, string> = {
    desktop: '桌面端',
    'prd-agent-desktop': '桌面端',
    'visual-agent': '视觉创作',
    'literary-agent': '文学创作',
    'open-platform': '开放平台',
    'open-platform-agent': '开放平台',
    admin: '管理后台',
    'prd-agent-web': '管理后台',
  };
  
  // 功能描述映射
  const descriptions: Record<string, Record<string, string>> = {
    desktop: {
      'chat.sendmessage::chat': '用户发送聊天消息',
      'chat.sendmessage::intent': '识别用户消息意图',
      'chat::vision': '理解聊天中的图片',
      'prd.analysis::chat': 'PRD 智能分析',
      'prd.preview::chat': 'PRD 预览问答',
      'gap.detection::chat': 'Gap 差异检测',
      'gap.summarization::chat': 'Gap 差异总结',
    },
    'prd-agent-desktop': {
      'chat.sendmessage::chat': '用户发送聊天消息',
      'chat.sendmessage::intent': '识别用户消息意图',
      'chat::vision': '理解聊天中的图片',
      'prd.analysis::chat': 'PRD 智能分析',
      'prd.preview::chat': 'PRD 预览问答',
      'gap.detection::chat': 'Gap 差异检测',
      'gap.summarization::chat': 'Gap 差异总结',
    },
    'visual-agent': {
      'image::generation': '生成配图',
      'image::vision': '验证图片质量',
      'image::chat': '生成图片描述',
    },
    'literary-agent': {
      'content::chat': '生成文学内容',
      'illustration::generation': '生成文章配图',
      'illustration::vision': '验证配图质量',
    },
    'open-platform': {
      'proxy::chat': 'API 对话代理',
      'proxy::vision': 'API 视觉代理',
      'proxy::generation': 'API 生图代理',
    },
    'open-platform-agent': {
      'proxy::chat': 'API 对话代理',
      'proxy::vision': 'API 视觉代理',
      'proxy::generation': 'API 生图代理',
    },
    admin: {
      'lab::chat': '实验室模型测试',
      'lab::vision': '实验室视觉测试',
      'lab::generation': '实验室生图测试',
    },
    'prd-agent-web': {
      'lab::chat': '实验室模型测试',
      'lab::vision': '实验室视觉测试',
      'lab::generation': '实验室生图测试',
    },
  };
  
  const subject = appSubject[app] || app;
  const fullPath = features.join('.') + '::' + modelType;
  const description = descriptions[app]?.[fullPath];
  
  if (description) {
    return `${subject}：${description}`;
  }
  
  // 回退：基于功能和模型类型生成通用描述
  const featureName = getFeatureDisplayName(features[0] || '');
  const modelTypeName = getModelTypeDisplayName(modelType);
  return `${subject}：${featureName} - ${modelTypeName}`;
}
