import { describe, expect, it } from 'vitest';
import { applyRequirementAiFill } from './requirementAiFillApply';
import type { Customer, Feature, FormField, Requirement } from './types';

const customers: Customer[] = [
  {
    id: 'c1', name: '米多科技', company: null, contact: null, description: null,
    tags: [], formData: {}, ownerId: 'u1', createdAt: '', updatedAt: '',
  },
];

const requirements: Requirement[] = [
  {
    id: 'r1', productId: 'p1', requirementNo: 'R-001', title: '会员积分体系', grade: 'p2',
    customerIds: [], versionIds: [], formData: {}, ownerId: 'u1', createdAt: '', updatedAt: '',
  },
];

const features: Feature[] = [
  {
    id: 'f1', productId: 'p1', featureNo: 'F-001', title: '营销活动配置', grade: 'p2',
    requirementIds: [], moduleName: '营销活动', featureType: 'basic', mainRequirementId: 'r1',
    plannedVersionId: 'v1', keyRules: '', acceptanceCriteria: '', formData: {}, ownerId: 'u1',
    createdAt: '', updatedAt: '',
  },
];

const templateFields: FormField[] = [
  { key: 'relatedFeature', label: '关联功能', type: 'relation', relationEntityType: 'feature', required: false, sortOrder: 0 },
];

describe('applyRequirementAiFill', () => {
  it('maps requirement origin and customer names', () => {
    const out = applyRequirementAiFill({
      result: {
        title: '优化积分规则',
        requirementOrigin: '客户反馈',
        formData: { 客户名称: '米多科技' },
      },
      customers,
      requirements,
      features,
      templateFields,
    });
    expect(out.requirementOrigin).toBe('客户反馈');
    expect(out.customerIds).toEqual(['c1']);
    expect(out.formData['需求来源']).toBe('客户反馈');
  });

  it('resolves parent requirement and related features from titles', () => {
    const out = applyRequirementAiFill({
      result: {
        formData: {
          父需求: '会员积分',
          关联功能: '营销活动',
        },
      },
      customers,
      requirements,
      features,
      templateFields,
    });
    expect(out.parentId).toBe('r1');
    expect(out.formData.relatedFeature).toBe('f1');
  });
});
