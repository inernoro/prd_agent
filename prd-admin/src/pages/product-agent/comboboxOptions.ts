import type { Customer, Feature, Product, ProductVersion, Requirement } from './types';
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

export function toProductOptions(products: Product[]): ItemSearchOption[] {
  return products.map((p) => ({ id: p.id, label: p.name, subLabel: p.productNo }));
}
