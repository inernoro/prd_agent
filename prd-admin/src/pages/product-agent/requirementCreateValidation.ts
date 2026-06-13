import type { FormField } from './types';
import { getRequirementOriginDetailField, type RequirementOriginValue } from './requirementOriginCatalog';

export interface RequirementCreateInput {
  title: string;
  description: string;
  assigneeId: string;
  requirementOrigin?: RequirementOriginValue;
  customerIds?: string[];
  templateFields: FormField[];
  formData: Record<string, string>;
}

export function validateRequirementCreateInput(input: RequirementCreateInput): string | null {
  if (!input.title.trim()) return '请填写需求标题';
  const descPlain = (input.description || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  if (!descPlain) return '请填写需求描述';
  if (!input.assigneeId) return '请选择处理人';

  const originDetail = getRequirementOriginDetailField(input.requirementOrigin ?? '');
  if (originDetail) {
    if (originDetail.kind === 'customer') {
      if (!input.customerIds?.length) return '请选择客户名称';
    } else {
      const v = (input.formData[originDetail.formKey] ?? '').trim();
      if (!v) return `请填写${originDetail.label}`;
    }
  }

  for (const field of input.templateFields) {
    if (!field.required) continue;
    // 新建需求时关联功能可选，详情/关联关系再维护
    if ((field.label || '').trim() === '关联功能') continue;
    const v = (input.formData[field.key] ?? field.defaultValue ?? '').trim();
    if (!v) return `请填写${field.label || field.key}`;
  }
  return null;
}
