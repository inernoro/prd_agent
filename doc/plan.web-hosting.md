# 网页托管与分享 (Web Hosting) 实现计划

## 核心概念

这不是书签/收藏功能。这是一个 **网页托管平台**：
- 用户上传 HTML 文件或 ZIP 压缩包 → 系统解压并托管 → 生成可访问的 URL
- 工作流等系统模块也可以程序化创建托管网页
- 每个站点在 COS 上拥有独立文件夹，完全隔离
- 分享机制复用现有模式（Token、密码、过期时间）

## 数据模型

### HostedSite（托管站点）

```
{
  id: string,                    // GUID
  title: string,                 // 站点标题
  description?: string,          // 站点描述

  // ── 来源分类 ──
  sourceType: string,            // "upload" | "workflow" | "api"
  sourceRef?: string,            // 来源引用 (如 workflowExecutionId)

  // ── COS 存储 ──
  cosPrefix: string,             // COS 上的目录前缀: "web-hosting/sites/{siteId}/"
  entryFile: string,             // 入口文件名 (默认 "index.html")
  siteUrl: string,               // 完整入口 URL (COS public URL + cosPrefix + entryFile)
  files: [{                      // 文件清单
    path: string,                // 相对路径 (如 "index.html", "css/style.css")
    cosKey: string,              // COS 完整 key
    size: long,                  // 文件大小
    mimeType: string             // MIME 类型
  }],
  totalSize: long,               // 总大小 (bytes)

  // ── 元信息 ──
  tags: string[],                // 标签
  folder?: string,               // 分类文件夹
  coverImageUrl?: string,        // 封面图 (截图或首张图片)

  // ── 所有权 ──
  ownerUserId: string,
  viewCount: long,
  createdAt: DateTime,
  updatedAt: DateTime,
}
```

### 分享链接

复用现有 `WebPageShareLink` 模型，微调字段：
- `WebPageId` → `SiteId`（关联 HostedSite）
- `WebPageIds` → `SiteIds`（合集分享）
- 其他字段（Token, Password, ExpiresAt, AccessLevel）保持不变

## COS 存储结构

```
{prefix}/web-hosting/sites/{siteId}/
  ├── index.html          # 入口文件
  ├── css/
  │   └── style.css
  ├── js/
  │   └── app.js
  └── images/
      └── logo.png
```

- **Domain**: 新增 `DomainWebHosting = "web-hosting"` 到 AppDomainPaths
- **不使用 SHA256 去重**：每个站点独立目录，直接用 `UploadBytesAsync(key, bytes, contentType)` 上传
- **Type**: 新增 `TypeSite = "site"` — 但实际 COS key 不走 `{domain}/{type}/{sha}.{ext}` 模式，而是 `web-hosting/sites/{siteId}/{filePath}`

## API 设计

### Controller: `WebPagesController` (重构)

路由前缀: `api/web-pages`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/upload` | 上传 HTML 文件或 ZIP 包，解压并托管 |
| POST | `/from-content` | 从 HTML 内容直接创建（工作流/API 调用） |
| GET | `/` | 列出当前用户的托管站点 |
| GET | `/{id}` | 获取站点详情 |
| PUT | `/{id}` | 更新站点元信息（标题、描述、标签等）|
| DELETE | `/{id}` | 删除站点（含 COS 文件清理） |
| POST | `/batch-delete` | 批量删除 |
| POST | `/{id}/reupload` | 重新上传/更新站点内容 |
| GET | `/folders` | 获取文件夹列表 |
| GET | `/tags` | 获取标签列表 |

分享相关端点保持不变:
| POST | `/share` | 创建分享链接 |
| GET | `/shares` | 获取分享列表 |
| DELETE | `/shares/{shareId}` | 撤销分享 |
| GET | `/s/wp/{token}` | 匿名访问分享（返回站点 URL 重定向或元信息） |

### 上传处理逻辑

1. **单 HTML 文件**：
   - 直接保存到 `web-hosting/sites/{siteId}/index.html`
   - entryFile = "index.html"

2. **ZIP 压缩包**：
   - 在内存中解压（不落盘）
   - 安全检查：路径遍历攻击防护、文件大小限制
   - 自动检测入口文件：`index.html` > `index.htm` > 第一个 HTML 文件
   - 逐个文件上传到 `web-hosting/sites/{siteId}/{relativePath}`
   - 记录所有文件清单

3. **限制**：
   - 单文件最大 50MB
   - ZIP 解压后总大小最大 200MB
   - 单个 ZIP 最多 500 个文件
   - 禁止 `.exe`, `.dll`, `.sh` 等可执行文件

### 匿名访问 `/s/wp/{token}`

对于网页托管场景，分享链接的访问方式改为：
- 验证 Token、密码、过期时间
- 返回站点入口 URL（COS 公开 URL），前端直接 iframe 加载或跳转

## 变更文件清单

### 后端 (prd-api)

| 文件 | 操作 | 说明 |
|------|------|------|
| `Core/Models/WebPage.cs` | **重写** | `WebPage` → `HostedSite` 模型，`WebPageShareLink` 微调字段 |
| `Api/Controllers/Api/WebPagesController.cs` | **重写** | 全部重写为托管逻辑，新增 upload/from-content 端点 |
| `Infrastructure/Database/MongoDbContext.cs` | **修改** | 集合名 `web_pages` → `hosted_sites`，保留 `web_page_share_links` |
| `Infrastructure/Services/AssetStorage/AppDomainPaths.cs` | **修改** | 新增 `DomainWebHosting` |

### 前端 (prd-admin)

| 文件 | 操作 | 说明 |
|------|------|------|
| `pages/WebPagesPage.tsx` | **重写** | 改为站点管理页面（上传区 + 站点卡片 + 预览/分享） |
| `services/real/webPages.ts` | **重写** | API 函数适配新接口 |
| `services/api.ts` | **修改** | 路径更新 |
| `services/contracts/webPages.ts` | **新增** | TypeScript 类型定义 |

## 实施步骤

1. **后端模型** — 重写 `WebPage.cs` → `HostedSite` + 调整 `WebPageShareLink`
2. **COS 域名注册** — AppDomainPaths 新增 web-hosting
3. **MongoDbContext** — 注册新集合 + 索引
4. **Controller 重写** — 上传解压 + CRUD + 分享
5. **编译验证** — `dotnet build` 确认零错误
6. **前端类型** — contracts 定义
7. **前端服务层** — API 函数
8. **前端页面** — WebPagesPage 重写
9. **路由/导航** — 确认已接入（应该已有）

## 安全考虑

- ZIP 解压时防止路径遍历（`../` 攻击）
- 限制上传文件类型白名单
- COS 文件夹隔离，每个站点独立 `{siteId}/` 前缀
- 删除站点时级联清理 COS 文件
- 匿名访问走 COS 公开 URL，不通过后端代理
