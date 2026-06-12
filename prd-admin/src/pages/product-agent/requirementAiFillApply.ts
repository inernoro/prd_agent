import { REQUIREMENT_ORIGIN_FORM_KEY, REQUIREMENT_ORIGIN_OPTIONS, type RequirementOriginValue } from './requirementOriginCatalog';
import { REQUIREMENT_TYPE_FORM_KEY } from './requirementTypeCatalog';
import type { Customer, Feature, FormField, ItemGrade, Requirement } from './types';

const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

export interface RequirementAiFillResult {
  title?: string;
  description?: string;
  grade?: string;
  requirementOrigin?: string;
  customerIds?: string[];
  parentId?: string;
  formData?: Record<string, string>;
}

export interface RequirementAiFillApplyInput {
  result: RequirementAiFillResult;
  customers: Customer[];
  requirements: Requirement[];
  features: Feature[];
  templateFields: FormField[];
}

export interface RequirementAiFillApplyOutput {
  title?: string;
  description?: string;
  grade?: ItemGrade;
  requirementOrigin?: RequirementOriginValue;
  requirementType?: string;
  customerIds?: string[];
  parentId?: string;
  formData: Record<string, string>;
}

const ORIGIN_VALUES = new Set(REQUIREMENT_ORIGIN_OPTIONS.map((o) => o.value));

function normalizeOrigin(value?: string | null): RequirementOriginValue | undefined {
  const v = (value ?? '').trim();
  if (!v || v === '空') return '';
  if (ORIGIN_VALUES.has(v as RequirementOriginValue)) return v as RequirementOriginValue;
  const hit = REQUIREMENT_ORIGIN_OPTIONS.find((o) => o.label === v || o.value === v);
  return hit?.value;
}

function matchCustomerIds(names: string[], customers: Customer[]): string[] {
  const ids = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const exact = customers.find((c) => c.name.trim() === name);
    if (exact) { ids.add(exact.id); continue; }
    const partial = customers.find((c) => c.name.includes(name) || name.includes(c.name));
    if (partial) ids.add(partial.id);
  }
  return [...ids];
}

function matchParentId(title: string | undefined, requirements: Requirement[]): string | undefined {
  const q = (title ?? '').trim();
  if (!q) return undefined;
  const exact = requirements.find((r) => r.title.trim() === q);
  if (exact) return exact.id;
  return requirements.find((r) => r.title.includes(q) || q.includes(r.title))?.id;
}

function featureFieldKey(fields: FormField[]): string | undefined {
  return fields.find((f) => (f.label || '').trim() === '关联功能' || f.relationEntityType === 'feature')?.key;
}

function matchFeatureIds(titles: string[], features: Feature[]): string[] {
  const ids = new Set<string>();
  for (const raw of titles) {
    const q = raw.trim();
    if (!q) continue;
    const exact = features.find((f) => f.title.trim() === q);
    if (exact) { ids.add(exact.id); continue; }
    const partial = features.find((f) => f.title.includes(q) || q.includes(f.title) || (f.moduleName ?? '').includes(q));
    if (partial) ids.add(partial.id);
  }
  return [...ids];
}

/** 将 AI 智能填充结果映射为新建需求表单可写入的状态补丁 */
export function applyRequirementAiFill(input: RequirementAiFillApplyInput): RequirementAiFillApplyOutput {
  const { result, customers, requirements, features, templateFields } = input;
  const formData: Record<string, string> = { ...(result.formData ?? {}) };

  const origin = normalizeOrigin(result.requirementOrigin ?? formData[REQUIREMENT_ORIGIN_FORM_KEY]);
  if (origin !== undefined) {
    formData[REQUIREMENT_ORIGIN_FORM_KEY] = origin;
  }

  const requirementType = formData[REQUIREMENT_TYPE_FORM_KEY]?.trim() || undefined;

  let customerIds = result.customerIds?.filter(Boolean) ?? [];
  const customerNamesRaw = formData['客户名称'] ?? formData['客户'];
  if (customerNamesRaw && customerIds.length === 0) {
    const names = customerNamesRaw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
    customerIds = matchCustomerIds(names, customers);
  }

  let parentId = result.parentId;
  const parentTitle = formData['父需求'] ?? formData['parentRequirementTitle'];
  if (!parentId && parentTitle) parentId = matchParentId(parentTitle, requirements);

  const featureKey = featureFieldKey(templateFields);
  const featureTitlesRaw = formData['关联功能'] ?? formData['relatedFeatureTitles'];
  if (featureKey && featureTitlesRaw && !formData[featureKey]?.trim()) {
    const titles = featureTitlesRaw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
    const ids = matchFeatureIds(titles, features);
    if (ids.length > 0) formData[featureKey] = ids.join(',');
  }

  // 清理 AI 临时键，避免写入 formData 持久化
  delete formData['parentRequirementTitle'];
  delete formData['relatedFeatureTitles'];
  delete formData['customerNames'];

  const grade = result.grade && ITEM_GRADES.includes(result.grade as ItemGrade)
    ? (result.grade as ItemGrade)
    : undefined;

  return {
    title: result.title?.trim() || undefined,
    description: result.description,
    grade,
    requirementOrigin: origin,
    requirementType,
    customerIds: customerIds.length > 0 ? customerIds : undefined,
    parentId,
    formData,
  };
}
