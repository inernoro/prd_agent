import type { Customer, Feature, Product, ProductRelease, ProductVersion, Requirement } from './types';
import type { ItemSearchOption } from '@/components/ItemSearchSelect';

export function toRequirementOptions(requirements: Requirement[]): ItemSearchOption[] {
  return requirements.map((r) => ({ id: r.id, label: r.title, subLabel: r.requirementNo }));
}

export function toFeatureOptions(features: Feature[]): ItemSearchOption[] {
  return features.map((f) => ({ id: f.id, label: f.title }));
}

export function toVersionOptions(versions: ProductVersion[]): ItemSearchOption[] {
  return versions.map((v) => ({ id: v.id, label: v.versionName }));
}

export function toCustomerOptions(customers: Customer[]): ItemSearchOption[] {
  return customers.map((c) => ({ id: c.id, label: c.name, subLabel: c.company ?? undefined }));
}

/** 产品下拉展示名：去掉 PRD 编号前缀，只保留中文名称 */
export function productDisplayName(product: Pick<Product, 'name' | 'productNo'>): string {
  const { name, productNo } = product;
  if (!productNo) return name;
  for (const sep of [' · ', ' - ', '－', '-']) {
    const prefix = `${productNo}${sep}`;
    if (name.startsWith(prefix)) return name.slice(prefix.length).trim();
  }
  if (name.startsWith(productNo)) return name.slice(productNo.length).replace(/^[\s·\-－]+/, '').trim();
  return name;
}

export function toProductOptions(products: Product[]): ItemSearchOption[] {
  return products.map((p) => ({
    id: p.id,
    label: productDisplayName(p),
    searchExtra: p.productNo,
  }));
}

export function toReleaseOptions(releases: ProductRelease[]): ItemSearchOption[] {
  return releases.map((r) => ({ id: r.id, label: r.vCode, subLabel: r.planName }));
}
