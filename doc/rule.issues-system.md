# Issues 体系 · 协议规则

> 创建日期：2026-05-14
> 状态：活跃
> 维护人：协议演化讨论在 [#605](https://github.com/inernoro/prd_agent/issues/605)
> 配套技能：`/issues-autofix`、`/issues-visual-create`、`/issues-visual-run`

GitHub issue 在本项目同时承载三类工作：日常 bug/feature 维护、视觉验收的开单与执行、协议本身的演化讨论。本文件做一次系统性解释，让三类工作可机器化协同、不互相打架、不需要每次重新沟通。

---

## 1. 体系全景

```
                           ┌────────────────────────────────────┐
                           │  GitHub Issues (inernoro/prd_agent) │
                           └────────────────────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
        ▼                                 ▼                                 ▼
  日常 bug/feature              视觉验收 工单 + 执行              协议元 issue (#605)
  /issues-autofix              /issues-visual-create             label = visual-test:protocol
                               /issues-visual-run                永久开放，讨论模板演化
                                                                  │
  label: agent-replied         label: visual-test:pending          ▼
         agent-fixed                  :reviewing               讨论后 bump 模板版本
         needs-human                  :passed                  本文件 §5 + #605 §四同步更新
         needs-info                   :blocked
         duplicate                    :protocol (元 issue 独占)
         agent-timeout
         cannot-reproduce
```

三条主线**互不重叠、互不打扰**：

| 主线 | 触发方式 | 谁处理 | 何时关闭 |
|---|---|---|---|
| 日常 bug/feature | `/issues-autofix` 手动批跑 | 通用 Agent | 修完合并 / 答复完毕 |
| 视觉验收 | `/issues-visual-create` 开单 → `/issues-visual-run` 接单 | 24h 视觉测试 Agent | P0/P1 全清零 |
| 协议演化 | 直接评论 #605 | 维护者 | **永不关闭** |

---

## 2. Label 体系（全局唯一权威）

任何新增 label 必须先在本表登记。**本表是 SSOT**，技能文件、自动化 Agent、PR 模板都从这里查。

### 2.1 日常 Agent 处理标签

| Label | 颜色 hex | 含义 | 谁加 | 谁清 |
|---|---|---|---|---|
| `agent-processing` | `9CA3AF` 灰 | 本 Agent 正在处理（乐观锁） | `/issues-autofix` 进入时 | 同一 Agent 处理结束时 |
| `agent-replied` | `94A3B8` 浅灰 | 已答复无修复 | `/issues-autofix` | — |
| `agent-fixed` | `10B981` 绿 | 已答复且提了 PR | `/issues-autofix` | — |
| `proposed-fix` | `60A5FA` 浅蓝 | 给了思路未提 PR | `/issues-autofix` | — |
| `needs-human` | `F59E0B` 橙 | 升级人工 | `/issues-autofix` 或 `/issues-visual-run` | — |
| `needs-info` | `EAB308` 黄 | 信息不足（只允许一次） | `/issues-autofix` | 下轮 |
| `duplicate` | `D1D5DB` 灰 | 重复 | `/issues-autofix` | — |
| `agent-timeout` | `EF4444` 红 | 处理超时 | `/issues-autofix` 或 `/issues-visual-run` | — |
| `cannot-reproduce` | `DC2626` 深红 | 复现失败 ≥ 3 次 | `/issues-autofix` | — |

### 2.2 视觉验收标签

| Label | 颜色 hex | 含义 | 谁加 | 谁清 |
|---|---|---|---|---|
| `visual-test:protocol` | `8B5CF6` 紫 | **元 issue (#605) 独占**，演化讨论 | 维护者 | 不清 |
| `visual-test:pending` | `FBBF24` 黄 | 执行者订阅，看到即接单 | `/issues-visual-create` | `/issues-visual-run` 接单时 |
| `visual-test:reviewing` | `3B82F6` 蓝 | 已接单，等待开发者回应 | `/issues-visual-run` 报失败时 | 开发者修复 push 后 |
| `visual-test:passed` | `10B981` 绿 | 全部 P0/P1 通过，可关闭 | `/issues-visual-run` 通过时 | — |
| `visual-test:blocked` | `EF4444` 红 | 环境不通 / 模板填不全 | `/issues-visual-run` 阻塞时 | 开发者澄清后 |

### 2.3 全局豁免标签

凡有以下任一 label，`/issues-autofix` **完全跳过**（不评论、不留痕）：

| Label | 含义 |
|---|---|
| `human-only` | 显式禁止 Agent 介入 |
| `discussion` / `protocol` / `meta` / `rfc` | 长期讨论，不是请求 |
| `tracking` / `epic` / `umbrella` | 追踪型，无单点修复 |
| `wip` / `wontfix` / `invalid` / `on-hold` | 状态明确不需 Agent |

### 2.4 首次部署：创建 label 脚本

```bash
REPO=inernoro/prd_agent
# 日常 Agent
gh label create "agent-processing"   --color 9CA3AF --description "本 Agent 正在处理（乐观锁）" --repo $REPO
gh label create "agent-replied"      --color 94A3B8 --description "已答复无修复"             --repo $REPO
gh label create "agent-fixed"        --color 10B981 --description "已答复且提了 PR"          --repo $REPO
gh label create "proposed-fix"       --color 60A5FA --description "给了思路未提 PR"          --repo $REPO
gh label create "needs-human"        --color F59E0B --description "升级人工"                 --repo $REPO
gh label create "needs-info"         --color EAB308 --description "信息不足（只允许一次）"    --repo $REPO
gh label create "duplicate"          --color D1D5DB --description "重复 issue,已合并到他处"   --repo $REPO
gh label create "agent-timeout"      --color EF4444 --description "处理超时"                 --repo $REPO
gh label create "cannot-reproduce"   --color DC2626 --description "复现失败 ≥ 3 次"           --repo $REPO
# 视觉验收
gh label create "visual-test:pending"   --color FBBF24 --description "执行者订阅：接单中"           --repo $REPO
gh label create "visual-test:reviewing" --color 3B82F6 --description "已接单，等待开发者回应"        --repo $REPO
gh label create "visual-test:passed"    --color 10B981 --description "全部 P0/P1 通过，可关闭"      --repo $REPO
gh label create "visual-test:blocked"   --color EF4444 --description "环境/需求阻塞，需澄清"        --repo $REPO
gh label create "visual-test:protocol"  --color 8B5CF6 --description "元 issue 独占，演化讨论"      --repo $REPO --force
# 豁免
gh label create "human-only"   --color 1F2937 --description "显式禁止 Agent 介入"  --repo $REPO
gh label create "discussion"   --color 6B7280 --description "长期讨论，不是请求"   --repo $REPO
```

---

## 3. `/issues-autofix` 完全跳过清单

为防止通用 Agent 误入"其他 Agent 领地"，跳过条件按顺序判定，命中即静默 next：

1. **作者是机器人**：用户名匹配 `*[bot]` / `dependabot` / `renovate` / `github-actions` / `claude-code-app`，或 GitHub API `user.type == "Bot"`
2. **issue 含 §2.2 任一 `visual-test:*` label**（视觉测试 Agent 领地）
3. **issue 含 §2.3 任一豁免 label**
4. **issue 含 §2.1 终态 label 且不需复活**：`agent-replied` / `agent-fixed` / `agent-timeout` / `proposed-fix` / `needs-human` / `cannot-reproduce` / `duplicate`（这些谁清字段为 "—"，永久终态）
5. **`needs-info` 条件跳过**（不是终态，§2.1 规定"下轮清"）：
   - 自 Agent 最近一次"请求补充信息"评论以来，没有非 Agent / 非机器人用户的新评论 → 跳过本轮
   - 有用户新评论 → 移除 `needs-info` label，按 §5 重新分类
6. **标题前缀属于元类**：`[visual-test*]` / `[protocol]` / `[rfc]` / `[tracking]` / `[meta]`
7. **issue body 含** `<!-- agent-handled:` HTML 注释指纹（已处理过）
8. **issue 已有未关闭的关联 PR**
9. **作者是 maintainer** 且无 `please-fix`/`bug` 类 label
10. **草稿/template 占位**：正文 < 20 字 或 仅含模板未填项

**设计意图**：本节是兜底防火墙。label 是主防线，body 指纹是次防线，标题前缀是第三防线。任何一道触发都跳过。`needs-info` 是唯一允许"下轮复活"的状态，所有其他 Agent 处理过的 label 都视作永久终态。

---

## 4. 三个技能的协同

| 技能 | 输入 | 输出 | 终态 label |
|---|---|---|---|
| `/issues-autofix` | 仓库 open issue 队列 | 评论/PR/label 改动 | `agent-replied` / `agent-fixed` / `needs-human` / `duplicate` / `agent-timeout` |
| `/issues-visual-create` | PR# / commit / 页面路径 + 业务用例 | 一条 `[visual-test]` 子 issue | `visual-test:pending` |
| `/issues-visual-run` | 仓库 `visual-test:pending` 队列 | 评论失败清单或 `/visual-pass` | `visual-test:reviewing` / `visual-test:passed` / `visual-test:blocked` |

**互斥关系**：

- `/issues-autofix` 看到 `visual-test:*` 一律跳过
- `/issues-visual-run` 只看 `visual-test:pending`，不动其他 issue
- `/issues-visual-create` 只开单，不接单（接单是 `/issues-visual-run`）

**协作关系**：

```
开发者推代码
   │
   ├─ "测一下视觉" → /issues-visual-create → 子 issue(pending) → /issues-visual-run 接单
   │                                                                │
   │                                                                ├─ 失败 → reviewing → 开发者修 → pending → 重测
   │                                                                └─ 通过 → passed → close
   │
   └─ "看看待办 issues" → /issues-autofix → 批量答复/修复/升级
                              │
                              └─ 遇到 visual-test:* / discussion / 等 → 跳过
```

---

## 5. 视觉验收模板（v0.1，与 #605 §四同步）

模板正文以 [#605](https://github.com/inernoro/prd_agent/issues/605) 当前内容为准。**修改模板的唯一入口是 #605 评论**，不要直接改本文件。本节是镜像快照，便于 AI 离线读取。

模板字段：
- §1 范围（提交/PR、影响页面、变更类型）
- §2 入口（预览地址按规则 #11 v3 公式、登录账号）
- §3 测试矩阵（视口 × 主题 × 状态 × 交互态，dark+light 双主题强制）
- §4 项目专属硬约束（10 条，对应 CLAUDE.md / .claude/rules/）
- §5 业务用例（至少 3 条角色+任务+预期）
- §6 已知不覆盖（防止执行者越界）
- §7 失败回报格式（表格列：# / 检查点 / 视口 / 主题 / 截图 / 问题描述 / 严重级）
- §8 通过标志（P0/P1 清零 → `/visual-pass`）

### 5.1 §4 硬约束 10 条（与项目规则一一对应）

| # | 检查点 | 规则来源 |
|---|---|---|
| 1 | 无 emoji | `CLAUDE.md` §0 |
| 2 | 白天模式无暗色 modal/弹窗/代码块 | `.claude/rules/cds-theme-tokens.md` |
| 3 | Modal 走 createPortal + inline style 高度 + min-h:0 | `.claude/rules/frontend-modal.md` |
| 4 | 页面撑满视口，无 `calc(100vh-Npx)` 魔数 | `.claude/rules/full-height-layout.md` |
| 5 | 空状态有引导 CTA | `.claude/rules/guided-exploration.md` |
| 6 | LLM 面板顶部展示模型名 + 平台 | `.claude/rules/ai-model-visibility.md` |
| 7 | 长任务 >2s 静止 = 缺陷，屏幕必须持续变化 | `CLAUDE.md` §6 |
| 8 | 输入框有上传/选择/预填通道之一 | `.claude/rules/zero-friction-input.md` |
| 9 | 2D 画布手势统一 | `.claude/rules/gesture-unification.md` |
| 10 | 加载组件走 MAP Loader，禁 `<Loader2>` 裸用 | `.claude/rules/frontend-architecture.md` §统一加载组件 |

### 5.2 严重级口径

| 级别 | 含义 | 示例 |
|---|---|---|
| **P0** | 阻塞合并 | 白天黑底、emoji 出现、Modal 撑破屏幕、登录走不通、空状态无 CTA |
| **P1** | 必须修 | 模型名缺、加载组件不统一、双主题样式不一致 |
| **P2** | 可延后 | 配色微调、间距 1-2px |
| **P3** | 优化建议 | 动效更顺、文案更准 |

---

## 6. 工作流（端到端）

### 6.1 视觉验收完整循环

```
1. 开发者 push 代码
2. 开发者跑 /issues-visual-create
   ├─ 必要输入：标的(PR#/commit/页面) + 业务用例
   └─ 自动推导：预览地址(规则 #11 v3) + 分支 + commit
3. 子 issue 创建 → label: visual-test:pending
4. 视觉测试 Agent 跑 /issues-visual-run
   ├─ 加 agent-processing 乐观锁
   ├─ 评论"已接单 · 预计 N 分钟"
   ├─ 按 §3 矩阵跑（双主题强制）
   └─ 按 §7 格式回评论
5. 分两种终态：
   ├─ 有 P0/P1 → label: visual-test:reviewing
   │     │
   │     └─ 开发者修复 push
   │           ├─ 评论"已修 commit <hash>"
   │           ├─ 移除 visual-test:reviewing
   │           └─ 加回 visual-test:pending
   │           │
   │           └─ 回到第 4 步重测（仅受影响项 + P0 全量回归）
   │
   └─ 全清零 → 评论 /visual-pass → label: visual-test:passed → close
```

### 6.2 日常 issue 维护循环

```
1. 用户/外部贡献者开 issue
2. 维护者跑 /issues-autofix（手动批跑）
3. Agent 按 §3 跳过清单过滤
4. 通过过滤的 issue 按 §5 分类（安全/架构/Bug/Feature/使用问题/重复）
5. 每条 issue 一条结构化答复（四要素）
6. 满足开 PR 条件的 → 推到 agent/fix-issue-N-slug 分支 → 开 PR
7. 终态 label
8. 输出本轮报告（扫描数/处理数/跳过数/升级数）
```

---

## 7. 模板演化机制

**唯一入口**：#605 评论。

- 用过觉得啰嗦/漏字段 → 在 #605 评论建议
- 维护者每攒够 N 条建议或 K 次执行回顾 → 合并到 #605 正文 → bump 版本号 (v0.1 → v0.2)
- 每次 bump 同步更新本文件 §5
- 当模板稳定连续 K 次执行无大改 → 固化为 `.github/ISSUE_TEMPLATE/visual-test.yml`，本文件 §5 改为引用该 YAML

**严禁**：
- 不要新开 issue 讨论模板（应集中在 #605）
- 不要直接改本文件 §5 而不同步 #605（会引发不一致）
- 不要把项目专属硬约束精简到 10 条以下（#605 元 issue 决议）

---

## 8. 历史背景

- **2026-05-14** v0.1 协议落地：
  - #605 元 issue 创建（含模板 v0.1 + 协议正文）
  - 自动化 issue Agent 加跳过规则
  - 用户决议："保留 10 条硬约束"、"用 label 触发不依赖 @-mention"、"先开元 issue 不动 `.github/`"
- **Phase 1 进行中**：等 24h 视觉测试 Agent 上线 + 订阅 `visual-test:pending` label
- **Phase 3 计划**：模板稳定后固化为 `.github/ISSUE_TEMPLATE/visual-test.yml`，本文件 §5 改为引用

---

## 9. 相关文件

| 文件 | 内容 |
|---|---|
| `.claude/skills/issues-autofix/SKILL.md` | 日常 Agent 执行逻辑 |
| `.claude/skills/issues-visual-create/SKILL.md` | 开单技能 |
| `.claude/skills/issues-visual-run/SKILL.md` | 执行者技能 |
| `doc/rule.doc-naming.md` | doc/ 文件命名规则（本文件本身遵守） |
| `.claude/rules/cds-theme-tokens.md` | 双主题硬规则（§5.1 第 2 条） |
| `.claude/rules/frontend-modal.md` | Modal 三约束（§5.1 第 3 条） |
| `.claude/rules/full-height-layout.md` | 撑满视口（§5.1 第 4 条） |
| `.claude/rules/guided-exploration.md` | 空状态引导（§5.1 第 5 条） |
| `.claude/rules/ai-model-visibility.md` | LLM 模型可见性（§5.1 第 6 条） |
| `.claude/rules/zero-friction-input.md` | 输入零摩擦（§5.1 第 8 条） |
| `.claude/rules/gesture-unification.md` | 画布手势（§5.1 第 9 条） |
| `.claude/rules/frontend-architecture.md` | MAP Loader（§5.1 第 10 条）+ 组件复用 |
| GitHub issue [#605](https://github.com/inernoro/prd_agent/issues/605) | 模板演化讨论 |
