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
  Mic,            // 语音识别 (ASR)
  Volume2,        // 语音合成 (TTS)
  Film,           // 视频生成
  Music,          // 音频生成
  ShieldCheck,    // 内容审核
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
  | 'asr'
  | 'tts'
  | 'video-gen'
  | 'audio-gen'
  | 'moderation'
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

  // 语音识别
  if (v === 'asr' || v === 'speech-recognition' || v === 'stt' || v === 'transcription') return 'asr';

  // 语音合成
  if (v === 'tts' || v === 'text-to-speech' || v === 'speech-synthesis') return 'tts';

  // 视频生成
  if (v === 'video-gen' || v === 'videogen' || v === 'video-generation' || v === 'video') return 'video-gen';

  // 音频生成
  if (v === 'audio-gen' || v === 'audiogen' || v === 'audio-generation' || v === 'music-gen') return 'audio-gen';

  // 内容审核
  if (v === 'moderation' || v === 'content-moderation' || v === 'safety') return 'moderation';

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
    'asr': '语音识别',
    'tts': '语音合成',
    'video-gen': '视频生成',
    'audio-gen': '音频生成',
    'moderation': '内容审核',
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
    'asr': Mic,               // 麦克风 - 语音识别
    'tts': Volume2,           // 扬声器 - 语音合成
    'video-gen': Film,        // 胶片 - 视频生成
    'audio-gen': Music,       // 音符 - 音频生成
    'moderation': ShieldCheck, // 盾牌 - 内容审核
    'unknown': HelpCircle,
  };

  return icons[mt] || HelpCircle;
}

/**
 * 模型类型定义（统一数据源）
 * 所有需要展示模型类型列表的地方都应使用此数组，禁止各处重复硬编码。
 */
export interface ModelTypeDefinition {
  value: string;
  label: string;
  description: string;
  icon: ComponentType<any>;
  category: 'core' | 'extended' | 'media';
}

export const MODEL_TYPE_DEFINITIONS: ModelTypeDefinition[] = [
  // ── 核心类型 ──
  { value: 'chat',         label: '对话模型',   description: '通用对话、推理、文本生成',       icon: MessageSquare, category: 'core' },
  { value: 'intent',       label: '意图识别',   description: '快速意图分类、结构化 JSON 返回', icon: Brain,         category: 'core' },
  { value: 'vision',       label: '视觉理解',   description: '图片识别、多模态内容理解',       icon: Eye,           category: 'core' },
  { value: 'generation',   label: '图像生成',   description: '文生图、图生图、风格迁移',       icon: Palette,       category: 'core' },
  // ── 扩展类型 ──
  { value: 'code',         label: '代码生成',   description: '代码补全、代码审查、重构',       icon: Code2,         category: 'extended' },
  { value: 'long-context', label: '长上下文',   description: '长文档摘要、大规模上下文分析',   icon: ScrollText,    category: 'extended' },
  { value: 'embedding',    label: '向量嵌入',   description: '文本向量化、语义搜索',           icon: Layers,        category: 'extended' },
  { value: 'rerank',       label: '重排序',     description: '搜索结果重排、相关性优化',       icon: ArrowUpDown,   category: 'extended' },
  { value: 'moderation',   label: '内容审核',   description: '内容安全检测、合规过滤',         icon: ShieldCheck,   category: 'extended' },
  // ── 多媒体类型 ──
  { value: 'asr',          label: '语音识别',   description: 'ASR 语音转文字、会议转录',       icon: Mic,           category: 'media' },
  { value: 'tts',          label: '语音合成',   description: 'TTS 文字转语音、旁白朗读',       icon: Volume2,       category: 'media' },
  { value: 'video-gen',    label: '视频生成',   description: '文生视频、图生视频',             icon: Film,          category: 'media' },
  { value: 'audio-gen',    label: '音频生成',   description: '音乐生成、音效合成',             icon: Music,         category: 'media' },
];

/**
 * 模型类型分类标签
 */
export const MODEL_TYPE_CATEGORIES: Record<string, string> = {
  core: '核心能力',
  extended: '扩展能力',
  media: '多媒体',
};

