import type { ImportRequirementRow } from '@/services/real/productAgent';

const PRODUCT_FIELD_KEYS = ['应用', '产品', '所属产品', '产品名称', '产品线'] as const;
const REQUIREMENT_CATEGORY_PRODUCT_KEYS = ['分类'] as const;

/** 行是否自带可路由到系统产品的明确字段（应用 / 产品 / 所属产品列）。 */
export function rowHasExplicitProductRouteField(row: Pick<ImportRequirementRow, 'sourceFields'>): boolean {
  const fields = row.sourceFields ?? {};
  return PRODUCT_FIELD_KEYS.some((key) => fields[key]?.trim());
}

/** 行是否自带可路由到系统产品的标签（明确产品列或标题【前缀】）。 */
export function rowHasProductRouteHint(row: Pick<ImportRequirementRow, 'title' | 'sourceFields'>): boolean {
  if (rowHasExplicitProductRouteField(row)) return true;
  return /^【[^】]+】/.test(row.title?.trim() ?? '');
}

/** 为缺少应用标签的行注入默认产品名（跨产品导入 CSV/RTF 无「应用」列时使用） */
export function applyFallbackProductToRows(
  rows: ImportRequirementRow[],
  productName: string | undefined,
): ImportRequirementRow[] {
  const name = productName?.trim();
  if (!name) return rows;
  return rows.map((row) => {
    if (rowHasExplicitProductRouteField(row)) return row;
    return { ...row, sourceFields: { ...row.sourceFields, 应用: name } };
  });
}

/**
 * 需求池/TAPD 需求导出里「分类」承载的是产品/应用归属。
 * 只在需求导入链路使用，避免影响缺陷里的「分类」语义。
 */
export function promoteRequirementCategoryToProductField(
  fields?: Record<string, string> | null,
): Record<string, string> | undefined {
  const next = { ...(fields ?? {}) };
  if (rowHasExplicitProductRouteField({ sourceFields: next })) {
    return Object.keys(next).length > 0 ? next : undefined;
  }
  for (const key of REQUIREMENT_CATEGORY_PRODUCT_KEYS) {
    const value = next[key]?.trim();
    if (value) {
      next.应用 = value;
      return next;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
