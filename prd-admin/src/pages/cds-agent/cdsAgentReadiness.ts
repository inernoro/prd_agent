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
