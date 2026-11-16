import { describe, expect, it } from 'vitest';
import { readGovernanceView } from '../../web/src/pages/release-center/ReleaseGovernancePanel.js';

describe('发布治理响应边界', () => {
  it('空的真实账本可正常展示，缺失或损坏响应不能进入渲染状态', () => {
    const empty = { authorizations: [], attempts: [], mergeBacks: [], checks: [] };
    expect(readGovernanceView(empty)).toBe(empty);
    for (const value of [null, {}, { authorizations: [] }, { ...empty, attempts: null }, { ...empty, checks: {} }]) {
      expect(() => readGovernanceView(value)).toThrow('响应不完整');
    }
  });
});
