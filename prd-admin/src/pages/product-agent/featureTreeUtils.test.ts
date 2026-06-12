import { describe, expect, it } from 'vitest';
import type { Feature } from './types';
import {
  buildFeatureTree,
  collectDescendantIds,
  collectSubtreeIds,
  featurePathLabel,
  normalizeFeaturePath,
} from './featureTreeUtils';

function feat(id: string, title: string, parentId?: string): Feature {
  return {
    id,
    productId: 'p1',
    featureNo: `FEA-${id}`,
    title,
    parentId,
    ownerId: 'u1',
    grade: 'p2',
    featureType: 'basic',
    moduleName: '',
    requirementIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as Feature;
}

describe('normalizeFeaturePath', () => {
  it('normalizes separators', () => {
    expect(normalizeFeaturePath('营销\\优惠券 > 满减')).toBe('营销/优惠券/满减');
  });
});

describe('buildFeatureTree', () => {
  it('builds nested tree from parentId', () => {
    const features = [
      feat('a', '营销活动'),
      feat('b', '优惠券', 'a'),
      feat('c', '满减', 'b'),
    ];
    const tree = buildFeatureTree(features);
    expect(tree).toHaveLength(1);
    expect(tree[0].feature.id).toBe('a');
    expect(tree[0].children[0].feature.id).toBe('b');
    expect(tree[0].children[0].children[0].feature.id).toBe('c');
  });
});

describe('collectSubtreeIds', () => {
  it('includes self and all descendants', () => {
    const features = [
      feat('a', '根'),
      feat('b', '子', 'a'),
      feat('c', '孙', 'b'),
      feat('x', '其他'),
    ];
    const ids = collectSubtreeIds(features, 'a');
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns all when root is null', () => {
    const features = [feat('a', 'A'), feat('b', 'B')];
    expect(collectSubtreeIds(features, null).size).toBe(2);
  });
});

describe('collectDescendantIds', () => {
  it('excludes self', () => {
    const features = [feat('a', '根'), feat('b', '子', 'a')];
    expect(collectDescendantIds(features, 'a')).toEqual(new Set(['b']));
  });
});

describe('featurePathLabel', () => {
  it('joins ancestor titles', () => {
    const features = [
      feat('a', '营销活动'),
      feat('b', '优惠券', 'a'),
    ];
    expect(featurePathLabel(features, 'b')).toBe('营销活动 / 优惠券');
  });
});
