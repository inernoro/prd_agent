# 数据字典（数据库 / 缓存 Key / 所有持久化清单）

本文件用于**集中说明本项目所有“持久化/可恢复状态”**（服务端数据库、缓存 Key、对象存储、客户端本地存储、桌面端落盘文件等），作为研发与运维的统一对照表。

维护规则（强制）：
- 新增/变更任何持久化点（集合/索引/TTL、缓存 key、COS key、localStorage/IndexedDB、落盘文件路径/格式）时，**必须同步更新本文件**。
- 以代码为准：后端集合/索引/TTL 以 `prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs` 为权威来源；缓存 key 以 `prd-api/src/PrdAgent.Core/Interfaces/ICacheManager.cs` 为权威来源；COS key 以 `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs` 为权威来源。

---

## MongoDB（长期存储）

### 关键约束

- **集合名**：全小写（例如 `users`, `messages`）。
- **主键**：统一 string（Guid 字符串），不要用 `ObjectId`。
- **字段命名**：camelCase。
- **索引/TTL**：统一在 `MongoDbContext.CreateIndexes()` 创建（见下表“索引/TTL/唯一约束”列）。

### 集合清单

> 说明：字段的完整定义以对应的 `PrdAgent.Core/Models/*.cs` 为准；此处只记录用途、关键约束与索引。

| 集合（collection） | 模型（POCO） | 用途 | 索引/TTL/唯一约束（来自 MongoDbContext） |
|---|---|---|---|
| `users` | `User` | 用户账号 | `username` 唯一 |
| `groups` | `Group` | 群组 | `inviteCode` 唯一 |
| `groupmembers` | `GroupMember` | 群成员关系 | `(groupId, userId)` 唯一 |
| `documents` | `ParsedPrd` | PRD 文档（原文 + 解析结构），`documentId` 为内容 hash | `createdAt` 逆序索引 |
| `messages` | `Message` | 会话/群消息（SSE 有序） | `groupId`；`sessionId`；`(groupId, groupSeq)` 唯一（仅对存在 long 的 `GroupSeq` 生效的 partial unique）；`(sessionId, timestamp desc)` |
| `group_message_counters` | `GroupMessageCounter` | 群消息序号计数器（生成 `groupSeq`） | （未显式创建额外索引） |
| `contentgaps` | `ContentGap` | PRD 缺失点检测结果 | `groupId` |
| `attachments` | `Attachment` | 文档/消息附件元数据 | （未显式创建额外索引） |
| `llmconfigs` | `LLMConfig` | LLM 配置（历史/兼容） | （未显式创建额外索引） |
| `invitecodes` | `InviteCode` | 邀请码 | `code` 唯一 |
| `llmplatforms` | `LLMPlatform` | LLM 平台（OpenAI/Anthropic/...） | `name` 唯一 |
| `llmmodels` | `LLMModel` | LLM 模型配置 | `modelName`；`platformId`；`priority` |
| `appsettings` | `AppSettings` | 全局设置（固定 `Id="global"`） | （未显式创建额外索引） |
| `promptstages` | `PromptSettings` / `BsonDocument` | 提示词配置（集合名为历史兼容保留 `promptstages`） | （未显式创建额外索引） |
| `systemprompts` | `SystemPromptSettings` | PRD 问答系统提示词（可按角色覆盖） | （未显式创建额外索引） |
| `llmrequestlogs` | `LlmRequestLog` | LLM 请求日志（调试/审计/统计） | `startedAt desc`；`requestId`；`groupId`；`sessionId`；`(provider, model)`；**TTL 7 天**（`endedAt`） |
| `apirequestlogs` | `ApiRequestLog` | API 请求日志（调试/审计） | `startedAt desc`；`requestId`；`userId`；`path`；`statusCode`；`(clientType, clientId)`；**TTL 7 天**（`endedAt`） |
| `prdcomments` | `PrdComment` | PRD 批注/评论 | `(documentId, headingId, createdAt desc)` |
| `model_lab_experiments` | `ModelLabExperiment` | LLM 实验（管理端） | `(ownerAdminId, updatedAt desc)`；`createdAt desc` |
| `model_lab_runs` | `ModelLabRun` | 实验运行（管理端） | `(ownerAdminId, startedAt desc)`；`experimentId` |
| `model_lab_run_items` | `ModelLabRunItem` | 运行项（管理端） | `(ownerAdminId, runId)`；`modelId` |
| `model_lab_model_sets` | `ModelLabModelSet` | 模型集合（管理端） | `(ownerAdminId, name)` 唯一；`(ownerAdminId, updatedAt desc)` |
| `model_lab_groups` | `ModelLabGroup` | 模型分组（管理端） | `(ownerAdminId, name)` 唯一；`(ownerAdminId, updatedAt desc)` |
| `image_master_sessions` | `ImageMasterSession` | Image Master / VisualAgent 会话（注：代码层已重命名为 VisualAgent，集合名保留兼容） | `(ownerUserId, updatedAt desc)` |
| `image_master_messages` | `ImageMasterMessage` | Image Master 消息 | `(sessionId, createdAt)`；`(workspaceId, createdAt)` |
| `image_assets` | `ImageAsset` | 图片资产元数据（去重：sha256） | `(ownerUserId, createdAt desc)`；`(ownerUserId, sha256)` 唯一；`(workspaceId, createdAt desc)`；`(workspaceId, sha256)` 唯一（partial unique：仅对存在 `workspaceId` 的文档生效） |
| `image_master_canvases` | `ImageMasterCanvas` | 画布（JSON payload） | `(ownerUserId, sessionId)` 唯一；`(ownerUserId, updatedAt desc)`；`workspaceId` 唯一（partial unique：仅对存在 `workspaceId` 的文档生效） |
| `image_master_workspaces` | `ImageMasterWorkspace` | Workspace（共享/协作） | `(ownerUserId, updatedAt desc)`；`memberUserIds`（multi-key） |
| `image_gen_size_caps` | `ImageGenSizeCaps` | 生图尺寸上限（按模型/平台维度） | `modelId` 唯一（partial：`ModelId` exists）；`(platformId, modelName)` 唯一（partial：`PlatformId` & `ModelName` exists） |
| `image_gen_runs` | `ImageGenRun` | 生图任务（管理端） | `(ownerAdminId, createdAt desc)`；`(status, createdAt)`；`(ownerAdminId, idempotencyKey)` 唯一（partial：`IdempotencyKey` 为 string） |
| `image_gen_run_items` | `ImageGenRunItem` | 生图任务项 | `(ownerAdminId, runId)`；`(runId, itemIndex, imageIndex)` 唯一 |
| `image_gen_run_events` | `ImageGenRunEvent` | 生图 SSE 事件（支持 afterSeq 续传） | `(ownerAdminId, runId)`；`(runId, seq)` 唯一 |
| `upload_artifacts` | `UploadArtifact` | 上传产物引用（用于追踪大内容落地） | `(requestId, createdAt desc)`；`(requestId, kind, createdAt desc)`；`(sha256, createdAt desc)` |
| `admin_prompt_overrides` | `AdminPromptOverride` | 管理端覆盖 system prompt | `(ownerAdminId, key)` 唯一 |
| `admin_idempotency` | `AdminIdempotencyRecord` | 管理端写接口幂等记录（替代 Redis） | `(ownerAdminId, scope, idempotencyKey)` 唯一（partial：`idempotencyKey` 为 string）；`createdAt desc` |
| `sessions` | `Session` | 会话元数据（IM形态，持久化） | `userId`；`groupId`；`updatedAt desc` |
| `admin_notifications` | `AdminNotification` | 管理端通知 | `(targetAdminId, createdAt desc)` |
| `desktop_asset_skins` | `DesktopAssetSkin` | Desktop 皮肤定义 | `name` 唯一 |
| `desktop_asset_keys` | `DesktopAssetKey` | Desktop 资源 Key 定义 | `key` 唯一 |
| `desktop_assets` | `DesktopAsset` | Desktop 资源文件映射 | `(skinId, keyId)` 唯一 |
| `literary_prompts` | `LiteraryPrompt` | 文学创作提示词模板 | `(ownerAdminId, updatedAt desc)` |
| `openplatformapps` | `OpenPlatformApp` | 开放平台应用（第三方接入） | `appKey` 唯一 |
| `openplatformrequestlogs` | `OpenPlatformRequestLog` | 开放平台请求日志 | `(appId, createdAt desc)`；**TTL** |
| `model_groups` | `ModelGroup` | 模型分组（用于业务隔离）。关键字段：`StrategyType`（int, 默认 0=FailFast, 可选 1=Race/2=Sequential/3=RoundRobin/4=WeightedRandom/5=LeastLatency）控制池内调度策略 | `name` 唯一 |
| `llm_app_callers` | `LLMAppCaller` | LLM 应用调用者配置 | `appCode` 唯一；`lastCalledAt` |
| `model_scheduler_config` | `ModelSchedulerConfig` | 模型调度策略配置 | - |
| `model_test_stubs` | `ModelTestStub` | 模型测试桩（Stub OpenAI 兼容） | - |
| `system_roles` | `SystemRole` | 系统角色定义（RBAC 权限矩阵） | `roleName` 唯一 |
| `user_preferences` | `UserPreference` | 用户偏好设置 | `userId` 唯一 |
| `watermark_font_assets` | `WatermarkFontAsset` | 水印字体资产 | `(userId, fontKey)` 唯一 |
| `watermark_configs` | `WatermarkConfig` | 水印配置（基于 appKey 绑定） | `(userId, updatedAt desc)`；`(userId, appKeys)` |
| `report_teams` | `ReportTeam` | 周报团队 | `leaderUserId` |
| `report_team_members` | `ReportTeamMember` | 周报团队成员 | `(teamId, userId)` 唯一；`userId` |
| `report_templates` | `ReportTemplate` | 周报模板 | `(isDefault, createdAt)` |
| `report_weekly_reports` | `WeeklyReport` | 周报主体 | `(userId, teamId, weekYear, weekNumber)` 唯一；`(teamId, status, periodEnd)`；`(userId, periodEnd)` |
| `report_daily_logs` | `ReportDailyLog` | 每日工作打点 | `(userId, date)` 唯一 |
| `report_data_sources` | `ReportDataSource` | Git/SVN 数据源配置 | `teamId` |
| `report_commits` | `ReportCommit` | 缓存的代码提交 | `(dataSourceId, commitHash)` 唯一；`(mappedUserId, committedAt)` |
| `report_comments` | `ReportComment` | 周报段落级评论（支持线程回复） | `(reportId, sectionIndex)`；`(parentCommentId)` |
| `report_team_summaries` | `TeamSummary` | AI 团队周报汇总（按周去重） | `(teamId, weekYear, weekNumber)` 唯一 |

---

## Redis / 内存缓存（加速层）

### Redis 基本配置

- **默认 TTL**：`Session:TimeoutMinutes`（默认 30 分钟），由 `RedisCacheManager` 的 `defaultExpiryMinutes` 决定（见 `prd-api/src/PrdAgent.Api/Program.cs`）。
- **序列化**：JSON（camelCase）。

### Redis Key 清单

> 说明：除下表列出的 key 外，不允许随意拼接裸字符串；如确需新增，优先加到 `CacheKeys`。

| Key 格式 | 值类型 | TTL | 读写方/用途 | 失效策略 |
|---|---|---|---|---|
| `session:{sessionId}` | `Session` | 30 分钟滑动 | `SessionService`：会话元数据 | 更新/读取会刷新活跃时间；清理：`CleanupExpiredSessionsAsync()` / Admin purge |
| `document:{documentId}` | `ParsedPrd` | 默认 TTL（通常 30 分钟） | `DocumentService`：文档热缓存；miss 回源 Mongo | 文档保存后写回；Admin purge 清理 `document:*` |
| `chat:history:{sessionId}` | `List<Message>`（最多 100） | 30 分钟滑动 | `ChatService`：拼接 LLM 上下文 | 每次写入刷新；会话删除时清理（非群会话） |
| `chat:history:group:{groupId}` | `List<Message>`（最多 100） | 30 分钟滑动 | `ChatService`：群上下文 | 由 TTL 自然过期；会话删除不会清理（避免误删共享历史） |
| `auth:refresh:{userId}:{clientType}:{sessionKey}` | `AuthRefreshSession` | 3 天滑动 | `AuthSessionService`：refresh session | 校验成功/Touch 会刷新 TTL；可按 pattern 删除 |
| `auth:refresh:{userId}:{clientType}:*` | （pattern） | - | 删除某用户某端全部 refresh session | `RemoveByPatternAsync` |
| `auth:tv:{userId}:{clientType}` | `int` | 不设置（长期保留） | `AuthSessionService`：tokenVersion（踢下线） | bump 时写入；不依赖 TTL |
| `admin:data:purge:{adminId}:{idemKey}` | `DataPurgeResponse` | 15 分钟 | `AdminDataController`：purge 幂等（重复请求直接返回上次结果） | TTL 到期自动失效 |

### 内存缓存（IMemoryCache）

| Key | 值类型 | TTL | 用途 |
|---|---|---|---|
| `AppSettings:Global` | `AppSettings` | 5 分钟 | `AppSettingsService`：全局设置的短期内存缓存（源：Mongo `appsettings`，固定 `Id="global"`） |

---

## 对象存储（Tencent COS）

### COS Key（对象名）规则

权威实现：`prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs`

- **Key 必须全小写**。
- 业务 Key 由 `domain/type/sha/ext` 决定，形如：
  - `{prefix}/{domain}/{type}/{sid}.{ext}`
  - `prefix` 为可选配置（归一化为小写；会剥离历史的 `/assets` 尾部）。
  - `domain/type` 为业务域（例如 Image Master）。
  - `sid` 为 sha256 的前 128-bit（16 bytes）经 base32（小写、无 padding）编码后的短标识（长度 26）。
  - `ext` 来自 mime（`png/jpg/jpeg/webp/gif`）。

### 删除安全护栏

- 默认**禁止**删除生产前缀对象：`DeleteAsync` 仅允许删除 `_it/` 测试目录下对象。
- 如需开启受控删除，必须显式启用开关并配置 allowlist（domain/type 前缀白名单）。

### 固定路径型 COS Key（智能资源）

除上述 `{prefix}/{domain}/{type}/{sid}.{ext}` 的 SHA 索引型 key 外，本项目还使用以下**固定路径型 key**（覆盖写、不走 SHA 去重）：

| COS Key 模式 | 用途 | 关联数据库字段 | 说明 |
|---|---|---|---|
| `icon/desktop/{key}.{ext}` | Desktop 默认资源（无皮肤） | `DesktopAsset.RelativePath` | `key` 为业务标识（如 `bg`、`load`），不含扩展名；`ext` 由上传文件推断 |
| `icon/desktop/{skin}/{key}.{ext}` | Desktop 皮肤资源 | `DesktopAsset.RelativePath` | `skin` 为皮肤名（如 `white`、`dark`），全小写；回退逻辑：若皮肤资源不存在，回退到默认 |
| `icon/backups/head/nohead.png` | 头像兜底图（固定文件名） | - | 当用户头像不存在或加载失败时的兜底图 |
| `icon/backups/head/{avatarFileName}` | 用户头像文件 | `User.AvatarFileName` | `avatarFileName` 格式为 `{usernameLower}.{ext}`（全小写），数据库只存文件名，服务端拼接完整 URL 下发 |

**关键约束**：
- **全小写**：所有 key 与 skin 名称必须全小写。
- **key 仅文件名**：Desktop 资源 key 不允许包含 `/`（禁止子目录），仅支持字母/数字/下划线/中划线/点。
- **覆盖写**：相同路径的资源会被新上传文件覆盖（不保留历史版本）。
- **扩展名推断**：服务端根据 `Content-Type` 与文件名后缀自动推断扩展名（支持 `png/jpg/gif/webp/mp4` 等）。

### 与数据库的关系（引用型持久化）

- 数据库中只保存 COS URL 与必要元数据（例如 `sha256/mime/size/requestId` 等），不保存大对象内容本身。
- 上传相关追踪：`upload_artifacts`（见上表）。

---

## Web 管理后台（prd-admin）本地持久化

### localStorage

| Key | 值 | 说明 |
|---|---|---|
| `prd-admin-auth` | zustand persist（`{ state, version }`） | 管理端登录态（`prd-admin/src/stores/authStore.ts`）；入口会读取它来判断是否触发 post-login 特效（`prd-admin/src/main.tsx`） |
| `prd-admin-layout` | zustand persist | 仅持久化 `navCollapsed`（侧边栏折叠） |
| `prdAdmin.aiChat.sessions.{userId}` | `LocalSession[]` | AI Chat 页面本地会话列表（仅 UI 层） |
| `prdAdmin.aiChat.messages.{userId}.{sessionId}` | `UiMessage[]` | AI Chat 页面本地消息（仅 UI 层） |
| `prdAdmin.imageMaster.splitWidth.{userId}` | string（number） | Image Master：左右分栏宽度 |
| `prdAdmin.imageMaster.viewport.{userId}` | `{ z, x, y }` | Image Master：相机/缩放 viewport |
| `prdAdmin.imageMaster.modelPref.{userId}` | `{ auto, modelId }` | Image Master：模型偏好 |
| `prdAdmin.imageMaster.directPrompt.{userId}` | `'1'/'0'` | Image Master：直出提示词开关 |
| `prd-admin-llm-lab-cache:v1:{userId}` | `LlmLabCacheV1`（JSON） | LLM Lab：UI 选择与结果（图片内容不在这里） |
| `prd_admin_platform_pricing_v1` | `Record<string, PlatformPricing>` | 模型管理页：平台计价配置（仅 UI 层） |

### sessionStorage

| Key | 值 | 说明 |
|---|---|---|
| `prd-postlogin-fx` | `'1'` | 刷新/首次进入时触发一次的 post-login 特效标记 |

### IndexedDB

| DB / Store | Key | 值 | 说明 |
|---|---|---|---|
| DB `prd-admin-llm-lab`（v1）/ store `images` | `id = {userId}:{itemKey}` | `{ id, blob, updatedAt }` | LLM Lab：图片 blob 本地缓存（避免 base64 进 localStorage） |

---

## 桌面端（prd-desktop）本地持久化

### localStorage（Zustand persist）

| Key | 值 | 说明 |
|---|---|---|
| `auth-storage` | 认证信息（token/refresh/sessionKey/user） | `prd-desktop/src/stores/authStore.ts` |
| `session-storage` | 会话/角色/模式/文档/群游标等（partialize） | `prd-desktop/src/stores/sessionStore.ts` |
| `message-storage` | 已加载消息（partialize），并在 rehydrate 时 revive Date | `prd-desktop/src/stores/messageStore.ts` |
| `prd-citation-preview-storage` | `drawerWidth` | 引用预览抽屉宽度（`prd-desktop/src/stores/prdCitationPreviewStore.ts`） |
| `ui-prefs-storage` | UI 偏好设置（主题、布局等） | `prd-desktop/src/stores/uiPrefsStore.ts` |
| `settings-storage` | 用户设置（服务器地址、开发者模式等） | `prd-desktop/src/stores/settingsStore.ts` |
| `desktop-branding-storage` | 桌面端品牌配置（名称、图标 URL 等） | `prd-desktop/src/stores/desktopBrandingStore.ts` |
| `remote-assets-storage` | 远程资产缓存 | `prd-desktop/src/stores/remoteAssetsStore.ts` |

### localStorage（手写 key）

| Key | 值 | 说明 |
|---|---|---|
| `prdAgent.sidebarWidth` | string（number） | Sidebar 展开宽度（`prd-desktop/src/components/Layout/Sidebar.tsx`） |

### sessionStorage

| Key | 值 | 说明 |
|---|---|---|
| `demo-prd-content` | string | 演示模式的 PRD 内容缓存（`prd-desktop/src/components/Settings/SettingsModal.tsx`） |

### 落盘文件（Tauri）

| 路径 | 格式 | 说明 |
|---|---|---|
| `{app_data_dir}/config.json` | JSON（pretty） | 桌面端配置（`apiBaseUrl/isDeveloper/clientId`），由 `src-tauri/src/commands/config.rs` 读写 |


