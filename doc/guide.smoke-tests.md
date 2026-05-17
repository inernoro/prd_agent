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
| `scripts/smoke-cds-agent-sidecar-alias-stability.sh` | CDS Agent sidecar alias 稳定性：通过 `cdscli branch exec` 从 API 容器内连续访问 sidecar `/readyz`，防止 stale DNS alias 命中新旧 sidecar |
| `scripts/smoke-cds-agent-profile-templates.sh` | CDS Agent runtime profile 模板与 adapter 兼容矩阵：验证 MAP 后端暴露 Anthropic 官方 Claude Agent SDK profile 模板，并声明官方 SDK / legacy / Codex-like 边界 |
| `scripts/smoke-cds-agent-official-sdk-boundary.sh` | CDS Agent official SDK 本地边界：不调远程、不耗 provider token，断言默认 adapter 是 `claude-agent-sdk`，官方 adapter 使用 `ClaudeSDKClient`，且没有重新实现 Anthropic/OpenAI chat loop |
| `scripts/smoke-cds-agent-profile-preflight.sh` | CDS Agent profile preflight：验证不兼容默认 profile 会在 `SendMessage` 前被 `runtime_profile_incompatible` 拦截，且不会写入消息或入队 |
| `scripts/smoke-cds-agent-official-sdk-run.sh` | CDS Agent official SDK S1 run：默认只做 readiness；显式允许 provider 调用后才创建临时只读审查会话并等待 assistant 响应 |
| `scripts/smoke-cds-agent-official-sdk-controls.sh` | CDS Agent official SDK S2/S3 controls：默认只做 readiness；显式允许 provider 调用后才验证 MAP 审批和 Stop |
| `scripts/doctor-cds-agent-runtime.sh` | CDS Agent runtime doctor：汇总 runtime-status、sidecar alias、默认 profile 兼容性、官方模板、adapter 矩阵，并给出下一步最小验收命令；可输出 JSON 诊断包 |
| `scripts/smoke-cds-agent-commercial-readiness.sh` | CDS Agent 商业级 readiness 总账：不调用 provider，审计 R0/R1/T1/S1/S2/S3/V1 当前证据和 pending gate |
| `scripts/smoke-cds-agent-one-cycle.sh` | CDS Agent 一个周期最小闭环：按 doctor/R0/A0/R1/S1/S2/S3/V1/N6 顺序串联脚本，保存日志、JSON 报告和视觉截图 |
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
    · CDS Agent Runtime Profile Templates
    · CDS Agent Profile Preflight
    · CDS Agent Commercial Readiness
    · PRD Agent
    · Defect Agent
    · Report Agent
❌ 失败: 0 项
⏭  跳过: 0 项
```

### 2. 只跑一两个子冒烟

```bash
# 只跑 health + prd-agent，跳过 CDS Agent + defect + report
SMOKE_SKIP=cds-agent-runtime,cds-agent-templates,cds-agent-preflight,cds-agent-readiness,cds-agent-s1,cds-agent-controls,defect,report bash scripts/smoke-all.sh

# 或单独跑
bash scripts/smoke-health.sh
bash scripts/smoke-prd-agent.sh

# CDS Agent official SDK 真实 run 前的控制面 readiness + profile preflight 闸门
bash scripts/smoke-cds-agent-runtime-status.sh
bash scripts/smoke-cds-agent-profile-templates.sh
bash scripts/smoke-cds-agent-profile-preflight.sh

# 不确定卡在哪里时，先跑 doctor。它不会触发 provider 调用。
bash scripts/doctor-cds-agent-runtime.sh

# 检查自研 agent loop 是否仍被压缩在显式 fallback 里。它不需要鉴权。
bash scripts/smoke-cds-agent-official-sdk-boundary.sh

# 想看"离商业级上手可用还差什么"时，跑 readiness audit。它不会触发 provider 调用。
bash scripts/smoke-cds-agent-commercial-readiness.sh

# 验收环境希望 R1 profile 不兼容时直接失败，可以打开硬门禁。
SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1 bash scripts/smoke-cds-agent-commercial-readiness.sh

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
| `SMOKE_SKIP` | _(空)_ | 逗号/空格分隔要跳过的 key（`health`/`cds-agent-runtime`/`cds-agent-sidecar-alias`/`cds-agent-templates`/`cds-agent-preflight`/`cds-agent-readiness`/`cds-agent-s1`/`cds-agent-controls`/`prd-agent`/`defect`/`report`） |
| `SMOKE_FAIL_FAST` | _(空)_ | 非空时首次失败即退出 |
| `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL` | _(空)_ | official SDK run/control 脚本专用；设为 `1` 才真实发送 prompt |
| `SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE` | _(空)_ | 默认 profile 不兼容时是否失败；默认只跳过 provider run |
| `SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL` | _(空)_ | `smoke-cds-agent-commercial-readiness.sh` 专用；设为 `1` 时 R1 profile 不兼容/缺 key 直接失败 |
| `SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES` | `3` | CDS Agent runtime-status R0/readiness 短重试次数；用于部署刚切换时 `/readyz` 健康状态短暂抖动 |
| `SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS` | `3` | CDS Agent runtime-status R0/readiness 每次重试间隔秒数 |
| `SMOKE_CDS_BRANCH_ID` | `prd-agent-codex-cds-agent-workbench-ui` | sidecar alias stability 专用；要 exec 的 CDS branch id |
| `SMOKE_CDS_AGENT_API_PROFILE` | `api-prd-agent` | sidecar alias stability 专用；从哪个 API 容器内访问 sidecar alias |
| `SMOKE_CDS_AGENT_SIDECAR_ALIAS` | `claude-agent-sdk-runtime-v2-prd-agent` | sidecar alias stability 专用；被 API 容器访问的 sidecar DNS alias |
| `SMOKE_CDS_AGENT_ALIAS_ATTEMPTS` | `6` | sidecar alias stability 专用；连续 `/readyz` 采样次数 |
| `SMOKE_CDS_AGENT_WORKBENCH_URL` | _(空)_ | readiness audit 专用；指定需要检查 HTTP 200 的 `/cds-agent` 页面 URL |
| `SMOKE_CDS_AGENT_READINESS_REPORT` | _(空)_ | readiness audit 专用；指定 JSON 报告输出路径，便于 CI、诊断包或页面消费 |
| `SMOKE_CDS_AGENT_DOCTOR_REPORT` | _(空)_ | doctor / one-cycle 专用；指定 JSON 诊断包输出路径，包含 diagnosis、nextRecommended、aliasCheck、默认 profile 和 adapter compatibility |
| `SMOKE_CDS_AGENT_BOUNDARY_REPORT` | _(空)_ | official SDK boundary / one-cycle 专用；指定本地 adapter 边界 JSON 报告输出路径，包含默认 adapter、legacy fallback 和 adapter 行数证据 |
| `SMOKE_CDS_AGENT_LOGIN_USERNAME` / `SMOKE_CDS_AGENT_LOGIN_PASSWORD` | _(空)_ | workbench visual 专用；用于登录并生成前端 JWT |
| `SMOKE_CDS_AGENT_ACCESS_TOKEN` | _(空)_ | workbench visual 专用；已有 JWT 时可替代用户名密码 |
| `SMOKE_CDS_AGENT_SCREENSHOT` | `/tmp/cds-agent-workbench-visual.png` | workbench visual 专用；截图输出路径 |
| `SMOKE_CDS_AGENT_S1_REPORT` | _(空)_ | S1 official SDK run 专用；指定 JSON 证据报告输出路径 |
| `SMOKE_CDS_AGENT_REPO` | `inernoro/prd_agent` | S1 只读审查目标仓库 |
| `SMOKE_CDS_AGENT_REF` | `main` | S1 只读审查目标 ref |
| `SMOKE_CDS_AGENT_POLL_SECONDS` | `120` | 等待 assistant 消息或 failed 状态的秒数 |

`smoke-cds-agent-runtime-status.sh` 还要求目标环境已配置共享 CDS sidecar discovery，或
通过 `CLAUDE_SIDECAR_BASE_URL` / `CLAUDE_SIDECAR_TOKEN` 配好静态 official SDK
sidecar。该脚本只读 `runtime-status`，不会消耗模型 provider token。

如果 R0 偶发在 `healthyCount=0` 和 `healthyCount=1` 之间跳，先跑 sidecar alias 稳定性：

```bash
CDS_HOST=https://cds.miduo.org \
AI_ACCESS_KEY=xxx \
bash scripts/smoke-cds-agent-sidecar-alias-stability.sh
```

它不是模型 smoke；它从 API 容器内部连续访问
`http://claude-agent-sdk-runtime-v2-prd-agent:7400/readyz`。所有采样都必须是
`ready=true`、`agentAdapter=claude-agent-sdk`、`loopOwner=claude-agent-sdk`。如果任意一次
返回旧版 `/readyz` 503，说明 CDS/Docker DNS alias 仍污染，需要更换唯一 profile alias
或清理 stale service。

`smoke-cds-agent-profile-templates.sh` 只读 MAP 模板与 adapter compatibility API，
确认 Anthropic 官方 profile 模板仍由后端提供，并声明兼容 `claude-agent-sdk`；
同时确认模板创建入口缺 API key 时返回 `api_key_required`，不会保存半成品 profile；
还会确认普通 `deepseek/*` 这类 OpenAI-compatible profile 不应误路由到官方 SDK，
以及 `codex`、`openai-agents-sdk`、`google-adk` 仍是 planned-not-routable。它不会保存
API key，也不会创建 runtime profile。

`smoke-cds-agent-official-sdk-boundary.sh` 是本地代码边界 smoke，不需要
`AI_ACCESS_KEY`，不会访问 CDS，也不会触发 provider 调用。它检查 sidecar 默认
adapter 仍是 `claude-agent-sdk`，官方 adapter 仍使用 `ClaudeSDKClient` /
`ClaudeAgentOptions` / SDK MCP / `can_use_tool`，并且没有在官方 adapter 里重新
引入 `AsyncAnthropic`、`client.messages.stream` 或 OpenAI-compatible
`chat/completions` loop。one-cycle 会把它的 JSON 写入
`official-sdk-boundary-report.json`，用于证明“压缩自研 loop”的方向没有回退。

`smoke-cds-agent-profile-preflight.sh` 会在默认 profile 不兼容 `claude-agent-sdk`
时创建一个临时 idle session，断言 `SendMessage` 返回 `runtime_profile_incompatible`，
再确认消息数仍为 0 并归档临时 session。它不触发模型 provider 调用；如果默认
profile 已兼容 Claude/Anthropic，该脚本会跳过不兼容分支。

`smoke-all.sh` 默认会运行 `smoke-cds-agent-commercial-readiness.sh`。默认模式下，
commercial readiness 有 pending gate 时仍返回 0，因此它会出现在 smoke-all 的
通过列表里；判断商业级完成度要看该脚本输出的 `Pending gates` 或
`SMOKE_CDS_AGENT_READINESS_REPORT` JSON，而不是只看 smoke-all 的退出码。

`smoke-cds-agent-official-sdk-run.sh` 是 S1 真运行入口。默认只确认 runtime pool
和默认 profile 兼容性，不会发送 prompt；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1`
后才创建临时会话、启动 runtime、发送只读审查 prompt，并等待 assistant 消息。
如果默认 profile 仍是普通 OpenAI-compatible 模型，它会跳过；设置
`SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1` 时则直接失败，适合配置好 Anthropic key
后的验收环境。
真调用成功后，它还会断言 `runtime_init.loopOwner=claude-agent-sdk`、
`sdkLoopEnabled=true`、workspace 已按 `SMOKE_CDS_AGENT_REPO/REF` 准备完成，并且
S1 只读审查没有触发 `Bash/Edit/Write` 这类危险审批。设置
`SMOKE_CDS_AGENT_S1_REPORT=/tmp/cds-agent-s1.json` 可输出 sessionId、traceId、
repo/ref、runtime_init 和 assistant 摘要，用作商业级验收证据；当 profile
不兼容或仅 readiness 模式跳过真调用时，也会输出跳过原因和默认 profile 信息。

`smoke-cds-agent-official-sdk-controls.sh` 是 S2/S3 真控制入口。默认同样只做
readiness；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 后会触发一次危险工具
审批 prompt，等待 `tool_call.status=waiting`，调用 MAP `tool-approvals/{id}`
拒绝审批并确认 `tool_result.source=map-tool-approval`；随后创建长任务会话并调用
`stop`，确认 MAP 接受停止请求。该脚本会触发 provider 调用和临时会话，只应在
真实 Claude/Anthropic profile 已配置后运行。

`doctor-cds-agent-runtime.sh` 是排障入口，不替代 smoke gate。它会读取
`runtime-status`、默认 runtime profile、后端官方模板和 adapter 兼容矩阵；设置
`CDS_HOST` 时还会从远程 API 容器内连续采样 sidecar DNS alias，然后按
当前状态输出下一步命令：
- runtime pool 未就绪时，优先修 CDS discovery / static sidecar / `/readyz`
- 默认 profile 不兼容或缺 key 时，提示用 Anthropic official template 创建默认 profile
- 默认 profile 已兼容时，提示先跑 readiness，再显式设置
  `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 跑 S1/S2/S3 真调用

这条脚本的定位是"把问题定位到下一条命令"，所以它默认不失败于
`instanceCount=0` 这类业务配置缺口；真正的验收仍看 runtime/profile/S1/controls
smoke gate 是否通过。

如果需要把 doctor 结果放进执行面板或诊断包：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_DOCTOR_REPORT=/tmp/cds-agent-doctor.json \
  bash scripts/doctor-cds-agent-runtime.sh
```

报告会包含 `diagnosis`、`nextRecommended`、`runtime`、`aliasCheck`、
`defaultProfile`、`officialTemplate` 和 `adapterCompatibility`。当前远程 preview 的
典型阻塞会表现为 `aliasCheck.status=stable`、`loopOwner=claude-agent-sdk`，但
`defaultProfile.compatibleWithDesiredRuntimeAdapter=false`；这说明应先修 R1 profile，
而不是继续改页面。

`smoke-cds-agent-commercial-readiness.sh` 是验收总账入口，不触发 provider 调用。
它会检查：
- R0：MAP/CDS runtime pool、healthy sidecar、`loopOwner=claude-agent-sdk`
- R1：默认 runtime profile 是否兼容官方 SDK 且已有 API key
- T1：官方 Anthropic profile 模板与 adapter compatibility API 是否由后端提供，并确认
  `codex`、`openai-agents-sdk`、`google-adk` 这些候选不会被静默标成可路由
- S1/S2/S3：当前是否已经解除 provider 真调用的前置阻塞，并打印下一步命令
- V1：`/cds-agent` 页面是否返回 HTTP 200

该脚本还会校验 `runtime-status.diagnostics.executionPanel`。这是后端生成的执行面板事实源，用来统一页面、CI 和人工排障的当前阻塞门、阻塞原因、下一条命令和 gate 计数，避免前端与 smoke 各自推导出不同结论。

默认模式下，R1/S1/S2/S3 不满足时会列为 pending，但脚本仍可完成，用于说明当前离
商业级可用还差什么。验收环境应设置 `SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1`，
这样默认 profile 不兼容或缺 key 时会直接失败。即便该脚本全绿，仍需要显式运行
`SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 的 S1/S2/S3 脚本来证明真实代码审查、
MAP 审批和 Stop 都已通过。

如果需要把结果带进 CI artifact 或诊断包：

```bash
SMOKE_CDS_AGENT_READINESS_REPORT=/tmp/cds-agent-readiness.json \
  bash scripts/smoke-cds-agent-commercial-readiness.sh
```

报告会包含 `overall`、runtime pool、默认 profile、页面 HTTP 状态、R0/R1/T1/S1S2S3/V1
gate 状态和 pending 列表；不会包含 API key。
如果同时设置 `SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1`，脚本会在失败前先写出报告；
此时失败点之后尚未执行的 gate 会显示为 `unknown`。

`smoke-cds-agent-workbench-visual.sh` 是更强的 V1 视觉入口。它需要真实登录 token
或用户名密码，不调用 provider，只用 headless Chrome 打开 `/cds-agent`，把 JWT 注入
前端持久化 auth store，等待页面出现 `Runtime 调试`、`商业级 READINESS LEDGER` 和
`下一周期最小闭环`，然后保存截图。它用于证明用户看到的是 authenticated workbench
和 runtime 诊断面板，而不是仅仅 `HEAD /cds-agent = 200`。

```bash
SMOKE_CDS_AGENT_LOGIN_USERNAME=admin \
SMOKE_CDS_AGENT_LOGIN_PASSWORD='...' \
SMOKE_CDS_AGENT_SCREENSHOT=/tmp/cds-agent-workbench-visual.png \
  bash scripts/smoke-cds-agent-workbench-visual.sh
```

也可以直接传 `SMOKE_CDS_AGENT_ACCESS_TOKEN`；此时可选传
`SMOKE_CDS_AGENT_AUTH_USER_JSON` 用于填充前端 auth store 的用户信息。截图不会包含
API key，但它会显示当前默认 profile 是否仍阻塞 R1。

`smoke-all.sh` 已接入该视觉入口，key 为 `cds-agent-visual`。为了不让无登录凭据的
CI 环境误失败，`smoke-all.sh` 只有在检测到 `SMOKE_CDS_AGENT_ACCESS_TOKEN`，或同时
检测到 `SMOKE_CDS_AGENT_LOGIN_USERNAME` / `SMOKE_CDS_AGENT_LOGIN_PASSWORD` 时才运行它；
否则会把它记为 skipped。验收 V1 时应显式提供登录凭据，不能只看 skipped。

## CDS Agent 一个周期最小闭环

日常调试 CDS Agent 商业级 readiness 时，优先用一个周期入口，而不是手工记忆脚本顺序：

```bash
SMOKE_TEST_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org \
AI_ACCESS_KEY=xxx \
SMOKE_USER=admin \
bash scripts/smoke-cds-agent-one-cycle.sh
```

它会把证据写到 `SMOKE_CDS_AGENT_CYCLE_DIR`，默认是
`/tmp/cds-agent-cycle-<timestamp>`，包括每一步日志、`doctor-report.json`、
`readiness-report.json`、`r1-report.json`、`s1-report.json`、`controls-report.json`、
`cycle-summary.json` 和可选视觉截图。终端汇总里的 `Passed`
只表示脚本步骤完成；是否商业就绪以 `Cycle status`、`commercialGates`、
`Readiness overall` 和 pending gates 为准。

`cycle-summary.json.commercialGates` 会把验收语义拆开：

| Gate | 通过含义 |
| --- | --- |
| R0 | runtime-status 和 sidecar alias 都证明 `loopOwner=claude-agent-sdk` |
| A0 | 本地代码边界证明默认路径使用官方 Claude Agent SDK adapter，legacy loop 仅显式 fallback |
| R1 | 默认 runtime profile 已是 Anthropic/Claude-compatible 且有 key |
| S1 | 已显式允许 provider 调用，并完成真实只读 repo run |
| S2S3 | 已完成真实 MAP approval 和 Stop/cancel 控制验证 |
| V1 | 已用登录态截图证明页面显示真实 runtime 状态 |
| N6 | 非代码 Toolbox agent 不依赖 CDS sidecar runtime pool |

因此 S1/S2/S3 脚本在 R1 未通过时可以退出 0 并写出 `skipped_incompatible_profile`，
但 `commercialGates.S1/S2S3` 仍会是 `pending`，不能把它们算作商业级通过。
如果 preview 正在冷启动，doctor 会在 one-cycle 中默认重试 10 次、每次间隔 3 秒；
仍失败时 `commercialGates` 只会把尚未证明的 gate 标成 `unknown`，不会把未执行的
S1/S2/S3 误标成 pending 或 pass。

`cycle-summary.json` 会写出 `status`、`nextCommand` 和 `timing`。`timing.steps`
记录每个阶段的耗时，`timing.slowest` 给出最慢 3 个阶段；终端汇总也会打印
`Total measured step time` 和 `Slowest steps`，用于判断时间花在本地检查、远程
deploy 后的 readiness、视觉截图，还是 provider 调用。

常见状态含义：

| status | 含义 |
| --- | --- |
| `blocked_r1` | 默认 runtime profile 还不是官方 Claude/Anthropic-compatible，或缺少用于 R1 修复的 Anthropic/Claude-compatible key |
| `ready_for_provider_smokes` | R1 已满足，下一步需要显式打开 provider 调用跑 S1/S2/S3 |
| `blocked_provider_smokes` | R1 已不再是主阻塞，但 S1/S2/S3 还没有真实 provider 证据 |
| `provider_smokes_incomplete` | 已打开 provider 调用，但 S1/S2/S3 没有全部通过 |
| `provider_smokes_passed` | R1 和 S1/S2/S3 都有通过证据，可进入更高层业务验收 |
| `preview_not_ready` | 远程 CDS preview 仍在 `starting`，等待 ready 后重跑 one-cycle，不需要先改代码或 self update |
| `failed` | 某个脚本步骤失败，先看 `cycle-summary.json` 和对应 step log |

面向执行面板或 CI 时，优先读 `cycle-summary.json.executionPanel`。它已经聚合了
`status`、`commercialComplete`、`blockingReason`、`currentBlockingGate`、
步骤计数、gate 计数、最慢步骤和未通过 gate 列表；不需要再从终端日志里解析
`Passed`、`Pending gates` 或 `Slowest steps`。

没有 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 时，S1/S2/S3 仍只做 readiness 或跳过真调用；
没有 `SMOKE_CDS_AGENT_ANTHROPIC_API_KEY` 时，R1 repair 只做 dry-run，不会创建默认 profile，
但会在 `r1-report.json` 里写出当前默认 profile、后端 R1 修复计划、缺 key 保护结果和
不含真实密钥的下一条修复命令。

V1 视觉 smoke 可以使用真实 JWT、登录用户名/密码，或 `AI_ACCESS_KEY + SMOKE_USER`
的 smoke-only 浏览器请求头注入。后一种路径只给同源 `/api/` 请求注入
`X-AI-Access-Key` / `X-AI-Impersonate`，并移除 dummy Bearer token；截图和 text dump
不会包含真实 `AI_ACCESS_KEY`。V1 断言会检查 `/cds-agent` 页面包含
`Runtime 调试`、`当前执行结论`、`商业级 READINESS LEDGER` 和
`下一周期最小闭环`。新增 adapter contract 可观察性后，V1 还会检查
`ADAPTER 兼容性`、`默认路由`、`缺失 adapter contract` 和 `候选 adapter 边界`，
确保用户能在页面上直接看到为什么 OpenAI Agents SDK、Google ADK 或 Codex-like
候选还不能默认路由到代码审查。

要真正关闭 R1 并进入 provider smoke，必须显式提供 Anthropic/Claude-compatible key：

```bash
SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=sk-ant-... \
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 \
bash scripts/smoke-cds-agent-one-cycle.sh
```

这个命令会先走 R1 test-before-promote，再跑 S1/S2/S3。只有
`commercial-readiness` 的 R1 变为 pass 且 S1/S2/S3 真 provider 证据通过后，才可以把
CDS Agent 从“诊断可用”提升为“上手即用”。

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
