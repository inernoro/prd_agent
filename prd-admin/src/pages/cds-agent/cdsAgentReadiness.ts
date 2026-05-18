export type ProviderEvidenceInput = {
  defaultProfileReady: boolean;
  officialLoopReady: boolean;
  hasReadonlyRunEvidence: boolean;
  hasApprovalEvidence: boolean;
  hasCancelEvidence: boolean;
};

export type ProviderEvidenceState = {
  eligible: boolean;
  blockedDetail: string;
  s1DetailOverride: string;
  s2DetailOverride: string;
  s3DetailOverride: string;
  s1EvidenceReady: boolean;
  s2EvidenceReady: boolean;
  s3EvidenceReady: boolean;
};

export type ExecutionRunwayInput = {
  commercialComplete: boolean;
  blockingCode: string;
  deploymentAdvice: string;
  nextCommand: string;
};

export type ExecutionRunwayState = {
  deployDecision: 'skip-deploy' | 'deploy-only-on-change' | 'diagnose-first';
  deployLabel: string;
  commandKind: 'none' | 'doctor' | 'profile-dry-run' | 'profile-repair' | 'provider-cycle' | 'local-guardrail';
  commandLabel: string;
  providerCallRisk: 'none' | 'requires-explicit-opt-in';
  providerCallLabel: string;
};

export function resolveProviderEvidenceState(input: ProviderEvidenceInput): ProviderEvidenceState {
  const eligible = input.defaultProfileReady && input.officialLoopReady;
  const blockedDetail = input.defaultProfileReady
    ? '等待官方 SDK 真实 run 产生证据；旧会话事件不能证明当前 provider gate。'
    : '等待 R1 默认 Claude profile 通过后再运行真实 provider smoke；旧会话事件不能证明当前 provider gate。';

  return {
    eligible,
    blockedDetail,
    s1DetailOverride: !eligible && input.hasReadonlyRunEvidence ? blockedDetail : '',
    s2DetailOverride: !eligible && input.hasApprovalEvidence ? blockedDetail : '',
    s3DetailOverride: !eligible && input.hasCancelEvidence ? blockedDetail : '',
    s1EvidenceReady: eligible && input.hasReadonlyRunEvidence,
    s2EvidenceReady: eligible && input.hasApprovalEvidence,
    s3EvidenceReady: eligible && input.hasCancelEvidence,
  };
}

export function resolveExecutionRunway(input: ExecutionRunwayInput): ExecutionRunwayState {
  const blockingCode = input.blockingCode.trim().toUpperCase();
  const nextCommand = input.nextCommand.trim();
  const deploymentAdvice = input.deploymentAdvice.trim();
  const providerCallRisk = nextCommand.includes('SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1')
    ? 'requires-explicit-opt-in'
    : 'none';

  let deployDecision: ExecutionRunwayState['deployDecision'] = 'diagnose-first';
  if (input.commercialComplete) {
    deployDecision = 'deploy-only-on-change';
  } else if (
    blockingCode === 'R1'
    || blockingCode.startsWith('S')
    || deploymentAdvice.includes('不要靠重新部署')
    || deploymentAdvice.includes('不要重复部署')
    || deploymentAdvice.includes('Do not redeploy')
  ) {
    deployDecision = 'skip-deploy';
  }

  let commandKind: ExecutionRunwayState['commandKind'] = 'none';
  if (nextCommand.includes('doctor-cds-agent-runtime.sh')) {
    commandKind = 'doctor';
  } else if (nextCommand.includes('smoke-cds-agent-r1-profile-repair.sh')) {
    commandKind = nextCommand.includes('SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=')
      ? 'profile-repair'
      : 'profile-dry-run';
  } else if (nextCommand.includes('smoke-cds-agent-one-cycle.sh')) {
    commandKind = 'provider-cycle';
  } else if (nextCommand) {
    commandKind = 'local-guardrail';
  }

  const deployLabel = deployDecision === 'skip-deploy'
    ? '不需要重新部署'
    : deployDecision === 'deploy-only-on-change'
      ? '仅代码/环境变更时部署'
      : '先诊断再决定';
  const commandLabel = commandKind === 'doctor'
    ? '只读 doctor'
    : commandKind === 'profile-dry-run'
      ? 'R1 dry-run'
      : commandKind === 'profile-repair'
        ? 'R1 test-before-promote'
        : commandKind === 'provider-cycle'
          ? '一个周期 provider smoke'
          : commandKind === 'local-guardrail'
            ? '本地守卫命令'
            : '暂无命令';
  const providerCallLabel = providerCallRisk === 'requires-explicit-opt-in'
    ? '显式 opt-in 后才调用 provider'
    : '不会触发真实 provider 调用';

  return {
    deployDecision,
    deployLabel,
    commandKind,
    commandLabel,
    providerCallRisk,
    providerCallLabel,
  };
}
