import { describe, expect, it } from 'vitest';
import {
  extractProductLabelFromFields,
  matchProductByLabel,
  resolveImportProductId,
  resolveProductLabelFromVersionRow,
} from './productImportRouting';
import type { Product } from './types';

const products: Product[] = [
  {
    id: 'p1', name: '互动营销', productNo: '1001', grade: 'normal', ownerId: '', memberIds: [], adminIds: [], ownerIds: [],
    formData: {}, versionCount: 0, requirementCount: 0, featureCount: 0, defectCount: 0, createdAt: '', updatedAt: '',
  },
  {
    id: 'p2', name: 'DCRM', productNo: '1002', grade: 'normal', ownerId: '', memberIds: [], adminIds: [], ownerIds: [],
    formData: {}, versionCount: 0, requirementCount: 0, featureCount: 0, defectCount: 0, createdAt: '', updatedAt: '',
  },
];

describe('productImportRouting', () => {
  it('maps 应用 field to product label', () => {
    expect(extractProductLabelFromFields({ 应用: '互动营销', 系统: '大数据引擎系统' })).toBe('互动营销');
  });

  it('prefers appName on version workflow rows', () => {
    expect(resolveProductLabelFromVersionRow('互动营销', '大数据引擎系统', { 产品: '互动营销' })).toBe('互动营销');
  });

  it('matches product by 应用 name', () => {
    expect(matchProductByLabel(products, '互动营销')?.id).toBe('p1');
    expect(matchProductByLabel(products, 'dcrm')?.id).toBe('p2');
  });

  it('falls back when 应用 does not match any product', () => {
    const resolved = resolveImportProductId(products, {
      appName: '不存在的产品',
      fallbackProductId: 'fallback',
    });
    expect(resolved.matched).toBe(false);
    expect(resolved.productId).toBe('fallback');
    expect(resolved.label).toBe('不存在的产品');
  });
});
