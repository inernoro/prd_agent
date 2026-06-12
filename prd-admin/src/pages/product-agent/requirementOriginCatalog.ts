/** 需求来源（对齐 TAPD 字段「需求来源」） */
export const REQUIREMENT_ORIGIN_FORM_KEY = '需求来源';

export const REQUIREMENT_ORIGIN_OPTIONS = [
  { value: '', label: '空' },
  { value: '客户反馈', label: '客户反馈' },
  { value: '内部规划', label: '内部规划' },
  { value: '运营活动', label: '运营活动' },
  { value: '竞品调研', label: '竞品调研' },
  { value: '其他', label: '其他' },
] as const;

export type RequirementOriginValue = (typeof REQUIREMENT_ORIGIN_OPTIONS)[number]['value'];
