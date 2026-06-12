/**
 * MAP 内置功能工作流目录（与后端 FeatureWorkflowCatalog 一致）。
 * 仅作 API 未返回流程定义时的兜底。
 */
export const BUILTIN_FEATURE_STATE_LABEL: Record<string, string> = {
  planned: '规划中',
  developing: '开发中',
  testing: '测试中',
  released: '已发布',
  cancelled: '已下架',
};

export const BUILTIN_FEATURE_STATE_DESCRIPTION: Record<string, string> = {
  planned: '功能已登记并纳入产品能力库，待排入本版本开发计划',
  developing: '功能正在本版本内开发实现',
  testing: '功能开发已完成，进入测试与验收',
  released: '功能已随本版本正式发布上线',
  cancelled: '功能规划调整或不再提供，已从产品中下架（保留历史记录）',
};

export function builtinFeatureStateLabel(key?: string | null): string {
  if (!key) return '未设置';
  return BUILTIN_FEATURE_STATE_LABEL[key] ?? key;
}
