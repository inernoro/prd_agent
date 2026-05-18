import { describe, expect, it } from 'vitest';

import { resolveExecutionRunway, resolveProviderEvidenceState } from '../cdsAgentReadiness';

describe('CDS Agent provider readiness evidence', () => {
  it('does not let old session events pass S1/S2/S3 while R1 is blocked', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: false,
      officialLoopReady: true,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(false);
    expect(state.s1EvidenceReady).toBe(false);
    expect(state.s2EvidenceReady).toBe(false);
    expect(state.s3EvidenceReady).toBe(false);
    expect(state.blockedDetail).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s1DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s2DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s3DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
  });

  it('requires the official SDK loop before using page events as provider evidence', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: true,
      officialLoopReady: false,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(false);
    expect(state.s1EvidenceReady).toBe(false);
    expect(state.s2EvidenceReady).toBe(false);
    expect(state.s3EvidenceReady).toBe(false);
    expect(state.s1DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s2DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s3DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
  });

  it('allows S1/S2/S3 page evidence only after R1 and official loop are ready', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: true,
      officialLoopReady: true,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(true);
    expect(state.s1EvidenceReady).toBe(true);
    expect(state.s2EvidenceReady).toBe(true);
    expect(state.s3EvidenceReady).toBe(true);
    expect(state.s1DetailOverride).toBe('');
    expect(state.s2DetailOverride).toBe('');
    expect(state.s3DetailOverride).toBe('');
  });
});

describe('CDS Agent execution runway', () => {
  it('classifies R0 runtime pool evidence as no redeploy and no provider call', () => {
    const state = resolveExecutionRunway({
      commercialComplete: false,
      blockingCode: 'R0',
      deploymentAdvice: '不要靠普通 preview redeploy 解决 R0；先采集 runtime pool evidence。',
      nextCommand: 'CDS_HOST=https://cds.miduo.org CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC=1 bash scripts/collect-cds-agent-runtime-pool-evidence.sh',
    });

    expect(state.deployDecision).toBe('skip-deploy');
    expect(state.deployLabel).toBe('不需要重新部署');
    expect(state.commandKind).toBe('runtime-pool-evidence');
    expect(state.commandLabel).toBe('R0 证据采集');
    expect(state.providerCallRisk).toBe('none');
  });

  it('classifies R1 dry-run as no redeploy and no provider call', () => {
    const state = resolveExecutionRunway({
      commercialComplete: false,
      blockingCode: 'R1',
      deploymentAdvice: '不要靠重新部署解决 R1；当前阻塞是 CDS-managed runtime profile/secret。',
      nextCommand: 'CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-r1-profile-repair.sh',
    });

    expect(state.deployDecision).toBe('skip-deploy');
    expect(state.deployLabel).toBe('不需要重新部署');
    expect(state.commandKind).toBe('profile-dry-run');
    expect(state.commandLabel).toBe('R1 dry-run');
    expect(state.providerCallRisk).toBe('none');
    expect(state.providerCallLabel).toBe('不会触发真实 provider 调用');
  });

  it('classifies provider cycle as explicit provider opt-in', () => {
    const state = resolveExecutionRunway({
      commercialComplete: false,
      blockingCode: 'S1',
      deploymentAdvice: '不要重复部署；下一步是显式开启 provider smoke。',
      nextCommand: 'CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh',
    });

    expect(state.deployDecision).toBe('skip-deploy');
    expect(state.commandKind).toBe('provider-cycle');
    expect(state.commandLabel).toBe('一个周期 provider smoke');
    expect(state.providerCallRisk).toBe('requires-explicit-opt-in');
    expect(state.providerCallLabel).toBe('显式 opt-in 后才调用 provider');
  });

  it('keeps deploy available only for real changes after commercial completion', () => {
    const state = resolveExecutionRunway({
      commercialComplete: true,
      blockingCode: '',
      deploymentAdvice: '商业级门禁已通过；只有新代码变更、promotion 或环境切换时才需要重新部署。',
      nextCommand: '',
    });

    expect(state.deployDecision).toBe('deploy-only-on-change');
    expect(state.deployLabel).toBe('仅代码/环境变更时部署');
    expect(state.commandKind).toBe('none');
  });
});
