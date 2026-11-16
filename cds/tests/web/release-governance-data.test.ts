import { describe, expect, it } from 'vitest';
import { readGovernanceView, releaseGovernanceFailure } from '../../web/src/pages/release-center/ReleaseGovernancePanel.js';
import { ApiError } from '../../web/src/lib/api.js';

describe('发布治理响应边界', () => {
  it('空的真实账本可正常展示，缺失或损坏响应不能进入渲染状态', () => {
    const empty = { authorizations: [], attempts: [], mergeBacks: [], checks: [] };
    expect(readGovernanceView(empty)).toBe(empty);
    for (const value of [null, {}, { authorizations: [] }, { ...empty, attempts: null }, { ...empty, checks: {} }]) {
      expect(() => readGovernanceView(value)).toThrow('响应不完整');
    }
  });
  it('预期拒绝只展示治理原因和恢复动作，保留诊断信息给日志', () => {
    const error = new ApiError(409, { code: 'release_governance_rejected', message: '存在真实合并冲突：allowed/app.txt' },
      'POST /api/private 失败 HTTP 409 requestId=private');
    expect(releaseGovernanceFailure(error)).toBe('存在真实合并冲突：allowed/app.txt。请核对申请条件后重试');
    expect(releaseGovernanceFailure(error)).not.toMatch(/POST|\/api\/|HTTP|requestId/);
  });
  it('未知响应与认证异常有可恢复提示，不透传上游诊断', () => {
    for (const error of [new Error('secret'), new ApiError(503, { message: 'PRIVATE_KEY /root/private' }, 'secret')]) {
      expect(releaseGovernanceFailure(error)).toContain('重试');
      expect(releaseGovernanceFailure(error)).not.toMatch(/secret|PRIVATE_KEY|\/root/);
    }
    expect(releaseGovernanceFailure(new ApiError(401, null, 'raw'))).toContain('重新登录');
    expect(releaseGovernanceFailure(new ApiError(403, null, 'raw'))).toContain('有权访问');
  });
});
