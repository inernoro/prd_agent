import { describe, expect, it } from 'vitest';
import { REQUIREMENT_PRODUCT_DEFECT_FORM_KEY } from './productDefectLinkageCatalog';
import source from './RequirementCreateForm.tsx?raw';

describe('RequirementCreateForm', () => {
  it('does not expose product-defect checkbox on create', () => {
    expect(source).toContain(REQUIREMENT_PRODUCT_DEFECT_FORM_KEY);
    expect(source).toContain('createFormData');
    expect(source).not.toMatch(/type="checkbox"[\s\S]*产品缺陷/);
  });
});
