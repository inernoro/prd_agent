/** 需求来源（对齐 TAPD 字段「需求来源」） */
export const REQUIREMENT_ORIGIN_FORM_KEY = '需求来源';

export const REQUIREMENT_ORIGIN_OPTIONS = [
  { value: '', label: '空' },
  { value: '新增功能', label: '新增功能' },
  { value: '功能优化', label: '功能优化' },
  { value: '性能优化', label: '性能优化' },
  { value: '交互优化', label: '交互优化' },
  { value: '其他', label: '其他' },
] as const;

export type RequirementOriginValue = (typeof REQUIREMENT_ORIGIN_OPTIONS)[number]['value'];
