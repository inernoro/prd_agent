# 苹果快捷指令集成 设计方案

> **版本**：v1.0 | **日期**：2026-03-10 | **状态**：开发中

## 一、问题背景

用户在日常使用 iPhone 时，经常需要收藏各种内容：抖音/快手短视频、公众号文章、小红书笔记等。目前这些内容散落在各个 App 的收藏夹中，无法统一管理和检索。

通过苹果快捷指令（Apple Shortcuts），用户可以从任意 App 的"分享"菜单一键将内容发送到 PrdAgent，系统自动解析链接、提取元数据、归类存储。这是一个零摩擦的采集入口。

## 二、设计目标

| 目标 | 说明 | 非目标 |
|------|------|--------|
| 一键收藏 | 用户在分享菜单中选择快捷指令即完成收藏 | 不做 App 内嵌 WebView |
| 自动解析 | 识别短视频/文章/图片链接，提取标题、封面、作者 | 不做视频下载/转码 |
| 用户级隔离 | 每用户独立 API Key + 独立收藏空间 | 不做多租户组织级 |
| 复用渠道体系 | 作为新 ChannelType 接入，复用白名单/配额/任务追踪 | 不新建独立认证体系 |

## 三、核心设计决策

### 决策 1：作为 Channel 渠道类型接入，而非独立模块

**结论**：新增 `ChannelType = "shortcuts"`，复用现有渠道基础设施。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. 新增 Channel 类型 | 复用白名单、配额、任务追踪、管理后台 | 需遵循 Channel 约定 | ✅ 采用 |
| B. 独立 Controller + 独立认证 | 完全自由 | 重复造轮子，管理分散 | ❌ 否决 |

**理由**：渠道体系已提供身份映射、配额管理、任务状态机、管理后台 UI 等能力，直接复用可减少 ~60% 工作量。

### 决策 2：认证方式使用现有 API Key 体系

**结论**：复用 `OpenPlatformApp` 的 `sk-` API Key，快捷指令通过 Bearer Token 认证。

**理由**：苹果快捷指令原生支持 HTTP 请求 + Bearer Token，无需额外 SDK。用户只需在首次设置时粘贴 API Key。

### 决策 3：URL 解析采用策略模式 + 302 跟随

**结论**：实现 `IUrlParserService` 接口，内置各平台解析策略，通过 HttpClient 跟随短链跳转获取真实 URL，再提取 OG meta 标签。

| 平台 | 短链格式 | 解析方式 |
|------|----------|----------|
| 抖音 | `v.douyin.com/xxx` | 302 跳随 → 正则提取 video_id → OG meta |
| 快手 | `v.kuaishou.com/xxx` | 302 跟随 → OG meta |
| B站 | `b23.tv/xxx` | 302 → BV号 → OG meta |
| 小红书 | `xhslink.com/xxx` | 302 → note_id → OG meta |
| 公众号 | `mp.weixin.qq.com/s/xxx` | 直接 OG meta |
| 通用 | 其他 URL | 尝试 OG meta，回退到 `<title>` |

## 四、整体架构

```
┌─────────────────┐
│  iPhone 分享菜单  │
│  → 苹果快捷指令   │
└────────┬────────┘
         │ POST /api/shortcuts/collect
         │ Authorization: Bearer sk-xxx
         │ Body: { url, text?, tags? }
         ▼
┌─────────────────────────┐
│   ShortcutsController    │
│   (appKey: shortcuts)    │
├─────────────────────────┤
│ 1. ApiKey 认证 (复用)     │
│ 2. ChannelWhitelist 配额  │
│ 3. 创建 ChannelTask      │
│ 4. 调用 UrlParserService │
│ 5. 存储 UserCollection   │
│ 6. 同步返回结果           │
└────────┬────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────────┐
│ URL    │ │ user_        │
│ Parser │ │ collections  │
│ Service│ │ (MongoDB)    │
└────────┘ └──────────────┘
```

**快捷指令安装流程**：

```
用户扫二维码 → 打开 iCloud 链接 → 安装快捷指令
→ 首次运行 → 输入 API Key → 存储到快捷指令变量
→ 后续使用 → 分享菜单 → 自动携带 Key 发送
```

## 五、数据设计

### 新增集合

| 集合 | 用途 | 关键索引 |
|------|------|----------|
| `user_collections` | 用户收藏内容 | `userId + createdAt`、`userId + contentType`、`userId + platform` |
| `shortcut_templates` | 快捷指令模板（iCloud 链接管理） | `isDefault` |

### UserCollection 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 主键 |
| UserId | string | 是 | 所属用户 |
| ContentType | string | 是 | video / article / image / link / text |
| Platform | string | 否 | douyin / kuaishou / bilibili / xiaohongshu / wechat / other |
| SourceUrl | string | 是 | 原始链接 |
| ResolvedUrl | string | 否 | 解析后真实链接 |
| Title | string | 否 | 内容标题 |
| Description | string | 否 | 摘要 |
| CoverUrl | string | 否 | 封面图 |
| Author | string | 否 | 作者 |
| Tags | List\<string\> | 否 | 标签（用户指定 + 自动推断） |
| FolderId | string | 否 | 分类文件夹（预留） |
| Source | string | 是 | 来源渠道：shortcuts / web / desktop |
| Metadata | Dictionary | 否 | 额外元数据 |
| CreatedAt | DateTime | 是 | 创建时间 |

### ShortcutTemplate 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 主键 |
| Name | string | 是 | 模板名称（如"收藏到 PrdAgent"） |
| Description | string | 否 | 说明 |
| ICloudUrl | string | 是 | iCloud 分享链接 |
| Version | string | 是 | 版本号 |
| IsDefault | bool | 是 | 是否系统默认 |
| CreatedBy | string | 否 | null = 系统级 |
| CreatedAt | DateTime | 是 | 创建时间 |

## 六、接口设计

| 方法 | 路径 | 用途 | 认证 |
|------|------|------|------|
| POST | `/api/shortcuts/collect` | 收藏内容（快捷指令主入口） | API Key |
| GET | `/api/shortcuts/collections` | 查询收藏列表（分页） | API Key |
| DELETE | `/api/shortcuts/collections/{id}` | 删除收藏 | API Key |
| POST | `/api/shortcuts/parse` | 仅解析 URL 不保存（预览用） | API Key |
| GET | `/api/shortcuts/templates` | 获取快捷指令模板列表 | 无（公开） |
| POST | `/api/admin/shortcuts/templates` | 创建/管理模板 | JWT (管理员) |

### 收藏接口详细设计

**请求**：
```
POST /api/shortcuts/collect
Authorization: Bearer sk-xxx
Content-Type: application/json

{ "url": "https://v.douyin.com/xxx", "text": "可选附加文字", "tags": ["旅行"] }
```

**响应**：
```json
{
  "success": true,
  "data": {
    "id": "...",
    "contentType": "video",
    "platform": "douyin",
    "title": "视频标题",
    "coverUrl": "https://...",
    "author": "@作者名"
  }
}
```

快捷指令收到响应后可通过 `Show Notification` 动作展示标题，给用户即时反馈。

## 七、影响范围

| 影响模块 | 变更内容 | 风险等级 |
|----------|----------|----------|
| ChannelTypes | 新增 `shortcuts` 常量 | 低 |
| ChannelTaskIntent | 新增 `save-link`、`parse-url` 意图 | 低 |
| MongoDbContext | 注册 2 个新集合 | 低 |
| Program.cs | 注册 `IUrlParserService` | 低 |
| 新建 ShortcutsController | ~200 行新代码 | 无（纯新增） |
| 新建 UrlParserService | ~300 行新代码 | 中（依赖外部 HTTP） |

## 八、关键约束与风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 短视频平台反爬 | 高 | 解析失败 | 降级为仅保存原始 URL + 标题 |
| 公众号文章防盗链 | 中 | 封面图无法加载 | 使用服务端代理或不保存封面 |
| 用户 API Key 泄露 | 低 | 冒用身份 | API Key 可随时重新生成 |
| 苹果快捷指令限制 | 低 | 功能受限 | 快捷指令支持完整 HTTP 请求，限制极少 |

## 九、分期实施

### Phase 1（MVP）— 本次实施

- ShortcutsController + 收藏/列表/删除
- UrlParserService（通用 OG meta + 抖音 + 公众号）
- UserCollection / ShortcutTemplate 模型
- ChannelTypes 新增 shortcuts

### Phase 2（增强）

- 更多平台解析器（快手、B站、小红书）
- LLM 自动摘要 + 智能标签
- 管理后台 shortcuts 页面
- 收藏夹文件夹分类
- 二维码生成 + 模板管理 UI
