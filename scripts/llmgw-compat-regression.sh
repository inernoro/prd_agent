#!/usr/bin/env bash
# Simulation only. Real-provider execution is always a separate explicit command/job.
set -euo pipefail
cd "$(dirname "$0")/.."
report_dir="${1:?usage: bash scripts/llmgw-compat-regression.sh REPORT_DIR}"
mkdir -p "$report_dir"
report_dir="$(realpath "$report_dir")"
export LLMGW_COMPAT_CAPTURE_DIR="$report_dir/captures"
# A fresh directory prevents a missing/failed test from reusing a previous capture.
if [[ -e "$LLMGW_COMPAT_CAPTURE_DIR" ]]; then
  echo 'Choose a fresh report directory; stale captures are not allowed.' >&2
  exit 1
fi
mkdir -p "$LLMGW_COMPAT_CAPTURE_DIR"
filter='FullyQualifiedName~ProtocolCompatibilityReplayTests|FullyQualifiedName~GatewayProtocolFidelityTests|FullyQualifiedName~ThinkingProtocolContractTests|FullyQualifiedName~ClaudeToolTranslationTests|FullyQualifiedName~ReasoningChatBudgetCompatibilityTests|FullyQualifiedName~NativeResponses_TwoToolRoundsPreserveRawStreamAndTrustedAttribution|FullyQualifiedName~NativeResponses_StoredContextIsRejectedBeforeResolution|FullyQualifiedName~NativeResponses_UnverifiedToolsFailClosedWithoutSending|FullyQualifiedName~NativeResponses_Gpt56NativeToolsAndReasoningRemainNative|FullyQualifiedName~NativeResponses_FailedOrTruncatedUpstreamNeverLogsSuccess|FullyQualifiedName~NativeResponses_NonStreamingTerminalFailureNeverReachesTheClientAsSuccess|FullyQualifiedName~OpenAiResponsesCompatibleEndpoint_|FullyQualifiedName~LlmGatewayTests'
dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-build \
  -c "${CONFIGURATION:-Debug}" --filter "($filter)&Category!=Integration&Category!=Manual" \
  --logger 'trx;LogFileName=protocol-simulation.trx' --results-directory "$report_dir"
python3 scripts/llmgw-compat-regression.py --mode simulation \
  --captures "$LLMGW_COMPAT_CAPTURE_DIR" --expected-commit "$(git rev-parse HEAD)" \
  --output "$report_dir/simulation.json"
python3 scripts/tests/llmgw-compat-regression.test.py
