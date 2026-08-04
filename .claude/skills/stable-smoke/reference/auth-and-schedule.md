# 合成登录与定时执行

## 目标

在密码登录关闭、真人 SSO 需要扫码的环境中，让自动化测试使用独立账号进入系统，同时保证该能力不能演变成通用登录后门。

## 安全边界

1. 每个环境必须显式设置 `SYNTHETIC_LOGIN_ENABLED=true`，默认关闭。
2. `SYNTHETIC_LOGIN_ALLOWED_USERS` 只列稳定冒烟专用账号，禁止加入日常真人管理员账号。
3. 签发接口仅接受 `X-AI-Access-Key` 认证，并以 `X-AI-Impersonate` 指定的已存在账号为准。
4. 一次性票据有效期 1-5 分钟，默认 3 分钟；服务端只保存哈希，消费后立即失效。
5. 登录会话最长 30 分钟，不签发 refresh token，不能滑动续期。
6. 返回地址只接受 `/` 开头的站内路径，拒绝绝对地址、协议相对地址和反斜杠路径。
7. 服务端审计只记录 ticketId、账号、失效时间、requestId，不记录票据、密钥和访问令牌。
8. 发生异常时先关闭 `SYNTHETIC_LOGIN_ENABLED`，再轮换 `AI_ACCESS_KEY`，最后审计票据签发记录。

## 超级指令

生成 3 分钟入口并打开目标页面：

```bash
AI_ACCESS_KEY='<从安全变量注入>' \
scripts/stable-smoke-login.sh \
  --base '<环境权威地址>' \
  --user '<合成测试专用账号>' \
  --return-url '/visual-agent' \
  --minutes 3 \
  --open
```

命令只应在受控终端使用。不要把输出的登录地址粘贴到工单、报告或聊天记录；它虽然短时失效，仍属于临时凭据。

## 账号与密钥持久化

账号本体保存在 CDS 环境和正式环境各自的用户数据库。凭据分为三类，不得混成一套：

| 身份 | 用途 | 可用性要求 | 自动化规则 |
|---|---|---|---|
| 环境管理员 `admin` | 永久破窗、权限恢复、专用账号失效时兜底 | 环境运行期间任何时候都必须可登录 | 可做登录预检和故障恢复，不作为日常业务数据归属人 |
| 稳定冒烟专用账号 | 每 48 小时业务旅程 | 固定用户名、最低必要权限、可独立停用 | 正常测试必须优先使用，所有测试资源带 `stsmk-` 前缀 |
| CDS 项目身份 | 部署、回滚、读取环境状态 | 项目范围、可审计、可单独轮换 | 只操作对应 CDS 项目，不替代产品登录账号 |

网关 `admin` 采用环境变量长期托管：`LLMGW_ADMIN_ENV_AUTHORITY=1` 与 `LLMGW_ADMIN_PASSWORD` 共同构成权威。服务启动时验证数据库哈希；一致时不写库、不递增安全版本，只有口令或账号状态漂移时才修复。`LLMGW_ADMIN_FORCE_RESET` 只保留为一次性兼容恢复开关，不作为永久配置。这样固定的是口令和可用性，不是每次启动都执行一次“重置”。

仓库只保存变量名、账号标识、Keychain service 名和状态，不保存真实值。本机 macOS 使用登录钥匙串；无人值守服务器使用部署平台 Secret Store。`.env.stable-smoke.local` 只作为被 git 忽略且权限为 `0600` 的兼容回退，不是首选。禁止把真实密码、AI 密钥、一次性票据或 token 提交到仓库、验收报告或自动化配置正文。

非敏感凭据登记表见 `credential-registry.json`。每次创建、轮换、停用、恢复或验证后必须更新 `state`、`lastVerifiedAt` 和 `nextAction`；下一窗口先读登记表再操作。状态迁移固定为：`planned -> provisioned -> verified -> active -> rotating -> verified`，异常时进入 `degraded`，不得静默回到 `planned`。

每轮前置检查必须验证账号存在、未禁用、在合成登录白名单、权限符合矩阵。检查失败归类为 environment 并通知，不能把它解释成产品通过。

## 本地自动化所需配置

| 环境 | 地址 | AI 密钥 | 专用账号 |
|---|---|---|---|
| CDS | `preview-url` 返回的当前主分支入口；`STABLE_SMOKE_CDS_BASE_URL` 只作本地显式固定值 | `STABLE_SMOKE_CDS_AI_ACCESS_KEY` | `STABLE_SMOKE_CDS_USER` |
| 正式 | `STABLE_SMOKE_PROD_BASE_URL=https://map.ebcone.net` | `STABLE_SMOKE_PROD_AI_ACCESS_KEY` | `STABLE_SMOKE_PROD_USER` |
| MAP 通知 | `STABLE_SMOKE_NOTIFY_BASE_URL=https://map.ebcone.net`、`STABLE_SMOKE_NOTIFY_SOURCE` | `STABLE_SMOKE_NOTIFY_AI_ACCESS_KEY` | `STABLE_SMOKE_NOTIFY_USER` + `STABLE_SMOKE_NOTIFY_TARGET_USER_ID` |

本地兼容文件必须是 `.env.stable-smoke.local`，该名称已被 `.env.*.local` 忽略规则覆盖。文件权限应为仅当前用户可读。CDS 环境和正式环境使用不同 AI 密钥与不同专用账号。目标用户 ID 必须配置，脚本拒绝降级成全局通知。生产 API 尚未发布 `stable-smoke` 来源前，`STABLE_SMOKE_NOTIFY_SOURCE` 使用 `system-alert`；发布后切为 `stable-smoke`。

## 48 小时调度

Codex 桌面端创建本地自动化 `stable-smoke-48h`：

- `execution_environment` 必须为 `local`，工作目录为 `/Users/inernoro/project/prd_agent`。
- 调度使用 `RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=2;BYMINUTE=17`，时区为 `Asia/Shanghai`。
- 启动时装载 `.env.stable-smoke.local`，但不得打印环境变量值。
- 用本地互斥锁禁止同一时刻出现两轮稳定冒烟；已有运行时本轮退出并记录 `conditional`。
- CDS 环境和正式环境独立出结果，不允许一边失败导致另一边证据丢失。
- 任务先读取项目主工作区最新代码和功能台账，再执行 `/稳测 all`。GitHub Actions 与本调度无关。
- 首次创建后必须立即手动运行一次；之后每 48 小时由本机 Codex 自动化唤醒。

人工执行或排查前先运行只读预检：

```bash
node scripts/stable-smoke-run.mjs --preflight
```

只检查 CDS 环境与正式环境的权威地址、身份和部署版本，不创建测试资源、不调用创作模型。只查 CDS 环境时增加 `--cds-only`，只查正式环境时增加 `--production-only`。预检失败必须输出审核者可执行的阻塞项，禁止展示代码堆栈；参数不确定时运行 `node scripts/stable-smoke-run.mjs --help`。

## 每轮报告

本地运行产物写入 `/tmp/prd-agent-stable-smoke/<runId>`，包含 Playwright HTML、JSON、截图、trace 和视频；完成后归档到 CDS 验收中心。知识库报告按稳定冒烟九段式归档，至少包含：目标、范围、环境、身份方式、模块结果、失败证据、双环境差异、清理结果、下一步动作。

若密钥缺失、开关未开或账号不在白名单，结果是 `conditional` 或 `fail`，不得用跳过伪装成通过。
