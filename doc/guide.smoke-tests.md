# 冒烟测试 · 指南

> Phase 2 交付物 —— 部署后快速验证关键链路是否跑通。

---

## 作用

CDS 灰度环境部署完成并不等于业务可用：镜像能起来，但 Controller 可能被我改坏了、LLM Gateway 可能 401、数据库可能被环境变量错拼导致连接失败。Phase 2 的冒烟脚本用 **真实 curl 打真实预览域名**，在几十秒内发现这些"容器绿、接口红"的情况，是介于单元测试和真人 UAT 之间的一层。

不是为了取代 UAT，而是为了让每次 `/cds-deploy` 之后人类不用自己去点 10 个页面。

---

## 文件清单

| 文件 | 作用 |
|------|------|
| `scripts/smoke-lib.sh` | 共享辅助：curl/jq 封装、断言、重试、日志格式 |
| `scripts/smoke-health.sh` | 连通 + 鉴权（含 2 条负向测试：无效 key / 缺 impersonate） |
| `scripts/smoke-prd-agent.sh` | PRD Agent 链路：Group → Session → Run → 轮询 Completed |
| `scripts/smoke-defect-agent.sh` | 缺陷 CRUD + 讨论消息追加 |
| `scripts/smoke-report-agent.sh` | 团队/模板/周报 CRUD |
| `scripts/smoke-cds-agent-runtime-status.sh` | CDS Agent runtime pool：验证 MAP runtime-status、sidecar discovery、`/readyz` healthy 与 `loopOwner=claude-agent-sdk`；不触发模型 run |
| `scripts/smoke-cds-agent-profile-templates.sh` | CDS Agent runtime profile 模板与 adapter 兼容矩阵：验证 MAP 后端暴露 Anthropic 官方 Claude Agent SDK profile 模板，并声明官方 SDK / legacy / Codex-like 边界 |
| `scripts/smoke-cds-agent-profile-preflight.sh` | CDS Agent profile preflight：验证不兼容默认 profile 会在 `SendMessage` 前被 `runtime_profile_incompatible` 拦截，且不会写入消息或入队 |
| `scripts/smoke-cds-agent-official-sdk-run.sh` | CDS Agent official SDK S1 run：默认只做 readiness；显式允许 provider 调用后才创建临时只读审查会话并等待 assistant 响应 |
| `scripts/smoke-cds-agent-official-sdk-controls.sh` | CDS Agent official SDK S2/S3 controls：默认只做 readiness；显式允许 provider 调用后才验证 MAP 审批和 Stop |
| `scripts/smoke-all.sh` | 串行执行所有冒烟，汇总 pass/fail/skip |

---

## 快速上手

### 1. 本地跑

```bash
# 环境变量三件套
export SMOKE_TEST_HOST=https://my-branch.miduo.org
export AI_ACCESS_KEY='xxx'       # prd-api 的 X-AI-Access-Key
export SMOKE_USER=admin          # 假冒的用户 login

# 一把梭
bash scripts/smoke-all.sh
```

输出长这样：

```
##########################################
# PRD Agent 大全套冒烟测试 (smoke-all.sh)
##########################################
==========================================
冒烟测试: Health & Auth
目标:     https://my-branch.miduo.org
用户:     admin (impersonate)
==========================================

>>> [1/4] 验证 prd-api 可达 (带 3 次指数退避重试)
✅ HTTP 可达
...
##########################################
# 冒烟测试汇总 (总耗时 37 秒)
##########################################
✅ 通过: 6 项
    · Health & Auth
    · CDS Agent Runtime
    · CDS Agent Profile Preflight
    · PRD Agent
    · Defect Agent
    · Report Agent
❌ 失败: 0 项
⏭  跳过: 0 项
```

### 2. 只跑一两个子冒烟

```bash
# 只跑 health + prd-agent，跳过 CDS Agent + defect + report
SMOKE_SKIP=cds-agent-runtime,cds-agent-templates,cds-agent-preflight,defect,report bash scripts/smoke-all.sh

# 或单独跑
bash scripts/smoke-health.sh
bash scripts/smoke-prd-agent.sh

# CDS Agent official SDK 真实 run 前的控制面 readiness + profile preflight 闸门
bash scripts/smoke-cds-agent-runtime-status.sh
bash scripts/smoke-cds-agent-profile-templates.sh
bash scripts/smoke-cds-agent-profile-preflight.sh

# 配好真实 Claude/Anthropic profile 后，先只做 readiness
bash scripts/smoke-cds-agent-official-sdk-run.sh

# 明确允许消耗 provider token 后，再跑 S1 只读 official SDK 真运行
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-run.sh

# 再跑 S2 审批 + S3 Stop 控制面真运行
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh
```

### 3. CI fail-fast 模式

```bash
SMOKE_FAIL_FAST=1 bash scripts/smoke-all.sh
```

首个失败的子冒烟就直接退出，不继续跑后续 —— CI 里节省分钟级的算力。

### 4. 开启详细日志

```bash
SMOKE_VERBOSE=1 bash scripts/smoke-all.sh
```

会打印每步的 JSON 响应关键字段，排查失败时用。

---

## 环境变量参考

| 变量 | 默认 | 说明 |
|------|------|------|
| `SMOKE_TEST_HOST` | `http://localhost:5000` | 目标根 URL，支持 CDS 预览子域名 |
| `AI_ACCESS_KEY` | **必填** | prd-api 校验的 `X-AI-Access-Key` 值 |
| `SMOKE_USER` | `admin` | 被假冒的用户 login（必须在 users 集合存在） |
| `SMOKE_TIMEOUT` | `20` | 单次 curl 超时秒数 |
| `SMOKE_VERBOSE` | _(空)_ | 非空时打印完整 JSON 响应摘要 |
| `SMOKE_SKIP` | _(空)_ | 逗号/空格分隔要跳过的 key（`health`/`cds-agent-runtime`/`cds-agent-templates`/`cds-agent-preflight`/`prd-agent`/`defect`/`report`） |
| `SMOKE_FAIL_FAST` | _(空)_ | 非空时首次失败即退出 |
| `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL` | _(空)_ | official SDK run/control 脚本专用；设为 `1` 才真实发送 prompt |
| `SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE` | _(空)_ | 默认 profile 不兼容时是否失败；默认只跳过 provider run |
| `SMOKE_CDS_AGENT_REPO` | `inernoro/prd_agent` | S1 只读审查目标仓库 |
| `SMOKE_CDS_AGENT_REF` | `main` | S1 只读审查目标 ref |
| `SMOKE_CDS_AGENT_POLL_SECONDS` | `120` | 等待 assistant 消息或 failed 状态的秒数 |

`smoke-cds-agent-runtime-status.sh` 还要求目标环境已配置共享 CDS sidecar discovery，或
通过 `CLAUDE_SIDECAR_BASE_URL` / `CLAUDE_SIDECAR_TOKEN` 配好静态 official SDK
sidecar。该脚本只读 `runtime-status`，不会消耗模型 provider token。

`smoke-cds-agent-profile-templates.sh` 只读 MAP 模板与 adapter compatibility API，
确认 Anthropic 官方 profile 模板仍由后端提供，并声明兼容 `claude-agent-sdk`；
同时确认模板创建入口缺 API key 时返回 `api_key_required`，不会保存半成品 profile；
还会确认普通 `deepseek/*` 这类 OpenAI-compatible profile 不应误路由到官方 SDK，
以及 `codex` 仍是 planned-not-routable。它不会保存 API key，也不会创建 runtime profile。

`smoke-cds-agent-profile-preflight.sh` 会在默认 profile 不兼容 `claude-agent-sdk`
时创建一个临时 idle session，断言 `SendMessage` 返回 `runtime_profile_incompatible`，
再确认消息数仍为 0 并归档临时 session。它不触发模型 provider 调用；如果默认
profile 已兼容 Claude/Anthropic，该脚本会跳过不兼容分支。

`smoke-cds-agent-official-sdk-run.sh` 是 S1 真运行入口。默认只确认 runtime pool
和默认 profile 兼容性，不会发送 prompt；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1`
后才创建临时会话、启动 runtime、发送只读审查 prompt，并等待 assistant 消息。
如果默认 profile 仍是普通 OpenAI-compatible 模型，它会跳过；设置
`SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1` 时则直接失败，适合配置好 Anthropic key
后的验收环境。

`smoke-cds-agent-official-sdk-controls.sh` 是 S2/S3 真控制入口。默认同样只做
readiness；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 后会触发一次危险工具
审批 prompt，等待 `tool_call.status=waiting`，调用 MAP `tool-approvals/{id}`
拒绝审批并确认 `tool_result.source=map-tool-approval`；随后创建长任务会话并调用
`stop`，确认 MAP 接受停止请求。该脚本会触发 provider 调用和临时会话，只应在
真实 Claude/Anthropic profile 已配置后运行。

---

## 集成到 CI

### 手动触发（已配置）

`.github/workflows/ci.yml` 里新增了 `smoke-preview` job，只在 `workflow_dispatch`（手动触发）时跑。入口参数：
- `host`：预览域名 URL（例：`https://my-branch.miduo.org`）

在 GitHub Actions → CI → Run workflow 里填好 `host` 即可。`AI_ACCESS_KEY` 走 repo secret，名字同名。

**为什么只做手动触发而不是每 PR 自动跑？**
- 自动冒烟需要目标 URL，而 CDS 灰度部署是 `/cds-deploy` 触发的独立链路
- 强行在 CI 里拉起一个完整 CDS 会把 PR 时长拖到 10 分钟以上
- Phase 3 计划把这一步塞进 `/cds-deploy` 完成后的 hook，而不是在 GitHub Actions 里

### 和 `/cds-deploy` 联动（建议）

部署流程示意：

```
PR commit
   ↓
/cds-deploy (CDS skill)
   ↓ 绿灯
bash scripts/smoke-all.sh (host=branch 预览域名)
   ↓ 绿灯
真人 /uat 验收
```

---

## 设计约束

### 数据清洁

每个子冒烟在结束时 **best-effort** 删除自己创建的测试数据（Group/Session/Defect/Team/Report）。即便删除失败，残留数据的 `title` 字段也会带 `smoke-<时间戳>` 前缀，方便 DBA 批量清理。

不要在生产环境跑包含写操作的冒烟 —— 虽然数据可标识，但 LLM 真实调用会消耗真实配额，建议只在 CDS 预览环境/灰度跑。

### 错误处理

- 每个子脚本都用 `set -euo pipefail`，任何 curl 失败/断言失败都会立刻退出
- `smoke-all.sh` 默认 **不 fail-fast**，让一次跑完能看到所有问题
- 失败的步骤会打到 stderr（`❌ xxx`），成功打到 stdout（`✅ xxx`），便于 CI 日志过滤

### 扩展新 Agent

在 `scripts/` 下加 `smoke-<name>-agent.sh`，以现有脚本为模板：

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=N
smoke_init "Your Agent Name"

smoke_step "做某事"
resp=$(smoke_post /api/your-agent/xxx '{"foo":"bar"}')
id=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$id" "id"
smoke_ok "ok"

smoke_done
```

然后在 `smoke-all.sh` 的 `SMOKES` 数组追加一行：

```bash
"your-agent|$SCRIPT_DIR/smoke-your-agent.sh|Your Agent Name"
```

---

## 限制与不做

- ❌ **不测 LLM 响应质量** —— 只测 Controller 接 LLM Gateway 的链路是否畅通
- ❌ **不测 UI 渲染** —— Phase 3 (Playwright + Bridge) 负责
- ❌ **不替代单元测试** —— `dotnet test` / `pnpm test` 仍然是代码级正确性的门禁
- ❌ **不在 CI 自动跑** —— 需要真实部署环境，走手动或 `/cds-deploy` hook

---

## 相关文档

- `.claude/skills/smoke-test/SKILL.md` —— `/smoke` 技能定义
- `.claude/rules/cds-first-verification.md` —— CDS 优先验证原则
- `.claude/rules/e2e-verification.md` —— 端到端验收原则
- `doc/plan.cds-status.md` —— CDS 当前状态看板(Phase 2 已并入主进度)
