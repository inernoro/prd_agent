---
name: acceptance-test-design
description: Convert PRs, commits, yesterday's changes, or release scope into a test-minded acceptance design before visual execution. Use when the user asks for daily acceptance, visual acceptance, PR/commit acceptance, proof that code changes really affected product behavior, coverage planning, fusion testing, evidence strength, or when screenshots/reports looked related but failed to prove the assigned task.
---

# Acceptance Test Design

## Purpose

Use this skill before visual acceptance or MAP report archiving when the hard part is deciding what to test. It turns raw code changes into risk hypotheses, user-visible impact, fusion test scenarios, and evidence requirements.

This skill does not take screenshots and does not archive reports. Its output is an acceptance test design brief that downstream skills, especially `acceptance-scenario-orchestrator` and `create-visual-test-to-kb`, must follow.

## Core Rule

Do not start from pages. Start from changed behavior.

The working chain is:

`PR/commit -> behavior assertion -> affected user/data/state surfaces -> risk hypothesis -> proof strategy -> fusion scenario -> evidence requirement -> visual execution`

If this chain is weak, stop and produce a design-risk report. Do not compensate by taking more screenshots.

## Workflow

1. Freeze the target.
   - Resolve the exact date, branch, commit range, PRs, preview URL, and tested SHA.
   - If the user says "yesterday", resolve it in the user's timezone and write the absolute date.
   - Collect commits and diffs before choosing pages.

2. Extract behavior assertions.
   - Convert each commit/PR into the behavior it claims to change.
   - Group mechanical commits into one feature assertion, but keep the source commits visible.
   - Mark assertions as `user-facing`, `workflow`, `state/data`, `auth/security`, `async/background`, `environment`, `docs/rules`, or `internal-only`.

3. Build the impact model.
   - Identify who can notice the change and where: page, breadcrumb, entry, status, result row, detail panel, error text, toast, permission state, sync log, or absence of a forbidden action.
   - Trace likely affected areas: upstream inputs, downstream outputs, persisted state, background jobs, permissions, integration boundaries, rollback/restore, and existing user workflows.
   - Mark hidden influence clearly. If users cannot see it directly, describe the expected visible consequence or classify it as internal-only.

4. Design proof, not screenshots.
   - Read `references/proof-strength.md`.
   - For each assertion, write the strongest practical proof: page result first, interaction path second, internal corroboration third.
   - Reject weak proof such as a nearby page, entry page, generic API 200, or screenshot that only proves the module loaded.

5. Design fusion tests.
   - Read `references/fusion-testing.md`.
   - Prefer scenarios that cover multiple assertions through one realistic user journey.
   - Do not stop at 10 screenshots by habit. The screenshot budget follows risk and proof coverage.
   - If a small number of images is enough, explain why each image has high proof density.

6. Produce the design brief.
   - Read `references/output-contract.md`.
   - Output the required tables before any visual execution:
     - `昨日/范围总结`
     - `改动断言表`
     - `影响面矩阵`
     - `融合测试设计`
     - `证明力矩阵`
     - `覆盖缺口与不可测项`
     - `交给视觉验收的执行清单`

7. Hand off to visual execution.
   - Pass the design brief into `acceptance-scenario-orchestrator`.
   - The visual report must map screenshots back to the design brief.
   - If execution cannot capture the planned proof, downgrade the verdict or mark coverage missing. Do not silently replace it with weaker evidence.

## Hard Rules

- No screenshot-first testing. A screenshot taken before a behavior assertion and proof target exists is not acceptance evidence.
- No API-first pass for user-facing changes. Internal evidence can explain or corroborate; it cannot replace page proof.
- No nearby-page substitution. Same module does not mean same behavior.
- No fixed 10-image brake. Evidence count is driven by risk, impact, and fusion coverage.
- No pass without falsifiability. Every planned proof must say what would make it fail.
- No disappearing commits. Each commit is passed, failed, fused into a higher-level scenario, marked non-runtime, or marked uncovered.
- No "looks right" verdict. A pass must answer: what changed, who sees it, where they see it, what action caused it, and what result proves it.

## Failure Signals

Use this skill again when a report shows any of these:

- More than half of screenshots cannot be tied to the assigned commits.
- The report proves data exists but not that a user path changed.
- The same entry/list page is reused as proof for unrelated changes.
- A high-risk module has no negative path or state-result evidence.
- The conclusion says deep acceptance, but the body is only reachability smoke.
- The user says "看似对了，实则无用", "没有证明改对", "覆盖不全面", or "截图和提交没有关联".

## References

- `references/proof-strength.md`: evidence hierarchy, proof score, and weak-proof traps.
- `references/fusion-testing.md`: how to design scenarios that cover multiple assertions.
- `references/output-contract.md`: required design-brief structure and tables.
