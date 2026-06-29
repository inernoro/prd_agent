---
name: cds-deploy-pipeline
description: Deploys code to an existing CDS branch, monitors readiness, runs layered smoke tests, fetches container logs, and diagnoses deploy failures (the hot path of CDS lifecycle). Activates when the user wants to push and verify on the grey/灰度 environment, inspect logs from a deployed branch, debug a failing deploy, restart a profile, or check live grey-env status. Every operation runs through cdscli (no hand-written curl). Does NOT handle initial project onboarding, tech-stack scanning, or cds-compose.yml generation — those belong to cds-project-scan (cold path). Does NOT handle credential setup or CDS self-update — those belong to cds (core). Trigger phrases include "部署到灰度", "deploy pipeline", "推送并测试", "灰度状态", "容器报错", "看容器日志", "deploy 失败", "帮我看看 cds 报错", "重启 api", "冒烟测试", "/cds-deploy", "/cds-debug", "/cds-smoke".
---

# CDS 部署流水线

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/cds-deploy`、`/cds-debug`、`/cds-smoke`、"部署到灰度"、"看容器日志"、"deploy 失败"

> **热路径定位**：高频 / 每天 N 次。已部署项目的"代码 → 灰度 → 验证 → 排错"闭环。
> 还没接入 CDS 的新项目 → 走 `cds-project-scan`（冷路径）。
> 配置认证 / env / Key / CDS 服务自更新 → 走 `cds`（核心）。

## 本技能处理 / 不处理

| 处理 | 不处理（去对应技能） |
|---|---|
| `git push` + CDS pull + deploy + 等待就绪 | 新项目首次接入（`cds-project-scan`） |
| 容器日志 / 操作历史 / `container-exec` 诊断 | 生成 `cds-compose.yml`（`cds-project-scan`） |
| 分层冒烟测试（L1 无认证 / L2 代码 / L3 认证 API） | 配 `AI_ACCESS_KEY` / 项目 Key（`cds`） |
| 重启 profile / 重置错误状态 / 清理孤儿容器 | 更新 CDS 服务本体（`cds` 的 self-update） |
| 灰度环境状态总览（哪些分支在跑、容量、端口） | |

## 触发判定

满足任一即进入本技能：

- 用户说"**部署**到灰度"、"**推送并测试**"、"**看看** cds 报错"、"**重启** api"、"**冒烟**"
- 用户传命令：`/cds-deploy`、`/cds-debug`、`/cds-smoke`
- 已经有 `branchId` 或灰度 URL 出现在上下文里
- 用户在抱怨 deploy 失败、容器跑不起来、401、502、灰度卡死

歧义场景（用户只说"cds"，没说接入也没说调试）→ 让 `cds` 分诊器先反问。

## 快速开始

所有操作走共享的 cdscli（位于 `cds` 技能下，单一来源）：

```bash
CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"

# 一键全链路
$CLI deploy                              # git push + pull + deploy + ready + smoke

# 拆步骤
$CLI branch list                         # 看灰度环境状态
$CLI branch deploy <branchId>            # 触发部署 + 轮询
$CLI branch logs <id> --profile api --tail 200
$CLI branch exec <id> --profile api 'curl -s http://localhost:5000/api/x'
$CLI smoke <branchId>                    # 分层冒烟
$CLI diagnose <branchId>                 # 状态+日志+env+history 一次抓
$CLI help-me-check <branchId>            # diagnose + 根因分析 + 修复建议
```

> 不要手写 curl。CLI 处理了 Cloudflare UA ban、SSE 解析、JSON 嵌套转义、跨 Bash 调用变量丢失。

## 三大场景

### 场景 1：日常迭代部署

```bash
$CLI deploy                              # 单条命令搞定
```

`cdscli deploy` 内部一条龙：`git push → CDS pull → 全量 deploy → 轮询就绪 → smoke`。
单分支不重新 push 只重部署用 `$CLI branch deploy <branchId>`。

> 注：cdscli 走全量 deploy（所有 profile），不做"只改后端就只部署 api"的单 profile
> 拆分。需要单 profile 重建时直接调 API（见 [../cds/reference/api.md](../cds/reference/api.md)
> 的 `POST /api/branches/:id/deploy/:profileId`）。

### 场景 2：部署失败排查

```bash
$CLI help-me-check <branchId>
```

输出示例：

```
=== 诊断报告 [trace:a1b2c3d4] ===

分支: main | 状态: error | API=error Admin=running

【根因】api 容器日志末尾出现：
  error CS0103: The name 'Foo' does not exist in the current context
  → C# 编译错误（Program.cs:42）

【修复建议】
  1. 本地 `dotnet build` 复现错误
  2. 修改后 git push → cdscli deploy

【历史操作】
  最近一次: deploy 失败于 2026-04-18T15:32
  失败步骤: build-api (exit 1)
```

诊断决策树（容器日志 → 根因）详见 [../cds/reference/diagnose.md](../cds/reference/diagnose.md)。

### 场景 3：灰度环境总览

```bash
$CLI --human project list                # 表格视图（--human 是全局选项，放子命令前）
$CLI branch list --project <id>          # 单项目分支
$CLI branch status <branchId>            # 单分支详情
```

输出示例：

```
## 灰度环境状态
**服务器容量**: 3/12 容器运行中

| 分支 | 状态 | API | Admin | 最后访问 |
|------|------|-----|-------|---------|
| claude/fix-xxx | running | :10003 OK | :10004 OK | 5 分钟前 |
```

## 速查表

| 用户说 | CLI 命令 |
|---|---|
| "部署失败了" | `$CLI help-me-check <id>` |
| "容器跑不起来" | `$CLI branch logs <id> --profile api --tail 200` |
| "环境变量是不是少配了" | `$CLI env get --scope <projectId>` + `$CLI branch exec <id> --profile api 'printenv'` |
| "API 返回 401" | 参考 [../cds/reference/auth.md](../cds/reference/auth.md) 双层认证决策树 |
| "灰度什么状态" | `$CLI --human project list` |
| "重启 API" | `$CLI branch deploy <id>`（全量重部署；单 profile 重建调 API `/deploy/:profileId`） |
| "停了不用了" | 调 API `POST /api/branches/:id/stop`，确认不再要再 `DELETE /api/branches/:id`（cdscli 无 branch stop/delete 子命令） |
| "灰度跑的是什么版本" | `$CLI branch status <id>` 看 commitHash + git-log |

## 分层冒烟策略

避免认证问题阻塞整个验证，从无认证到有认证逐层走：

| 层 | 目标 | 命令 |
|---|---|---|
| L1 无认证 | 服务进程在跑 | 直连 `https://<preview>.miduo.org/api/shortcuts/version-check` |
| L2 代码验证 | 改动确实部署上去了 | `$CLI branch exec <id> --profile api 'grep -c NewFunc /app/...'` |
| L3 认证 API | 业务接口通 | 直连预览域名 + `X-AI-Access-Key` + `X-AI-Impersonate: $MAP_AI_USER` |

完整冒烟策略 → [../cds/reference/smoke.md](../cds/reference/smoke.md)

## 预览域名公式（SSOT）

不要凭直觉拼。v3 公式（`cds/src/services/preview-slug.ts:computePreviewSlug`）：

```
有 prefix:  ${tail}-${prefix}-${projectSlug}.miduo.org
无 prefix:  ${tail}-${projectSlug}.miduo.org   (中段省略)
```

- `tail` = 分支名第一个 `/` 之后（slugify：小写 + 非 `[a-z0-9-]` 转 `-`）
- `prefix` = 第一个 `/` 之前（claude / feat / fix），无 `/` 时无 prefix
- `projectSlug` = CDS 项目 slug，从 `/api/projects` 取

详见 [../cds/reference/api.md](../cds/reference/api.md)，或调 `/preview-url` 技能。

## 关联技能

| 想做什么 | 走哪个 |
|---|---|
| 新项目首次接入 CDS / 生成 compose | `cds-project-scan` |
| 配置 `AI_ACCESS_KEY` / 旋转项目 Key | `cds` |
| CDS 服务本体变更后重启 | `cds` 的 `cdscli self update` |
| 反馈 CDS bug / 提 issue | `auto-fix-issues` 技能（`/audit`） |

## 参考索引（按需加载）

所有 reference 文档都在 `cds` 技能下复用，不重复维护：

| 文件 | 何时读 |
|---|---|
| [../cds/reference/api.md](../cds/reference/api.md) | CLI 未覆盖、需要直接调 API |
| [../cds/reference/auth.md](../cds/reference/auth.md) | 401 / 403 排查 |
| [../cds/reference/smoke.md](../cds/reference/smoke.md) | 冒烟策略 + container-exec 转义陷阱 |
| [../cds/reference/diagnose.md](../cds/reference/diagnose.md) | 容器日志 → 根因决策树 |
