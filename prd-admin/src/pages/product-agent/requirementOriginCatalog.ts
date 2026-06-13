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

/** 各来源对应的补充信息：选中后才展示，且为必填 */
export const REQUIREMENT_ORIGIN_DETAIL_FIELDS = {
  客户反馈: { formKey: '客户名称', label: '客户名称', kind: 'customer' as const },
  内部规划: { formKey: '规划名称', label: '规划名称', kind: 'text' as const },
  运营活动: { formKey: '活动名称', label: '活动名称', kind: 'text' as const },
  竞品调研: { formKey: '竞品名称', label: '竞品名称', kind: 'text' as const },
} as const;

export type RequirementOriginDetailKind = (typeof REQUIREMENT_ORIGIN_DETAIL_FIELDS)[keyof typeof REQUIREMENT_ORIGIN_DETAIL_FIELDS]['kind'];

export function getRequirementOriginDetailField(origin: RequirementOriginValue) {
  if (!origin || origin === '其他') return null;
  return REQUIREMENT_ORIGIN_DETAIL_FIELDS[origin as keyof typeof REQUIREMENT_ORIGIN_DETAIL_FIELDS] ?? null;
}

/** 切换来源时清理其他来源遗留的 formData 键 */
export function originDetailFormKeysExcept(origin: RequirementOriginValue): string[] {
  const keep = getRequirementOriginDetailField(origin)?.formKey;
  return Object.values(REQUIREMENT_ORIGIN_DETAIL_FIELDS)
    .map((f) => f.formKey)
    .filter((key) => key !== keep);
}
