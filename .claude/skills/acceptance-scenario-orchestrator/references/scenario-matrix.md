# Scenario Matrix

Use this reference to classify acceptance tasks and prevent scope loss.

## daily-yesterday

Use when the user says "每日验收", "昨天验收", "昨天做完的所有内容", or asks whether yesterday's code entered the knowledge base.

Required behavior:
- Resolve the exact target date in Asia/Shanghai.
- Collect PRs, commits, branches, and unpublished environments tied to that date.
- Group work by feature module, not only by file path.
- Extract a `change assertion` from each PR/commit before selecting evidence. The test target must be the changed behavior, not a nearby page in the same module.
- For each assertion, choose the user-visible page or state first. If a change has no user-visible surface, classify it as `内部能力` and explain why internal evidence is acceptable.
- Include a `改动断言到证据表` that lists changed files, asserted behavior, required proof, actual proof, and relevance verdict (`相关`, `弱相关`, `无关`, `未覆盖`).
- Include `页面优先证据分层`: page evidence first, then interaction/API/log/state evidence. Internal data may explain a result, but it must not hide the missing user-facing proof.
- Compute and report a depth budget before testing: commit count, PR count, module count, high-risk module count, planned evidence count, actual evidence count, and selected depth label (`广度冒烟`, `深度验收`, or `发布前阻断验收`).
- Start the report with `昨日工作总结`.
- Include `PR/commit 到结果映射` before page-by-page evidence.
- Include items that cannot be visually tested, but label them as file, API, docs, rules, or environment evidence.
- Mark missing coverage as a report defect.
- For `深度验收`, plan at least 12 screenshots and at least two evidence points for each high-risk runtime module. Fewer screenshots may be valid only when the report explicitly says `广度冒烟`.
- High-risk runtime modules include auth boundaries, async workers, upload/compression, external downloads, deploy/preview/canary, state transitions, and data restore/version rollback.

Failure examples:
- A commit changed a rule or backend endpoint but the report only shows UI screenshots.
- A screenshot shows a page, but no row maps it back to the PR or commit that required the test.
- A branch is reachable, but the feature itself was not exercised.
- A report says `深度验收` for a day with many PRs/commits but only captures a handful of entry pages.
- A high-risk module is marked passed without an action/result pair or negative-path/API proof.
- A knowledge-base sync change is marked passed because the knowledge-base list page loaded.
- An upload/compression change is marked passed because the visual workbench loaded, without uploading or inspecting the compressed result.
- A report leads with API/log/database evidence for a user-facing change, leaving the reviewer unable to see where the issue appears on the product page.

## pull-request

Use when the user provides a PR number or asks for PR results to match the report.

Required behavior:
- Read the PR diff and commit list.
- Extract user-facing claims from code, PR title/body, and changed routes.
- For each claim, produce one or more test units.
- Reject evidence that is only module-adjacent. The proof must touch the changed path or its output state.
- Prefer page-result evidence for user-facing PRs. API/log evidence should confirm the page result or diagnose a failure, not replace the page result.
- If a claim cannot be tested in the current environment, mark it `未覆盖` with reason and next action.

Pass condition:
- Every PR claim is either passed with evidence, failed with evidence, or explicitly marked untestable with a concrete blocker.

## commit-range

Use when the user specifies one commit, a commit range, or says "commit 的结果也要和结果对上".

Required behavior:
- Build a commit-to-result matrix.
- Merge commits that are part of the same feature, but keep each commit visible.
- Confirm whether the tested environment actually contains the target commit.
- If the preview environment is on a different SHA, mark environment drift and do not pretend the commit was tested.

## unpublished-branch

Use when the user mentions "未发布", "分支", "灰度", "预览", or the target branch is not main.

Required behavior:
- Record branch name, preview URL, container status, and commit SHA.
- Distinguish branch health from feature acceptance.
- If deploy or startup is flaky, retry once when reasonable and record both attempts.
- If the branch cannot start, produce a failure report rather than skipping the branch.

Pass condition:
- The feature works on the target branch, not merely on main or another preview host.

## defect-retest

Use when the target is a known failure, bug fix, or user complaint.

Required behavior:
- Restate the original failure in observable terms.
- Test the failure path first, then the expected fixed path.
- Keep screenshots of failures even when a retry later passes.
- Report severity using the same labels as the acceptance report.

## visual-regression

Use when the user focuses on layout, visual drift, blank regions, screenshot correctness, or "看着像不代表对".

Required behavior:
- Prefer semantic screenshot inspection before pixel diff.
- Check for blank bodies, loading placeholders, wrong viewport, clipped content, overlays, theme issues, and text overflow.
- Use baseline/diff only when a meaningful baseline exists.
- Mark screenshot problems separately from product defects.

## release-preflight

Use before publishing, merging, or promoting a release.

Required behavior:
- Start from risk and changed surface area.
- Include smoke tests for critical pages and APIs.
- Block release on P0 defects, missing evidence for critical user paths, or environment drift on the target SHA.
- Keep known non-blocking issues visible as P1/P2/P3 with owner or next action.
