# Scenario Matrix

Use this reference to classify acceptance tasks and prevent scope loss.

## daily-yesterday

Use when the user says "每日验收", "昨天验收", "昨天做完的所有内容", or asks whether yesterday's code entered the knowledge base.

Required behavior:
- Resolve the exact target date in Asia/Shanghai.
- Collect PRs, commits, branches, and unpublished environments tied to that date.
- Group work by feature module, not only by file path.
- Start the report with `昨日工作总结`.
- Include `PR/commit 到结果映射` before page-by-page evidence.
- Include items that cannot be visually tested, but label them as file, API, docs, rules, or environment evidence.
- Mark missing coverage as a report defect.

Failure examples:
- A commit changed a rule or backend endpoint but the report only shows UI screenshots.
- A screenshot shows a page, but no row maps it back to the PR or commit that required the test.
- A branch is reachable, but the feature itself was not exercised.

## pull-request

Use when the user provides a PR number or asks for PR results to match the report.

Required behavior:
- Read the PR diff and commit list.
- Extract user-facing claims from code, PR title/body, and changed routes.
- For each claim, produce one or more test units.
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
