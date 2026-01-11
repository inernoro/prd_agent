/**
 * 应用调用者工具函数
 * 用于解析和分组 App Caller Key
 */

export interface ParsedAppCallerKey {
  app: string;              // 应用名称，如 desktop, visual-agent
  features: string[];       // 功能路径，如 ['chat', 'sendmessage']
  modelType: string;        // 模型类型，如 chat, vision, generation
  fullPath: string;         // 完整功能路径，如 chat.sendmessage
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
    'desktop': 'Desktop 桌面端',
    'visual-agent': 'Visual Agent 视觉创作',
    'literary-agent': 'Literary Agent 文学创作',
    'open-platform': 'Open Platform 开放平台',
    'admin': 'Admin 管理后台',
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
  const names: Record<string, string> = {
    'chat': '对话模型',
    'intent': '意图识别',
    'vision': '视觉理解',
    'generation': '图片生成',
    'code': '代码生成',
    'embedding': '向量嵌入',
    'rerank': '重排序',
  };
  return names[modelType] || modelType;
}

/**
 * 获取模型类型的图标
 */
export function getModelTypeIcon(modelType: string): string {
  const icons: Record<string, string> = {
    'chat': '💬',
    'intent': '🎯',
    'vision': '👁️',
    'generation': '🎨',
    'code': '💻',
    'embedding': '🔢',
    'rerank': '🔄',
  };
  return icons[modelType] || '📦';
}

/**
 * 从 requestPurpose 获取功能描述（用于日志页面）
 * 
 * @param requestPurpose - 如 "desktop.chat.sendmessage::chat" 或 "chat.sendMessage"（旧格式）
 * @returns 中文描述，如 "桌面端：用户发送聊天消息"
 */
export function getFeatureDescriptionFromRequestPurpose(requestPurpose: string | null | undefined): string {
  const rp = (requestPurpose ?? '').trim();
  if (!rp) return '未知';
  
  // 新格式：包含 ::
  if (rp.includes('::')) {
    const parsed = parseAppCallerKey(rp);
    return getFeatureDescription(parsed);
  }
  
  // 旧格式：chat.sendMessage / modelLab.run 等
  // 简单映射
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
    'desktop': '桌面端',
    'visual-agent': '视觉创作',
    'literary-agent': '文学创作',
    'open-platform': '开放平台',
    'admin': '管理后台',
  };
  
  // 功能描述映射
  const descriptions: Record<string, Record<string, string>> = {
    'desktop': {
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
    'admin': {
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
