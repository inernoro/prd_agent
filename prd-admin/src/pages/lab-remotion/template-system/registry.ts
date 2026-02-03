/**
 * 模板注册表
 * 所有可用模板的集中管理
 */
import { TemplateDefinition, TemplateRegistry, TemplateCategory } from './types';
import { conferenceOpeningTemplate } from './templates/conference-opening';

// 注册所有模板
export const templateRegistry: TemplateRegistry = {
  'conference-opening': conferenceOpeningTemplate,
  // 后续添加更多模板:
  // 'product-launch': productLaunchTemplate,
  // 'year-in-review': yearInReviewTemplate,
  // 'social-promo': socialPromoTemplate,
};

/**
 * 获取所有模板列表
 */
export function getAllTemplates(): TemplateDefinition[] {
  return Object.values(templateRegistry);
}

/**
 * 按分类获取模板
 */
export function getTemplatesByCategory(category: TemplateCategory): TemplateDefinition[] {
  return Object.values(templateRegistry).filter((t) => t.category === category);
}

/**
 * 根据 ID 获取模板
 */
export function getTemplateById(id: string): TemplateDefinition | undefined {
  return templateRegistry[id];
}

/**
 * 分类信息
 */
export const categoryInfo: Record<TemplateCategory, { label: string; description: string; icon: string }> = {
  conference: { label: '会议活动', description: '大会、发布会、峰会', icon: '🎤' },
  product: { label: '产品宣传', description: '产品发布、功能介绍', icon: '🚀' },
  social: { label: '社交媒体', description: '短视频、动态海报', icon: '📱' },
  data: { label: '数据可视化', description: '图表、报告', icon: '📊' },
  intro: { label: '片头片尾', description: 'Logo 动画、品牌展示', icon: '🎬' },
  celebration: { label: '庆祝纪念', description: '周年、节日、里程碑', icon: '🎉' },
};
