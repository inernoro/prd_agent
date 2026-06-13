import type { Product } from './types';

const PRODUCT_FIELD_KEYS = ['应用', '产品', '所属产品', '产品名称', '产品线', 'product', 'productname'];

const BRACKET_PREFIX = /^【([^】]+)】/;

export function extractTitleBracketLabel(title?: string | null): string | null {
  if (!title?.trim()) return null;
  const match = title.trim().match(BRACKET_PREFIX);
  return match?.[1]?.trim() ?? null;
}

export function extractProductLabelFromFields(fields?: Record<string, string> | null): string | null {
  if (!fields || Object.keys(fields).length === 0) return null;
  for (const key of PRODUCT_FIELD_KEYS) {
    const hit = Object.entries(fields).find(([fieldKey]) => fieldKey.trim().toLowerCase() === key.toLowerCase());
    if (hit?.[1]?.trim()) return hit[1].trim();
  }
  return null;
}

export function resolveProductLabelFromVersionRow(
  appName?: string,
  systemName?: string,
  legacyData?: Record<string, string>,
): string | null {
  if (appName?.trim()) return appName.trim();
  const fromLegacy = extractProductLabelFromFields(legacyData);
  if (fromLegacy) return fromLegacy;
  if (systemName?.trim()) return systemName.trim();
  return null;
}

export function matchProductByLabel(products: Product[], label: string): Product | null {
  const q = label.trim();
  if (!q) return null;
  const exact = products.find(
    (p) => p.name.trim().toLowerCase() === q.toLowerCase()
      || (p.code?.trim().toLowerCase() === q.toLowerCase()),
  );
  if (exact) return exact;
  const contains = products
    .filter((p) => {
      const name = p.name.trim();
      if (!name) return false;
      const lower = name.toLowerCase();
      const query = q.toLowerCase();
      return lower.includes(query) || query.includes(lower);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  return contains ?? null;
}

export function resolveImportProductId(
  products: Product[],
  options: {
    title?: string;
    sourceFields?: Record<string, string>;
    appName?: string;
    systemName?: string;
    legacyData?: Record<string, string>;
    fallbackProductId?: string;
  },
): { productId: string | null; label: string | null; matched: boolean } {
  const label = options.appName !== undefined || options.systemName !== undefined || options.legacyData
    ? resolveProductLabelFromVersionRow(options.appName, options.systemName, options.legacyData)
    : (extractProductLabelFromFields(options.sourceFields) ?? extractTitleBracketLabel(options.title));
  if (!label) {
    return { productId: options.fallbackProductId ?? null, label: null, matched: false };
  }
  const product = matchProductByLabel(products, label);
  if (product) return { productId: product.id, label, matched: true };
  return { productId: options.fallbackProductId ?? null, label, matched: false };
}
