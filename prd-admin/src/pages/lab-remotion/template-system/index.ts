/**
 * 模板系统主入口
 * 导出所有类型、组件、hooks 和工具函数
 */

// 类型定义
export type {
  FieldType,
  FieldMeta,
  TemplateDefinition,
  TemplateCategory,
  AspectRatio,
  TemplateRegistry,
  AIGeneratedProps,
} from './types';

export { ASPECT_RATIO_CONFIG } from './types';

// 模板注册表
export {
  templateRegistry,
  getAllTemplates,
  getTemplatesByCategory,
  getTemplateById,
  categoryInfo,
} from './registry';

// 模板
export { conferenceOpeningTemplate, conferenceOpeningSchema } from './templates/conference-opening';
export type { ConferenceOpeningProps } from './templates/conference-opening';

// AI 生成器
export {
  buildSystemPrompt,
  parseAIResponse,
  generateParamsWithAI,
  streamGenerateParams,
} from './ai-generator';
export type { AIGeneratorConfig } from './ai-generator';

// Hooks
export { useAIGenerator } from './hooks';
export type { UseAIGeneratorState, UseAIGeneratorReturn } from './hooks';

// 组件
export { TemplateSelector, TemplateParamsForm, TemplateWorkflow } from './components';
