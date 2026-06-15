import type { ImportRequirementRow } from '@/services/real/productAgent';

const PRODUCT_FIELD_KEYS = [
  '应用', '所属应用', '应用名称', '应用产品', '应用/产品',
  '产品', '所属产品', '产品名称', '产品线', '系统产品',
] as const;

/** 行是否自带可路由到系统产品的标签（应用列或标题【前缀】） */
export function rowHasProductRouteHint(row: Pick<ImportRequirementRow, 'title' | 'sourceFields'>): boolean {
  const fields = row.sourceFields ?? {};
  if (PRODUCT_FIELD_KEYS.some((key) => fields[key]?.trim())) return true;
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
    if (rowHasProductRouteHint(row)) return row;
    return { ...row, sourceFields: { ...row.sourceFields, 应用: name } };
  });
}
