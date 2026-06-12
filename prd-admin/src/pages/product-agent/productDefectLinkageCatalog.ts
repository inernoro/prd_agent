/** 需求 FormData：勾选「产品缺陷」 */
export const REQUIREMENT_PRODUCT_DEFECT_FORM_KEY = '产品缺陷';
export const REQUIREMENT_PRODUCT_DEFECT_VALUE = '是';

/** 缺陷划分 */
export const PRODUCT_DEFECT_CLASSIFICATION = '缺陷';
export const NON_PRODUCT_DEFECT_CLASSIFICATION = '非产品缺陷';

export const WORKFLOW_LINK_ENTITY_LABELS: Record<string, string> = {
  requirement: '联动：转为需求',
  defect: '联动：转为缺陷（标记产品缺陷）',
};

export function isRequirementProductDefect(formData: Record<string, string> | undefined | null): boolean {
  return formData?.[REQUIREMENT_PRODUCT_DEFECT_FORM_KEY] === REQUIREMENT_PRODUCT_DEFECT_VALUE;
}

export function normalizeDefectClassification(value: string | null | undefined): string {
  return value === NON_PRODUCT_DEFECT_CLASSIFICATION ? NON_PRODUCT_DEFECT_CLASSIFICATION : PRODUCT_DEFECT_CLASSIFICATION;
}
