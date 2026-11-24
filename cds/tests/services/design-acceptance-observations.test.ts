import { describe, expect, it } from 'vitest';
import { observeDesignRules } from '../../src/services/design-acceptance-observations.js';
import type { DesignRule } from '../../src/shared/design-workspace.js';

const phoneLayout: Parameters<typeof observeDesignRules>[1] = {
  layers: [], headerAlignment: null, width: 375, content: 375, vertical: 1, clippedControls: 0, textControls: 5,
  height: 812, scrollHeight: 812, raw: 0, frame: null, title: null, currentStep: false, stepNumber: 0,
  causes: [], hero: false, methods: 0, compare: [], feedback: [], columns: 1, frameworkColumns: 1, clippedCards: 0,
};
const library: DesignRule = {
  id: 'A-46', rule: '手机设计库使用两列稿件', expected: '框架单列，稿件两列。检查：docOverflow ≤ 0、overflowCount = 0',
  how: 'measure', priority: 'high', screenId: 'design-m', slots: ['phone-light'],
  probe: { type: 'horizontal-overflow', tolerance: 0 },
};

describe('program verification of declared layout rules', () => {
  it('detects a one-column library even when the document fits', () => {
    expect(observeDesignRules([library], phoneLayout)['A-46'].status).toBe('failed');
    expect(observeDesignRules([library], { ...phoneLayout, columns: 2 })['A-46'].status).toBe('unverified');
  });

  it('does not pass a compound rule based on document width alone', () => {
    const rule = { ...library, id: 'A-13', screenId: 'dsn-delivery-m' };
    expect(observeDesignRules([rule], phoneLayout)['A-13'].status).toBe('unverified');
    expect(observeDesignRules([rule], { ...phoneLayout, content: 385 })['A-13'].status).toBe('failed');
  });

  it('passes a rule that declares document width as its whole check', () => {
    const rule = { ...library, id: 'A-1', expected: '文档内容宽不能超过视口宽。' };
    expect(observeDesignRules([rule], phoneLayout)['A-1'].status).toBe('passed');
  });
});
