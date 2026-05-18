#!/usr/bin/env bash
# ============================================
# CDS Agent cycle evidence index
# ============================================
#
# Builds a small human/machine-readable index for a one-cycle evidence dir.
#
# Usage:
#   bash scripts/index-cds-agent-cycle-evidence.sh /tmp/cds-agent-cycle-.../cycle-summary.json
#
# Output:
#   <cycle-dir>/evidence-index.json
#   <cycle-dir>/evidence-index.md
# ============================================

set -euo pipefail

summary="${1:-${SMOKE_CDS_AGENT_CYCLE_SUMMARY:-}}"

find_latest_cycle_summary() {
  local latest search_roots
  search_roots=$(printf '%s\n/tmp\n/private/tmp\n' "${TMPDIR:-/tmp}" | awk '!seen[$0]++')
  latest=$(while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 2 -path '*/cds-agent-cycle-*/cycle-summary.json' -type f -print 2>/dev/null | while IFS= read -r file; do
      printf '%s\t%s\n' "$(stat -f '%m' "$file" 2>/dev/null || stat -c '%Y' "$file" 2>/dev/null || printf '0')" "$file"
    done || true
  done <<< "$search_roots" | sort -n | tail -n 1 | cut -f2- || true)
  [[ -n "$latest" ]] && printf '%s' "$latest"
  return 0
}

if [[ -z "$summary" ]]; then
  summary=$(find_latest_cycle_summary)
fi

if [[ -z "$summary" || ! -f "$summary" ]]; then
  printf 'cycle summary not found; pass /path/to/cycle-summary.json\n' >&2
  exit 2
fi

cycle_dir="$(cd "$(dirname "$summary")" && pwd)"
json_out="$cycle_dir/evidence-index.json"
md_out="$cycle_dir/evidence-index.md"
r1_report="$(jq -r '.r1.report // ""' "$summary")"
r1_details_json='null'
if [[ -n "$r1_report" && -f "$r1_report" ]]; then
  r1_details_json=$(jq -c '{
    status: (.status // "unknown"),
    targetTemplateId: (.targetTemplateId // ""),
    defaultProfile: (.evidence.defaultProfile // null),
    repairPlan: (.evidence.repairPlan // null),
    targetTemplate: (.evidence.targetTemplate // null),
    missingKeyGuard: (.evidence.missingKeyGuard // null),
    providerKeyReceived: (.evidence.providerKeyReceived // false)
  }' "$r1_report")
fi

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cycleDir "$cycle_dir" \
  --arg summary "$summary" \
  --arg doctorLog "$cycle_dir/doctor.log" \
  --arg r0RuntimeLog "$cycle_dir/r0-runtime.log" \
  --arg r0AliasLog "$cycle_dir/r0-sidecar-alias.log" \
  --arg templatesLog "$cycle_dir/t1-templates.log" \
  --arg a0Log "$cycle_dir/a0-official-sdk-boundary.log" \
  --arg r1Log "$cycle_dir/r1-repair.log" \
  --arg readinessLog "$cycle_dir/readiness.log" \
  --arg s1Log "$cycle_dir/s1-official-sdk-run.log" \
  --arg controlsLog "$cycle_dir/s2-s3-controls.log" \
  --arg visualLog "$cycle_dir/v1-visual.log" \
  --arg n6Log "$cycle_dir/n6-non-code-boundary.log" \
  --argjson r1Details "$r1_details_json" \
  --argjson s "$(jq '.' "$summary")" \
  '{
    schemaVersion: "cds-agent-cycle-evidence-index/v1",
    generatedAt: $generatedAt,
    cycleDir: $cycleDir,
    summary: $summary,
    git: ($s.git // null),
    remoteCdsBranch: ($s.remoteCdsBranch // null),
    host: ($s.host // ""),
    target: ($s.target // null),
    status: ($s.status // "unknown"),
    commercialComplete: ($s.commercialComplete // false),
    blockingReason: ($s.blockingReason // ""),
    deploymentAdvice: ($s.deploymentAdvice // ""),
    failure: ($s.failure // null),
    nextCommand: ($s.nextCommand // ""),
    providerPrerequisites: ($s.providerPrerequisites // {
      status: (if ($s.providerCallsEnabled // false) then "provider_requested_legacy_summary" else "readiness_only" end),
      advice: "",
      providerCallsRequested: ($s.providerCallsEnabled // false),
      r1RepairKeyProvided: ($s.r1RepairApply // false),
      canAttemptR1Repair: ($s.r1RepairApply // false),
      canCollectProviderSmokes: (($s.providerCallsEnabled // false) and ($s.r1RepairApply // false))
    }),
    providerReadiness: ($s.providerReadiness // {
      status: ($s.commercialGates.R1.status // "unknown"),
      reportStatus: ($r1Details.status // "unknown"),
      defaultProfile: ($r1Details.defaultProfile // null),
      compatibilityReasonCode: ($r1Details.defaultProfile.compatibilityReasonCode // null),
      compatibilityReason: ($r1Details.defaultProfile.compatibilityReason // $r1Details.defaultProfile.warning // null),
      compatibilityNextActions: ($r1Details.defaultProfile.compatibilityNextActions // []),
      targetTemplate: ($r1Details.targetTemplate // null),
      targetTemplateId: ($r1Details.targetTemplateId // "")
    }),
    r1Repair: {
      status: ($s.r1.status // $r1Details.status // "unknown"),
      report: ($s.r1.report // null),
      currentProfile: ($s.r1.details.defaultProfile // $r1Details.defaultProfile // null),
      repairPlan: ($s.r1.details.repairPlan // $r1Details.repairPlan // null),
      targetTemplate: ($s.r1.details.targetTemplate // $r1Details.targetTemplate // null),
      missingKeyGuard: ($s.r1.details.missingKeyGuard // $r1Details.missingKeyGuard // null),
      providerKeyReceived: ($s.r1.details.providerKeyReceived // $r1Details.providerKeyReceived // false),
      suggestedCommand: ($s.r1.details.suggestedCommand // $s.r1.suggestedCommand // $s.nextCommand // "")
    },
    executionPanel: ($s.executionPanel // null),
    gates: ($s.commercialGates // {}),
    gatesNotPass: ($s.commercialGatesNotPass // []),
    timing: {
      totalSeconds: ($s.timing.totalSeconds // 0),
      slowest: ($s.timing.slowest // []),
      steps: ($s.timing.steps // [])
    },
    reports: {
      doctor: ($s.doctor.report // null),
      readiness: ($s.readiness.report // null),
      r1: ($s.r1.report // null),
      s1: ($s.s1.report // null),
      controls: ($s.controls.report // null),
      officialSdkBoundary: ($s.officialSdkBoundary.report // null),
      screenshot: ($s.visual.screenshot // null)
    },
    logs: {
      doctor: $doctorLog,
      r0Runtime: $r0RuntimeLog,
      r0SidecarAlias: $r0AliasLog,
      templates: $templatesLog,
      a0OfficialSdkBoundary: $a0Log,
      r1Repair: $r1Log,
      readiness: $readinessLog,
      s1OfficialSdkRun: $s1Log,
      s2s3Controls: $controlsLog,
      v1Visual: $visualLog,
      n6NonCodeBoundary: $n6Log
    }
  }' > "$json_out"

jq -r \
  --arg jsonOut "$json_out" \
  --arg mdOut "$md_out" \
  '
  . as $root |
  def gate_line($key):
    "- " + $key + ": " + ($root.gates[$key].status // "unknown") + " — " + ($root.gates[$key].evidence // "");

  "# CDS Agent Cycle Evidence\n\n" +
  "- Summary: `" + .summary + "`\n" +
  "- JSON index: `" + $jsonOut + "`\n" +
  "- Status: `" + .status + "`\n" +
  "- Commercial complete: `" + (.commercialComplete|tostring) + "`\n" +
  "- Git: `" + ((.git.branch // "unknown") + "@" + (.git.commitShort // "unknown")) + "`\n" +
  (if (.remoteCdsBranch.observed // false) then
    "- Remote CDS branch: `" + (.remoteCdsBranch.branchId // "unknown") + "` status=`" + (.remoteCdsBranch.status // "unknown") + "` github=`" + (.remoteCdsBranch.githubCommitSha // "unknown") + "` runtime=`" + (.remoteCdsBranch.runtimeCommitSha // "unknown") + "` deployCount=`" + ((.remoteCdsBranch.deployCount // "unknown")|tostring) + "`\n" +
    "- Remote runtime relation: `" + (.remoteCdsBranch.runtimeRelation // "unknown") + "`\n" +
    "- Remote deploy advice: " + (.remoteCdsBranch.deployAdvice // "") + "\n"
  else
    "- Remote CDS branch: `not observed`\n"
  end) +
  "- Host: `" + .host + "`" + (if (.target.source // "") != "" then " (`" + (.target.source // "") + "`)" else "" end) + "\n" +
  "- Provider prerequisites: `" + (.providerPrerequisites.status // "unknown") + "` providerCallsRequested=`" + ((.providerPrerequisites.providerCallsRequested // false)|tostring) + "` r1RepairKeyProvided=`" + ((.providerPrerequisites.r1RepairKeyProvided // false)|tostring) + "` canCollectProviderSmokes=`" + ((.providerPrerequisites.canCollectProviderSmokes // false)|tostring) + "`\n" +
  (if (.providerPrerequisites.advice // "") != "" then "- Provider prerequisite advice: " + (.providerPrerequisites.advice // "") + "\n" else "" end) +
  "- Blocking gate: `" + (.executionPanel.currentBlockingGate // "unknown") + "`\n" +
  "- Blocking reason: " + (.blockingReason // "") + "\n" +
  (if (.providerReadiness.compatibilityReasonCode // "") != "" then "- R1 reason: `" + (.providerReadiness.compatibilityReasonCode // "") + "` — " + (.providerReadiness.compatibilityReason // "") + "\n" else "" end) +
  "- R1 current profile: `" + ((.r1Repair.currentProfile.name // "unknown") + " / " + (.r1Repair.currentProfile.protocol // "unknown") + " / " + (.r1Repair.currentProfile.model // "unknown")) + "` compatible=`" + (if (.r1Repair.currentProfile | has("compatibleWithDesiredRuntimeAdapter")) then (.r1Repair.currentProfile.compatibleWithDesiredRuntimeAdapter|tostring) else "unknown" end) + "` hasKey=`" + (if (.r1Repair.currentProfile | has("hasApiKey")) then (.r1Repair.currentProfile.hasApiKey|tostring) else "unknown" end) + "`\n" +
  "- R1 target template: `" + ((.r1Repair.repairPlan.targetTemplateId // .r1Repair.targetTemplate.id // "unknown") + " / " + (.r1Repair.repairPlan.targetProtocol // .r1Repair.targetTemplate.protocol // "unknown") + " / " + (.r1Repair.repairPlan.targetModel // .r1Repair.targetTemplate.model // "unknown")) + "`\n" +
  (if (.r1Repair.missingKeyGuard.errorCode // "") != "" then "- R1 missing-key guard: `" + (.r1Repair.missingKeyGuard.errorCode // "") + "`\n" else "" end) +
  (if (.failure.kind // "none") != "none" then "- Failure kind: `" + (.failure.kind // "unknown") + "`\n" else "" end) +
  (if (.failure.advice // "") != "" then "- Failure advice: " + (.failure.advice // "") + "\n" else "" end) +
  "- Deploy/build advice: " + (.deploymentAdvice // "") + "\n" +
  "- Next command: `" + (.nextCommand // "") + "`\n\n" +
  "## Gates\n\n" +
  (["R0","A0","R1","S1","S2S3","V1","N6"] | map(gate_line(.)) | join("\n")) + "\n\n" +
  "## R1 Repair Path\n\n" +
  "- Current profile: `" + ((.r1Repair.currentProfile.name // "unknown") + " / " + (.r1Repair.currentProfile.protocol // "unknown") + " / " + (.r1Repair.currentProfile.model // "unknown")) + "`\n" +
  "- Target template: `" + ((.r1Repair.repairPlan.targetTemplateId // .r1Repair.targetTemplate.id // "unknown") + "` (`" + (.r1Repair.repairPlan.targetProtocol // .r1Repair.targetTemplate.protocol // "unknown") + "`, `" + (.r1Repair.repairPlan.targetModel // .r1Repair.targetTemplate.model // "unknown") + "`)") + "\n" +
  "- Missing-key guard: `" + (.r1Repair.missingKeyGuard.errorCode // "unknown") + "`\n" +
  "- Provider key received: `" + ((.r1Repair.providerKeyReceived // false)|tostring) + "`\n" +
  "- Test-before-promote: backend creates a candidate Anthropic profile, tests upstream, then promotes only on success.\n" +
  "- Rerun command: `" + (.r1Repair.suggestedCommand // .nextCommand // "") + "`\n\n" +
  "## Slowest Steps\n\n" +
  ((.timing.slowest // []) | map("- [" + (.phase // "") + "] " + (.name // "") + " — " + ((.durationSeconds // 0)|tostring) + "s — " + (.status // "")) | join("\n")) + "\n\n" +
  "## Key Artifacts\n\n" +
  "- Workbench screenshot: `" + (.reports.screenshot // "") + "`\n" +
  "- R1 report: `" + (.reports.r1 // "") + "`\n" +
  "- S1 report: `" + (.reports.s1 // "") + "`\n" +
  "- Controls report: `" + (.reports.controls // "") + "`\n" +
  "- Official SDK boundary report: `" + (.reports.officialSdkBoundary // "") + "`\n" +
  "- Readiness report: `" + (.reports.readiness // "") + "`\n" +
  "- Doctor report: `" + (.reports.doctor // "") + "`\n"
  ' "$json_out" > "$md_out"

printf 'Evidence index JSON: %s\n' "$json_out"
printf 'Evidence index MD: %s\n' "$md_out"
