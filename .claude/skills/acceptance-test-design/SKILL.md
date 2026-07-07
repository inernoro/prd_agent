---
name: acceptance-test-design
version: 1.0.0
description: Convert PRs, commits, yesterday's changes, or release scope into a test-minded acceptance design before visual execution. Use when the user asks for daily acceptance, visual acceptance, PR/commit acceptance, proof that code changes really affected product behavior, coverage planning, fusion testing, evidence strength, or when screenshots/reports looked related but failed to prove the assigned task.
---

# 验收测试设计

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/验收设计`、"验收设计"、"PR/commit 验收"、"覆盖规划"、"融合测试"

## 用途

Use this skill before visual acceptance or MAP report archiving when the hard part is deciding what to test. It turns raw code changes into risk hypotheses, user-visible impact, fusion test scenarios, and evidence requirements.

This skill does not take screenshots and does not archive reports. Its output is an acceptance test design brief that downstream skills, especially `acceptance-scenario-orchestrator` and `create-visual-test-to-kb`, must follow.

## Rule Source SSOT

Before designing tests, load the acceptance rule source in this order:

1. Repository SSOT when available: `doc/rule.acceptance.map-enterprise.md`, `doc/rule.acceptance.ssot.md`, `doc/guide.acceptance.daily-sop.md`, `doc/guide.acceptance.report-evidence.md`, `doc/design.acceptance.knowledge-governance.md`.
2. Skill-package fallback when the skill is installed outside this repository: `references/rules/*.md` and `references/rules/manifest.json`.
3. If neither source exists, fail closed and state that the acceptance rule source is missing. Do not invent a local substitute.

The `doc/` files are authoritative. The bundled `references/rules/` files are generated snapshots for marketplace/offline users. When local instructions conflict with these rule documents, the rule documents win.

Use `doc/rule.acceptance.map-enterprise.md` section “验收链路总控矩阵” to decide whether the request belongs to single acceptance, daily acceptance, or daily-report communication. This skill designs acceptance tests only; it does not design the newspaper-style daily report except to provide acceptance conclusions that the report may cite.

## Core Rule

Do not start from pages. Start from changed behavior.

The working chain is:

`PR/commit -> behavior assertion -> affected user/data/state surfaces -> risk hypothesis -> proof strategy -> fusion scenario -> evidence requirement -> visual execution`

If this chain is weak, stop and produce a design-risk report. Do not compensate by taking more screenshots.

## Content Completeness Rule

Daily acceptance fails when the design brief is thin. The brief must be deliberately full enough that a later executor can test without guessing and a reviewer can see what was excluded.

For daily/yesterday, PR, commit-range, or disputed acceptance:

- Do not write only a summary paragraph. Produce tables with one row per behavior assertion or fused assertion group.
- Each assertion row must answer: source PR/commit, changed files, claimed behavior, who can notice it, where it appears, how to trigger it, expected result, strongest proof, failure condition, and coverage decision.
- Every runtime/high-risk assertion is either covered by a fusion scenario, explicitly delegated to a later deep test, or marked uncovered. It must not disappear because it is inconvenient.
- The design brief must include both breadth and depth: module inventory, high-risk inventory, user-visible surfaces, internal-only surfaces, negative/boundary needs, and untestable constraints.
- Avoid empty shorthand such as `见上文`, `同上`, `略`, `待补`, or `按常规`. If a cell cannot be filled, write the specific missing input and the impact on verdict.
- For a large day, group related commits, but keep the commit list visible inside the group. Grouping is allowed; omission is not.
- The handoff must state whether the expected report can only be `广度冒烟`, `有条件通过`, or `不通过`. Do not let downstream execution infer this silently.

## Proportionality Rule

Completeness is not over-execution. The design brief must be risk-proportionate:

- Do not create tests only because a field, component, or commit exists. Test the behavior, risk, or user consequence.
- Do not escalate a minor visual observation into P0/P1 unless it blocks a primary path, hides required information, causes data loss, breaks trust, or prevents a user action.
- For low-risk or non-runtime changes, prefer file/rule evidence, changelog evidence, or `non-runtime` classification over browser busywork.
- For large daily scopes, use fused scenarios when they preserve proof strength. Do not split every commit into a separate browser path if one real workflow proves the grouped assertion.
- Stop when the evidence is sufficient for the declared depth. Extra screenshots that add no new assertion, state, boundary, or risk explanation are noise and should be omitted.
- When a concern is worth mentioning but not worth failing the run, classify it as `observation` or `P3` and state why it does not affect the Verdict.

The brief must state the proportionality decision: why this depth is enough, what was deliberately not tested, and why those omissions are acceptable or recorded as gaps.

## Workflow

1. Freeze the target.
   - Resolve the exact date, branch, commit range, PRs, preview URL, and tested SHA.
   - If the user says "yesterday", resolve it as the exact Asia/Shanghai date and write the absolute date.
   - Collect commits and diffs before choosing pages.
   - For daily/yesterday acceptance, run `scripts/daily_scope.py --date <YYYY-MM-DD> --json-out /tmp/daily-scope.json --md-out /tmp/daily-scope.md` first. Use its commit/module/high-risk/open-branch inventory as the starting scope; do not replace it with a hand-written summary.

2. Extract behavior assertions.
   - Convert each commit/PR into the behavior it claims to change.
   - Group mechanical commits into one feature assertion, but keep the source commits visible.
   - Mark assertions as `user-facing`, `workflow`, `state/data`, `auth/security`, `async/background`, `environment`, `docs/rules`, or `internal-only`.

3. Build the impact model.
   - Identify who can notice the change and where: page, breadcrumb, entry, status, result row, detail panel, error text, toast, permission state, sync log, or absence of a forbidden action.
   - Trace likely affected areas: upstream inputs, downstream outputs, persisted state, background jobs, permissions, integration boundaries, rollback/restore, and existing user workflows.
   - Mark hidden influence clearly. If users cannot see it directly, describe the expected visible consequence or classify it as internal-only.
   - Separate `cds` platform changes from `CDS Agent` product/runtime changes. `cds/` deploy, preview, reports, branch network, extra-services, self-update, scheduler, smoke, or proxy changes must be proven with CDS platform evidence such as cdscli/API status, `/reports`, branch/deploy state, smoke results, logs, or preview routing. Do not use the prd-admin `/cds-agent` page as proof for those platform changes. Only use `/cds-agent` when the changed behavior is specifically CDS Agent UI/runtime/session behavior.

4. Design proof, not screenshots.
   - Read `references/proof-strength.md`.
   - For each assertion, write the strongest practical proof: page result first, interaction path second, internal corroboration third.
   - Reject weak proof such as a nearby page, entry page, generic API 200, or screenshot that only proves the module loaded.

5. Design fusion tests.
   - Read `references/fusion-testing.md`.
   - Prefer scenarios that cover multiple assertions through one realistic user journey.
   - Do not stop at 10 screenshots by habit. The screenshot budget follows risk and proof coverage.
   - If a small number of images is enough, explain why each image has high proof density.
   - If a large number of images is requested by scope pressure, cap it by proof value. More images are justified only when they add a new assertion, failure condition, boundary, role, viewport, or state transition.

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
   - Fill the brief with enough detail to prevent omission. A daily brief must be able to explain what happened yesterday, why each high-risk module was or was not tested, and what evidence would change the verdict.

7. Hand off to visual execution.
   - Pass the design brief into `acceptance-scenario-orchestrator`.
   - The visual report must map screenshots back to the design brief.
   - If execution cannot capture the planned proof, downgrade the verdict or mark coverage missing. Do not silently replace it with weaker evidence.

## Hard Rules

- No screenshot-first testing. A screenshot taken before a behavior assertion and proof target exists is not acceptance evidence.
- No API-first pass for user-facing changes. Internal evidence can explain or corroborate; it cannot replace page proof.
- No nearby-page substitution. Same module does not mean same behavior.
- No CDS/CDS Agent substitution. CDS platform changes and CDS Agent user/runtime changes are separate acceptance targets; one cannot prove the other.
- No fixed 10-image brake. Evidence count is driven by risk, impact, and fusion coverage.
- No open-ended over-testing. Evidence count also has an upper bound: stop when the declared depth and risk model are satisfied.
- No severity inflation. Minor cosmetic findings are not P0/P1 unless they block user value or violate a hard gate.
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
- `scripts/daily_scope.py`: deterministic daily scope inventory for yesterday/date-based runs; outputs JSON and Markdown for downstream orchestration.
