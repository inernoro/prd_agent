# Desktop 资产功能方案 (Desktop Asset Features) · 计划

> **状态**：计划中 | **版本**：v1.0 | **日期**：2026-03-02

## 一、背景与目标

### 用户反馈
手机端（MobileAssetsPage）的资产聚合功能获得好评——用户可以在一个页面看到所有 Agent 产出物（图片、文档、附件），非常直观。现需要将此能力带到桌面端，并充分利用大屏优势提供更丰富的功能。

### 设计理念
- **复用核心**：复用手机端的 API 数据源 (`GET /api/mobile/assets`) 和分类逻辑
- **增强体验**：利用桌面端大屏空间，提供列表/网格视图切换、详情预览面板、搜索过滤、批量操作等增强能力
- **一致性**：遵循桌面端现有设计语言（Glass UI、dark/light 主题、Sidebar 导航模式）

---

## 二、功能对比矩阵

| 功能 | 手机端 (现有) | 桌面端 (新增) |
|------|:---:|:---:|
| 分类 Tab（全部/图片/文档/附件） | ✅ | ✅ 复用 |
| 2 列卡片网格 | ✅ | ✅ 复用 + 自适应列数 |
| 缩略图预览 | ✅ | ✅ 增强（更大预览） |
| 文件大小/类型标签 | ✅ | ✅ 复用 |
| **列表视图** | - | ✅ **新增** |
| **视图切换（网格/列表）** | - | ✅ **新增** |
| **详情侧面板** | - | ✅ **新增** |
| **搜索（按标题）** | - | ✅ **新增** |
| **排序（时间/大小/名称）** | - | ✅ **新增** |
| **单个资产操作（复制链接/下载/打开）** | - | ✅ **新增** |
| **分页加载 / 滚动加载** | 仅 limit:50 | ✅ **增强** |
| **空状态引导** | ✅ 简单文案 | ✅ 增强（带操作按钮） |
| **统计概览** | - | ✅ **新增**（顶栏简要统计） |

---

## 三、技术方案

### 3.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Desktop App (Tauri)                         │
│                                                                 │
│  Sidebar                    Main Area                           │
│  ┌────────┐    ┌──────────────────────────────────────────────┐ │
│  │ 群组    │    │  mode === 'Assets'                           │ │
│  │        │    │  ┌─────────────────────────────────────────┐ │ │
│  │        │    │  │ DesktopAssetsPage                       │ │ │
│  │        │    │  │                                         │ │ │
│  │ 知识库  │    │  │  Toolbar: [Tabs] [Search] [Sort] [View]│ │ │
│  │        │    │  │                                         │ │ │
│  │ 缺陷管理│    │  │  ┌─────────────────┐ ┌──────────────┐ │ │ │
│  │        │    │  │  │  Grid/List View  │ │ Detail Panel │ │ │ │
│  │ 我的资产│◄───│  │  │  (Asset cards)   │ │ (Preview)    │ │ │ │
│  │  ▲新增  │    │  │  │                 │ │              │ │ │ │
│  │        │    │  │  └─────────────────┘ └──────────────┘ │ │ │
│  └────────┘    │  └─────────────────────────────────────────┘ │ │
│                └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 路由集成

在桌面端的 `InteractionMode` 中新增 `'Assets'` 模式：

```typescript
// types/index.ts
type InteractionMode = 'QA' | 'Knowledge' | 'PrdPreview' | 'AssetsDiag' | 'Defect' | 'Assets';
```

在 `App.tsx` 路由条件中新增：

```typescript
mode === 'Assets' ? <DesktopAssetsPage /> : ...
```

在 `Sidebar.tsx` 底部区域新增"我的资产"入口（与"知识库"、"缺陷管理"同级别）。

### 3.3 后端 API 复用 + 增强

**复用现有 API**（无需修改后端）：

- `GET /api/mobile/assets?category=&limit=&skip=` — 核心数据源，已完全满足需求

**新增 Rust Tauri Command**：

```rust
// src-tauri/src/commands/assets.rs (新增)
#[tauri::command]
pub async fn get_my_assets(
    category: Option<String>,    // image | document | attachment | null
    limit: Option<u32>,          // 默认 30
    skip: Option<u32>,           // 分页偏移
    state: tauri::State<'_, AppState>,
) -> Result<ApiResponse<MyAssetsResponse>, String> {
    // 调用 GET /api/mobile/assets
}
```

> **为什么通过 Rust 中转？** 遵循桌面端现有模式（所有 API 调用都走 Tauri invoke → Rust HTTP client），保持 token 自动刷新、错误拦截等统一能力。

### 3.4 前端组件结构

```
prd-desktop/src/
├── components/
│   └── Assets/
│       ├── AssetsDiagPage.tsx          # 已有（管理员资源诊断）
│       ├── DesktopAssetsPage.tsx        # ★ 新增：主页面容器
│       ├── AssetsToolbar.tsx            # ★ 新增：顶部工具栏（Tab + 搜索 + 排序 + 视图切换）
│       ├── AssetGridView.tsx           # ★ 新增：网格视图
│       ├── AssetListView.tsx           # ★ 新增：列表视图
│       ├── AssetCard.tsx               # ★ 新增：网格卡片（复用手机端设计语言）
│       ├── AssetDetailPanel.tsx        # ★ 新增：右侧详情面板
│       └── StartLoadOverlay.tsx        # 已有
├── stores/
│   └── assetStore.ts                   # ★ 新增：资产状态管理
```

### 3.5 状态管理 (Zustand Store)

```typescript
// stores/assetStore.ts
interface AssetStore {
  // 数据
  assets: MobileAssetItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;

  // 过滤与排序
  activeTab: AssetTab;           // 'all' | 'image' | 'document' | 'attachment'
  searchQuery: string;
  sortBy: 'date' | 'size' | 'name';
  sortOrder: 'asc' | 'desc';

  // 视图
  viewMode: 'grid' | 'list';
  selectedAssetId: string | null; // 详情面板选中项

  // Actions
  setActiveTab: (tab: AssetTab) => void;
  setSearchQuery: (q: string) => void;
  setSortBy: (sort: 'date' | 'size' | 'name') => void;
  toggleSortOrder: () => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  selectAsset: (id: string | null) => void;

  fetchAssets: () => Promise<void>;
  loadMore: () => Promise<void>;   // 滚动加载
  refresh: () => Promise<void>;
}
```

### 3.6 UI 设计细节

#### 3.6.1 DesktopAssetsPage（主容器）

```
┌──────────────────────────────────────────────────────────────┐
│  📂 我的资产                                      统计: 32图 8文档 │
│                                                              │
│  [全部] [图片] [文档] [附件]  │  🔍 搜索...  │ ↕排序 │ ▦ ≡   │
│──────────────────────────────────────────────────────────────│
│                                           │                  │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐             │  Asset Detail    │
│  │    │ │    │ │    │ │    │             │  ┌──────────┐    │
│  │ 🖼️ │ │ 🖼️ │ │ 📄 │ │ 🖼️ │             │  │          │    │
│  │    │ │    │ │    │ │    │             │  │  Preview  │    │
│  ├────┤ ├────┤ ├────┤ ├────┤             │  │          │    │
│  │名称│ │名称│ │名称│ │名称│             │  └──────────┘    │
│  │标签│ │标签│ │标签│ │标签│             │  Title: xxx      │
│  └────┘ └────┘ └────┘ └────┘             │  Type: 图片      │
│                                           │  Size: 1.2 MB    │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐             │  Date: 2026-03-01│
│  │    │ │    │ │    │ │    │             │  Prompt: ...     │
│  │ 🖼️ │ │ 📎 │ │ 🖼️ │ │ 📄 │             │                  │
│  │    │ │    │ │    │ │    │             │  [复制链接]       │
│  └────┘ └────┘ └────┘ └────┘             │  [在浏览器打开]   │
│                                           │                  │
│                                           │                  │
│           ⏬ 加载更多...                    │                  │
└──────────────────────────────────────────────────────────────┘
```

#### 3.6.2 网格视图 (AssetGridView)

- 自适应列数：`grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`（比手机端 2 列更宽松）
- 卡片样式复用手机端设计：4:3 缩略图 + 标题 + 类型标签 + 文件大小
- hover 效果：边框高亮 + 轻微放大 (`scale-[1.01]`)
- 选中态：左侧蓝色指示条 + 边框高亮
- 点击卡片：右侧打开详情面板

#### 3.6.3 列表视图 (AssetListView)

```
┌──────────────────────────────────────────────────────┐
│  🖼️  缩略图  │  标题              │ 类型  │ 大小   │ 日期        │
│──────────────────────────────────────────────────────│
│  [thumb]    │  AI生成的风景图      │ 图片  │ 1.2MB │ 2026-03-01 │
│  [thumb]    │  需求文档v2.pdf      │ 文档  │ 3.5MB │ 2026-02-28 │
│  [thumb]    │  UI设计稿.png        │ 附件  │ 850KB │ 2026-02-27 │
└──────────────────────────────────────────────────────┘
```

- 紧凑行高，每行左侧 40x30 缩略图
- 表头可排序（点击列标题切换排序）

#### 3.6.4 详情面板 (AssetDetailPanel)

- 右侧滑入面板（宽 320px），与 GroupInfoDrawer 设计语言一致
- 内容：
  - 大图预览（图片类型）/ 文件图标（非图片类型）
  - 文件名、类型、大小、创建时间
  - 图片宽高信息（仅图片）
  - 生成提示词（仅 AI 生成的图片，来自 `asset.title`）
  - 所属工作区（如有 `workspaceId`）
- 操作按钮：
  - 复制链接（写入剪贴板）
  - 在浏览器中打开（shell.open）
  - 下载到本地（Tauri dialog.save + HTTP download）

### 3.7 Glass UI 适配

遵循桌面端已有的 Glass UI 设计系统：

```css
/* 卡片使用 */
.asset-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(8px);
}

/* 工具栏使用 */
.assets-toolbar {
  background: var(--bg-elevated);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

/* 详情面板使用 */
.asset-detail-panel {
  @apply ui-glass-panel;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}
```

---

## 四、实施计划

### Phase 1：核心页面框架 (Day 1)

| 步骤 | 任务 | 文件 |
|------|------|------|
| 1.1 | 新增 `InteractionMode: 'Assets'` | `types/index.ts` |
| 1.2 | 新增 Tauri command `get_my_assets` | `src-tauri/src/commands/assets.rs`, `main.rs` |
| 1.3 | 创建 `assetStore.ts` (Zustand) | `stores/assetStore.ts` |
| 1.4 | 创建 `DesktopAssetsPage.tsx` (主容器) | `components/Assets/DesktopAssetsPage.tsx` |
| 1.5 | 创建 `AssetsToolbar.tsx` (Tab + 搜索) | `components/Assets/AssetsToolbar.tsx` |
| 1.6 | 创建 `AssetGridView.tsx` + `AssetCard.tsx` | `components/Assets/AssetGridView.tsx` |
| 1.7 | 在 `App.tsx` 添加路由 | `App.tsx` |
| 1.8 | 在 `Sidebar.tsx` 添加"我的资产"入口 | `components/Layout/Sidebar.tsx` |

### Phase 2：增强功能 (Day 2)

| 步骤 | 任务 | 文件 |
|------|------|------|
| 2.1 | 创建 `AssetListView.tsx` (列表视图) | `components/Assets/AssetListView.tsx` |
| 2.2 | 创建 `AssetDetailPanel.tsx` (详情面板) | `components/Assets/AssetDetailPanel.tsx` |
| 2.3 | 实现搜索过滤（前端 filter） | `assetStore.ts` |
| 2.4 | 实现排序（时间/大小/名称） | `assetStore.ts` |
| 2.5 | 实现滚动加载 (loadMore) | `AssetGridView.tsx`, `AssetListView.tsx` |
| 2.6 | 实现操作：复制链接、浏览器打开 | `AssetDetailPanel.tsx` |

### Phase 3：精打细磨 (Day 3)

| 步骤 | 任务 |
|------|------|
| 3.1 | 空状态优化（带引导按钮） |
| 3.2 | 统计概览栏（图片数/文档数/附件数） |
| 3.3 | 视图偏好持久化（localStorage） |
| 3.4 | 暗色/亮色主题适配验证 |
| 3.5 | 键盘导航（↑↓ 选择、Enter 打开、Esc 关闭详情） |

---

## 五、数据流

```
用户点击 Sidebar "我的资产"
  → sessionStore.setMode('Assets')
  → App.tsx 渲染 <DesktopAssetsPage />
  → useEffect → assetStore.fetchAssets()
  → invoke('get_my_assets', { category, limit: 30 })
  → Rust: GET /api/mobile/assets?category=&limit=30
  → 后端聚合 image_assets + attachments
  → 返回 { items, total, hasMore }
  → assetStore.setAssets(items)
  → 前端 useMemo: 搜索过滤 + 排序
  → 渲染 Grid/List View

用户点击卡片
  → assetStore.selectAsset(id)
  → AssetDetailPanel 滑入
  → 显示大图预览 + 元信息 + 操作按钮

用户滚动到底部
  → IntersectionObserver 触发
  → assetStore.loadMore()
  → invoke('get_my_assets', { skip: currentCount })
  → 追加到 assets 列表
```

---

## 六、风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| 后端 API 返回大量数据 | 前端分页加载（每次 30 条），避免一次请求过多 |
| 缩略图加载慢 | `loading="lazy"` + 占位符骨架屏 |
| 搜索性能 | 当前搜索为前端过滤（基于已加载数据），数据量不大时足够 |
| 与手机端样式冲突 | 桌面端独立组件，不复用 MobileAssetsPage 组件代码，仅复用 API 和数据模型 |

---

## 七、不做的事项（明确排除）

1. **不新增后端 API**：完全复用 `/api/mobile/assets`，避免重复建设
2. **不做批量删除**：资产归属于各 Agent（VisualAgent、PRD），删除需要各模块配合，暂不开放
3. **不做文件上传**：资产页仅展示已有产出物，上传功能保留在各 Agent 入口
4. **不做视频播放**：视频资产暂时仅展示缩略图和链接，不内嵌播放器
5. **不修改 InteractionMode 的互斥逻辑**：资产页与其他 mode 互斥，点击侧栏项切换
