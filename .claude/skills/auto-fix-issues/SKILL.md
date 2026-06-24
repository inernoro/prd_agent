---
name: auto-fix-issues
description: Agent 与 Agent 之间互相提交、修复、复测 GitHub issue 的自动巡检协议。当一个 agent 用另一个 agent 的产物（cdscli、prd-api、共享 skill 等）发现 bug、阻塞、能力缺口时，用本技能产出标准 issue / tracker / PR 收尾清单 / 复测报告，避免 agent 之间反复确认"修没修、修对没修、复测了没"。触发词："巡检"、"自动巡检"、"反馈给对方 agent"、"复测修复"、"agent 间提 issue"、"/audit"、"/auto-fix-issues"。
---

# Agent 间自动巡检与修复闭环

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/audit`、`/auto-fix-issues`、"巡检"、"反馈给对方 agent"、"复测修复"

> 给 agent 用的「我用了你的产物发现 bug，怎么以最低 friction 让你修，修完我怎么复测」协议。
> **不是**给最终用户的 UAT，**不是**自检代码 review，**是** agent → agent 的契约。

## 0. 何时触发

满足任一条件即触发本技能：

- Agent A 在使用 Agent B 维护的 skill / CLI / 服务（如 cdscli、prd-api endpoint）时遇到可复现的 bug、阻塞、能力缺口
- 用户说「告诉对方 agent 修一下」「跟进 X 技能问题」「复测 X 修复」
- PR 合并后需要回头同步 issue 标签（这是 session 真实事故的兜底）
- 想聚合多个相关问题成一个 tracker（如 #552 部署体验阻塞清单）

**不触发**：
- 自己的代码改完想自检 → 用 `/verify`
- 让真人按表打勾 → 用 `/uat`
- 给最终用户交付 → 用 `/handoff`

## 1. 三种角色 + 三种产物

| 角色 | 时机 | 产出 |
|------|------|------|
| **反馈方** | 发现 bug | Issue（带复现+期望+验收）+ 视情况加入 tracker |
| **修复方** | 接到 issue | PR（含 `Fixes #N` 关键字）+ 收尾清单（**改 label** + 评论复测命令） |
| **复测方** | 修复 PR 合并后 | PASS 报告 / FAIL 报告（FAIL 必须重开 issue + 附版本号 + 复现日志） |

同一个 agent 在不同 session 可以扮演不同角色，本技能保证三者输出格式一致、能机读。

## 2. 标签体系（强制三档）

仓库级统一标签，新仓库初次使用本技能时若不存在自动创建（GitHub MCP `issue_write` 带 labels 会自动创建）：

| 标签 | 含义 | 谁加 |
|------|------|------|
| `待解决` | 已收到反馈，未开始修 / 修复中 | 反馈方提交 issue 时 |
| `已解决待验收` | 修复 PR 已合并，等复测确认 | 修复方合并 PR **当时立即**改 |
| `已验收` | 复测 PASS，可以彻底关 | 复测方 PASS 后改（同时 close issue） |

**硬规则**：

1. **PR 合并后必须立刻把对应 issue 的 label 从 `待解决` 改成 `已解决待验收`**。`Fixes #N` 关键字会 close issue，但不会改 label —— 这是 session 实战的真实坑（2026-05-09 用户当场指出）。
2. **复测失败不允许把 label 改回 `待解决` 然后什么都不做** —— 必须**重开 issue** 或 **新开 follow-up issue**，附：`cdscli --version` / 复测包时间戳 / 完整复现命令 / 实际输出 vs 期望。
3. **PR 合并** ≠ **issue 关闭** ≠ **问题解决**。三档要分别走完。

## 3. Issue 反馈模板（反馈方用）

```markdown
## 背景

- Skill / CLI 名 + 版本号：`cdscli 0.4.0`
- 复测包时间戳（如适用）：`cds-skills-2026-05-09T09-51-51`
- 相关 PR / commit：#543 / commit `abc123`
- 我现在的目标：把 X 项目部署到 CDS

## 复现步骤

```bash
# 1. 干净副本（避免缓存影响）
rsync ...
# 2. 触发命令
python3 cdscli.py scan ./tmp --output out.yml
```

## 实际行为

```json
{ "ok": true, "modules": [/* 只有前端 */] }
```

## 期望行为

```yaml
services:
  imp-api:    # 后端应被识别
    ...
```

## 验收标准（checkbox，复测时逐条核对）

- [ ] scan 输出包含 `imp-api` 服务
- [ ] command 含 `-pl imp-api -am`
- [ ] volume 挂父目录而非子目录

## 阻塞影响

> 真实 Java monorepo 只生成前端 compose，后端根本不会部署。

## 优先级 / Tracker 链接

- 优先级：P0 (硬阻塞) / P1 (有绕过路径) / P2 (体验缺陷)
- Tracker：#552 CDS-CLI-001
- 标签：`待解决`
- **禁止**：粘贴真实 token / cookie / access key / 数据库连接串
```

## 4. Tracker Issue 模板（聚合多条相关反馈）

适用：同一 skill / 同一模块的多条 issue，用一个 tracker 给修复方看全貌。本仓库 `#552` 是模板范例。

```markdown
## 目标

[一句话说明 tracker 范围]

## 阻塞清单

| ID | 优先级 | 问题 | 状态 | 证据/链接 | 期待修复 |
|----|--------|------|------|-----------|----------|
| CDS-CLI-001 | P0 | Maven parent pom 不递归 | OPEN | #544 | 解析 modules + 递归 |
| CDS-CLI-002 | P0 | 嵌套 compose 漏识别 | FIXED | PR #556 | partial signal 已加 |

## 已复测通过

| 项 | 状态 | 证据 |
|----|------|------|
| Vite port 读取 | PASS | 三个前端端口正确 |

## 当前停滞点

[如果 tracker 上整体不能 PASS，说明卡在哪里]

## "彻底解决" 定义

[列出全部通过条件，让修复方有明确目标]
```

修复每个子项后，状态列从 `OPEN` 改为 `FIXED` 或 `VERIFIED`，并贴 PR 链接。

## 5. 修复方 PR 收尾清单（合并 PR **必走**）

合并 PR 之后，按本清单执行（**不允许跳步**）：

```
- [ ] 1. 确认 PR description 含 `Fixes #N1, fixes #N2` 关键字（GitHub 自动 close issue）
- [ ] 2. 用 GitHub MCP issue_write method=update labels=["已解决待验收"] 改每个对应 issue 的 label
       （Fixes 关键字不会改 label，这是踩过的坑）
- [ ] 3. 在每个对应 issue 评论里贴：
       - 复测命令（具体 bash，可 copy-paste 跑）
       - 验证点（应该看到的关键输出 / 状态变化）
       - 失败时怎么办（重开 issue + 附 X / Y / Z）
- [ ] 4. 如果有 tracker（如 #552），更新 tracker 的状态列
- [ ] 5. 给反馈方 / 复测方 agent 一行话总结：版本号 + PR + 复测命令
```

**硬规则**：步骤 2 / 3 不做就视为 PR **没合并完**。reviewer 看到没做就要求补，否则反馈方下一轮 session 会再捡到 `待解决` 标签的"幽灵 issue"。

## 6. 复测方报告模板

### PASS 报告

```markdown
## 复测 PASS — issue #544

- 拉取版本：`cdscli 0.5.0` / 包时间戳 `cds-skills-2026-05-09T11-30-00`
- 复测命令（按 issue 第 5 节验收标准逐条）：

```bash
python3 cdscli.py scan ./mdimp --output /tmp/out.yml
grep "imp-api:" /tmp/out.yml          # ✓ 命中
grep "spring-boot:run -pl imp-api" /tmp/out.yml  # ✓ 命中
grep "./imp-platform:/app" /tmp/out.yml  # ✓ 命中
```

- [x] scan 输出包含 imp-api
- [x] command 含 -pl imp-api -am
- [x] volume 挂父目录

✅ 全部 PASS。请改 label `已验收` 并关闭。
```

### FAIL 报告

```markdown
## 复测 FAIL — issue #544 第 N 次复测

- 拉取版本：`cdscli 0.5.0` / 包时间戳 `cds-skills-...`
- 期望：scan 包含 imp-api
- 实际：仍只识别 3 个前端

```bash
$ python3 cdscli.py scan ./mdimp
{...只有 imp-admin / imp-supplier / imp-scan-web...}
```

- [x] scan 含 imp-api  ← **未通过**
- [ ] (后续未测)

## 怀疑根因

[反馈方的初步判断，给修复方 agent 一个起点]

## 行动

- 重开 issue 标 `待解决`，链接本复测
- 不再继续向下推进部署，等修复
```

## 7. Agent 间契约

互相不甩锅、不漏单的硬约束：

**反馈方义务**：
- 必须给可复现命令（不是"反正就是不行"）
- 必须给期望行为（明确"应该是什么"）
- 必须给可勾选的验收标准（不是模糊"能用就行"）
- 必须脱敏（不上 secret）

**修复方义务**：
- PR description 用 `Fixes #N` 关键字关 issue
- 合并后立刻改 label（参见第 5 节）
- 提供具体复测命令（不只是"已修复，请验证"）
- 已知 debt 写到 `doc/debt.{module}.md`，不是只写在 commit message

**复测方义务**：
- 必须用最新版本 / 包（带时间戳证据）
- 失败必须有具体 evidence，不是"还是不行"
- 不能因为复测失败就放弃推进；要拆出"新发现的子问题"另开 issue

任何一方不履行，对方有权 **退回重提**（issue 评论说明缺哪一项）而不是默默吞下。

## 8. 自动化（v2，MVP 不做）

未来可加：
- GitHub Actions：PR 含 `Fixes #N` 时合并后自动改 label 为 `已解决待验收`（消除手动遗漏）
- 复测 webhook：收到「复测 PASS」格式评论时自动改 `已验收` + close
- Cross-repo bridge：跨仓库（如 cds skill 和主仓库）反馈链路

MVP 阶段全靠人 / agent 手动按本 SKILL 执行。

## 9. 上下游技能

| 上游 | 关系 |
|------|------|
| `/scope-check` | 提交前看自己改了什么，不要越界 |
| `/verify` | 自检代码 |
| 用户 | 派单的人 |

| 下游 | 关系 |
|------|------|
| `/handoff` | 完成后给用户的交付报告 |
| `/uat` | 真人按表打勾 |
| `/cds-deploy` | 修复后部署到灰度环境复测 |
| `/preview` | 复测前生成预览地址 |

## 10. 真实案例（Reference）

- **#544 / #550**（Maven 多模块）：反馈方用本协议提了两个 issue（含明确复现 + 验收）→ 修复方在 PR #556 一并修 → 合并后改 label 为 `已解决待验收` → 等复测
- **#552**（部署体验 tracker）：反馈方聚合 9 个子项到一个 tracker → 修复方按子项 ID（CDS-CLI-001 ... 009）逐项推进 → tracker 状态列实时更新
- **本 session 反面案例**：合并 #556/#557/#558 后忘了改 label，用户当场指出"为什么还是 `待解决`" —— 这是促使本技能诞生的直接动机，第 5 节硬规则就是为了堵这个坑

## 11. 不在本技能范围

- 给最终用户的功能验收 → `/uat`
- 任务交付报告 → `/handoff`
- 代码越界检查 → `/scope-check`
- 多 agent 任务编排 → 用主 agent 的 Agent tool

本技能只管"agent A 提 bug → agent B 修 → agent A 复测"这一条链路。
