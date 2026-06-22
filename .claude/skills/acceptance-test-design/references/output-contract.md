# Acceptance Test Design Output Contract

Produce this design brief before visual execution.

For daily/yesterday runs, first attach or summarize the output from
`scripts/daily_scope.py`. The brief must not silently omit commits, open PRs, or
unpublished branches that appear in that scope inventory.

## 1. 昨日/范围总结

Write a short summary:

- target date or range
- tested branch/preview/SHA
- commit count and PR count
- major modules
- high-risk modules
- expected depth: `广度冒烟`, `深度验收`, or `发布前阻断验收`
- scope source: path to `daily_scope.py` JSON/Markdown output when available

## 2. 改动断言表

| PR/commit | changed files | 归属模块 | 改动断言 | 类型 | 用户可见页面/状态 | 是否可视觉验收 |
|-----------|---------------|----------|----------|------|-------------------|----------------|

Rules:
- Each commit appears or is intentionally grouped.
- The assertion describes behavior, not implementation.
- If there is no user-visible surface, write `无用户可见页面` and classify it as internal-only.

## 3. 影响面矩阵

| 改动断言 | 上游输入 | 用户路径 | 下游输出 | 持久化状态 | 权限/边界 | 异步/外部依赖 | 可能回归 |
|----------|----------|----------|----------|------------|-----------|----------------|----------|

The goal is not exhaustive imagination. The goal is to reveal where a correct-looking code change could still fail users.

## 4. 融合测试设计

| 融合场景 | 覆盖断言 | 用户路径 | 主要页面证据 | 内部佐证 | 负面/边界路径 | 证明密度 | 风险 |
|----------|----------|----------|--------------|----------|----------------|----------|------|

Mark a scenario as invalid if its covered assertions are only file-adjacent or module-adjacent.

## 5. 证明力矩阵

| 改动断言 | 页面主证据 | 交互动作 | 内部佐证 | 失败条件 | 证明力 0-4 | 结论 |
|----------|------------|----------|----------|----------|------------|------|

Use `references/proof-strength.md` for scoring.

## 6. 覆盖缺口与不可测项

| 缺口 | 原因 | 风险 | 降级结论 | 后续动作 |
|------|------|------|----------|----------|

If a critical assertion lacks score 3 or 4 proof, the final visual report cannot claim deep acceptance pass.

## 7. 交给视觉验收的执行清单

| 顺序 | 现在开测 | 归属模块 | 页面位置 | 预期页面反馈 | 截图要求 | 内部佐证 | 通过标准 |
|------|----------|----------|----------|--------------|----------|----------|----------|

Each row must be executable by a browser-driven agent. If it cannot be executed, move it to the gap table instead of pretending.
