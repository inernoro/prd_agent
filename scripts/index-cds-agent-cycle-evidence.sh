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
  --argjson s "$(jq '.' "$summary")" \
  '{
    schemaVersion: "cds-agent-cycle-evidence-index/v1",
    generatedAt: $generatedAt,
    cycleDir: $cycleDir,
    summary: $summary,
    git: ($s.git // null),
    host: ($s.host // ""),
    status: ($s.status // "unknown"),
    commercialComplete: ($s.commercialComplete // false),
    blockingReason: ($s.blockingReason // ""),
    deploymentAdvice: ($s.deploymentAdvice // ""),
    nextCommand: ($s.nextCommand // ""),
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
  "- Host: `" + .host + "`\n" +
  "- Blocking gate: `" + (.executionPanel.currentBlockingGate // "unknown") + "`\n" +
  "- Blocking reason: " + (.blockingReason // "") + "\n" +
  "- Deploy/build advice: " + (.deploymentAdvice // "") + "\n" +
  "- Next command: `" + (.nextCommand // "") + "`\n\n" +
  "## Gates\n\n" +
  (["R0","A0","R1","S1","S2S3","V1","N6"] | map(gate_line(.)) | join("\n")) + "\n\n" +
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
