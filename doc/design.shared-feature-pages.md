# Shared Feature Pages: prd-admin & prd-desktop 共享页面技术方案

> **版本**: v1.0
> **日期**: 2026-02-08
> **状态**: 设计草案
> **目标**: Desktop 与 Admin 共享功能页面，修改一方另一方自动生效

---

## 1. 现状分析

### 1.1 两端技术栈对比

| 维度 | prd-admin (Web) | prd-desktop (Tauri) |
|------|----------------|-------------------|
| **React** | 18.3.1 | 18.3.1 |
| **TypeScript** | 5.6.3 | 5.6.3 |
| **Zustand** | 5.0.1 | 5.0.1 |
| **Vite** | 6.0.1 | 6.0.1 |
| **Tailwind** | **v4.1** | **v3.4** |
| **路由** | React Router v7 | Zustand state 切换 |
| **数据层** | `fetch()` → HTTP API | `invoke()` → Rust → HTTP API |
| **UI 体系** | 液态玻璃 + Radix + Lexical + echarts + Three.js | 极简 + Radix 子集 |
| **页面数量** | 76+ 页面，20+ 路由 | 5 个交互模式 |
| **共享代码** | 无 | 无 |

### 1.2 Desktop Rust 层实际职责

Desktop 的 50+ Tauri commands 本质上是 **HTTP 代理**：

```
React → invoke('send_message', args) → Rust → reqwest::post("/api/v1/sessions/{id}/messages") → .NET Backend
```

Rust 层的 **真正独有价值** 只有：

| 能力 | 是否可被 Web 替代 |
|------|-----------------|
| SSE 事件转发 (group-message, message-chunk) | 可替代：浏览器原生 `EventSource` / `fetch` streaming |
| Auth token 管理 + 自动 refresh | 可替代：prd-admin 的 `apiClient.ts` 已实现 |
| Desktop Presence 心跳 (30s) | 可替代：Web 端发 HTTP 即可 |
| **自动更新** | **不可替代** - 必须 Rust |
| **深度链接 (prdagent://)** | **不可替代** - 必须 Rust |
| **系统菜单 / 托盘** | **不可替代** - 必须 Rust |
| **剪贴板写入图片** | **不可替代** - 必须 Rust |
| **窗口标题/标题栏样式** | **不可替代** - 必须 Rust |

**结论**：如果 Desktop 直接加载 prd-admin 的页面，50+ Tauri commands 中只有 ~5 个真正需要保留。

### 1.3 功能覆盖关系

```
prd-admin 功能集 (76+ 页面):
┌──────────────────────────────────────────────────────┐
│  Dashboard / Agent Dashboard / Stats                  │
│  User Management / Groups / Authz                     │
│  Model Management / Model Groups / Platforms          │
│  ┌──────────────────────────────────────────┐        │
│  │  PRD Chat (AiChatPage)           ← 重叠  │        │
│  │  Defect Agent                    ← 重叠  │        │
│  │  Literary Agent                           │        │
│  │  Visual Agent (Fullscreen)                │        │
│  │  AI Toolbox                               │        │
│  └──────────────────────────────────────────┘        │
│  LLM Logs / Data Management / Open Platform           │
│  Prompt Stages / Assets / Lab / Settings              │
│  Marketplace / Channels                               │
└──────────────────────────────────────────────────────┘

prd-desktop 功能集 (5 模式):
┌──────────────────────────────────────────┐
│  QA Chat (ChatContainer)         ← 重叠  │
│  PRD Preview (3列布局+划词提问)           │  ← admin 无此页面
│  Defect Management               ← 重叠  │
│  Knowledge Base (占位)                    │
│  Assets Diagnostics (Admin-only)          │
└──────────────────────────────────────────┘
```

Desktop 当前只有 5 个模式，而 admin 有 76+ 页面。共享后 Desktop 用户立即获得全部功能。

---

## 2. 方案选型

### 方案 A: Desktop WebView 直接加载 prd-admin（推荐）

```
┌─────────────────────────────────────────┐
│  Tauri Shell (Rust)                     │
│  ┌───────────────────────────────────┐  │
│  │  WebView                          │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  prd-admin (React SPA)     │  │  │
│  │  │  ├─ fetch() → HTTP → API   │  │  │
│  │  │  ├─ 检测 __TAURI__ ?       │  │  │
│  │  │  │   └─ 是 → 启用桌面增强  │  │  │
│  │  │  │       (深度链接/更新/...)│  │  │
│  │  │  └─ 否 → 纯 Web 模式      │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
│  Rust 层保留:                            │
│  ├─ 自动更新 (tauri-plugin-updater)     │
│  ├─ 深度链接 (prdagent://)              │
│  ├─ 系统菜单 (设置/DevTools/检查更新)    │
│  ├─ 窗口管理 (标题栏/拖拽)              │
│  └─ 剪贴板 (写入图片)                   │
└─────────────────────────────────────────┘
```

**核心逻辑**：
- prd-admin 的 `apiClient.ts` 已用 `fetch()` 直接调后端 — 在 WebView 中照常工作
- prd-admin 新增 `isDesktop()` 检测，按需启用桌面增强功能
- Desktop 的 Rust 层只保留无法被 Web 替代的原生能力
- Desktop 的 React 前端代码(`prd-desktop/src/`)可以逐步废弃

### 方案 B: Monorepo 共享包（工程正解但重构量大）

抽出 `packages/shared-ui`, `packages/shared-pages`, `packages/shared-stores`，两端通过 adapter 消费。

**不推荐先做**：需要统一 Tailwind v3→v4、抽象 50+ service 接口、改造路由体系。

### 方案 C: Module Federation（过度工程）

**不推荐**：运维复杂度远超项目规模。

---

## 3. 方案 A 详细设计

### 3.1 运行模式

Desktop 应用支持两种加载模式，通过配置切换：

```rust
// config.json
{
  "api_base_url": "https://pa.759800.com",
  "web_app_url": "https://pa.759800.com",   // 新增：Web 应用 URL
  "load_mode": "remote",                      // "remote" | "embedded"
  "is_developer": false,
  "client_id": "xxx"
}
```

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `remote` | WebView 加载远程 prd-admin URL | 生产环境（默认） |
| `embedded` | WebView 加载内嵌的 prd-admin 构建产物 | 离线/内网/高安全要求 |

### 3.2 实现步骤

#### Phase 1: prd-admin 桌面感知层（前端改动）

**新增文件**: `prd-admin/src/lib/desktop.ts`

```typescript
/**
 * 桌面环境检测与原生能力桥接
 *
 * 当 prd-admin 在 Tauri WebView 中运行时，
 * window.__TAURI_INTERNALS__ 会被 Tauri 自动注入。
 * 本模块提供统一的检测和调用接口。
 */

export function isDesktop(): boolean {
  const g = globalThis as any;
  return Boolean(g.__TAURI_INTERNALS__?.invoke);
}

export function getDesktopPlatform(): 'macos' | 'windows' | 'linux' | null {
  if (!isDesktop()) return null;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

// --- 原生能力桥接 ---

/** 检查更新（仅桌面端） */
export async function checkForUpdate(): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('check_for_update');
}

/** 打开开发者工具 */
export async function openDevTools(): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_devtools');
}

/** 监听深度链接事件 */
export async function onDeepLink(handler: (url: string) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('deep-link', (e) => handler(e.payload));
}

/** 监听系统菜单"设置"事件 */
export async function onOpenSettings(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('open-settings', () => handler());
}

/** 写入剪贴板（支持图片） */
export async function writeImageToClipboard(imageBytes: Uint8Array): Promise<void> {
  if (!isDesktop()) return;
  const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
  await writeImage(imageBytes);
}
```

**关键**: 所有 `@tauri-apps/*` 的 import 都用 dynamic import，确保在纯 Web 环境下不会报错。

#### Phase 2: prd-admin 布局适配

**修改文件**: `prd-admin/src/layouts/AppShell.tsx`

```typescript
import { isDesktop, getDesktopPlatform } from '@/lib/desktop';

function AppShell() {
  const platform = getDesktopPlatform();

  return (
    <div className={cn(
      "h-screen flex flex-col",
      // macOS: 为红绿灯预留安全区
      platform === 'macos' && "pt-[28px]",
      // 桌面端: 为可拖拽标题栏预留空间
      isDesktop() && "desktop-shell"
    )}>
      {/* 桌面端标题栏可拖拽区域 */}
      {isDesktop() && (
        <div
          data-tauri-drag-region
          className="fixed top-0 left-0 right-0 h-[28px] z-50"
        />
      )}
      {/* ... 原有布局 */}
    </div>
  );
}
```

#### Phase 3: Tauri 配置改造

**修改文件**: `prd-desktop/src-tauri/tauri.conf.json`

```jsonc
{
  "build": {
    // 开发模式仍指向本地 prd-admin dev server
    "beforeDevCommand": "",       // 不再启动 desktop 的 Vite
    "devUrl": "http://localhost:5173",  // prd-admin 的 Vite dev server
    "beforeBuildCommand": "",     // 不再构建 desktop 前端
    "frontendDist": "../dist"     // 生产模式：内嵌 prd-admin 构建产物（可选）
  }
  // 其余配置不变
}
```

**修改文件**: `prd-desktop/src-tauri/src/lib.rs`

```rust
// 精简 invoke_handler，只保留桌面独有命令
.invoke_handler(tauri::generate_handler![
    // 原生能力（Web 无法替代）
    commands::config::get_config,
    commands::config::save_config,
    commands::config::get_default_api_url,
    commands::config::test_api_connection,
    commands::updater::check_for_update,
    commands::updater::get_updater_platform_info,
    commands::updater::fetch_update_manifests,
    commands::devtools::open_devtools,
    // 深度链接处理保留在 setup() 中
])
```

**删除 50+ 个不再需要的 commands**：
- `commands::session::*` (所有聊天/消息命令)
- `commands::document::*` (文档上传)
- `commands::group::*` (群组管理)
- `commands::auth::*` (登录/token 同步)
- `commands::branding::*` (品牌配置)
- `commands::assets::*` (资产皮肤)
- `commands::prd_comments::*` (评论)
- `commands::defect::*` (缺陷管理)
- `commands::intent::*` (意图识别)
- `commands::preview_ask_history::*` (预览提问历史)

**删除 services/api_client.rs 的大部分代码**：不再需要 Rust HTTP 代理。

#### Phase 4: 构建流程改造

**新增脚本**: `scripts/build-desktop.sh`

```bash
#!/bin/bash
# 构建桌面应用：先构建 prd-admin，再打包进 Tauri

# 1. 构建 prd-admin
cd prd-admin
pnpm build
cd ..

# 2. 复制构建产物到 desktop 的 dist 目录
rm -rf prd-desktop/dist
cp -r prd-admin/dist prd-desktop/dist

# 3. 构建 Tauri 应用
cd prd-desktop
pnpm tauri build
```

#### Phase 5: 深度链接集成

深度链接处理从 Desktop React 移到 prd-admin：

**新增文件**: `prd-admin/src/hooks/useDesktopDeepLink.ts`

```typescript
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { onDeepLink } from '@/lib/desktop';

export function useDesktopDeepLink() {
  const navigate = useNavigate();

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    onDeepLink((url) => {
      // prdagent://join/{inviteCode}
      const match = url.match(/prdagent:\/\/join\/([^?#/\s]+)/);
      if (match?.[1]) {
        navigate(`/prd-agent?join=${match[1]}`);
      }
    }).then((fn) => { cleanup = fn; });

    return () => cleanup?.();
  }, [navigate]);
}
```

### 3.3 开发体验

改造后的开发流程：

```bash
# 启动 prd-admin dev server（所有页面开发都在这里）
cd prd-admin && pnpm dev   # http://localhost:5173

# 如果需要测试桌面原生功能（深度链接/更新/系统菜单）
cd prd-desktop && pnpm tauri dev   # WebView 加载 http://localhost:5173
```

**关键收益**：
- 日常开发只需打开 prd-admin
- 浏览器中改代码，桌面端自动 HMR 同步
- 只有测试桌面原生功能时才需要启动 Tauri

### 3.4 prd-admin 需要的 Tauri 依赖处理

prd-admin 需要能 `import('@tauri-apps/api/core')` 但又不能让它成为硬依赖。

**方案**: 作为 optional dependency + dynamic import

```jsonc
// prd-admin/package.json
{
  "optionalDependencies": {
    "@tauri-apps/api": "^2.1.1",
    "@tauri-apps/plugin-clipboard-manager": "^2.0.1",
    "@tauri-apps/plugin-updater": "^2.0.0"
  }
}
```

`desktop.ts` 中全部使用 `await import(...)` 动态导入，Web 环境下永远不会执行到这些代码路径。

---

## 4. 迁移策略（渐进式）

### 第一阶段：双轨并行（1-2 天）

```
prd-admin:
  + 新增 src/lib/desktop.ts (桌面检测)
  + 新增 src/hooks/useDesktopDeepLink.ts
  + AppShell 添加 macOS 标题栏安全区
  + package.json 添加 @tauri-apps/* optional deps

prd-desktop:
  + tauri.conf.json devUrl 指向 prd-admin dev server
  ~ lib.rs invoke_handler 暂时保留全部（渐进删除）
  ~ 保留原有 src/ 代码（暂不删除）
```

此阶段：Desktop 开发时加载 prd-admin 页面，但原有代码不删，可随时回退。

### 第二阶段：验证核心流程（2-3 天）

验证清单：
- [ ] 登录/登出在 WebView 中正常工作
- [ ] PRD Chat (AiChatPage) 在 WebView 中正常对话
- [ ] SSE 流式响应在 WebView 中正常渲染
- [ ] 深度链接 (`prdagent://join/xxx`) 正常触发路由
- [ ] 自动更新检查正常
- [ ] macOS 红绿灯位置正确
- [ ] 系统菜单（设置/DevTools）正常工作
- [ ] 主题切换（亮/暗）在 WebView 中正常

### 第三阶段：清理 Desktop 代码（1 天）

- 删除 `prd-desktop/src/` 下的 React 页面代码
- 精简 Rust commands 到只保留原生能力（~8个）
- 删除 `services/api_client.rs` 中的 HTTP 代理逻辑
- 更新构建脚本

### 第四阶段：Desktop 独有页面迁移（按需）

Desktop 有一个 prd-admin 没有的页面：**PRD Preview（3列布局+划词提问）**。

迁移方案：
- 在 prd-admin 中新增 `/prd-preview/:groupId` 路由
- 迁移 `PrdPreviewPage`, `PrdSectionAskPanel`, `PrdCommentsPanel` 组件到 prd-admin
- 使用 prd-admin 的 `apiRequest()` 替代 `invoke()` 调用

---

## 5. 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| **WebView 中 SSE 兼容性** | 中 | prd-admin 已有 SSE 实现（`fetch` streaming），WebView 中表现与浏览器一致 |
| **API CORS** | 低 | CSP 已禁用 (`csp: null`)；远程模式需后端 CORS 允许 Tauri 自定义协议 origin |
| **离线不可用** | 中 | embedded 模式打包构建产物可解决；或显示友好的离线提示页 |
| **Tailwind v4 在 WebView 中的兼容性** | 低 | Tauri 使用系统 WebView (macOS: WebKit, Windows: WebView2)，均支持现代 CSS |
| **localStorage 隔离** | 低 | Tauri WebView 的 localStorage 独立于浏览器，不会冲突 |
| **prd-admin 构建体积增大** | 低 | @tauri-apps/* 使用 dynamic import，tree-shaking 会自动排除 |
| **Desktop 用户感知变化** | 中 | UI 从极简风变为液态玻璃风格，需提前沟通 |

### CORS 特别说明

Tauri WebView 加载远程 URL 时，origin 为 `https://pa.759800.com`（同源），**无 CORS 问题**。

若使用 embedded 模式（`tauri://` 协议），后端需添加：
```
Access-Control-Allow-Origin: tauri://localhost
```

---

## 6. 收益总结

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| **需维护的前端代码库** | 2 套 | 1 套 (prd-admin) |
| **Desktop 功能页面数** | 5 个模式 | 20+ 路由 (与 admin 一致) |
| **Tauri commands 数量** | 50+ | ~8 |
| **Rust 代码量** | ~2500 行 | ~500 行 |
| **新功能开发** | 两端分别实现 | 只改 prd-admin |
| **Desktop 用户可用功能** | Chat + Preview + Defect | 全部管理功能 |
| **开发者日常需要打开的项目** | 2 个 | 1 个 (prd-admin) |

---

## 7. 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 加载方式 | remote 优先，embedded 兜底 | 远程加载免更新、免打包；embedded 保证离线可用 |
| Tauri API 引入方式 | optional deps + dynamic import | 不影响 Web 构建，零运行时开销 |
| Desktop 前端代码处理 | 渐进废弃 | 第一阶段保留可回退，验证后再清理 |
| PRD Preview 页面 | 迁移到 prd-admin | 是 Desktop 唯一独有页面，迁移后两端统一 |
| Auth 方式 | 复用 prd-admin 的 fetch + token refresh | 已验证稳定，无需 Rust 中间层 |
| Desktop 标识 | `X-Client: desktop` header + `isDesktop()` | 后端可区分客户端来源，前端可条件渲染 |

---

## 8. 不在本方案范围内

- prd-admin Tailwind v4 → Desktop Tailwind v3 的统一（方案 A 不需要，因为加载的就是 prd-admin）
- 离线数据同步（如需离线，embedded 模式已够用）
- Desktop 独立发版脱离 admin（打包时一次性绑定即可）
- i18n 国际化
