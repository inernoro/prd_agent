# LLM Gateway 外部平台化与控制台体验收口 · 计划

> **版本**：v1.3 | **日期**：2026-07-12 | **状态**：开发中

## 1. 目标

把已经承载 MAP 生产 AI 流量的 LLM Gateway，从“内部可运维网关”推进为“外部团队可以安全、自助、低心智接入的统一 AI 治理平台”。

本计划不重做模型池、不重做 full-http 迁移，也不复制 OpenRouter。它只补齐五类有限能力：

1. 租户、用户、团队、成员和角色权限。
2. 外部系统可管理、可撤销、可审计的接入身份。
3. 网页版快速接入教程和四协议示例。
4. appCaller 级提示词前缀/后缀与版本化治理。
5. 面向普通使用者的控制台信息架构、图表和金额可信度。

## 1.1 执行目标与推进合同

本文件是本任务唯一计划和进度 SSOT，不再创建第二份并行计划。执行目标是按 PR-1 至 PR-5 依次完成外部平台化；每个 PR 必须独立评审、验证、发布和验收，前一个 PR 未完成时不得提前混入后一个 PR 的功能。

| PR | 当前状态 | 分支 | 独立完成门 |
|---|---|---|---|
| PR-1 | 已合并；CI、Codex Review、CDS 与预览验收通过；Bugbot 因订阅停用记为不适用 | `codex/llmgw-tenant-rbac` / [PR #1085](https://github.com/inernoro/prd_agent/pull/1085) | tenant/team/user/membership/RBAC、服务端租户解析、全租户数据隔离与跨租户拒绝测试 |
| PR-2 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-service-key-quickstart` / [PR #1086](https://github.com/inernoro/prd_agent/pull/1086) | tenant-scoped service key、自助接入、四协议 Quickstart；四协议各一次真实请求，其余假上游 |
| PR-3 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-prompt-policy` / [PR #1087](https://github.com/inernoro/prd_agent/pull/1087) | PromptPolicy 版本、预览、审计及 chat/vision 注入合同 |
| PR-4 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-console-experience` / [PR #1088](https://github.com/inernoro/prd_agent/pull/1088) | 控制台 IA、左侧导航、首页、Activity 图表与金额可信度，多视口双主题验收 |
| PR-5 | 开发与本地合同验收中 | `codex/llmgw-final-platform-acceptance` | 跨租户安全、四协议、完整接入流程和迁移收口验收 |

每个 PR 的固定流程：从最新 `main` 建独立分支 → 实现有限范围 → 本地静态、单元与行为测试 → 中文 commit → push → 创建独立 PR → 等待 CI、Codex Review、CDS → 直连预览域名验收 → 修复所有阻塞项 → 合并后再开始下一 PR。Bugbot 自 2026-07-12 起因用户停止续费而不再作为门禁，统一记录为不适用，不触发、不等待。

PR-1 证据（2026-07-12）：`prd-api`、`PrdAgent.Api.Tests`、`prd-llmgw` 编译通过；.NET 8 容器连接临时 Mongo 实跑 Gateway 相关测试，0 失败；真实 `prd-llmgw` HTTP 流程验证 tenant B 对 tenant A 的 team/key 列表泄漏为 0，跨租户资源写入返回 404，viewer 对审计和组织写入返回 403，无 membership 的租户切换返回 403，membership 版本变化后旧 token 返回 401。GitHub CI、四个相关镜像、Codex Review、CDS Deploy 与直连预览验收通过，PR #1085 已 squash 合并为 `19a33c7f4461eae24861f8ad59123b0ec0679389`。

PR-2 证据（2026-07-12）：保留既有 `gwk_*`、一次性明文和 SHA-256 存储；新增创建者、key prefix、可选 TeamId、来源 CIDR、有效期、每分钟限流与轮换关联。Developer 查询和撤销同时按 TenantId 与 CreatedByUserId 收口。serving 只从经过 trusted proxy 处理后的连接远端地址检查 CIDR；分钟窗口唯一索引包含 TenantId，首分钟并发 upsert 的 duplicate-key 竞争会转为非 upsert 原子递增。`prd-llmgw`、`PrdAgent.LlmGateway` 与 `prd-llmgw-web` 构建通过，Gateway 筛选测试 110 项、数据域守卫 55 项通过；本地真实登录浏览器已完成空列表、创建 key、一次性显示及桌面/移动 Quickstart 验收。最终提交 `b618d17f2` 的 GitHub CI 10 项成功、四镜像、CDS Deploy 和 smoke 3/3 通过，serving health 精确回显同 commit；独立控制台 Quickstart 深链返回 200，无法确认 serving origin 时的线上产物使用明确占位域名。Codex 自动复审因云端额度耗尽无法覆盖最终提交，按仓库 `human-verify` 完成正确性、错误处理、安全、边界、数据流与用户场景替代复审并修复发现的问题。PR #1086 已 squash 合并为 `f2550f2e298ec7621480facd77f33661de99d78c`；Bugbot 不适用。

PR-3 证据（2026-07-12）：新增 `llmgw_prompt_policies` 不可变版本集合，唯一索引为 TenantId + AppCallerCode + RequestType + Version；控制台 GET/预览/保存/回滚全部先以服务端会话 TenantId 过滤 appCaller 和策略。实跑临时库完成无版本、预览、保存 v1、陈旧版本 409、禁用 v2、回滚新建 v3，操作审计不含前缀/后缀正文。serving 只在四协议统一后的 chat/vision `messages` 应用策略，合并顺序为前缀、请求 system、后缀；raw/非 chat/vision 回归保持原请求。日志向上游发送合并正文，但 `RequestBodyRedacted` 只保留策略标记，`SystemPromptText` 置空，仅写 id/version/hash/chars。PromptPolicy 定向行为 4/4、日志脱敏 1/1、数据域守卫 58/58 通过；GitHub 标准 .NET 8 CI、四镜像与 CDS Deploy 全绿，CDS smoke 3/3，serving health 精确回显提交 `1c7073fa51e5c01f1508572bd5d70650d07f490d`。自动 Codex Review 因额度耗尽未生成结果，已用人工对抗审查替代并修复禁用策略回退与索引方向漂移。PR #1087 已 squash 合并为 `6b98efd19da42b39e9eeab0c79fee0ab8538afad`；Bugbot 不适用。

PR-4 本地证据（2026-07-12）：顶部收口为品牌、租户切换、requestId 搜索、文档和用户菜单，页面导航迁入工作区、路由、开发者、组织、治理、设置六组左侧栏；移动端使用可关闭抽屉。普通首页第一屏只呈现健康状态、四协议 Quickstart、最近请求与费用可信度，runtime gate、配置权威迁移和容器拓扑整体迁到 `/governance`。Activity 保留请求量图并增加状态分布图，费用汇总新增 `pricedRequests`、`unknownCostRequests`、`priceCoveragePercent` 与按原币种 `estimatedCosts`；只有 token 使用量对应价格快照完整的请求才计为 covered，只有明确 USD 快照进入 `EstimatedCostUsd`，没有 USD 样本时返回 null。临时 Mongo + 真实控制台后端验证四条日志中完整 USD 1.25、完整 CNY 8.00、无价格和仅输入价格两条均为 unknown，覆盖率 50%；部分 USD 估算未混入 USD 汇总，CNY 与 USD 未相加。租户列表由服务端 userId 与 TenantId membership 解析。浏览器验证桌面和移动无水平溢出、移动抽屉、深浅主题、两张 Activity 图、unknown 显示、requestId 全局搜索和筛选均通过，0 console warning/error。控制台构建、后端 0 warning/0 error、数据域守卫 61/61 通过。

PR-4 发布证据（2026-07-12）：最终提交 `5fba56b9552e161f16b74cb720b8be2c17a09311` 的 GitHub CI、四镜像、CDS Deploy 与 smoke 3/3 全绿，serving health 精确回显同 commit，独立控制台和 serving 深链均返回 200。Codex 自动复审因云端额度耗尽未生成结果，已用人工对抗审查替代并修复 requestId 同路由刷新与部分价格快照覆盖率两个缺陷。PR #1088 已 squash 合并为 `3217c862a8da7ce9fe78eef086e5b4a7a7dfd2f7`；Bugbot 不适用。

PR-5 精确计划（2026-07-12）：不再增加平台能力，只做有限验收收口。第一，修复生产治理验收脚本在 PR-1 后仍伪造无租户 claim JWT、Mongo 查询和清理缺少 TenantId 的漂移，改为通过真实控制台登录与 `/auth/context` 取得服务端租户。第二，用既有假上游合同覆盖 tenant-scoped key 的授权、越权、撤销和 GW Native、OpenAI、Claude、Gemini 四协议，不批量调用付费模型。第三，串联 PR-1 至 PR-4 的租户创建、密钥接入、PromptPolicy 元数据、Activity、费用可信度与桌面/移动证据，避免重复建设 full-http、模型池和发布 gate。第四，PR 分支在 CI、Codex Review 或替代人工复审、CDS、直连预览和完整测试租户清理全部通过后才能合并。

PR-5 本地证据（进行中）：治理验收脚本已改用 `/gw/auth/login` 与 `/gw/auth/context`，所有临时配置、预算、并发租约、日志和审计清理均包含服务端解析的 TenantId，并删除对 JWT secret 和手工签名的依赖；脚本语法、默认 dry-run 与数据域静态守卫通过。四协议 fidelity 与 service-key 鉴权合同合计 179/179 通过，数据域守卫 62/62 通过，控制台前端 TypeScript 与生产构建通过。首页协议列表已与 Quickstart 的 GW Native、OpenAI、Claude、Gemini 对齐。生产/灰度执行、测试租户清理和独立 PR 门禁仍待完成。

执行期间保持以下边界：

- 不重做 full-http、模型迁移、模型池、配置权威或发布 gate。
- 不在相邻 PR 之间夹带实现；为后续 PR 预留的 DTO、路由或页面必须等对应 PR 再增加。
- 不批量调用付费模型；每类真实协议最多一次，其余使用假上游和固定数据。
- 所有进度以本节状态表、GitHub PR 证据和 CDS 验收结果为准，不用聊天文字替代落盘状态。

## 2. 当前事实

### 2.1 已有能力，不得重做

| 能力 | 当前事实 |
|---|---|
| 生产执行 | MAP 已运行 `Mode=http`，活跃 appCaller 的 MAP 配置 fallback 已关闭 |
| 协议入口 | GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 已进入统一 IR |
| 配置权威 | appCaller、模型池、平台、模型、Exchange、上游 key 已归 `llm_gateway` |
| 外部密钥基座 | 已有 `gwk_*` scoped service key，支持 appCaller、ingress protocol、scope、过期时间和撤销 |
| 日志与审计 | 请求日志、shadow、登录审计、操作审计已独立写入 `llm_gateway` |
| 发布保障 | 同 commit 发布、runtime gate、回滚演练和六类一次性验收已落地 |

### 2.2 真正缺失

| 缺口 | 当前问题 |
|---|---|
| 租户体系 | PR-1 已补齐租户归属与数据隔离；PR-2 正在补齐 key 自助约束和接入体验 |
| 用户与团队 | PR-1 已补齐 tenant/team/user/membership/RBAC；网页组织入口在 PR-2 接入自助流程 |
| 外部开发者体验 | PR-2 已补齐网页版四协议 Quickstart、错误排查和 requestId 定位 |
| appCaller 提示词策略 | PR-3 已补齐版本、预览、回滚、审计以及 chat/vision 应用 |
| 首页可理解性 | PR-4 已把普通用户首要任务前置并通过独立发布门验证 |
| 导航 | PR-4 已落地左侧分组导航与移动抽屉并通过独立发布门验证 |
| 金额可信度 | PR-4 已区分 estimated/unknown 并按原币种汇总，通过独立发布门验证 |
| 图表 | PR-4 已完成请求量、状态分布、空态、窄屏与双主题验收 |

## 3. 产品与数据边界

### 3.1 身份层级

```text
Tenant
  -> Team
     -> Membership(User + Role)
     -> AppCaller
     -> ServiceKey
     -> Budget / RateLimit / PromptPolicy
```

角色固定为：

| 角色 | 权限 |
|---|---|
| `owner` | 租户所有权、成员、账单、全部配置 |
| `admin` | 团队、appCaller、模型池绑定、key、审计 |
| `developer` | 创建和撤销自己范围内的 key、查看调用日志和教程 |
| `viewer` | 只读日志、统计、配置 |
| `billing` | 只读费用、预算和用量，不读取请求正文 |

硬约束：tenant 必须由登录会话或 service key 服务端解析，禁止相信请求 body/header 自报的 tenantId。所有 `llm_gateway` 业务集合必须带 `TenantId`；团队资源再带 `TeamId`。查询、唯一索引、审计和预算必须包含租户边界。

### 3.2 service key 演进

保留现有 `gwk_*` 和 scope 语义，在其上增加：

- `TenantId`、可选 `TeamId`、创建人、名称、前缀、最后使用时间。
- key 明文仍只显示一次，数据库只存 hash。
- 可限制 appCaller、协议、scope、来源 CIDR、到期时间和每分钟限流。
- 轮换采用“新旧短时并存 -> 客户切换 -> 撤销旧 key”，不能原地显示旧明文。
- 兼容现有 MAP 内部共享 key，但新外部租户不得使用内部共享 key。

### 3.3 appCaller 提示词策略

新增版本化 `PromptPolicy`，至少包含：

| 字段 | 说明 |
|---|---|
| `TenantId/TeamId/AppCallerCode/RequestType` | 策略作用域 |
| `SystemPromptPrefix` | 请求系统提示词前追加的治理内容 |
| `SystemPromptSuffix` | 请求系统提示词后追加的补充内容 |
| `Enabled/Version` | 启停和乐观并发版本 |
| `AllowedVariables` | 允许插值的变量白名单，禁止任意表达式执行 |
| `MaxChars` | 长度上限 |
| `CreatedBy/UpdatedBy/UpdatedAt` | 审计字段 |

合并顺序固定为：平台安全策略 -> 租户策略 -> 团队/appCaller 策略 -> 请求自身 system prompt。日志只记录 policy id、version、hash 和字符数；默认不重复存储完整敏感提示词。

提示词策略首版只作用于明确支持 system instruction 的 `chat/vision`。图片、视频、ASR、raw passthrough 不允许静默拼接，除非对应 adapter 有显式合同测试。

## 4. 控制台目标信息架构

顶部只保留全局上下文：品牌、租户/团队切换、全局搜索、开发文档、用户菜单。

左侧导航分组：

| 分组 | 页面 |
|---|---|
| 工作区 | 概览、Activity/日志、appCaller |
| 路由 | 模型池、模型、平台、Exchange |
| 开发者 | Quickstart、API Keys、协议参考、错误码 |
| 组织 | 团队、成员、角色 |
| 治理 | 预算与用量、审计、shadow、运行状态 |
| 设置 | 租户设置、安全、保留策略 |

首页第一屏必须回答四件事：

1. 网关现在是否可用。
2. 如何在五分钟内发出第一条请求。
3. 最近请求是否成功、失败在哪里。
4. 当前金额是否可信，可信度和价格覆盖率是多少。

容器拓扑、config-authority、runtime gate 等内部发布信息移到“治理/运行状态”，不得继续占普通用户第一屏。

## 5. 金额与图表规则

- 金额区分 `actual`、`estimated`、`unknown`，不得把 unknown 渲染成 `$0.00`。
- 没有价格快照的请求显示“缺价格”，并展示价格覆盖率，例如“73% 请求可估算”。
- CNY 与 USD 不直接相加。需要换算时必须记录汇率来源和时间；首版可按原币种分组，避免伪精确。
- `Estimated USD` 只能汇总明确为 USD 或有可审计换算记录的数据。
- 图表必须验证非空像素、横纵轴、时间范围、tooltip、零值、单点、窄屏和双主题。
- 日志详情展示本次请求使用的价格快照，不回算历史价格。

## 6. 网页接入教程

新增 `/docs` 或 `/quickstart`，不要求用户先理解模型池。页面至少包含：

1. 创建租户/团队与 service key。
2. 选择或创建 appCallerCode。
3. GW Native、OpenAI、Claude、Gemini 四种可复制示例。
4. `auto/pool/pinned` 的最短解释和示例。
5. 流式、图片、vision、ASR、视频的能力边界。
6. 401/403/404/409/429/5xx 的排查方式。
7. requestId 如何在 Activity 中定位。

示例必须使用占位 key，不允许把真实生产 key 写入 HTML、日志、截图或仓库。

## 7. 有限 PR 顺序

| PR | 范围 | 完成门 |
|---|---|---|
| PR-1 | tenant/team/user/membership/RBAC 数据模型与服务端租户隔离 | 跨租户读写、key 冒用、审计越权测试全部拒绝 |
| PR-2 | tenant-scoped service key、自助接入、四协议 Quickstart | 新租户从网页创建 key 后四协议各成功一次；越权 403、撤销后 401 |
| PR-3 | appCaller PromptPolicy、版本、预览、审计和 chat/vision 应用 | 前缀/后缀顺序、禁用、版本冲突、日志 hash、raw 不误注入测试通过 |
| PR-4 | 控制台信息架构、左侧导航、首页、Activity 图表与金额可信度 | 桌面/移动、双主题、空态、长文本、图表像素和金额覆盖率验收通过 |
| PR-5 | 端到端安全验收、迁移脚本、文档收口与生产灰度 | 一个测试租户完整走通，删除测试数据；不改 MAP full-http 主链 |

一次只做一个 PR。每个 PR 合并前先合入最新 main，等待 CI、Codex Review 和 CDS 完成；不得把五个 PR 合成不可审查的大提交。Bugbot 因订阅停用统一记为不适用。

## 8. 调研要求

- 只使用 OpenRouter 官方文档和实际网页作为对标依据，重点调研 Quickstart、API Keys、Activity、Models、Provider Routing、Organizations/Teams、Usage/Costs。
- 对标的是信息层级、首次接入路径、错误解释和治理能力，不做像素级抄袭，不复制品牌、文案和受版权保护的视觉资产。
- 先用浏览器记录当前 GW 在桌面和移动端的真实问题，再改布局；不得仅凭源码想象页面。
- 模型池核心调度本轮不改，除非发现阻断租户隔离的安全问题。

### 8.1 OpenRouter 登录态页面借鉴结论

2026-07-12 已在用户授权的登录态浏览器中只读核对 OpenRouter 的 Workspace、Logs、Activity 和 Models 页面。后续实现只借鉴信息结构与交互原则：

- 顶部只承载品牌、全局搜索、产品级入口、组织/个人上下文和用户菜单；Workspace 与 Account 的管理入口进入左侧分组。
- Workspace 范围集中放 API Keys、Routing、Guardrails、Observability 和 Settings；Account 范围集中放 Activity、Logs、Credits、Management Keys、Privacy 和 Preferences。
- Logs 先给日期、复合筛选、请求趋势和请求表，再把 model、provider、appCaller、输入、输出、cost、usage type、speed、finish reason、client user id、API key 作为可配置列；GW 不复制字段命名，但保留同等可定位性。
- Activity 分 Overview、Trends、Explore、Guardrails；首页指标优先为 spend、requests、token volume、cache hit rate，并提供 Top API Keys、Top Apps、Usage by model、Usage type、Request volume、Token breakdown 和 Prompt caching 的下钻。
- 无数据必须明确显示“无数据/未知”，缓存命中率等不可计算指标显示占位状态；不得用 0 伪装未知值。金额仍遵守本计划的 actual/estimated/unknown、币种和价格覆盖率规则。
- Models 的模态、上下文、价格、支持参数、provider、作者、数据保留和区域筛选可作为 PR-4 信息密度参考；本轮不复制其视觉资产，也不重做现有 GW 模型池和 provider router。

## 9. 验收

- 新用户不读内部架构文档，五分钟内能从 Quickstart 发出第一条请求。
- tenant A 无法读取 tenant B 的用户、团队、key、appCaller、日志、预算和审计。
- service key 只能调用授权 appCaller、协议和 scope。
- appCaller 提示词策略可预览、版本化、回滚、审计，且不会污染不支持的请求类型。
- 首页第一屏不出现需要滚动后才理解的核心统计，也不把 runtime gate 当普通用户主任务。
- 左侧导航承载工作区和治理页面，顶部只保留全局操作。
- 金额 unknown 不显示为 0；所有估算都显示币种、覆盖率和估算标识。
- 图表在 1440x900、1024x768、390x844 和深浅主题下无空白、溢出或错误比例。
- 不做重复付费模型测试：协议接入每格最多一次，UI/权限优先使用假上游和固定数据。

## 10. 不做

- 不重新迁移 MAP 模型请求。
- 不重新设计 GW 模型池调度算法。
- 不删除 inproc/legacy 回滚代码；该任务由 full-cutover 最后阶段负责。
- 不伪造供应商账单、价格或汇率。
- 不把 MAP 用户表直接当 GW 多租户表复用。
- 不在没有租户隔离测试前开放公网自助注册。

## 11. Agent 交接提示词

```text
你接手的是 LLM Gateway 外部平台化与控制台体验任务。唯一 SSOT 是：
doc/plan.platform.llm-gateway-external-platform.md

先阅读：
1. doc/plan.platform.llm-gateway-protocol-router.md
2. doc/plan.llm-gateway.full-cutover.md
3. doc/debt.llm-gateway.md
4. prd-llmgw/Program.cs
5. prd-llmgw-web/src/App.tsx
6. prd-llmgw-web/src/components/ConsoleLayout.tsx
7. prd-llmgw-web/src/pages/OverviewPage.tsx

当前生产已经 full-http。不要重做模型迁移、模型池或发布 gate。现有 gwk_* scoped service key 是基座，不是完整租户体系。你的目标是按 PR-1 到 PR-5 有限推进：租户/团队/用户/RBAC、tenant-scoped key 与网页 Quickstart、appCaller PromptPolicy、控制台 IA/图表/金额可信度、最终安全验收。

开始前必须浏览 OpenRouter 官方 Quickstart、API Keys、Activity、Models、Provider Routing、Organizations/Teams、Usage/Costs，并用浏览器检查 https://map.ebcone.net/llmgw/ 当前桌面与移动页面。只借鉴信息架构和交互，不复制品牌资产。

硬约束：
- tenant 只能由会话或 key 服务端解析，不能信任请求自报 tenantId。
- 所有新集合先对照现有 Model 写法；所有查询和索引带 TenantId。
- 提示词策略首版只用于 chat/vision，日志只记 policy id/version/hash。
- unknown cost 不得显示为 0，CNY/USD 不得无汇率直接相加。
- 顶部只放全局上下文，左侧承担页面导航；普通首页不展示发布 gate 和容器拓扑。
- 不进行批量付费模型测试；每类真实协议最多一次，其余用假上游。
- 每个 PR 独立完成测试、CI、Codex Review、CDS 预览和交接，不允许一次实现五个 PR；Bugbot 因订阅停用记为不适用。

先输出仓库事实审计和 PR-1 的精确实施计划，确认没有重复建设，再开始编码。每次进度用表格汇报：事项、完成百分比、证据、阻塞、下一步。
```
