import { describe, expect, it } from 'vitest';
import {
  AGENT_PREBUILT_POLICY_OPTIONS,
  resolveAgentPrebuiltPolicy,
} from '../../web/src/pages/ProjectSettingsPage.js';

describe('项目设置 Agent 部署策略', () => {
  it('展示完整三档策略，优先极速版位于第一项', () => {
    expect(AGENT_PREBUILT_POLICY_OPTIONS.map((option) => option.value)).toEqual([
      'prefer-prebuilt',
      'prebuilt-only',
      'unrestricted',
    ]);
  });

  it('新字段优先，旧布尔字段保持兼容', () => {
    expect(resolveAgentPrebuiltPolicy({ agentPrebuiltOnly: true })).toBe('prebuilt-only');
    expect(resolveAgentPrebuiltPolicy({ agentPrebuiltOnly: false })).toBe('unrestricted');
    expect(resolveAgentPrebuiltPolicy({ agentPrebuiltPolicy: 'prefer-prebuilt', agentPrebuiltOnly: true }))
      .toBe('prefer-prebuilt');
  });
});
