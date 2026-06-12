import type { FormField } from './types';

export interface RequirementCreateInput {
  title: string;
  description: string;
  assigneeId: string;
  templateFields: FormField[];
  formData: Record<string, string>;
}

export function validateRequirementCreateInput(input: RequirementCreateInput): string | null {
  if (!input.title.trim()) return '请填写需求标题';
  const descPlain = (input.description || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  if (!descPlain) return '请填写需求描述';
  if (!input.assigneeId) return '请选择处理人';
  for (const field of input.templateFields) {
    if (!field.required) continue;
    // 新建需求时关联功能可选，详情/关联关系再维护
    if ((field.label || '').trim() === '关联功能') continue;
    const v = (input.formData[field.key] ?? field.defaultValue ?? '').trim();
    if (!v) return `请填写${field.label || field.key}`;
  }
  return null;
}
