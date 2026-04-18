---
name: cds
description: CDS (Cloud Dev Space) 全生命周期管理技能。一个技能覆盖：项目扫描生成 compose YAML、Agent 鉴权（静态 key / 配对 / 项目 key）、推送部署到灰度、等待就绪、分层冒烟测试、故障诊断自动排查。内置 cdscli Python CLI 封装所有 CDS REST API，告别 curl+bash 转义地狱。可从 CDS Dashboard 一键下载贴到任意项目。触发词："cds"、"部署"、"灰度"、"扫描项目"、"容器报错"、"帮我看看 cds"、"/cds"、"/cds-deploy"、"/cds-scan"、"/cds-smoke"、"apply to cds"。
---

# CDS — 全生命周期 Agent 技能

> **一个技能覆盖**：Scan → Auth → Deploy → Ready → Smoke → Diagnose
>
> **跨项目便携**：从 CDS Dashboard 一键下载，解压到 `你的项目/.claude/skills/cds/` 即可用

## 🪪 你是哪种身份

这个技能有两条不同的工作流，先确认你是哪一种：

| 身份 | 典型动作 | 看哪篇 |
|------|---------|--------|
| **消费方**（下载了这个技能到自己项目） | `cdscli init` / `cdscli deploy` / `cdscli update` 升级 | 继续往下读，或 [reference/drop-in.md](reference/drop-in.md) |
| **维护者**（`inernoro/prd_agent` 仓库所有者） | 改 `cli/cdscli.py` / 改 `reference/*.md` / bump VERSION / push | 直奔 [reference/maintainer.md](reference/maintainer.md)，本文可略读 |

> 维护者会被误导到"自己重新下载自己的技能"这种荒谬路径，这里提醒一下：
> 你就是技能源头，直接编辑 `.claude/skills/cds/` 下的文件就行，
> commit+push 后别人通过 `cdscli update` 或 📦 拿到新版。**没有发布流程**。

## 目录

- [快速开始（三种场景）](#快速开始三种场景)
- [CLI 总览](#cli-总览)
- [环境初始化（init 向导）](#环境初始化init-向导)
- [核心工作流](#核心工作流)
- [故障诊断](#故障诊断)
- [参考文档索引](#参考文档索引)
- [为什么合并了三个技能](#为什么合并了三个技能)

## 快速开始（三种场景）

**场景 A：你在 PRD Agent 仓库内部开发**
```bash
$CLI auth check && $CLI deploy
```
一行搞定：认证自检 → git push → CDS pull → deploy → readiness → smoke。

**场景 B：你刚下载这个技能到别的项目**（首次）
```bash
$CLI init                         # 交互式配置 CDS_HOST + AI_ACCESS_KEY
$CLI scan --apply-to-cds <projectId>   # 扫描本地，生成 compose，提交 CDS 审批
```

**场景 C：用户说"帮我看看 cds 报错了"**
```bash
$CLI help-me-check <branchId>     # 自动抓状态+日志+env+history，分析根因给出修复建议
```

其中 `$CLI = python3 .claude/skills/cds/cli/cdscli.py`。建议在用户的 `.bashrc` 加 alias：
```bash
alias cdscli='python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py'
```

## CLI 总览

所有 CDS 操作走 CLI，不要手写 curl。CLI 内部处理了：
- Cloudflare 1010 UA ban（统一 `curl/8.5.0` UA）
- SSE 流解析（self-update / deploy）
- JSON 嵌套转义（container-exec 命令塞 curl）
- 跨 Bash 调用变量丢失（CLI 自包含）
- 统一错误码 + `{ok, data|error, trace}` JSON 输出

```
cdscli <命令族> <子命令> [参数] [--human|--json] [--trace XXX]

命令族:
  auth       check              验证凭据
  init                          env 向导（首次 drop-in）
  project    list|show|stats
  branch     list|status|deploy|stop|logs|exec|history
  env        get|set             scope 感知（_global / <projectId> / _all）
  self       branches|update    CDS 自更新
  global-key list|create|revoke 全局 bootstrap key
  key        list|create|revoke 项目级 cdsp_* key
  scan       [--apply-to-cds]   扫本地项目 → 生成 compose YAML → (可选) POST 到 CDS
  deploy                        完整流水线 (push + pull + deploy + ready + smoke)
  smoke      <branchId>         分层冒烟（L1 无认证 / L2 代码 / L3 认证 API）
  diagnose   <branchId>         一键抓状态+日志+env+history
  help-me-check <branchId>      diagnose + 根因分析 + 修复建议
  watch                         SSE activity stream 实时流
```

完整 help：`cdscli --help` 或 `cdscli <cmd> --help`。

## 环境初始化（init 向导）

首次在新项目用这个技能时，运行 `cdscli init`：

```
$ cdscli init

=== CDS 初始化向导 ===

Step 1/3: CDS 地址
  当前: (未设置)
  输入 CDS 地址（如 cds.miduo.org，不带 https://）:
  > cds.miduo.org
  ✓ 已写入 ~/.cdsrc: CDS_HOST=cds.miduo.org

Step 2/3: 认证方式
  (A) 静态 AI_ACCESS_KEY        ← 已配置 `process.env.AI_ACCESS_KEY`
  (B) 动态配对（Dashboard 批准）  ← 无需密钥，但要用户去浏览器点一下
  (C) 项目级 cdsp_* 通行证       ← 需要用户从项目页复制 "授权 Agent" 按钮产出
  选择 [A/B/C]: A

  ⏳ 用 CDS_HOST=cds.miduo.org + AI_ACCESS_KEY 跑 /api/config ...
  ✓ 认证通过（via AI_ACCESS_KEY）

Step 3/3: 首个目标项目（可选，不填就用 legacy）
  可用项目: legacy, prd-agent-2
  输入 projectId: prd-agent-2
  ✓ 已写入 CDS_PROJECT_ID=prd-agent-2

初始化完成。下一步推荐:
  cdscli scan --apply-to-cds prd-agent-2    # 扫描本地项目生成 CDS compose
  cdscli deploy                             # 或直接推送当前分支部署
```

Init 产出两个文件（可选）：
- `~/.cdsrc`（`source ~/.cdsrc` 加入 shell profile 即可持久化）
- `.cds.env`（项目本地 `.gitignore`），方便项目级覆盖

## 核心工作流

### 工作流 1：首次扫描部署（新项目接入 CDS）

```
cdscli init                                     # 配置 env
cdscli scan --apply-to-cds <projectId>          # 扫描 + 提交待审批
# 用户到 Dashboard 批准 → 基础设施自动创建
cdscli deploy                                   # 推代码 + 部署
cdscli smoke <branchId>                         # 冒烟确认
```

### 工作流 2：迭代部署（日常）

```
cdscli deploy                                   # 一句话搞定全链路
```

内部等价于：
```
git push → cdscli branch pull <id> → cdscli branch deploy <id>
                                  → 轮询状态
                                  → cdscli smoke <id>
```

### 工作流 3：故障排查（用户说"帮我看看"）

```
cdscli help-me-check <branchId>
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

## 故障诊断

完整决策树 → [reference/diagnose.md](reference/diagnose.md)

速查：

| 用户说 | CLI 命令 |
|--------|----------|
| "部署失败了" | `cdscli help-me-check <id>` |
| "容器跑不起来" | `cdscli branch logs <id> --profile api --tail 200` |
| "环境变量是不是少配了" | `cdscli env get --scope <projectId>` + `cdscli branch exec <id> --profile api 'printenv'` |
| "API 返回 401" | 参考 [reference/auth.md](reference/auth.md) 双层认证决策树 |
| "灰度什么状态" | `cdscli project list --human` |

## 参考文档索引

按需加载，不要一次全读：

| 文件 | 何时读 |
|------|--------|
| [reference/api.md](reference/api.md) | 需要直接调 API（CLI 未覆盖场景） |
| [reference/auth.md](reference/auth.md) | 401 / 403 / 双层认证架构 |
| [reference/scan.md](reference/scan.md) | 扫描规则、compose YAML 契约 |
| [reference/smoke.md](reference/smoke.md) | 分层冒烟策略、预览域名 vs container-exec |
| [reference/diagnose.md](reference/diagnose.md) | 容器日志模式 → 根因决策树 |
| [reference/drop-in.md](reference/drop-in.md) | 新项目接入完整步骤 + 常见问题 |

## 为什么合并了三个技能

旧：
- `cds-project-scan`（扫描项目生成 YAML）
- `cds-deploy-pipeline`（推送部署 + 诊断）
- `smoke-test`（生成冒烟 curl 链）

三个技能都以 CDS 为中心，但上下文互不通气：
- 扫描后要手工切到部署技能
- 部署报错后冒烟技能不知道 branchId
- 用户记不住哪个触发词对哪个功能

合并之后：**一个技能 + 一个 CLI + 一组 reference**，用户一句话覆盖从"我有个新项目"到"凌晨 3 点报错了"整条链路。

**禁止退化**：遇到 CLI 未覆盖的需求，优先给 CLI 加命令，而不是写一次性 curl 脚本 patch。

---

> 可下载性：CDS Dashboard 项目设置页有 **「📦 下载 cds 技能包」** 按钮（/api/export-skill 端点），会把本目录 tar.gz 成 `cds-skill-<timestamp>.tar.gz` 让用户解压到自己项目的 `.claude/skills/cds/`。
