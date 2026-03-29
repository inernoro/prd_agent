# 网页托管与分享 — 设计文档

> **版本**：v1.0 | **日期**：2026-03-07 | **状态**：已实现

## 一、管理摘要

- **解决什么问题**：缺乏轻量级静态站点托管能力，工作流和视频 Agent 生成的 HTML 无法直接分享
- **方案概述**：用户上传 HTML/ZIP 文件，系统解压后托管到 COS 对象存储，支持分享链接、密码保护、过期控制；其他服务可通过 IHostedSiteService 直接创建托管页
- **业务价值**：为工作流、视频 Agent 等模块提供统一的网页输出和分享能力
- **影响范围**：prd-api WebPagesController + HostedSiteService、COS 对象存储
- **预计风险**：低 — 独立模块，不影响已有功能

## 概述

网页托管（Web Hosting）是一个轻量级静态站点托管平台，用户可上传 HTML/ZIP 文件，系统解压后托管到 COS 对象存储并生成可访问 URL。支持分享链接、密码保护、过期控制。

其他服务（工作流、视频 Agent 等）可通过 `IHostedSiteService` 领域服务直接创建托管网页，无需走 HTTP。

---

## 架构设计

### 分层结构

```
┌─────────────────────────────────────────────────────┐
│                   HTTP 层 (Controller)               │
│   WebPagesController — 路由: api/web-pages           │
│   职责: 参数校验、HTTP 状态码映射、Auth 上下文提取     │
└───────────────────────┬─────────────────────────────┘
                        │ 注入
┌───────────────────────▼─────────────────────────────┐
│               领域服务层 (IHostedSiteService)          │
│   HostedSiteService — 核心业务逻辑                    │
│   职责: ZIP 解压、HTML 改写、COS 上传编排、分享管理    │
│   可被 Controller / Worker / Agent 共同注入使用        │
└───────────┬───────────────────────┬─────────────────┘
            │                       │
┌───────────▼──────────┐  ┌────────▼──────────────────┐
│   MongoDbContext      │  │   IAssetStorage            │
│   hosted_sites        │  │   UploadToKeyAsync()       │
│   web_page_share_links│  │   BuildSiteKey()           │
└──────────────────────┘  │   BuildUrlForKey()          │
                          │   DeleteByKeyAsync()        │
                          └─────────────────────────────┘
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储方式 | COS 自定义 key（非 SHA256 去重） | 站点文件需保持相对路径结构 |
| HTML 路径改写 | 绝对路径 `/xxx` → 相对路径 `./xxx` | COS 子目录下加载资源需要相对路径 |
| 分享机制 | 12 字符 Base64 Token | URL 友好、碰撞率极低 |
| 服务层抽取 | IHostedSiteService 领域服务 | 其他模块可直接注入，无需走 HTTP |

---

## 数据模型

### HostedSite（托管站点）

集合: `hosted_sites` | 模型: `PrdAgent.Core.Models.HostedSite`

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | GUID（32 位无连字符） |
| Title | string | 站点标题 |
| Description | string? | 站点描述 |
| SourceType | string | 来源: `upload` / `workflow` / `api` |
| SourceRef | string? | 来源引用（如 workflowExecutionId、runId） |
| CosPrefix | string | COS 目录前缀: `web-hosting/sites/{siteId}/` |
| EntryFile | string | 入口文件名（默认 `index.html`） |
| SiteUrl | string | 完整入口 URL |
| Files | List\<HostedSiteFile\> | 文件清单（path, cosKey, size, mimeType） |
| TotalSize | long | 站点总大小 (bytes) |
| Tags | List\<string\> | 用户标签 |
| Folder | string? | 分类文件夹 |
| CoverImageUrl | string? | 封面图 URL |
| OwnerUserId | string | 所属用户 |
| ViewCount | long | 浏览次数 |
| CreatedAt | DateTime | 创建时间 |
| UpdatedAt | DateTime | 更新时间 |

**索引**:
- `(OwnerUserId asc, CreatedAt desc)` — 用户站点列表
- `(Tags asc)` — 标签多值索引
- `(OwnerUserId asc, SourceType asc)` — 按来源过滤
- `(OwnerUserId asc, Folder asc)` — 按文件夹过滤

### WebPageShareLink（分享链接）

集合: `web_page_share_links` | 模型: `PrdAgent.Core.Models.WebPageShareLink`

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | GUID |
| Token | string | 短 Token（12 字符 Base64，URL 安全） |
| SiteId | string? | 关联站点 ID（单站点分享） |
| SiteIds | List\<string\> | 关联站点列表（合集分享） |
| ShareType | string | `single` / `collection` |
| Title | string? | 分享标题（自动生成或自定义） |
| Description | string? | 分享描述 |
| AccessLevel | string | `public` / `password` |
| Password | string? | 访问密码 |
| ViewCount | long | 浏览次数 |
| LastViewedAt | DateTime? | 最后浏览时间 |
| CreatedBy | string | 创建者用户 ID |
| CreatedAt | DateTime | 创建时间 |
| ExpiresAt | DateTime? | 过期时间 |
| IsRevoked | bool | 是否已撤销 |

**索引**:
- `(Token)` — 唯一索引
- `(CreatedBy asc, CreatedAt desc)` — 用户分享列表

---

## COS 存储结构

```
{prefix}/web-hosting/sites/{siteId}/
  ├── index.html
  ├── css/style.css
  ├── js/app.js
  └── images/logo.png
```

- **不使用 SHA256 去重**: 每个站点独立目录，保持原始文件路径结构
- **IAssetStorage 扩展方法**: `BuildSiteKey()`, `UploadToKeyAsync()`, `BuildUrlForKey()`, `DeleteByKeyAsync()`
- **域名路径**: `AppDomainPaths.DomainWebHosting = "web-hosting"`

---

## API 端点

路由前缀: `api/web-pages` | 权限: `web-pages.read` / `web-pages.write`

### 站点管理

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| POST | `/upload` | 上传 HTML/ZIP，解压并托管 | write |
| POST | `/from-content` | 从 HTML 字符串创建（供 Agent/工作流） | write |
| GET | `/` | 列出用户站点（支持 keyword/folder/tag/sourceType/sort） | read |
| GET | `/{id}` | 获取站点详情 | read |
| PUT | `/{id}` | 更新元信息（标题、描述、标签、文件夹、封面） | write |
| POST | `/{id}/reupload` | 重新上传替换内容 | write |
| DELETE | `/{id}` | 删除站点（含 COS 清理） | write |
| POST | `/batch-delete` | 批量删除 | write |
| GET | `/folders` | 获取文件夹列表 | read |
| GET | `/tags` | 获取标签列表（含计数） | read |

### 分享管理

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| POST | `/share` | 创建分享链接 | write |
| GET | `/shares` | 获取分享列表 | read |
| DELETE | `/shares/{shareId}` | 撤销分享 | write |
| GET | `/shares/view/{token}` | 匿名访问分享（无需登录） | 匿名 |

---

## IHostedSiteService 领域服务

### 接口定义

```
IHostedSiteService
├── CreateFromHtmlAsync()       — 从 HTML 字节创建
├── CreateFromZipAsync()        — 从 ZIP 字节创建
├── CreateFromContentAsync()    — 从 HTML 字符串创建（核心对接点）
├── ReuploadAsync()             — 替换站点内容
├── GetByIdAsync()              — 查询单站点
├── ListAsync()                 — 列表查询（分页 + 筛选）
├── ListFoldersAsync()          — 文件夹列表
├── ListTagsAsync()             — 标签列表
├── UpdateAsync()               — 更新元信息
├── DeleteAsync()               — 删除（含 COS 清理）
├── BatchDeleteAsync()          — 批量删除
├── CreateShareAsync()          — 创建分享
├── ListSharesAsync()           — 分享列表
├── RevokeShareAsync()          — 撤销分享
└── ViewShareAsync()            — 匿名查看分享
```

### 对接示例

```csharp
// 其他服务通过 DI 注入即可使用
public class VideoGenRunWorker
{
    private readonly IHostedSiteService _siteService;

    public async Task ExecuteAsync(string userId, string html, string runId)
    {
        var site = await _siteService.CreateFromContentAsync(
            userId, html,
            title: "视频教程页面",
            description: null,
            sourceType: "video-agent",
            sourceRef: runId,
            tags: null, folder: null);
        // site.SiteUrl → 可直接访问的 URL
    }
}
```

---

## 上传处理流程

### 单 HTML 文件

```
用户上传 .html/.htm
  → RewriteAbsolutePathsInHtml（路径改写）
  → UploadToKeyAsync（上传到 COS）
  → 创建 HostedSite（1 个文件记录）
  → 返回站点信息
```

### ZIP 压缩包

```
用户上传 .zip
  → 内存解压（不落盘）
  → DetectRootPrefix（自动剥离根目录前缀）
  → 遍历文件：
     → 安全检查（路径遍历 / 禁止扩展名 / 大小限制）
     → 跳过隐藏文件和 __MACOSX 元数据
     → HTML 文件做路径改写
     → 逐个 UploadToKeyAsync
  → 自动检测入口文件：index.html > index.htm > 第一个 HTML > 第一个文件
  → 创建 HostedSite（完整文件清单）
  → 返回站点信息
```

### HTML 路径改写规则

将 HTML 中 `src="/xxx"` 和 `href="/xxx"` 的绝对路径改为相对路径 `src="./xxx"`，使站点在 COS 子目录下也能正确加载资源。

```
输入: <script src="/js/app.js"></script>
输出: <script src="./js/app.js"></script>

输入 (子目录): <link href="/css/style.css">  (entryFile = "sub/index.html")
输出: <link href="../css/style.css">
```

排除 `//` 开头的协议相对 URL（如 `//cdn.example.com`）。

---

## 安全措施

| 措施 | 说明 |
|------|------|
| 路径遍历防护 | 过滤 `..` 和绝对路径 |
| 文件类型限制 | 禁止 .exe/.dll/.sh/.bat/.py 等可执行文件 |
| 大小限制 | 单文件 50MB、解压总量 200MB、最多 500 个文件 |
| macOS 元数据过滤 | 自动跳过 `__MACOSX/` 和隐藏文件 |
| 分享密码保护 | 可选密码验证 |
| 分享过期机制 | 可配置过期天数 |
| 分享撤销 | 支持主动撤销分享链接 |

---

## 权限定义

| 权限 Key | 说明 |
|----------|------|
| `web-pages.read` | 查看托管站点列表与详情 |
| `web-pages.write` | 上传/编辑/删除/分享托管站点 |

**基础功能**：网页托管属于基础功能，所有内置角色（admin / operator / viewer / agent_tester）默认授予 read + write 权限。

菜单: `AdminMenuCatalog` → appKey `web-pages`, 路由 `/web-pages`, 图标 `Globe`

---

## 前端页面

### WebPagesPage (`/web-pages`)

管理后台站点管理页面，功能包括:
- 拖拽上传区（支持 HTML/ZIP）
- 站点卡片列表（iframe 实时预览缩略图）
- 筛选：关键词搜索、文件夹过滤、标签过滤、来源类型过滤
- 排序：最新/最早/标题/最多浏览/最大
- 站点操作：编辑元信息、重新上传、分享、删除、批量删除
- 一键分享弹窗（密码保护 + 过期天数）

### ShareViewPage (`/s/wp/:token`)

匿名分享查看页面:
- Token 验证 + 可选密码验证
- 单站点: 直接 iframe 展示
- 合集: 站点列表 + 选中后 iframe 展示

---

## 核心文件清单

| 文件 | 用途 |
|------|------|
| `Core/Interfaces/IHostedSiteService.cs` | 领域服务接口 |
| `Core/Models/WebPage.cs` | HostedSite + WebPageShareLink + HostedSiteFile 模型 |
| `Infrastructure/Services/HostedSiteService.cs` | 领域服务实现 |
| `Infrastructure/Database/MongoDbContext.cs` | hosted_sites + web_page_share_links 集合 + 索引 |
| `Infrastructure/Services/AssetStorage/IAssetStorage.cs` | COS 存储接口扩展 |
| `Infrastructure/Services/Assets/WebPageAssetProvider.cs` | 资产发现器（IAssetProvider） |
| `Api/Controllers/Api/WebPagesController.cs` | HTTP 薄壳 Controller |
| `prd-admin/src/pages/WebPagesPage.tsx` | 站点管理页面 |
| `prd-admin/src/pages/ShareViewPage.tsx` | 分享查看页面 |
| `prd-admin/src/services/real/webPages.ts` | 前端 API 服务层 |

---

## 用户隔离设计

### 原则

网页托管数据严格按用户隔离，每个用户只能看到和操作自己的数据。

### 隔离范围

| 数据 | 隔离方式 | 说明 |
|------|----------|------|
| `hosted_sites` | `OwnerUserId` 过滤 | 所有查询/更新/删除都必须携带 userId 条件 |
| `web_page_share_links` | `CreatedBy` 过滤 | 分享链接只对创建者可见和可管理 |
| COS 文件 | `web-hosting/sites/{siteId}/` | 站点级隔离，siteId 全局唯一 |
| 文件夹 / 标签 | `OwnerUserId` 聚合 | 仅返回当前用户自己的文件夹和标签 |

### 实现要点

1. **Service 层强制 userId**：`IHostedSiteService` 所有方法都要求传入 `userId`，在 MongoDB 查询中作为必填过滤条件
2. **Controller 层提取身份**：从 JWT Claims 提取当前用户 ID，不接受前端传入的 userId
3. **匿名分享例外**：`ViewShareAsync` 不需要登录，通过 Token 查找分享链接后返回站点数据（只返回站点公开信息，不暴露 OwnerUserId）

### 不隔离的数据

- **匿名分享页面**：任何人持有 Token 即可访问（密码保护可选）
- **统一资产视图**：`WebPageAssetProvider` 也通过 userId 过滤，仅展示当前用户资产

---

## 后续事项

> 此处记录已识别但尚未实现的改进方向，供未来迭代参考。

### P1 — 近期优化

| 事项 | 说明 | 依赖 |
|------|------|------|
| AI 文本辅助 | 上传 HTML 后自动提取/生成标题、描述、标签 | `IHostedSiteService` + LLM Gateway，详见 `doc/plan.ai-text-assist.md` |
| 数据字典补全 | `hosted_sites` 和 `web_page_share_links` 需补录到 `rule.data-dictionary.md` | 无 |

### P2 — 中期增强

| 事项 | 说明 | 依赖 |
|------|------|------|
| 站点版本历史 | 每次 reupload 保留历史版本，支持回滚 | COS 版本管理或独立快照 |
| 站点访问统计 | 详细的 PV/UV 统计、来源追踪 | 需独立统计服务或嵌入打点脚本 |
| 自定义域名绑定 | 用户为站点绑定自有域名（CNAME） | COS/CDN 域名管理 API |

### P3 — 远期方向

| 事项 | 说明 | 依赖 |
|------|------|------|
| 团队协作 | 站点共享给团队成员（非匿名分享） | 团队/Group 权限体系 |
| 模板市场 | 站点模板发布到海鲜市场 | `IForkable` + `CONFIG_TYPE_REGISTRY` 集成 |
| 在线编辑器 | 浏览器内编辑 HTML/CSS/JS | Monaco Editor 集成 |
