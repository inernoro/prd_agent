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

  it('关联功能为空仍可通过（新建时非必填）', () => {
    expect(validateRequirementCreateInput({
      ...base,
      templateFields: [{ key: 'relatedFeature', label: '关联功能', type: 'relation', required: true, sortOrder: 0 }],
      formData: {},
    })).toBeNull();
  });

  it('全部合法返回 null', () => {
    expect(validateRequirementCreateInput(base)).toBeNull();
  });

  it('客户反馈未选客户报错', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '客户反馈',
      customerIds: [],
    })).toBe('请选择客户名称');
  });

  it('客户反馈已选客户通过', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '客户反馈',
      customerIds: ['c1'],
    })).toBeNull();
  });

  it('内部规划未填规划名称报错', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '内部规划',
      formData: {},
    })).toBe('请填写规划名称');
  });

  it('运营活动需填活动名称', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '运营活动',
      formData: { 活动名称: '618 大促' },
    })).toBeNull();
  });

  it('竞品调研需填竞品名称', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '竞品调研',
      formData: {},
    })).toBe('请填写竞品名称');
  });

  it('其他来源不要求客户或补充字段', () => {
    expect(validateRequirementCreateInput({
      ...base,
      requirementOrigin: '其他',
      customerIds: [],
    })).toBeNull();
  });
});
