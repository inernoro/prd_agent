import { describe, expect, it } from 'vitest';
import { validateRequirementCreateInput } from './requirementCreateValidation';

const base = {
  title: '测试需求',
  description: '<p>描述内容</p>',
  assigneeId: 'u1',
  templateFields: [],
  formData: {},
};

describe('validateRequirementCreateInput', () => {
  it('空标题报错', () => {
    expect(validateRequirementCreateInput({ ...base, title: '  ' })).toBe('请填写需求标题');
  });

  it('空描述报错', () => {
    expect(validateRequirementCreateInput({ ...base, description: '<p>&nbsp;</p>' })).toBe('请填写需求描述');
  });

  it('未选处理人报错', () => {
    expect(validateRequirementCreateInput({ ...base, assigneeId: '' })).toBe('请选择处理人');
  });

  it('必填自定义字段缺失报错', () => {
    expect(validateRequirementCreateInput({
      ...base,
      templateFields: [{ key: 'biz', label: '业务线', type: 'text', required: true, sortOrder: 0 }],
      formData: {},
    })).toBe('请填写业务线');
  });

  it('全部合法返回 null', () => {
    expect(validateRequirementCreateInput(base)).toBeNull();
  });
});
