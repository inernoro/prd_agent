# LLM Gateway 外部平台化与控制台体验收口 · 计划

> **版本**：v1.0 | **日期**：2026-07-12 | **状态**：规划中

## 1. 目标

把已经承载 MAP 生产 AI 流量的 LLM Gateway，从“内部可运维网关”推进为“外部团队可以安全、自助、低心智接入的统一 AI 治理平台”。

本计划不重做模型池、不重做 full-http 迁移，也不复制 OpenRouter。它只补齐五类有限能力：

1. 租户、用户、团队、成员和角色权限。
2. 外部系统可管理、可撤销、可审计的接入身份。
3. 网页版快速接入教程和四协议示例。
4. appCaller 级提示词前缀/后缀与版本化治理。
5. 面向普通使用者的控制台信息架构、图表和金额可信度。

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
| 租户体系 | service key 没有 tenant 归属，无法做租户级数据隔离、预算、审计和配额 |
| 用户与团队 | 控制台仍是独立管理员账号，没有邀请、成员、团队、角色和切换上下文 |
| 外部开发者体验 | 没有面向首次接入者的网页 Quickstart、SDK/cURL 示例、错误排查和在线请求检查器 |
| appCaller 提示词策略 | registry 没有系统提示词前缀/后缀、版本、启停和审计字段 |
| 首页可理解性 | 第一屏优先展示 runtime gate、协议覆盖等内部运维概念，普通用户不知道下一步做什么 |
| 导航 | 所有菜单挤在顶部；缺少“高频工作区 + 低频治理区”的层级 |
| 金额可信度 | `EstimatedCostUsd` 来自模型池价格快照；缺价格、币种或汇率时可能显示 0，不能当真实账单 |
| 图表 | 时间序列柱形图需要检查比例尺、空值、tooltip、容器尺寸和主题，不得用非零像素假装有效数据 |

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

一次只做一个 PR。每个 PR 合并前先合入最新 main，等待 CI、Bugbot 和 CDS 完成；不得把五个 PR 合成不可审查的大提交。

## 8. 调研要求

- 只使用 OpenRouter 官方文档和实际网页作为对标依据，重点调研 Quickstart、API Keys、Activity、Models、Provider Routing、Organizations/Teams、Usage/Costs。
- 对标的是信息层级、首次接入路径、错误解释和治理能力，不做像素级抄袭，不复制品牌、文案和受版权保护的视觉资产。
- 先用浏览器记录当前 GW 在桌面和移动端的真实问题，再改布局；不得仅凭源码想象页面。
- 模型池核心调度本轮不改，除非发现阻断租户隔离的安全问题。

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
- 每个 PR 独立完成测试、CI、Bugbot、CDS 预览和交接，不允许一次实现五个 PR。

先输出仓库事实审计和 PR-1 的精确实施计划，确认没有重复建设，再开始编码。每次进度用表格汇报：事项、完成百分比、证据、阻塞、下一步。
```
