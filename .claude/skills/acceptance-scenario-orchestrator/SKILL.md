---
name: acceptance-scenario-orchestrator
description: 识别每日验收、PR 验收、commit 验收、未发布分支验收、缺陷复测、视觉回归和发布前验收等场景，并为 create-visual-test-to-kb 生成测试范围、指差法步骤、预期结果、证据链、截图回读和报告结构。Use when the user asks to optimize or run visual acceptance across different scenarios, asks whether yesterday's changes, a PR, a commit range, or an unpublished branch were really accepted, or needs PR/commit results to map to screenshots and MAP knowledge base reports.
---

# Acceptance Scenario Orchestrator

## Overview

Use this skill before `create-visual-test-to-kb` when the验收目标 is broader than a single linear page check. The output is an execution brief that tells the downstream acceptance skill exactly what to test, what to announce before testing, what evidence must be captured, and how to decide the final verdict.

This skill does not replace browser取证 or MAP归档. It is the scene planner and evidence contract for those steps.

For daily, PR, commit-range, release, or repeatedly disputed acceptance, run `acceptance-test-design` first. This skill consumes that design brief and turns it into executable browser/test units.

## Workflow

1. Classify the scenario.
   - Read `references/scenario-matrix.md`.
   - Pick one primary scenario and any secondary modifiers.
   - If the target is "昨天", resolve the exact Asia/Shanghai date range before collecting commits.

2. Build the acceptance scope.
   - If an `acceptance-test-design` brief exists, preserve its behavior assertions, impact model, fusion tests, proof strength scores, and coverage gaps. Do not flatten it into a page list.
   - For daily/yesterday runs, require the upstream brief to include the `daily_scope.py` inventory or an equivalent machine-collected scope. If it is missing, stop and ask the upstream step to run the inventory before choosing pages.
   - Map PRs and commits to functional modules.
   - Extract one or more change assertions from each PR/commit before choosing pages. A change assertion is the behavior the diff claims to change, such as `knowledge-base sync retries failed pushes`, `image upload compresses large files`, or `MCP rejects non-AgentApiKey callers`.
   - For every assertion, first find the user-visible surface that should reveal the change: page, breadcrumb, visible state, toast, table row, detail panel, error text, empty state, progress state, or absence of a forbidden action. This page-level proof is the primary evidence whenever the change can be perceived by a user.
   - Map every assertion to the smallest real workflow, endpoint, log, or persisted state that can prove that assertion. Do not substitute a nearby module page for the changed behavior.
   - Treat API, log, database, and file evidence as secondary evidence unless the change is truly invisible to users. If no page-level evidence is possible, state why and name the internal evidence that replaces it.
   - For each module, identify the real user page location as a breadcrumb, such as `首页 -> 导航 -> 百宝箱 -> 文件转换`.
   - Include unpublished branches and preview environments when the user asks for "未发布状态", "昨天全部内容", or branch-specific acceptance.
   - Allow preview-environment test data with a clear prefix such as `每日验收-YYYY-MM-DD-...` when the automation policy permits it. Never use production-destructive data paths.
   - Mark items as `runtime`, `visual`, `api`, `docs/rules`, or `environment-only`.
   - Compute a depth budget before testing: target date, commit count, PR count, module count, high-risk module count, planned evidence count, and whether the run is `广度冒烟`, `深度验收`, or `发布前阻断验收`.
   - For daily/yesterday runs, do not allow a small set of entry screenshots to stand in for deep functional acceptance. If the budget cannot cover real workflows, label the run `广度冒烟` or mark uncovered items explicitly.

3. Produce the指差法 execution brief.
   For every test unit, write this before opening the page:
   - `现在开测`: PR number or commit range.
   - `归属模块`: business module and changed files if useful.
   - `改动断言`: the exact behavior claimed by the diff.
   - `页面位置`: breadcrumb and final URL.
   - `测试目的`: the claim being verified.
   - `预期结果`: user-visible observable conditions that must appear before the test can pass.
   - `证据要求`: page screenshot first, then API response, log, database state, or file evidence as corroboration.
   - `用户心智`: what a user or reviewer should understand from the page before seeing internal evidence.

   The brief must be verbose enough to execute safely:
   - Announce the expected result before testing. A step that says only "open page and observe" is not executable acceptance.
   - Write the breadcrumb as a human path, for example `主页 -> 导航 -> 百宝箱 -> 视觉分镜台`, not only a URL.
   - Include the evidence minimum for the step: entry proof, action proof, result proof, API/log/state proof, or negative proof.
   - If one screenshot is expected to cover multiple assertions, list every covered assertion and why the screenshot has fusion value.
   - If a changed path cannot be safely executed, specify the exact reason, the fallback evidence, and the forced verdict downgrade.

4. Run `create-visual-test-to-kb` with the brief.
   - The downstream skill performs browser取证, screenshot marking, report writing, MAP归档, and share-link verification.
   - If execution discovers new scope drift, update the brief rather than silently changing the report conclusion.

5. Enforce the evidence chain.
   - Every verdict row must connect `PR/commit -> changed files -> change assertion -> real workflow/API/state -> expected result -> actual evidence -> conclusion`.
   - Evidence relevance is mandatory. If a commit changed sync behavior, test sync execution/result/logs; a screenshot of the list page is at most entry evidence and must not be used as the pass proof for sync.
   - User-facing changes must be judged page-first: the report must show the page state a user would see, then use API/log/state evidence to explain or corroborate it. Internal data without a visible user consequence is diagnostic evidence, not the main visual acceptance result.
   - A screenshot that only shows "something happened" is insufficient unless its caption and markings explain which claim it proves.
   - A pass cannot be based only on an environment being reachable.
   - A deep daily acceptance pass requires at least two evidence points for each high-risk runtime module: one user-path screenshot plus one result/API/negative-path proof.
   - A daily/yesterday report that claims `深度验收` or `深度复验` must plan at least 12 valid screenshots. Fewer screenshots may be valid for `广度冒烟`, but the report title, top verdict, and summary must say so.

6. Write the report contract.
   - Start the rendered report with H1 plus `验收速览卡`; put the final verdict in that card. This is the only meaning of "final verdict at the top".
   - After the速览卡, start the body with `昨日工作总结` for daily/yesterday acceptance, or `验收范围摘要` for PR/commit/single-scenario acceptance.
   - Do not add an in-body table of contents. Use a coverage matrix and section headings instead.
   - Include `PR/commit 到结果映射` near the top.
   - Include `标记法则与验收标准`.
   - Include `截图回读检查`.
   - Ensure the速览卡 verdict matches the mapped results and the worst meaningful failed/conditional item.
   - Require content fullness. Daily/yesterday reports must contain enough narrative and table rows to explain the day, the covered modules, the uncovered modules, the evidence strength, and the downgrade reasons. A report that only has a few screenshots plus a short conclusion is not a valid daily acceptance report.
   - Require anti-omission wording. Each high-risk or runtime assertion must end as `pass`, `conditional`, `fail`, `internal-only`, `non-runtime`, or `uncovered`; no assertion can be left implicit.

## Scenario Selection

Use these scenario names in the execution brief:

| Scenario | Use when | Primary output |
|----------|----------|----------------|
| `daily-yesterday` | 用户说每日验收、昨天验收、昨天开发的所有内容 | Yesterday summary, PR/commit coverage matrix, full evidence report |
| `pull-request` | 用户指定 PR 或要求 PR 与结果对齐 | PR scope, changed modules, expected behavior, evidence per PR item |
| `commit-range` | 用户指定 commit 或说 commit 必须和结果对得上 | Commit-to-result matrix and uncovered commit list |
| `unpublished-branch` | 用户强调未发布、灰度、分支、预览环境 | Branch health plus functional evidence; environment reachability is not a functional pass |
| `defect-retest` | 用户要求复测缺陷、回归问题或失败报告 | Original failure, expected fix, retest evidence, retry record |
| `visual-regression` | 用户关注页面视觉是否退化、截图差异、布局变形 | Baseline/diff strategy plus semantic screenshot inspection |
| `release-preflight` | 用户要求发布前验收、上线前确认 | Risk-based release checklist and blocker gate |

If multiple scenarios match, choose the narrowest scenario as primary and list the others as modifiers. For example, "昨天未发布分支验收" is primary `daily-yesterday` with modifier `unpublished-branch`.

## Execution Brief Template

```markdown
# 验收场景编排

## 场景
- 主场景:
- 修饰场景:
- 目标日期或范围:
- 验收环境:

## 范围收敛
| PR/commit | 归属模块 | 页面位置 | 变更类型 | 是否运行态 | 验收策略 |
|-----------|----------|----------|----------|------------|----------|

## 指差法开测清单
| 顺序 | 现在开测 | 归属模块 | 页面位置 | 测试目的 | 预期结果 | 证据要求 |
|------|----------|----------|----------|----------|----------|----------|

## 报告契约
- 顶部结论:
- PR/commit 到结果映射:
- 标记法则与验收标准:
- 截图回读检查:
- 重试记录:
- 未覆盖项:
```

## Hard Rules

- Page evidence comes first for user-facing work. API/log/database evidence may confirm the cause or result, but must not replace the page proof unless the report explicitly marks the item as non-visual/internal.
- Do not let a screenshot prove a claim unless the screenshot is read back and the report states what was seen.
- Do not let a PR or commit disappear from the report. If it is non-runtime, mark it as file/rule evidence instead of omitting it.
- Do not turn retry success into a clean pass. Record the first failure, retry action, second result, and final judgment.
- Do not use environment health as a substitute for feature acceptance.
- Do not call a daily/yesterday run `深度验收` when it only checks entry pages and a few API 200s. That is `广度冒烟`.
- Do not use a nearby screen as proof for a changed behavior. `列表可见`, `按钮可见`, or `页面可达` only prove entry/availability unless the commit itself was about entry/availability.
- Do not mark an assertion passed unless the evidence exercises the changed path or inspects the changed result state. Otherwise mark it `未覆盖` or `关联不足`.
- Do not mark a high-risk module as deeply accepted without an action/result pair or a negative-path/API proof. High-risk modules include auth, async workers, uploads/compression, external downloads, deployment, state transitions, and data restore.
- Do not publish a MAP report whose share link has not been opened and verified.
- Do not include an in-body table of contents for daily acceptance reports.
- Do not accept thin daily reports. If the report cannot teach a reviewer what changed, where it was tested, why the evidence is relevant, what was not covered, and why the verdict is downgraded, send it back for expansion before archiving.
- Do not use filler as fullness. More screenshots or repeated prose do not count unless they add source scope, expected result, actual result, evidence linkage, or risk explanation.

## References

- Read `../acceptance-test-design/SKILL.md` first when the request is about daily/yesterday acceptance, PR/commit acceptance, evidence strength, impact coverage, fusion testing, or a failed/weak prior report.
- Read `references/scenario-matrix.md` when classifying a target or preparing the execution brief.
- Read `references/evidence-contract.md` when writing or reviewing the final report.

## Collaboration With create-visual-test-to-kb

After this skill produces the execution brief, use `create-visual-test-to-kb` for browser取证 and MAP归档. Pass the brief into the report body so that the final report can be audited against the original scenario plan.
