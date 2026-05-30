---
name: issues-visual-create
description: 手动触发创建一个视觉验收子 issue。输入"要测什么"（PR 号 / 页面路径 / 提交 hash），按 #605 元 issue 模板 v0.x 生成一条 [visual-test] 子 issue，挂 label visual-test:pending，等待执行者 Agent 接单。触发词："/issues-visual-create"、"创建视觉验收"、"开视觉测试 issue"、"visual test create"。
---

# Issues Visual Create — 创建视觉验收子 issue

> 把"我想给这个改动做视觉验收"变成一条结构化、可被 24h 执行者 Agent 接单的 GitHub issue。
>
> **本技能只做"开单"**。执行由 `/issues-visual-run` 负责，协议演化在元 issue #605 讨论。系统说明见 `doc/rule.issues-system.md`。

## 0. 何时触发 / 何时别用

**用本技能**：
- 你刚 push 完代码，想让 24h 视觉测试 Agent 做一次验收
- 想要矩阵化（视口 × 主题 × 状态 × 交互）覆盖，而不是自己手点
- 想把项目硬约束（无 emoji / 双主题 / Modal 三约束等）一次性测过

**别用**：
- 自己有空亲手过 UAT → 用 `/uat`
- 只是想看预览地址 → 用 `/preview`
- 修改协议本身 → 直接去 #605 评论，不要新开 issue

## 1. 必要输入（缺一项就找用户要）

| 字段 | 说明 | 示例 |
|---|---|---|
| **测试标的** | PR 号 / commit hash / 页面路由 | `#512` / `a3f5b21` / `/admin/literary` |
| **影响页面/组件** | 至少 1 个具体路由 + 组件名 | `/marketplace`, `MarketplaceCard.tsx` |
| **变更类型** | 新增 / 样式 / 布局 / 交互 / bug 修复 | `样式` |
| **业务用例** | 至少 3 条"角色+任务+预期"路径 | 见模板 §5 |

可选输入：
- 测试账号 / mock 数据约定
- 已知不覆盖范围

## 2. 自动从环境推导

- **预览地址**：按 CLAUDE.md 规则 #11 v3 公式自动拼接 `{tail}-{prefix}-{project-slug}.miduo.org`，三段都必须过 slugify（小写 + 非 `[a-z0-9-]` 替换为 `-` + 合并连续 `-` + 去头尾 `-`）
- **分支**：`git branch --show-current`，对 `/` 切分前缀/尾部后各自 slugify
- **项目 slug**：`basename $(git rev-parse --show-toplevel)` 后**必须 slugify**（本仓库 `prd_agent` → `prd-agent`，下划线必须变连字符）。直接复用 CLAUDE.md §11 给出的 bash slugify 函数，不要自己造
- **commit**：默认取 `git rev-parse --short HEAD`

## 3. 执行步骤

1. **校验**：检查必要输入是否齐，缺则要求用户补
2. **拉模板**：从 #605 元 issue 取**最新 v0.x 模板正文**（§四节子模板部分）
3. **填入参数**：自动填预览地址 / 分支 / commit / 标的
4. **建 issue**：
   - 标题：`[visual-test] <feature 一句话> @ <branch>`
   - body：填好的模板
   - label：`visual-test:pending`
5. **回执**：返回 issue URL 给用户，并提示"执行者 Agent 订阅 label 自动接单"

## 4. 标题命名

格式：`[visual-test] {简短特征描述} @ {branch}`

| 推荐 | 反例 |
|---|---|
| `[visual-test] 海鲜市场卡片 hover 态修复 @ fix/marketplace-hover` | `[visual-test] PR 512` |
| `[visual-test] 文学创作面板新增模型徽章 @ feat/literary-model-badge` | `[visual-test] 测试视觉` |

## 5. 硬约束（生成 body 前自检）

- **必须**：预览地址用 v3 公式（`{tail}-{prefix}-{project-slug}`），不用 v1/v2
- **必须**：§4 硬约束 10 条**完整列出**（不允许"按需精简"——见 #605 元 issue 决议）
- **必须**：§7 失败回报表格的列名与协议对齐：`# / 检查点 / 视口 / 主题 / 截图 / 问题描述 / 严重级`
- **必须**：业务用例 §5 至少 3 条，每条含角色 + 任务 + 预期
- **必须**：§6 "已知不覆盖" 不能为空（防止执行者越界）
- **禁止**：body 出现任何 emoji 字符（CLAUDE.md §0）
- **禁止**：跳过双主题（必填 dark + light）

## 6. 调用工具

- `git rev-parse` / `git branch --show-current` — 取分支与 commit
- `mcp__github__issue_write`（method: create）— 创建 issue
- 可选：`mcp__github__pull_request_read` — 当输入是 PR 号时读 PR 元信息辅助填写

## 7. 失败兜底

- 必要输入缺：列出缺哪几项，等用户补，不要瞎填
- label 不存在：提示用户先按 #605 评论里的 `gh label create` 脚本建好 4 个 label
- 模板版本对不上：以 #605 当前正文为准；如果用户希望用旧版本，明确说明 + 在子 issue 标注版本号

## 8. 输出

返回给用户：

```
[已创建] #N — [visual-test] xxx
URL: https://github.com/inernoro/prd_agent/issues/N
Label: visual-test:pending
预览: <python3 .claude/skills/cds/cli/cdscli.py --human preview-url 的输出>
执行者 Agent 应在 N 分钟内接单。如超时请检查 label 订阅。
```

## 9. 上下游

- 上游：`/cds-deploy`（确保预览域名就位）/ `/preview`（拿预览地址）
- 下游：`/issues-visual-run`（执行者）/ `/handoff`（视觉通过后正式交付）
- 协议演化：#605 评论区
