---
name: acceptance-scenario-orchestrator
description: 识别每日验收、PR 验收、commit 验收、未发布分支验收、缺陷复测、视觉回归和发布前验收等场景，并为 create-visual-test-to-kb 生成测试范围、指差法步骤、预期结果、证据链、截图回读和报告结构。Use when the user asks to optimize or run visual acceptance across different scenarios, asks whether yesterday's changes, a PR, a commit range, or an unpublished branch were really accepted, or needs PR/commit results to map to screenshots and MAP knowledge base reports.
---

# Acceptance Scenario Orchestrator

## Overview

Use this skill before `create-visual-test-to-kb` when the验收目标 is broader than a single linear page check. The output is an execution brief that tells the downstream acceptance skill exactly what to test, what to announce before testing, what evidence must be captured, and how to decide the final verdict.

This skill does not replace browser取证 or MAP归档. It is the scene planner and evidence contract for those steps.

## Workflow

1. Classify the scenario.
   - Read `references/scenario-matrix.md`.
   - Pick one primary scenario and any secondary modifiers.
   - If the target is "昨天", resolve the exact Asia/Shanghai date range before collecting commits.

2. Build the acceptance scope.
   - Map PRs and commits to functional modules.
   - For each module, identify the real user page location as a breadcrumb, such as `首页 -> 导航 -> 百宝箱 -> 文件转换`.
   - Include unpublished branches and preview environments when the user asks for "未发布状态", "昨天全部内容", or branch-specific acceptance.
   - Mark items as `runtime`, `visual`, `api`, `docs/rules`, or `environment-only`.

3. Produce the指差法 execution brief.
   For every test unit, write this before opening the page:
   - `现在开测`: PR number or commit range.
   - `归属模块`: business module and changed files if useful.
   - `页面位置`: breadcrumb and final URL.
   - `测试目的`: the claim being verified.
   - `预期结果`: observable conditions that must appear before the test can pass.
   - `证据要求`: screenshot, API response, log, or file evidence needed.

4. Run `create-visual-test-to-kb` with the brief.
   - The downstream skill performs browser取证, screenshot marking, report writing, MAP归档, and share-link verification.
   - If execution discovers new scope drift, update the brief rather than silently changing the report conclusion.

5. Enforce the evidence chain.
   - Every verdict row must connect `PR/commit -> module -> page breadcrumb -> expected result -> actual evidence -> conclusion`.
   - A screenshot that only shows "something happened" is insufficient unless its caption and markings explain which claim it proves.
   - A pass cannot be based only on an environment being reachable.

6. Write the report contract.
   - Start with `昨日工作总结` for daily/yesterday acceptance, or `验收范围摘要` for PR/commit/single-scenario acceptance.
   - Do not add an in-body table of contents. Use a coverage matrix and section headings instead.
   - Include `PR/commit 到结果映射` near the top.
   - Include `标记法则与验收标准`.
   - Include `截图回读检查`.
   - Put the final verdict at the top and ensure it matches the mapped results.

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

- Do not let a screenshot prove a claim unless the screenshot is read back and the report states what was seen.
- Do not let a PR or commit disappear from the report. If it is non-runtime, mark it as file/rule evidence instead of omitting it.
- Do not turn retry success into a clean pass. Record the first failure, retry action, second result, and final judgment.
- Do not use environment health as a substitute for feature acceptance.
- Do not publish a MAP report whose share link has not been opened and verified.
- Do not include an in-body table of contents for daily acceptance reports.

## References

- Read `references/scenario-matrix.md` when classifying a target or preparing the execution brief.
- Read `references/evidence-contract.md` when writing or reviewing the final report.

## Collaboration With create-visual-test-to-kb

After this skill produces the execution brief, use `create-visual-test-to-kb` for browser取证 and MAP归档. Pass the brief into the report body so that the final report can be audited against the original scenario plan.
