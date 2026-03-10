# 苹果快捷指令集成 设计方案

> **版本**：v2.0 | **日期**：2026-03-10 | **状态**：开发中

## 一、问题背景

用户在日常使用手机时，经常需要收藏各种内容：抖音/快手短视频、公众号文章、小红书笔记等。目前这些内容散落在各 App 的收藏夹中，无法统一管理，更无法自动触发后续工作流（如自动摘要、分发、转写）。

通过苹果快捷指令 + HTTP API 的方式，用户可以从任意 App 的"分享"菜单一键将链接发送到 PrdAgent，系统保存后可选触发工作流或智能体。未来 Android 也可通过 Tasker 等方式接入同一 API。

## 二、设计目标

| 目标 | 说明 | 非目标 |
|------|------|--------|
| 扫码即用 | 用户在管理后台点击"添加快捷指令"→ 取名 → 扫码安装 → 完成 | 不做 App 内嵌 |
| 每人独立密钥 | 每个快捷指令绑定独立 `scs-` token，可识别用户身份 | 不复用 OpenPlatform API Key |
| 仅收藏，不解析 | 只保存原始 URL/文本，不做内容解析 | 不做 OG meta 提取、视频下载 |
| 预留工作流触发 | collect 后可选触发 workflow/agent，返回结果 | 本期不实现触发逻辑 |
| 跨平台 | HTTP API 不绑定 iOS，Android/桌面端均可调用 | 本期只提供 iOS 快捷指令安装引导 |

## 三、核心设计决策

### 决策 1：独立轻量密钥，不复用 OpenPlatform

**结论**：每个 UserShortcut 生成独立 `scs-` 前缀 token，ShortcutsController 自行校验。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. 独立 scs- token | 轻量、不污染 OpenPlatform 应用列表、可独立管理生命周期 | 需自行实现 token 校验 | ✅ 采用 |
| B. 复用 OpenPlatform sk- | 认证链路已有 | 每创建一个快捷指令就多一个 OpenPlatformApp，概念混淆 | ❌ 否决 |

### 决策 2：不做内容解析，仅收藏原始地址

**结论**：collect 接口只保存 URL + 可选文本 + 标签，不做 302 跟随、OG meta 提取。

**理由**：用户明确表示"只是收藏地址"，内容解析是下游工作流的职责（如"自动摘要"工作流）。保持 collect 端简单、快速、可靠。

### 决策 3：扫码安装流程

**结论**：QR 码指向服务端 setup 页面，页面提供 iCloud 快捷指令安装链接 + 自动复制 token。

**安装流程**:

```
管理后台/桌面端                              iPhone
     │                                        │
     │  1. 点击"添加快捷指令"                    │
     │  2. 输入名称                             │
     │  3. 系统生成 scs- token                  │
     │  4. 展示二维码                            │
     │         ─────── 扫码 ──────→             │
     │                                 5. 打开 setup 页面
     │                                 6. 点击"安装快捷指令"（iCloud 链接）
     │                                 7. iOS 提示添加快捷指令
     │                                 8. token 已自动嵌入 URL 参数
     │                                 9. 完成！
     │                                        │
     │  后续使用：                               │
     │                                 分享菜单 → 选择快捷指令
     │         ←── POST /collect ────          │
     │                                 收到通知："已收藏"
```

## 四、整体架构

```
┌──────────────────┐     ┌──────────────────┐
│ iPhone 分享菜单    │     │ Android (Tasker)  │
│ → 苹果快捷指令     │     │ → HTTP Shortcut   │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         └──────┬─────────────────┘
                │ POST /api/shortcuts/collect
                │ Authorization: Bearer scs-xxx
                │ Body: { url, text?, tags? }
                ▼
┌───────────────────────────┐
│    ShortcutsController     │
│    (appKey: shortcuts)     │
├───────────────────────────┤
│ 1. scs- token 校验         │
│ 2. 保存到 user_collections │
│ 3. 记录 ChannelTask       │
│ 4. (预留) 触发工作流       │
│ 5. 返回结果                │
└───────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────────┐ ┌──────────────┐
│ user_    │ │ channel_     │
│shortcuts │ │ tasks        │
│ (密钥)   │ │ (追踪)       │
└──────────┘ └──────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────────┐ ┌──────────────┐
│ user_    │ │ (预留)        │
│collections│ │ 工作流触发    │
│ (收藏)   │ │              │
└──────────┘ └──────────────┘
```

## 五、数据设计

### 新增集合

| 集合 | 用途 | 关键索引 |
|------|------|----------|
| `user_shortcuts` | 用户的快捷指令绑定（含 token） | `userId`、`tokenHash`(唯一) |
| `user_collections` | 用户收藏的链接/文本 | `userId + createdAt` |
| `shortcut_templates` | 系统级快捷指令 iCloud 模板 | `isDefault + isActive` |

### UserShortcut 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 主键 |
| UserId | string | 是 | 所属用户 |
| Name | string | 是 | 用户自定义名称（如"工作收藏"） |
| TokenHash | string | 是 | SHA256(scs-xxx)，用于校验 |
| TokenPrefix | string | 是 | token 前 8 位，用于展示（如 `scs-a1b2...`） |
| DeviceType | string | 否 | ios / android / other |
| IsActive | bool | 是 | 是否启用 |
| LastUsedAt | DateTime | 否 | 最后使用时间 |
| CollectCount | int | 是 | 累计收藏次数 |
| CreatedAt | DateTime | 是 | 创建时间 |

### UserCollection 字段（简化版）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 主键 |
| UserId | string | 是 | 所属用户 |
| ShortcutId | string | 否 | 来自哪个快捷指令 |
| Url | string | 否 | 收藏的链接 |
| Text | string | 否 | 附加文字或纯文本收藏 |
| Tags | List\<string\> | 否 | 标签 |
| Source | string | 是 | shortcuts / web / desktop / api |
| Status | string | 是 | saved / processing / completed / failed |
| Result | string | 否 | 工作流/LLM 返回的结果 |
| Metadata | Dictionary | 否 | 额外元数据 |
| CreatedAt | DateTime | 是 | 创建时间 |

### ShortcutTemplate 字段（不变）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 主键 |
| Name | string | 是 | 模板名称 |
| Description | string | 否 | 说明 |
| ICloudUrl | string | 是 | iCloud 分享链接 |
| Version | string | 是 | 版本号 |
| IsDefault | bool | 是 | 是否系统默认 |
| IsActive | bool | 是 | 是否启用 |
| CreatedBy | string | 否 | null = 系统级 |
| CreatedAt | DateTime | 是 | 创建时间 |

## 六、接口设计

### 快捷指令管理（JWT 认证，用户操作）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/shortcuts` | 创建快捷指令（返回 token，仅一次） |
| GET | `/api/shortcuts` | 列出我的快捷指令 |
| DELETE | `/api/shortcuts/{id}` | 删除快捷指令（吊销 token） |
| GET | `/api/shortcuts/{id}/setup` | 获取安装信息（QR 码数据 + iCloud 链接） |

### 收藏操作（scs- token 认证，快捷指令调用）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/shortcuts/collect` | 收藏链接/文本 |
| GET | `/api/shortcuts/collections` | 查询我的收藏（分页） |
| DELETE | `/api/shortcuts/collections/{id}` | 删除收藏 |

### 模板管理（JWT 认证，管理员操作）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/shortcuts/templates` | 获取模板列表（公开） |
| POST | `/api/shortcuts/admin/templates` | 创建模板 |
| DELETE | `/api/shortcuts/admin/templates/{id}` | 删除模板 |

### 收藏接口详细设计

**请求**：
```
POST /api/shortcuts/collect
Authorization: Bearer scs-a1b2c3d4e5f6...
Content-Type: application/json

{ "url": "https://v.douyin.com/xxx", "text": "好看的视频", "tags": ["旅行"] }
```

**响应**：
```json
{
  "success": true,
  "data": {
    "id": "abc123",
    "url": "https://v.douyin.com/xxx",
    "status": "saved",
    "message": "已收藏"
  }
}
```

快捷指令收到响应后通过 `Show Notification` 动作展示 message，给用户即时反馈。

## 七、安装引导设计

### iOS（苹果快捷指令）

`GET /api/shortcuts/{id}/setup` 返回以下数据，供前端渲染安装页：

```json
{
  "shortcutName": "工作收藏",
  "serverUrl": "https://api.example.com",
  "token": "scs-a1b2c3d4...",
  "iCloudUrl": "https://www.icloud.com/shortcuts/xxxx",
  "qrCodeData": "https://api.example.com/api/shortcuts/{id}/setup?t=scs-a1b2c3d4...",
  "instructions": {
    "ios": ["打开相机扫描二维码", "点击'添加快捷指令'", "完成！token 已自动配置"],
    "android": ["安装 HTTP Shortcuts 应用", "导入配置文件", "粘贴 token"]
  }
}
```

### Android（未来）

同一 HTTP API，可通过以下方式接入：
- **HTTP Shortcuts** App（开源，支持导入配置）
- **Tasker** + HTTP Request 插件
- 自定义 Android Intent

## 八、关键约束与风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| token 泄露 | 低 | 他人可冒用收藏 | 支持随时删除/重建快捷指令 |
| 苹果快捷指令更新 | 低 | 安装流程变化 | iCloud 链接方式稳定 |
| 工作流触发延迟 | 中 | 用户等待时间长 | collect 先返回 saved，工作流异步执行 |

## 九、分期实施

### Phase 1（MVP）— 本次实施

- UserShortcut 模型（独立 scs- token）
- UserCollection 模型（简化版，仅存 URL + 文本）
- ShortcutsController（创建/列表/删除快捷指令 + collect + setup）
- ShortcutTemplate 模型（iCloud 模板管理）
- ChannelTypes.Shortcuts + ChannelTask 追踪

### Phase 2（增强）

- 工作流触发（collect 后自动触发绑定的 workflow/agent）
- 管理后台 shortcuts 页面（快捷指令管理 + 收藏浏览）
- Android HTTP Shortcuts 配置导出
- 收藏夹文件夹分类
- 批量操作（批量删除、批量打标签）
