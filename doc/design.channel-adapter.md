# 多通道适配器 · 设计

> **版本**：v2.0 | **日期**：2026-03-13 | **状态**：开发中

## 管理摘要

- **解决什么问题**：当前系统仅支持 Web/桌面端入口，无法覆盖邮件、短信等异步触发场景，使用门槛高、集成困难
- **方案概述**：设计统一的通道适配器架构，首期实现邮件通道（IMAP 轮询 + SendGrid Webhook），通过意图识别和白名单机制将外部消息路由到现有 Agent 系统
- **业务价值**：用户通过发送邮件即可触发 AI 任务（生图、提缺陷等），大幅降低使用门槛并扩展覆盖场景
- **影响范围**：新增独立模块（ChannelAdmin/EmailChannel），复用现有 Agent 系统（visual-agent、defect-agent、prd-agent）
- **预计风险**：低 — 独立模块不影响现有功能，IMAP 轮询有分钟级延迟但可通过 Webhook 增强

## 一、问题背景

当前开放平台仅支持 HTTP API（OpenAI 兼容格式）作为唯一入口。用户需要打开 Web 管理后台或桌面客户端才能使用系统能力。这导致：

- **使用门槛高**：用户在移动端、无网络环境下无法触发任务
- **覆盖场景窄**：邮件、短信等天然异步的场景无法接入
- **集成困难**：第三方系统需要通过 API 对接，缺少轻量级触发方式

核心洞察：邮件/短信/Webhook 等通道本质都是"输入指令 → 执行任务 → 输出结果"，区别仅在于输入协议、输出协议和身份验证方式。

## 二、设计目标

| 目标 | 说明 | 非目标 |
|------|------|--------|
| 统一通道抽象 | 定义通道适配器模式，新通道只需实现入站/出站逻辑 | 不做通用通道市场（不支持用户自定义通道类型） |
| 身份映射 | 外部标识（邮箱、手机号）→ 系统用户，支持白名单 + 配额控制 | 不做自助注册（管理员配置白名单） |
| 能力复用 | 所有通道共享现有 Agent 能力（visual-agent、defect-agent 等） | 不做通道专属 Agent |
| 邮件通道首发 | 首期完整实现邮件通道（IMAP 轮询 + SendGrid Webhook 双通道接收） | SMS/Siri/Webhook 通道预留模型，暂不实现 |

## 三、核心设计决策

### 决策 1：邮件接收方案 — IMAP 轮询 + Webhook 双通道

**结论**：同时支持 IMAP 轮询（主）和 SendGrid Webhook（辅），管理员可在后台配置 IMAP/SMTP 连接参数。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. IMAP 轮询 + Webhook 并存 | 灵活：无 SendGrid 也能用企业邮箱；有 SendGrid 则实时 | 轮询有分钟级延迟 | 采纳 |
| B. 纯 SendGrid Webhook | 实时 | 强依赖第三方服务、需 MX 记录配置 | 作为辅助保留 |
| C. 纯 IMAP IDLE | 秒级实时、免费 | 连接不稳定、需要长连接维护 | 否决 |

**理由**：IMAP 轮询对企业邮箱兼容性最好，管理员只需填入 IMAP/SMTP 凭据即可工作。SendGrid Webhook 作为可选增强。

### 决策 2：意图识别 — 前缀标签 + 关键词启发式

**结论**：两阶段识别：优先匹配邮件主题中的 `[前缀标签]`（置信度 1.0），无前缀时退化为关键词启发式匹配（置信度 0.7-0.8）。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. 前缀标签 + 关键词 | 确定性高、零 LLM 开销、可解释 | 无前缀时准确率有限 | 采纳 |
| B. 全部走 LLM 意图识别 | 准确率高 | 每封邮件都消耗 Token、延迟高 | 未来增强 |

**理由**：邮件场景下用户可以通过 `[生图]`、`[缺陷]` 等前缀明确意图，覆盖主要场景。

### 决策 3：白名单优先级匹配 + 原子配额计数

**结论**：白名单规则按 `Priority` 升序排列，首匹配即停止。每日配额通过 MongoDB 原子操作（TodayDate + TodayUsedCount）实现，避免并发竞态。

**理由**：优先级匹配允许精确规则覆盖通配规则（如 `user@co.com` 优先于 `*@co.com`）；原子配额避免分布式锁。

### 决策 4：邮件工作流（EmailWorkflow）支持地址前缀路由

**结论**：管理员可配置邮件工作流，将不同邮箱地址前缀（如 `todo@`、`bug@`、`classify@`）路由到不同的处理流程和 Agent。

**理由**：比主题前缀更直观，用户只需选择不同的收件地址即可触发不同工作流。

## 四、整体架构

```
                    ┌──────────────────┐
                    │  IMAP Poll       │ ← EmailChannelWorker (定时轮询)
                    │  (MailKit)       │
                    └────────┬─────────┘
                             │
                             ▼
┌──────────────────┐   ┌─────────────────────┐
│  SendGrid        │──▶│  EmailChannel       │
│  Webhook         │   │  Service            │
│  (POST /inbound) │   │  (邮件解析 + 回复)   │
└──────────────────┘   └────────┬────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  IntentDetector       │
                    │  (前缀标签 + 关键词)   │
                    └────────┬──────────────┘
                             │
                             ▼
                    ┌───────────────────────┐
                    │  WhitelistMatcher     │
                    │  (优先级匹配 + 配额)   │
                    └────────┬──────────────┘
                             │
                             ▼
                    ┌───────────────────────┐
                    │  ChannelTaskService   │
                    │  (任务创建 + 日志)     │
                    └────────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        visual-agent   defect-agent   prd-agent
```

### 关键交互流程

1. **IMAP 路径**：EmailChannelWorker 定时轮询 → 拉取未读邮件 → 解析 → 意图识别 → 白名单校验 → 创建任务 → Handler 执行 → SMTP 回复
2. **Webhook 路径**：SendGrid POST → EmailChannelController 解析 → ChannelTaskService 创建任务
3. **管理路径**：ChannelAdminController 提供白名单/映射/任务/设置/工作流的完整 CRUD

### 意图识别映射

| 前缀标签 | Intent | 目标 Agent | 示例 |
|----------|--------|-----------|------|
| `[生图]` `[画图]` `[图片]` | image-gen | visual-agent | `[生图] 夕阳下的猫` |
| `[缺陷]` `[BUG]` `[问题]` | defect-create | defect-agent | `[缺陷] 登录页面样式错乱` |
| `[查缺陷]` `[缺陷列表]` | defect-query | defect-agent | `[查缺陷] 最近一周` |
| `[PRD]` `[需求]` `[文档]` | prd-query | prd-agent | `[PRD] 用户注册流程` |
| `[取消]` `[停止]` | cancel | - | `[取消] TASK-20260313-ABC` |
| `[帮助]` `[help]` | help | - | `[帮助]` |

无前缀时退化为关键词匹配（"生成一张" → image-gen 0.8, "报告bug" → defect-create 0.8）。

## 五、数据设计

### 新增/变更的集合

| 集合 | 用途 | 关键索引 |
|------|------|----------|
| `channel_whitelist` | 通道白名单规则 | `(channelType, identifierPattern)`, `(isActive, priority)` |
| `channel_identity_mappings` | 外部标识 → 系统用户映射 | `(channelType, channelIdentifier)` unique |
| `channel_tasks` | 通道任务全生命周期 | `(status, createdAt)`, `(senderIdentifier, createdAt)`, `createdAt` TTL 30天 |
| `channel_request_logs` | 审计日志（含拒绝记录） | `(channelType, createdAt)`, `(mappedUserId, createdAt)`, `createdAt` TTL 30天 |
| `channel_settings` | IMAP/SMTP 配置（单例） | Id = "default" |
| `email_workflows` | 邮件工作流（地址前缀路由） | `(addressPrefix)` |

### 核心字段

**ChannelWhitelist**：

| 字段 | 类型 | 说明 |
|------|------|------|
| ChannelType | string | email / sms / siri / webhook |
| IdentifierPattern | string | 支持通配符，如 `*@company.com` |
| BoundUserId | string? | 绑定的系统用户（优先于身份映射） |
| AllowedAgents | List\<string\> | 空 = 全部允许 |
| AllowedOperations | List\<string\> | 空 = 全部允许 |
| DailyQuota | int | 0 = 不限；原子递增计数 |
| TodayUsedCount / TodayDate | int / string | 配额追踪，日期变更自动重置 |
| Priority | int | 越小越优先，首匹配即停 |
| IsActive | bool | 启用/禁用 |

**ChannelTask**：

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | 格式 `TASK-yyyyMMdd-{6HexChars}` |
| ChannelType | string | 来源通道 |
| SenderIdentifier | string | 发送者标识（邮箱/手机号） |
| MappedUserId | string? | 解析到的系统用户 |
| WhitelistId | string | 匹配的白名单规则 |
| Intent | string | image-gen / defect-create / prd-query / cancel / help / unknown |
| TargetAgent | string? | 路由目标 Agent |
| OriginalContent | string | 原始内容（去除前缀标签） |
| ParsedParameters | Dictionary | 提取的参数（prompt、style、aspectRatio 等） |
| Attachments | List\<Attachment\> | 附件元数据 |
| Status | string | pending → processing → completed / failed / cancelled |
| StatusHistory | List\<StatusChange\> | 完整状态审计轨迹 |
| Result | TaskResult? | 执行结果（text / image / list / error） |
| RetryCount / MaxRetries | int | 重试追踪，默认最多 3 次 |
| ParentTaskId | string? | 重试时关联原任务 |

**ChannelIdentityMapping**：

| 字段 | 类型 | 说明 |
|------|------|------|
| ChannelType | string | 通道类型 |
| ChannelIdentifier | string | 外部标识（小写归一化） |
| UserId | string | 系统用户 ID |
| IsVerified | bool | 是否已验证（未验证不生效） |
| VerificationCode / ExpiresAt | string / DateTime | 验证码及有效期 |

**ChannelSettings**（单例）：

| 字段 | 类型 | 说明 |
|------|------|------|
| ImapHost / Port / Username / Password / UseSsl | - | IMAP 收件配置 |
| SmtpHost / Port / Username / Password / UseSsl | - | SMTP 发件配置 |
| SmtpFromName / SmtpFromAddress | string | 发件人显示 |
| PollIntervalMinutes | int | 轮询间隔（默认 5 分钟） |
| IsEnabled | bool | 是否启用邮件通道 |
| AcceptedDomains | List\<string\> | 过滤收件域名（空 = 全部） |
| AutoAcknowledge | bool | 是否自动发确认回复 |

**EmailWorkflow**：

| 字段 | 类型 | 说明 |
|------|------|------|
| AddressPrefix | string | 邮箱前缀（如 todo、bug、classify） |
| DisplayName | string | 显示名（如"待办事项"） |
| IntentType | enum | CreateTodo / Classify / Summarize / FollowUp / FYI |
| TargetAgent | string? | 路由到的 Agent（如 defect-agent） |
| CustomPrompt | string? | 自定义 LLM 处理指令 |
| ReplyTemplate | string? | 回复模板，支持 {senderName}、{subject}、{result} 变量 |
| Priority | int | 匹配优先级 |

### 身份解析优先级

1. 白名单规则的 `BoundUserId`（如有直接使用）
2. `ChannelIdentityMapping` 查询（需 IsVerified = true）
3. 空（任务仍创建，标记无映射用户）

## 六、接口设计

**管理接口**（基础路径 `/api/admin/channels`）：

| 方法 | 路径 | 用途 | 备注 |
|------|------|------|------|
| GET | `/whitelist` | 白名单列表（分页 + 筛选） | 支持通道类型、状态、关键词 |
| POST | `/whitelist` | 创建白名单规则 | 校验模式唯一性 |
| PUT | `/whitelist/{id}` | 更新白名单规则 | |
| DELETE | `/whitelist/{id}` | 删除白名单规则 | |
| POST | `/whitelist/{id}/toggle` | 启用/禁用 | |
| GET | `/identity-mappings` | 身份映射列表 | |
| POST | `/identity-mappings` | 创建映射 | 校验用户存在 + 标识唯一 |
| DELETE | `/identity-mappings/{id}` | 删除映射 | |
| GET | `/tasks` | 任务列表 | 复合筛选：通道/状态/Agent/发送者/日期范围 |
| GET | `/tasks/stats` | 任务状态统计 | 按状态分组计数 |
| GET | `/tasks/{id}` | 任务详情 | |
| POST | `/tasks/{id}/retry` | 重试失败任务 | 创建新任务，关联 ParentTaskId |
| POST | `/tasks/{id}/cancel` | 取消任务 | |
| GET | `/stats` | 通道综合统计 | 今日成功率、平均耗时、通道状态 |
| GET | `/settings` | 获取设置 | 密码脱敏返回 |
| PUT | `/settings` | 更新设置 | 非空字段增量更新 |
| POST | `/settings/test` | 测试 IMAP 连接 | |
| POST | `/settings/poll` | 手动触发轮询 | |
| GET | `/workflows` | 工作流列表 | |
| POST | `/workflows` | 创建工作流 | 校验前缀格式 + 唯一性 |
| PUT | `/workflows/{id}` | 更新工作流 | |
| DELETE | `/workflows/{id}` | 删除工作流 | |
| POST | `/workflows/{id}/toggle` | 启用/禁用 | |
| POST | `/workflows/init-defaults` | 初始化默认工作流 | Todo/Classify/Summary/Bug |
| GET | `/workflows/intent-types` | 获取可用意图类型 | |

**Webhook 接口**（基础路径 `/api/channels/email`）：

| 方法 | 路径 | 用途 | 备注 |
|------|------|------|------|
| POST | `/inbound` | SendGrid Inbound Parse Webhook | multipart/form-data |
| POST | `/status` | 发送状态回调 | 预留 |
| POST | `/inbound/test` | 测试入站 | 仅 Development 环境 |

## 七、影响范围

| 影响模块 | 变更内容 | 风险等级 |
|----------|----------|----------|
| 新增 ChannelAdminController | 白名单/映射/任务/设置/工作流 CRUD（~1100 行） | 低（独立模块） |
| 新增 EmailChannelController | SendGrid Webhook 接收端点 | 低（独立端点） |
| 新增 EmailChannelWorker | 后台 IMAP 轮询服务 | 低（独立 Worker） |
| 新增 6 个 MongoDB 集合 | channel_whitelist 等 | 低（不影响现有集合） |
| 现有 Agent 系统 | 通过 TargetAgent 路由调用 | 中（需确保 Agent 接口稳定） |
| 通知系统 | 邮件回复（SMTP 发送） | 低（使用 MailKit 独立发送） |

## 八、关键约束与风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| IMAP 轮询延迟（分钟级） | 确定 | 用户感知延迟 | 可配置轮询间隔；有实时性需求时启用 SendGrid Webhook |
| 企业邮箱 IMAP 限制 | 中 | 轮询失败 | 后台记录 LastPollResult/Error，管理界面可手动测试连接 |
| 白名单规则冲突 | 低 | 错误匹配 | Priority 排序 + 首匹配即停，管理界面可查看规则优先级 |
| 配额竞态 | 低 | 超额放行 | MongoDB 原子更新（TodayDate + TodayUsedCount 条件更新） |
| SendGrid Webhook 签名验证未实现 | 中 | 伪造请求 | TODO：实现签名验证；当前依赖网络隔离 |
| Handler 执行异常 | 中 | 任务卡在 processing | StatusHistory 追踪 + 管理界面支持手动重试/取消 |
| SMS/Siri/Webhook 通道模型预留但未实现 | - | 数据模型中有通道类型但无实际适配器 | 标记为未来扩展，不影响邮件通道功能 |
