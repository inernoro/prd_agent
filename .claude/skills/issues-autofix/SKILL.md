---
name: issues-autofix
description: 无人值守的日常 issue 维护 Agent。手动触发后扫描仓库 open issue，按分类规则自动答复 / 修复 / 升级人工，绝不反向询问用户。完全跳过视觉测试系列、协议元 issue、其他 Agent 领地。触发词："/issues-autofix"、"自动修复issue"、"日常issue巡检"、"unattended issue triage"。
---

# Issues Autofix — 日常无人值守 issue 维护

> 手动触发的"批量过 issue"技能。一轮跑完输出处理报告。**不和用户来回**，模糊场景按默认分支走，宁可跳过不要卡住。
>
> 完整 label 协议、跳过清单、配色等系统说明见 **`doc/rule.issues-system.md`**。本文件只写"执行逻辑"。

## 0. 何时触发 / 何时别用

**用本技能**：
- 你想批量过一遍 open issues，让 Agent 自动答复/分类/小修复
- 不想被反向追问，宁愿 Agent 跳过模糊场景

**别用**：
- Agent 间互相反馈技能/产物 bug → 用 `/audit`（auto-fix-issues 技能，语义不同）
- 给真人交付前的自检 → 用 `/verify`
- 给真人验收 → 用 `/uat`

## 1. 可配置参数（每次运行前确认）

```yaml
project_name: prd_agent
single_run_max: 30              # 单轮处理 issue 上限
max_diff_lines: 200             # 自动开 PR 的改动行数上限
max_minutes_per_issue: 10       # 单 issue 超时阈值
max_reproduce_retries: 3
protected_paths:
  - prd-api/src/PrdAgent.Core/**
  - prd-api/src/PrdAgent.Infrastructure/Auth/**
  - .env*
  - .github/workflows/**
  - docker-compose*.yml
  - Dockerfile*
  - "**/package.json"
  - "**/pnpm-lock.yaml"
faq_dir: doc
faq_prefix: guide.faq.
reply_language: match_issue
commit_pr_language: zh-CN
forbid_emoji: true
known_bots: ["*[bot]", "dependabot", "renovate", "github-actions", "claude-code-app"]
```

## 2. 完全跳过清单（最先匹配，命中后**不评论、不标签、不留痕**）

凡命中以下任一，直接 next：

1. **作者是机器人**（`known_bots` 任一匹配或 `user.type == "Bot"`）
2. **issue 含以下任一 label**（无条件跳过，永不复活）：
   - `visual-test:*`（视觉测试 Agent 领地，见 #605）
   - `discussion` / `protocol` / `meta` / `rfc`
   - `tracking` / `epic` / `umbrella`
   - `wip` / `wontfix` / `invalid` / `on-hold`
   - `agent-timeout` / `needs-human` / `cannot-reproduce` / `duplicate`
   - `human-only`
3. **`needs-info` 条件跳过**（SSOT §2.1 规定"下轮清"）：
   - 自 Agent 最近一次"请求补充信息"评论以来，**没有**非 Agent / 非机器人用户的新评论 → 跳过本轮
   - 有用户新评论 → **移除** `needs-info` label，按 §5 重新分类、再走一遍处理流程（信息可能已补足）
4. **`agent-replied` / `agent-fixed` / `proposed-fix` 条件升级**（§13 承诺"答复后追问转 needs-human"，必须真正实现）：
   - 自 Agent 最近一次 `agent-handled:*:terminal:*` 指纹以来，**没有**非 Agent / 非机器人用户的新评论 → 跳过本轮
   - 有用户新评论 → 加 `needs-human` label + 发"已转人工处理"评论，**不**移除原终态 label（保留追溯），本轮跳过
5. **标题前缀属于元类**：`[visual-test*]` / `[protocol]` / `[rfc]` / `[tracking]` / `[meta]`
6. **issue body 含** `<!-- agent-handled:` HTML 注释指纹
7. **issue 已有未关闭的关联 PR**
8. **作者是 maintainer 且无 `please-fix`/`bug` 类 label**
9. **草稿 / template 占位**：正文 < 20 字 或 仅含模板未填项

> 完整跳过清单与"为什么这样设计"在 `doc/rule.issues-system.md` §3。

## 3. 扫描范围

- 状态：open
- 创建者：非机器人
- 单轮上限：`single_run_max`
- 排序：`created_at desc`，超出排队下轮

## 4. 并发与幂等（claim-then-verify）

> GitHub "Add labels" API 对**已存在** label 不返回失败，只返回当前 label 集合。"加 label 失败"不是 CAS 信号——两个并行 worker 都会"成功"。必须 claim 评论 + 再读 verify。详细模式参照 `issues-visual-run` §2，本节摘要要点：

- **启动 reaper**（每轮 sweep 第一步，扫死锁；同 `issues-visual-run` §2）：
  1. 列出所有挂 `agent-processing` 的 open issue
  2. 找最新 `agent-handled:*:claim:*` 指纹时间戳
  3. 距今 > **reaper 阈值**（默认 30 分钟，必须 > `max_minutes_per_issue`）且无对应 `:terminal:` → 删 `agent-processing` + 评论"reaper 重置（崩溃残留）"，下一轮按常规流程重新接单
- **接单**：
  1. 预检：当前 labels 含 `agent-processing` → 跳过
  2. 加 `agent-processing` + 发 claim 评论，末尾含 `<!-- agent-handled:{run_id}:claim:{iso8601-ts} -->`
  3. 等 3-5s 后重读 issue 评论，**过滤掉已退出的 claim**（若同 run_id 既有 `:claim:` 又有 `:terminal:` **或** `:withdrawn:` 指纹，则属历史 round，剔除），在剩余活跃 claim 池里按时间戳升序排序，最早的 run_id 是 winner。此过滤对 `needs-info` 复活场景必不可少——否则旧 round 的最早 claim 永远赢，新 round 永远 loser 而无法处理用户补充的信息
  4. Loser 静默 back-out：发"撤回 run_id={uuid}，已被 run_id={X} 抢先"评论，**末尾必须含**指纹 `<!-- agent-handled:{run_id}:withdrawn:{ts} -->`（否则 filter 认不出已退出）；判断 winner 状态：winner 仍活跃（无 `agent-handled:{X}:terminal:*` 指纹）→ 不动 label；winner 已完成 → **必须删 `agent-processing`**（避免 loser 后加的锁残留导致 issue 永久卡死）。理由同 `issues-visual-run` §2 e
- **指纹评论**：终态评论末尾必须含 `<!-- agent-handled:{run_id}:terminal:{ts} -->`，用于幂等去重 + §2 #5 跳过检测
- **处理结束（仅 winner，顺序严格）**：(1) 加终态 label → (2) **先发**终态评论含 `<!-- agent-handled:{run_id}:terminal:{ts} -->` 指纹 → (3) **最后**删 `agent-processing`。理由同 `issues-visual-run` 处理结束节：若先删 lock 再发指纹，中间窗口延迟 loser 看不到 terminal 会按 active 分支不清自己加的锁,issue 卡死
- **超时回滚**：超 `max_minutes_per_issue` 分钟 → 删 `agent-processing` + 加 `agent-timeout`

## 5. 分类判定（按顺序匹配，首个命中即停）

1. **安全/敏感**（密钥泄露、注入、CVE）：`needs-human` + 评论"已上报"，跳过修复
2. **架构级变更**（`protected_paths` 涉及、跨服务接口、DB schema、依赖大版本）：`needs-human`
3. **重复 issue**（走 §8 去重前置检查）：必须在 Bug/Feature 之前判定，否则首个命中即停会让"既是 Bug 又是重复"的报告在 Bug 分支结案，重复检测形同虚设
4. **Bug**：进入 §7 修复评估
5. **Feature Request**：走 §6 答复，不开 PR
6. **使用问题/文档缺失**：走 §6 答复 + §10 文档沉淀

## 6. 首次答复（四要素，合并到一条评论）

1. 一句话复述对问题的理解
2. 判定结论：可修复 / 暂不修复 / 需补充信息 / 重复
3. 处理时点：本轮做 / 排期 / 暂不做（给原因）
4. 信息不足：给出复现模板，打 `needs-info`，**只问一次**

**格式硬约束**：
- 语言按 `reply_language`
- 禁止 emoji（CLAUDE.md §0）
- 不写"希望对您有所帮助"等客套
- 终态评论末尾**必须**追加 `<!-- agent-handled:{run_id}:terminal:{iso8601-ts} -->`（与 §4 verify 检测的 `agent-handled:*:terminal:*` 模式对齐；缺 `:terminal:` 段会让延迟 loser 检测不到 winner 完成态，残留 `agent-processing` 卡死后续接单）

## 7. 自动修复边界（全部满足才允许开 PR）

- 改动 ≤ `max_diff_lines` 行
- 不触碰 `protected_paths`
- 已有测试覆盖 **或** 本次能补单测
- 修复语义明确
- **本地校验全绿**（CLAUDE.md §5.2）：`dotnet build` / `pnpm tsc --noEmit` + `pnpm lint` / 关联 test

任一不满足：评论修复思路（不开 PR），打 `proposed-fix` 等人工。

## 8. 去重规则

- 候选：**标题相似度 > 0.8**（如归一化 Levenshtein 相似度 = `1 - editDistance/maxLen`，越大越像；用 distance 度量则要求 `< 0.2`）**或** 错误信息 token 重合 ≥ 70%
- 二次校验：复现路径 + 症状 + 受影响版本 三者中至少两条一致
- 硬否决：任一 issue 已关联 PR → 不判重
- 命中：保留最早 issue，其余评论"已合并到 #XXX"，加 `duplicate` + 关闭
- 拿不准：按独立处理

## 9. PR 规范

- **分支**：`agent/fix-issue-{number}-{slug}` 或 `agent/docs-issue-{number}-{slug}`（避免和 `claude/`、`cursor/` 抢预览域名）
- **Commit 中文**（CLAUDE.md §5.1）：`fix(scope): 修复 XX 问题 (#issue)`
- **PR 描述模板**（CLAUDE.md §5.4 必含"改动 diff"）：

  ```markdown
  ## 摘要
  1-3 句话：解决什么 / 用什么方案。

  ## 改动 diff
  - `path/to/file.ts`：一句话说明
  - `changelogs/YYYY-MM-DD_xxx.md`：新增碎片

  ## 测试
  - [x] tsc / build 通过
  - [x] lint 零新增告警
  - [x] 关联单测全绿
  - [ ] 真人通过预览域名验收

  ## 风险评估
  影响面 / 回滚方案 / 已知边界

  Fixes #{issue_number}
  ```

- PR 创建后回 issue 评论："修复方案已提交 #PR编号，待 review"
- **绝不 self-merge / force push / --no-verify**

## 10. 文档沉淀触发（任一即触发）

- 同类问题本周 ≥ 3 次
- 高频使用问题且现有文档检索不到
- 修复涉及非显而易见的配置项

**沉淀位置**：`doc/guide.faq.{slug}.md`（doc-naming 规则要求）
**结构**：现象 / 原因 / 解决 / 预防
**同步**：更新 `doc/index.yml` + `doc/guide.list.directory.md`

## 11. 标签体系

完整定义见 `doc/rule.issues-system.md` §2。

## 12. 失败兜底

- 单 issue 超 `max_minutes_per_issue` 分钟 → `agent-timeout`
- 复现失败 ≥ `max_reproduce_retries` 次 → `cannot-reproduce`
- 工具调用失败 → 重试 2 次后跳过，记入本轮报告
- 任何不确定场景 → 跳过 > 卡住

## 13. 绝对禁止

- 不回复 issue 在你答复后的追问（后续评论一律转 `needs-human`）
- 不关闭非 `duplicate` 的 issue
- 不 merge 任何 PR
- 不动 `protected_paths`
- 不承诺具体上线日期
- **不输出任何 emoji**（CLAUDE.md §0）
- 不 `--no-verify` / `--no-gpg-sign`

## 14. 本轮调度报告（输出到指定日志/Slack/Yuque）

- 扫描数 / 处理数 / 跳过数（按 §2 各子条计数）/ 升级人工数
- 逐条：issue 链接、判定、动作、耗时
- 异常项单列
- 趋势观察：本轮反复出现的问题类型 + 建议沉淀
- 末尾附 `run_id`，与评论指纹对齐

## 15. 上下游技能

- 上游：`/cds-deploy`（issue 修复后部署）
- 下游：`/handoff`（修复完通知人工）
- 兄弟：`/audit`（auto-fix-issues：agent-to-agent 反馈，语义不同，别混）
- 视觉相关：`/issues-visual-create` + `/issues-visual-run`（本 Agent 完全避让）
