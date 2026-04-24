# 配置市场（海鲜市场） · 设计

> **状态**：已实现

---

## 1. 管理摘要

配置市场（内部代号"海鲜市场"）是一个跨应用的配置共享平台，让用户可以一键发布自己精心调校的 AI 配置（提示词、风格图、水印等），其他用户则可以免费 Fork 到自己的工作空间直接使用。

核心设计决策有两个：

- **前端类型注册表模式（CONFIG_TYPE_REGISTRY）**：新增配置类型只需在注册表中添加一行配置，卡片渲染、筛选、排序自动适配，零改动核心组件。
- **后端白名单 Fork 机制（IForkable + ForkService）**：Fork 时只拷贝业务字段白名单内的属性，所有权、计数、来源信息自动重置，从机制上保证数据隔离。

当前已支持 3 种配置类型（提示词、风格图、水印），工具箱智能体也已接入 Fork 能力。架构设计支持在 30 分钟内完成新类型扩展（前端 3 步 + 后端 3 步）。

---

## 2. 产品定位

### 2.1 解决什么问题

AI 配置（提示词、风格图、水印参数）的调校耗时且依赖经验。团队内部存在大量"只有自己知道的好配置"，新用户冷启动困难，老用户之间缺少交流渠道。

### 2.2 不做什么

| 不做 | 原因 |
|------|------|
| 付费交易 | 当前阶段聚焦内部共享，不引入支付复杂度 |
| 版本管理 | Fork 是创建时快照，不追踪上游变更 |
| 评论/评分 | 用 ForkCount 作为唯一热度指标，足够简单 |
| 实时同步 | Fork 后独立演化，不与原配置建立持续关联 |

---

## 3. 用户场景

### 场景一：分享高手——发布优质提示词

小王花了两周反复调校了一套文学创作提示词，生图效果稳定且风格独特。他打开配置管理弹窗，在提示词卡片上点击「发布」，系统标记该配置为公开，卡片上出现"已公开"徽章和"0 次下载"计数。其他同事在海鲜市场浏览时看到了这个提示词，觉得不错就 Fork 了一份。小王看到 ForkCount 从 0 涨到 15，获得了成就感。

**关键流程**：配置管理 → 找到卡片 → 点击「发布」 → 出现在市场 → 其他用户 Fork → ForkCount 递增

### 场景二：新人冷启动——一键 Fork 水印

小李刚入职，需要给生成的图片加水印但不知道怎么调参数。她打开海鲜市场，按"水印"分类筛选，按"热门"排序，看到排名第一的"极简水印"有 42 次下载。点击「拿来吧」按钮，输入自定义名称后确认，水印配置立刻出现在她的水印列表中，可以直接使用也可以微调。

**关键流程**：海鲜市场页面 → 分类筛选 → 排序 → 预览卡片 → 输入名称 → Fork → 立即可用

### 场景三：跨应用共享——从文学创作跳转市场

用户在文学创作 Agent 中点击"配置管理"，弹窗标题栏有"我的"和"海鲜市场"两个标签。切换到"海鲜市场"后看到所有类型（提示词 + 风格图 + 水印）混合展示。也可以直接访问独立路由 `/marketplace?type=watermark&source=visual-agent`，URL 参数自动激活对应的分类筛选。

### 场景四：取消发布——撤回配置

小王发现发布的提示词有逻辑错误，在"我的"视图找到该卡片，点击「取消发布」，系统二次确认后将 `IsPublic` 设为 `false`。配置从市场列表消失，但已被其他用户 Fork 的副本不受影响。

---

## 4. 核心能力

### 4.1 类型注册表模式（前端）

前端通过 `CONFIG_TYPE_REGISTRY` 实现配置类型的插件化管理。每个类型注册以下信息：

| 注册项 | 作用 |
|--------|------|
| `key` | 类型唯一标识（如 `prompt`、`refImage`、`watermark`） |
| `label` | 中文显示名 |
| `icon` | Lucide 图标组件 |
| `color` | 背景色、文字色、边框色、图标色配置 |
| `api` | 四个 API 函数（listMarketplace、publish、unpublish、fork） |
| `getDisplayName` | 从数据中提取展示名称 |
| `PreviewRenderer` | 类型专属预览渲染器组件 |

通用组件 `MarketplaceCard` 读取注册表，自动渲染标题栏（图标 + 名称 + 类型标签）、预览区（委托给 PreviewRenderer）和底栏（Fork 次数 + 作者信息 + 下载按钮），无需为新类型修改卡片代码。

### 4.2 白名单 Fork 机制（后端）

`IForkable` 接口要求每个可 Fork 的 Model 声明白名单字段：

```csharp
public string[] GetCopyableFields() => new[] { nameof(Name), nameof(Nodes), nameof(Connections) };
```

`ForkService.Fork<T>()` 通过反射只拷贝白名单中的属性，然后自动执行：

1. 生成新 ID
2. 设置新所有者
3. 记录 Fork 来源（ForkedFromId、ForkedFromUserId、ForkedFromUserName、ForkedFromUserAvatar）
4. 重置市场字段（IsPublic=false、ForkCount=0）
5. 调用 `OnForked()` 执行类型特定的后处理

白名单机制的好处：新增字段时默认不拷贝，必须显式加入白名单才会被 Fork，避免敏感信息泄露。

### 4.3 双入口访问

| 入口 | 路由 | 场景 |
|------|------|------|
| 独立页面 | `/marketplace` | 全局浏览，支持 `?type=` 和 `?source=` 参数 |
| 弹窗内嵌 | `ConfigManagementDialogBase` | Agent 内切换"我的/海鲜市场"标签 |

### 4.4 已注册类型

| 类型 Key | 标签 | 数据集合 | PreviewRenderer | 预览形式 |
|----------|------|----------|-----------------|----------|
| `prompt` | 提示词 | `literary_prompts` | PromptPreviewRenderer | Markdown 渲染 |
| `refImage` | 风格图 | `reference_image_configs` | RefImagePreviewRenderer | 左侧提示词 + 右侧图片缩略图 |
| `watermark` | 水印 | `watermark_configs` | WatermarkPreviewRenderer | 左侧参数网格 + 右侧效果预览 |

工具箱智能体（`toolbox_items`）也实现了 Fork 能力，但尚未注册到 `CONFIG_TYPE_REGISTRY`。

---

## 5. 架构设计

### 5.1 分层架构

```
用户操作
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  前端展示层                                               │
│                                                          │
│  MarketplacePage ──→ MarketplaceCard ──→ PreviewRenderer │
│       │                    │                              │
│       ▼                    ▼                              │
│  CONFIG_TYPE_REGISTRY (类型注册表)                         │
│  ├─ prompt: { api, icon, color, PreviewRenderer }        │
│  ├─ refImage: { ... }                                    │
│  └─ watermark: { ... }                                   │
│                                                          │
│  工具函数：merge → sort → filter                          │
└──────────────────────────────────────────────────────────┘
  │  HTTP API
  ▼
┌──────────────────────────────────────────────────────────┐
│  后端服务层                                               │
│                                                          │
│  各 Controller (硬编码 appKey)                             │
│  ├─ GET  /{type}/marketplace   → 列表（IsPublic=true）   │
│  ├─ POST /{type}/{id}/publish  → 发布                    │
│  ├─ POST /{type}/{id}/unpublish→ 取消发布                │
│  └─ POST /{type}/{id}/fork     → Fork + 记录日志         │
│                                                          │
│  ForkService.Fork<T>()  ← IForkable 白名单拷贝            │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  数据层 (MongoDB)                                         │
│                                                          │
│  各配置集合 + marketplace_fork_logs（下载记录）            │
└──────────────────────────────────────────────────────────┘
```

### 5.2 前端数据流

页面加载时并行请求所有注册类型的 `listMarketplace` API，将结果按类型存入 `dataByType` Map。展示时经过三步管道处理：

1. **mergeMarketplaceData**：将多类型数据合并为 `MixedMarketplaceItem[]`，按 `categoryFilter` 过滤
2. **sortMarketplaceItems**：按 `hot`（ForkCount 降序）或 `new`（CreatedAt 降序）排序
3. **filterMarketplaceItems**：按搜索关键词匹配 displayName 和 previewText

### 5.3 Fork 时序

```
用户点击「拿来吧」
  │
  ├─ 弹出命名对话框（systemDialog.prompt）
  │
  ├─ POST /{type}/{id}/fork  { name: "用户输入的名称" }
  │     │
  │     ├─ 查询源配置（IsPublic=true 校验）
  │     ├─ 查询源配置所有者信息（用户名、头像）
  │     ├─ ForkService.Fork<T>()  → 白名单拷贝 + 重置
  │     ├─ 插入新配置到 MongoDB
  │     ├─ 原配置 ForkCount +1（$inc 原子操作）
  │     └─ 插入 MarketplaceForkLog
  │
  ├─ 前端 toast「已添加到我的配置」
  └─ 重新加载市场数据（更新 ForkCount 显示）
```

---

## 6. 数据模型

### 6.1 IMarketplaceItem 公共字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 配置 ID |
| `IsPublic` | bool | 是否公开到市场 |
| `ForkCount` | int | 被 Fork 次数 |
| `ForkedFromId` | string? | Fork 来源配置 ID |
| `ForkedFromUserId` | string? | 来源所有者 ID |
| `ForkedFromUserName` | string? | 来源所有者名称（冗余） |
| `ForkedFromUserAvatar` | string? | 来源所有者头像（冗余） |
| `IsModifiedAfterFork` | bool | Fork 后是否已修改 |
| `CreatedAt` | DateTime | 创建时间 |
| `UpdatedAt` | DateTime | 更新时间 |

### 6.2 MarketplaceForkLog（下载记录）

存储于 `marketplace_fork_logs` 集合，记录每次 Fork 操作：

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 记录 ID |
| `UserId` | string | 下载用户 ID |
| `UserName` | string? | 用户名（冗余） |
| `ConfigType` | string | 配置类型（prompt / refImage / watermark） |
| `SourceConfigId` | string | 被 Fork 的源配置 ID |
| `SourceConfigName` | string | 源配置名称（冗余） |
| `ForkedConfigId` | string | Fork 后新配置 ID |
| `ForkedConfigName` | string | 新配置名称 |
| `SourceOwnerUserId` | string? | 原作者 ID |
| `SourceOwnerName` | string? | 原作者名称 |
| `AppKey` | string? | 应用标识 |
| `CreatedAt` | DateTime | 下载时间 |

### 6.3 前端类型定义

`MarketplaceItemBase` 定义前端通用字段，各类型扩展自身业务字段：

| 前端类型 | 扩展字段 |
|----------|----------|
| `MarketplacePrompt` | title, content, scenarioType |
| `MarketplaceRefImage` | name, prompt, imageUrl |
| `MarketplaceWatermark` | name, text, fontKey, fontSizePx, anchor, opacity, offsetX/Y, iconEnabled, borderEnabled, backgroundEnabled, roundedBackgroundEnabled, previewUrl |

---

## 7. 接口设计

### 7.1 每个配置类型的标准 API 端点

| 方法 | 路径模式 | 说明 | 认证 |
|------|----------|------|------|
| GET | `/{type}/marketplace?keyword=&sort=hot\|new` | 列表公开配置 | 需要 |
| POST | `/{type}/{id}/publish` | 发布到市场（所有者校验） | 需要 |
| POST | `/{type}/{id}/unpublish` | 取消发布（所有者校验） | 需要 |
| POST | `/{type}/{id}/fork` | Fork 配置（body: `{ name?: string }`） | 需要 |

### 7.2 已实现端点明细

| 类型 | 基础路径 |
|------|----------|
| 提示词 | `/api/literary-agent/prompts` |
| 风格图 | `/api/literary-agent/config/reference-images` |
| 水印 | `/api/watermarks` |
| 工具箱 | `/api/ai-toolbox` |

### 7.3 Marketplace 列表响应格式

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "abc123",
        "title": "生图刘文波",
        "forkCount": 12,
        "isPublic": true,
        "createdAt": "2026-01-15T08:30:00Z",
        "ownerUserId": "user-001",
        "ownerUserName": "张三",
        "ownerUserAvatar": "avatar-001.jpg"
      }
    ]
  }
}
```

### 7.4 Fork 请求/响应

请求体（可选）：

```json
{ "name": "我的自定义名称" }
```

响应：返回 Fork 后的完整配置对象，`IsPublic=false`、`ForkCount=0`、`ForkedFromId` 指向源配置。

---

## 8. 关联影响

### 8.1 与其他系统的关系

| 关联系统 | 关系 | 说明 |
|----------|------|------|
| 文学创作 Agent | 数据来源 | 提示词、风格图通过 LiteraryPromptsController / LiteraryAgentConfigController 管理 |
| 视觉创作 Agent | 数据来源 | 水印通过 WatermarkController 管理 |
| 工具箱 | 数据来源 | 智能体通过 AiToolboxController 管理 |
| 用户系统 | 依赖 | Fork 时查询用户名、头像用于冗余存储 |
| RBAC 权限 | 依赖 | MarketplacePage 路由需要 `access` 权限 |
| 导航系统 | 入口 | AppShell 侧边栏提供海鲜市场入口 |
| 用户画像 | 消费 | 用户个人资料页展示 marketplaceStats |

### 8.2 扩展新类型的检查清单

新增配置类型到海鲜市场时，需完成以下步骤：

**后端（3 步）**：
1. Model 类实现 `IForkable` 接口，声明 `GetCopyableFields()` 白名单
2. Controller 添加 `marketplace`、`publish`、`unpublish`、`fork` 四个端点
3. Fork 端点中插入 `MarketplaceForkLog` 记录

**前端（3 步）**：
1. 在 `marketplaceTypes.tsx` 定义数据类型接口（extends `MarketplaceItemBase`）
2. 实现 `PreviewRenderer` 组件
3. 在 `CONFIG_TYPE_REGISTRY` 中注册

**验证**：
- 独立页面 `/marketplace` 能看到新类型卡片
- 分类筛选标签自动出现新类型
- Fork 后配置出现在用户自己的列表中
- MarketplaceForkLog 有记录

---

## 9. 风险与约束

| 维度 | 风险 | 当前应对 | 剩余风险 |
|------|------|----------|----------|
| **数据隔离** | Fork 时拷贝了不该拷贝的字段 | IForkable 白名单机制，新字段默认不拷贝 | 低：需开发者显式加入白名单 |
| **数据一致性** | ForkCount 与实际 Fork 数不一致 | 使用 MongoDB `$inc` 原子操作 | 低：极端并发下可能有微小偏差 |
| **性能** | 市场列表加载慢（多类型并行请求） | 前端 Promise.all 并行加载 | 中：类型数量增长后请求数线性增长，未来可考虑聚合 API |
| **可扩展性** | 前后端扩展步骤不同步 | `.claude/rules/marketplace.md` 规则文档 + 注册表模式 | 低：有明确的扩展指南 |
| **用户体验** | Fork 后用户找不到配置在哪 | Toast 提示"已添加到我的配置" | 中：缺少直接跳转到"我的"的入口 |
| **内容质量** | 低质量配置淹没市场 | 仅用 ForkCount 排序 | 中：无举报/审核机制，依赖社区自治 |
| **历史兼容** | 老配置缺少 IMarketplaceItem 公共字段 | MongoDB 动态 Schema，缺失字段视为默认值 | 低：IsPublic 默认 false，不会意外公开 |

### 9.1 已知限制

- **单向 Fork**：Fork 后与源配置断开关联，不支持上游更新同步
- **无版本控制**：配置修改无历史记录
- **无分页**：市场列表一次性加载全部数据，配置数量增长后需要引入分页
- **搜索仅前端**：关键词过滤在前端执行，不利于大数据量场景

---

## 关键文件索引

| 文件 | 用途 |
|------|------|
| `prd-admin/src/lib/marketplaceTypes.tsx` | 前端类型注册表 + 预览渲染器 + 工具函数 |
| `prd-admin/src/pages/marketplace/MarketplacePage.tsx` | 独立市场页面 |
| `prd-admin/src/components/marketplace/MarketplaceCard.tsx` | 通用卡片组件 |
| `prd-admin/src/components/config-management/ConfigManagementDialogBase.tsx` | 弹窗内嵌入口 |
| `prd-admin/src/components/effects/MarketplaceBackground.tsx` | 背景动效管理 |
| `prd-api/src/PrdAgent.Core/Interfaces/IMarketplaceItem.cs` | IMarketplaceItem + IForkable 接口 |
| `prd-api/src/PrdAgent.Infrastructure/Services/ForkService.cs` | 通用 Fork 服务 |
| `prd-api/src/PrdAgent.Core/Models/MarketplaceForkLog.cs` | Fork 日志模型 |
| `prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryPromptsController.cs` | 提示词市场 API |
| `prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryAgentConfigController.cs` | 风格图市场 API |
| `prd-api/src/PrdAgent.Api/Controllers/WatermarkController.cs` | 水印市场 API |
| `prd-api/src/PrdAgent.Api/Controllers/Api/AiToolboxController.cs` | 工具箱市场 API |
