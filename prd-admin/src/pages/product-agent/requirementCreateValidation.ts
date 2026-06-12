import type { FormField } from './types';

export interface RequirementCreateInput {
  title: string;
  description: string;
  assigneeId: string;
  versionIds: string[];
  templateFields: FormField[];
  formData: Record<string, string>;
}

export function validateRequirementCreateInput(input: RequirementCreateInput): string | null {
  if (!input.title.trim()) return '请填写需求标题';
  const descPlain = (input.description || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  if (!descPlain) return '请填写需求描述';
  if (!input.assigneeId) return '请选择处理人';
  if (input.versionIds.length === 0) return '请选择归属版本';
  for (const field of input.templateFields) {
    if (!field.required) continue;
    const v = (input.formData[field.key] ?? field.defaultValue ?? '').trim();
    if (!v) return `请填写${field.label || field.key}`;
  }
  return null;
}
