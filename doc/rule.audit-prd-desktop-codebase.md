# PRD Agent 全面代码审计报告

> **审计日期**: 2026-02-06
> **审计范围**: prd-desktop (Tauri 桌面端)、prd-api (后端)、prd-admin (管理后台)
> **审计方法**: 静态代码分析 + CLAUDE.md 规则交叉验证

---

## 目录

1. [PRD Desktop 桌面端专项审计](#1-prd-desktop-桌面端专项审计)
   - [1.1 长连接无法快速停止后端](#11-问题一长连接无法快速停止后端)
   - [1.2 上传文件页面闪烁三次](#12-问题二上传文件页面闪烁三次)
   - [1.3 无法兼容多文档](#13-问题三无法兼容多文档)
   - [1.4 隐藏问题](#14-隐藏问题)
2. [代码与文档对齐审计](#2-代码与文档对齐审计)
   - [2.1 废弃概念残留](#21-废弃概念残留)
   - [2.2 前端数据映射违规](#22-前端业务数据映射违规)
   - [2.3 路由规范违规](#23-路由规范违规)
   - [2.4 AppKey 身份隔离违规](#24-appkey-身份隔离违规)
3. [旧代码识别与分类](#3-旧代码识别与分类)
4. [CLAUDE.md 规则调整建议](#4-claudemd-规则调整建议)
5. [缺失的系统默认架构图](#5-缺失的系统默认架构图)
6. [修改优先级建议](#6-修改优先级建议)

---

## 1. PRD Desktop 桌面端专项审计

### 1.1 问题一：长连接无法快速停止后端

**根因分析：3 层阻塞叠加导致进程退出卡死**

| 层级 | 问题 | 文件 | 行号 |
|------|------|------|------|
| Tauri 层 | 无 `ExitRequested` / `Exit` 事件处理器，退出时不调用 `cancel_all()` | `src-tauri/src/lib.rs` | 214-222 |
| Tokio 层 | `spawn` 的异步任务 `JoinHandle` 被静默丢弃，无法 `await` 或追踪 | `src-tauri/src/commands/session.rs` | 385, 613 |
| HTTP 层 | streaming client 无任何超时配置（无 `connect_timeout`, `read_timeout`, `pool_idle_timeout`） | `src-tauri/src/services/api_client.rs` | 601-607 |

**致命路径**：

```
用户退出应用
  → Tauri 开始关闭
  → 但 Tokio runtime 中的 SSE 任务仍在 stream.next().await 上阻塞
  → CancellationToken 仅在 chunk 到达后才被检查（轮询式，非 select! 式）
  → 如果服务端无数据发送，任务将无限阻塞
  → Tokio runtime drop 时被强制 abort，可能导致状态不一致
```

**CancellationToken 未正确传播**（`session.rs`）：

```rust
// 当前实现：轮询式检查（不能在等待中响应取消）
while let Some(chunk) = stream.next().await {   // ← 这里阻塞
    if token.is_cancelled() { break; }           // ← 只有收到数据后才检查
}

// 正确实现：应该用 tokio::select!
loop {
    tokio::select! {
        chunk = stream.next() => { /* process */ }
        _ = token.cancelled() => { break; }       // ← 可在等待中响应
    }
}
```

**修复建议**：

1. **添加 shutdown hook**：在 `lib.rs` 的 `app.run()` 中处理 `RunEvent::ExitRequested`，调用 `StreamCancelState::cancel_all()`
2. **改用 `tokio::select!`**：替换所有 `while let Some(chunk) = stream.next().await` 模式，使取消能在阻塞期间生效
3. **配置 streaming client 超时**：至少设置 `connect_timeout(10s)` 和 `tcp_keepalive(30s)`
4. **存储 JoinHandle**：将 spawn 返回的 handle 存入 `StreamCancelState`，shutdown 时 `await` 它们
5. **presence heartbeat 也需要 shutdown 清理**：`stop_desktop_presence_heartbeat()` 应在退出时调用

---

### 1.2 问题二：上传文件页面闪烁三次

**根因：`loadGroups({ force: true })` 的 loading 状态导致 ChatContainer 反复卸载/重挂载**

**闪烁机制**：

```
DocumentUpload.tsx 第 107-118 行：后台轮询获取 AI 生成的群名
  ↓
for (let i = 0; i < 3; i++) {
    await loadGroups({ force: true });    // ← 触发闪烁
    await sleep(3000);
}
  ↓
groupListStore.ts 第 22 行：set({ loading: true })  // 无条件设置
  ↓
App.tsx 第 435 行：groupsLoading ? <空白占位> : <ChatContainer />
  ↓
ChatContainer 被卸载 → StartLoadOverlay 出现
  ↓
API 返回 → loading: false → ChatContainer 重新挂载
  ↓
此过程重复 3 次 = 3 次闪烁
```

**每次闪烁的连锁反应**：

| 步骤 | 影响 |
|------|------|
| ChatContainer 卸载 | `useGroupStreamReconnect` cleanup → `cancel_stream({ kind: 'group' })` → SSE 连接断开 |
| ChatContainer 重挂载 | 新建 `group-message` 监听器 → 50ms 后重新 `subscribe_group_messages` → 新 SSE 连接 |
| 连接状态指示器 | `connected → disconnected → connecting → connected` 闪烁 |
| 消息同步 | `syncFromServer` 重新从服务端拉取消息 |

**修复建议**：

```typescript
// 方案 1（推荐）：区分 cold-start loading 和 background refresh
const groupListStore = create((set, get) => ({
  loading: false,          // 仅用于首次加载
  refreshing: false,       // 后台刷新用，不触发 UI 卸载

  loadGroups: async ({ force, silent } = {}) => {
    if (silent) {
      set({ refreshing: true });
    } else {
      set({ loading: true });
    }
    // ...
  },
}));

// App.tsx 只用 loading（首次加载）决定是否显示骨架屏
// DocumentUpload.tsx 轮询时传 { force: true, silent: true }
```

```typescript
// 方案 2：轮询时只更新特定 group 的 name，不触发全量 loading
(async () => {
  await sleep(5000);
  for (let i = 0; i < 3; i++) {
    const resp = await invoke('get_group_detail', { groupId: newGroupId });
    if (resp.data.groupName !== heuristicName) {
      // 只更新 store 中这个 group 的名字
      updateGroupName(newGroupId, resp.data.groupName);
      break;
    }
    if (i < 2) await sleep(3000);
  }
})();
```

---

### 1.3 问题三：无法兼容多文档

**架构限制分析**：

当前 sessionStore 是**单槽位单例模式**——整个应用同一时间只能持有一个文档、一个会话、一个活跃群组。

```typescript
// sessionStore.ts 第 6-10 行：全部是标量值
sessionId: string | null;        // 单个
activeGroupId: string | null;    // 单个
document: Document | null;       // 单个 ← 核心瓶颈
documentLoaded: boolean;         // 单个
```

**切换群组时的破坏性重建**：

```
用户点击另一个群组
  → bindGroupContext(): messages = [], document = null, sessionId = null
  → 100-500ms 异步间隙（此期间 UI 看到空状态）
  → open_group_session API
  → get_document API
  → setSession(): 新的 document、sessionId
  → syncFromServer(): 重新拉取消息
```

**数据丢失风险**（6 项）：

| 风险 | 说明 | 位置 |
|------|------|------|
| 流式消息丢失 | 切换群组时 `isStreaming: false` 但 streaming buffer 未清理，后端继续生成的内容丢失 | `messageStore.ts` 221-259 |
| 待确认消息丢失 | `pendingUserMessageId` 被置空，已发送但未确认的消息从 UI 消失 | `messageStore.ts` 250 |
| 全局 seq 追踪被清除 | `clearSession()` 清空所有群组的 `lastGroupSeqByGroup`，不仅仅是当前群组 | `sessionStore.ts` 124-135 |
| PRD 预览状态丢失 | `prdPreview` 内容、TOC、滚动位置为组件本地状态，卸载即消失 | `PrdPreviewPage.tsx` 30-33 |
| 异步间隙 UI 闪烁 | `document: null` 期间 Sidebar 显示"待上传"，ChatContainer 显示默认标题 | `sessionStore.ts` 57-65 |
| 评论面板跨污染 | 异步间隙中 `prdPreview.documentId`（旧）和 `activeGroupId`（新）不匹配 | `PrdPreviewPage.tsx` 978-985 |

**多文档支持改造方案**：

```typescript
// 改造后的 sessionStore 结构
interface SessionState {
  // 从单槽位 → 按群组索引的 Map
  sessionsByGroup: Map<string, {
    sessionId: string;
    document: Document;
    mode: InteractionMode;
    role: UserRole;
  }>;
  activeGroupId: string | null;

  // 便捷 getter
  get activeSession() { return this.sessionsByGroup.get(this.activeGroupId); }
  get activeDocument() { return this.activeSession?.document; }
}

// 改造后的 messageStore 结构
interface MessageState {
  messagesByGroup: Map<string, {
    messages: Message[];
    localMinSeq: number;
    localMaxSeq: number;
    hasMoreOlder: boolean;
  }>;
  boundGroupId: string | null;
}
```

此改造允许群组切换变为"指针切换"而非"数据销毁+重建"。

---

### 1.4 隐藏问题

通过深度代码分析发现以下未被报告的隐藏问题：

#### 1.4.1 Token 槽位共享导致意外取消（严重度：中）

```rust
// session.rs 第 14-18 行
pub struct StreamCancelState {
    message: Mutex<CancellationToken>,  // send_message + subscribe_chat_run 共用！
    preview: Mutex<CancellationToken>,
    group: Mutex<CancellationToken>,
}
```

`send_message`、`subscribe_chat_run`、`resend_message` 三个命令共享 `message` 槽位。调用任意一个会取消其他正在进行的操作。尤其 `send_message` 在 Tauri command 线程上同步运行（非 spawn），而 `subscribe_chat_run` 是 spawn 到后台的——两者生命周期不同但共享同一个取消 token。

#### 1.4.2 重连时的事件重复窗口（严重度：中）

`subscribe_group_messages` 每次调用 spawn 新任务，JoinHandle 被丢弃。快速重连时：

```
旧任务A：HTTP 请求已发出，等待第一个 chunk
新 token：cancel A 的 token
新任务B：spawn 并开始新 HTTP 请求
旧任务A：收到第一个 chunk（cancel 检查在 chunk 之后）→ 发射事件
新任务B：也在发射事件
→ 短暂窗口内两个任务同时向 "group-message" channel 发射重复事件
```

#### 1.4.3 Auth Refresh 竞态（严重度：低）

`subscribe_group_messages` 中的 401 重试（`session.rs` 334-351 行）调用 `refresh_auth()`，但此操作无法被 CancellationToken 中断。如果两个 subscribe 调用在重叠时间窗口内都触发 refresh，同一个 refresh_token 可能被使用两次。

#### 1.4.4 内存泄漏：Spawned 任务持有 AppHandle（严重度：中）

每个 spawn 的 SSE 任务（`subscribe_group_messages`, `subscribe_chat_run`）捕获了 `AppHandle` clone。如果 SSE 连接挂起（服务端不发数据也不断开），任务永远不会结束：
- 无超时
- CancellationToken 只在 chunk 到达后检查
- JoinHandle 被丢弃

每个孤儿任务持有：1 个 AppHandle、1 个 reqwest::Response（含 TCP socket）、1 个 CancellationToken、SSE 缓冲区字符串。

#### 1.4.5 `send_message` / `resend_message` 阻塞 IPC 线程（严重度：中）

与 `subscribe_group_messages`（spawn 到后台）不同，`send_message` 和 `resend_message` 直接在 Tauri command handler 线程上运行。`while let Some(chunk) = stream.next().await` 阻塞该线程，直到流结束或 token 被取消。如果流长时间运行，可能影响其他 IPC 调用的响应。

#### 1.4.6 connectionStore 探测定时器泄漏（严重度：低）

`connectionStore.ts` 33-46 行：`probeTimer` 使用 `window.setInterval`，但只在 `markConnected()` 时清除。如果应用关闭时处于 disconnected 状态，定时器不会被清理。

---

## 2. 代码与文档对齐审计

### 2.1 废弃概念残留

CLAUDE.md 明确列出的废弃概念，但在代码中仍有残留：

#### ImageMaster 代码层命名（15+ 文件受影响，高严重度）

CLAUDE.md 规定："ImageMaster (代码层) → VisualAgent (DB 集合名保留兼容)"，但代码层仍大量使用 ImageMaster：

| 类别 | 文件 | 示例 |
|------|------|------|
| Model 类 | `PrdAgent.Core/Models/ImageMasterCanvas.cs` 等 5 个文件 | `class ImageMasterCanvas`, `class ImageMasterWorkspace` |
| Controller | `Api/ImageMasterController.cs` | 完整控制器，~160 处 ImageMaster 引用 |
| DB Context | `MongoDbContext.cs` 69-73 行 | `ImageMasterSessions`, `ImageMasterMessages` 属性名 |
| Worker | `ImageGenRunWorker.cs` | `TryPersistToImageMasterAsync()` 方法 |
| 前端 API | `prd-admin/src/services/api.ts` 259-287 行 | `imageMaster` 路径对象 |
| 前端 Service | `prd-admin/src/services/real/visualAgent.ts` | 全文使用 `api.visualAgent.imageMaster.*` |

#### Guide SSE 残留（1 文件，低严重度）

| 文件 | 行号 | 内容 |
|------|------|------|
| `prd-admin/src/pages/lab-desktop/DesktopLabTab.tsx` | 357 | `/api/v1/sessions/{id}/guide/start` 端点引用 |

#### SmartModelScheduler 残留（2 文件，中严重度）

| 文件 | 说明 |
|------|------|
| `.cursor/rules/prd-api.mdc` 54 行 | 仍引用 `ISmartModelScheduler` 为当前调度接口 |
| `test-model-stub-system.md` | 引用 `SmartModelScheduler.cs` |

#### 直接 LLM Client 绕过 Gateway（2 个非例外文件）

| 文件 | 说明 |
|------|------|
| `Program.cs` | DI 注册仍将 `ILLMClient` 直接绑定到 `ClaudeClient`/`OpenAIClient` |
| `ModelDomainService.cs` | 直接创建 `ClaudeClient`/`OpenAIClient` 实例 |

注：`ModelLabController` 是已知例外。

---

### 2.2 前端业务数据映射违规

CLAUDE.md 规定："前端禁止维护任何业务数据映射表"。以下文件违反此规则：

| # | 文件 | 行号 | 违规内容 | 严重度 |
|---|------|------|----------|--------|
| 1 | `WatermarkSettingsPanel.tsx` | 62-67 | `appKeyLabelMap`: appKey → 中文名 | 高 |
| 2 | `UserProfilePopover.tsx` | 23-35 | `agentLabels`: agent → 中文名 | 高 |
| 3 | `AgentSwitcher.tsx` | 27-32 | `AGENT_DESCRIPTIONS`: agent → 功能描述 | 高 |
| 4 | `appCallerUtils.ts` | 198-245 | 3 个 display name 函数（app/feature/modelType） | 高 |
| 5 | `channels.ts` | 358-408 | 4 个导出映射（渠道类型/任务状态/意图/邮件意图） | 高 |
| 6 | `DefectDetailPanel.tsx` | 40-61 | `statusLabels` + `severityLabels` | 中 |
| 7 | `MenuPermissionDialog.tsx` | 31-38 | `categoryLabels` (权限分类) | 中 |
| 8 | `BasicCapabilities.tsx` | 271-275 | AI 能力分类标签 | 中 |
| 9 | `MessageList.tsx` (desktop) | 42-47 | `roleZh` 角色中文名 | 中 |
| 10 | `agentSwitcherStore.ts` | 38-95 | `AGENT_DEFINITIONS` 完整静态注册表 | 高 |
| 11 | `WatermarkDescriptionGrid.tsx` | 6-11 | `anchorLabelMap` 水印位置标签 | 低 |
| 12 | `authzMenuMapping.ts` | 16-171 | `menuList` + `allPermissions` 完整中文标签 | 高 |

---

### 2.3 路由规范违规

CLAUDE.md 规定："后台管理接口使用 `/api/{module}` 格式，禁止 `/v1/` 版本号"。

**Admin 控制器中的 `/v1/` 路由**：

| 文件 | 路由 |
|------|------|
| `RateLimitController.cs` | `api/v1/admin/rate-limit` |

**Client-facing 控制器（是否适用需澄清）**：

15 个 client-facing 控制器使用 `/v1/` 路由模式（如 `api/v1/sessions`, `api/v1/groups`, `api/v1/auth` 等）。CLAUDE.md 的措辞 "后台管理接口" 可能仅指 admin 接口，client-facing 接口使用 `/v1/` 可能是合理的版本控制。

**建议**：CLAUDE.md 应明确区分 admin 接口和 client-facing 接口的路由规范。

---

### 2.4 AppKey 身份隔离违规

| 文件 | 行号 | 违规 |
|------|------|------|
| `imageGen.ts` (contract) | 109 | `appKey?: string` 在请求体中定义 |
| `ArticleIllustrationEditorPage.tsx` | 1238 | 前端传递 `appKey: 'literary-agent'` |

CLAUDE.md 规定 appKey 必须在 Controller 中硬编码，不由前端传递。

---

## 3. 旧代码识别与分类

| 旧代码 | 原因 | 建议 |
|--------|------|------|
| `ImageMaster*` 全部代码层命名 | 项目曾叫 ImageMaster，重命名为 VisualAgent 时只改了概念名，代码层未重命名 | 渐进式重命名，DB 集合名保持不变 |
| `DesktopLabTab.tsx` guide SSE | GuideController 已删除但前端 Lab 页面遗留了测试代码 | 删除或替换为 Prompt Stages 测试 |
| `.cursor/rules/prd-api.mdc` | Cursor 规则文件引用了 `ISmartModelScheduler` 等旧接口 | 同步更新 Cursor 规则与 CLAUDE.md |
| `test-model-stub-system.md` | 测试文档引用旧调度器 | 更新或标注为过时 |
| `Program.cs` ILLMClient DI | 旧的 DI 注册直接绑定 LLM client，是 Gateway 引入前的遗留 | 评估是否还有代码路径使用 ILLMClient |
| `prd-admin` 12 处业务映射 | 早期快速开发时前端硬编码，后端 API 逐步完善后未回头清理 | 后端 API 补充 displayName 字段，前端逐步迁移 |
| `AdminInitController.cs.backup` | 备份文件残留在代码库中 | 删除 |

---

## 4. CLAUDE.md 规则调整建议

### 4.1 应明确区分的规则

| 当前规则 | 问题 | 建议调整 |
|----------|------|----------|
| "后台管理接口使用 `/api/{module}` 格式" | 未明确 client-facing 接口的路由规范 | 分两条规则：① Admin API: `/api/{module}`；② Client API: `/api/v1/{resource}` |
| "禁止直接调用底层 LLM 客户端" | ModelLab 是例外但未在 CLAUDE.md 中说明 | 增加"已知例外"章节，列出 ModelLab、ModelDomainService 等 |
| "前端禁止维护业务数据映射表" | 未区分"业务数据映射"和"纯 UI 标签" | 增加边界说明：位置标签 (左上/右上) 等 UI 显示逻辑允许，但 appKey→中文名、status→中文名 必须后端提供 |

### 4.2 应新增的规则

| 新规则 | 原因 |
|--------|------|
| **桌面端 Tauri 命令生命周期管理** | 当前 spawn 的 SSE 任务无追踪、无 shutdown hook，需要明确规范 |
| **Streaming client 超时配置** | streaming client 无任何超时是严重隐患 |
| **Store 状态分层规则** | `loading` flag 混淆 cold-start 和 background refresh 两种语义，需明确状态分层 |
| **CancellationToken 传播规范** | 应规定使用 `tokio::select!` 而非轮询式检查 |
| **前端多文档/多会话架构指导** | 当前单槽位设计限制了扩展性，需要架构演进指引 |

### 4.3 应更新的文档

| 文档 | 需更新内容 |
|------|-----------|
| `.cursor/rules/prd-api.mdc` | 将 `ISmartModelScheduler` 替换为 `ILlmGateway + ModelResolver` |
| `test-model-stub-system.md` | 更新 SmartModelScheduler 引用 |
| Codebase Skill 段落 | ImageMaster 仍标注为"代码层重命名完成"，实际未完成 |

---

## 5. 缺失的系统默认架构图

CLAUDE.md 的 Codebase Skill 段落缺少以下架构图，建议补充：

### 5.1 整体系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ prd-desktop   │  │ prd-admin    │  │ Open Platform    │  │
│  │ (Tauri 2.0)   │  │ (React 18)  │  │ (External API)   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬──────────┘  │
└─────────┼──────────────────┼──────────────────┼─────────────┘
          │ SSE/REST          │ REST/SSE         │ REST
┌─────────┼──────────────────┼──────────────────┼─────────────┐
│         ▼                  ▼                  ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              PrdAgent.Api (.NET 8)                   │    │
│  │  ┌───────────┐ ┌────────────┐ ┌──────────────────┐  │    │
│  │  │Controllers│ │ Middleware │ │  Workers (BG)    │  │    │
│  │  │(Identity) │ │ (RBAC)    │ │  ChatRunWorker   │  │    │
│  │  └─────┬─────┘ └────┬──────┘ │  ImageGenWorker  │  │    │
│  │        │             │        └────────┬─────────┘  │    │
│  │        ▼             ▼                 ▼            │    │
│  │  ┌──────────────────────────────────────────────┐   │    │
│  │  │              Service Layer                    │   │    │
│  │  └──────────────────┬───────────────────────────┘   │    │
│  └─────────────────────┼───────────────────────────────┘    │
│                        ▼                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          PrdAgent.Infrastructure                      │   │
│  │  ┌────────────┐  ┌──────────┐  ┌─────────────────┐  │   │
│  │  │ LLM Gateway│  │ MongoDB  │  │ Redis            │  │   │
│  │  │ (3-tier    │  │ (55 集合) │  │ (Rate Limit)    │  │   │
│  │  │  resolve)  │  │          │  │                  │  │   │
│  │  └──────┬─────┘  └──────────┘  └─────────────────┘  │   │
│  └─────────┼────────────────────────────────────────────┘   │
│            ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              外部 LLM 服务                             │   │
│  │  OpenAI / Claude / Google / DeepSeek / ...            │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 桌面端连接架构图

```
┌─────────────────────────────────────────────────┐
│                prd-desktop                       │
│  ┌─────────────────────────────────────────┐    │
│  │           React 层                       │    │
│  │  ┌──────────┐  ┌────────────────────┐   │    │
│  │  │ChatCont. │  │useGroupStreamRecon.│   │    │
│  │  │(事件监听) │  │(心跳 + 指数退避重连) │   │    │
│  │  └────┬─────┘  └─────────┬──────────┘   │    │
│  │       │ Tauri event       │ invoke()     │    │
│  └───────┼──────────────────┼──────────────┘    │
│          ▼                   ▼                   │
│  ┌─────────────────────────────────────────┐    │
│  │         Rust/Tauri 层                    │    │
│  │  ┌─────────────────┐  ┌─────────────┐  │    │
│  │  │StreamCancelState│  │  ApiClient   │  │    │
│  │  │ message token   │  │ (HTTP+Auth)  │  │    │
│  │  │ preview token   │  │ 30s 心跳     │  │    │
│  │  │ group token     │  └──────┬──────┘  │    │
│  │  └────────┬────────┘         │          │    │
│  │           │                  ▼          │    │
│  │  ┌────────┴──────────────────────────┐  │    │
│  │  │ SSE 连接 (spawn async tasks)       │  │    │
│  │  │  subscribe_group_messages [spawn]  │  │    │
│  │  │  subscribe_chat_run      [spawn]  │  │    │
│  │  │  send_message            [sync]   │  │    │
│  │  │  preview_ask_in_section  [sync]   │  │    │
│  │  └────────────────────┬──────────────┘  │    │
│  └───────────────────────┼──────────────────┘    │
└──────────────────────────┼──────────────────────┘
                           │ HTTP SSE
                           ▼
                    PrdAgent.Api 后端
```

### 5.3 LLM Gateway 三级调度图

```
GatewayRequest (AppCallerCode + ModelType)
         │
         ▼
  ┌──────────────┐     命中      ┌─────────────────┐
  │ Tier 1:      │──────────────→│ DedicatedPool    │
  │ 专属模型池    │               │ 按 AppCallerCode │
  │ LLMAppCallers│               │ 绑定的 GroupIds  │
  └──────┬───────┘               └─────────────────┘
         │ 未命中
         ▼
  ┌──────────────┐     命中      ┌─────────────────┐
  │ Tier 2:      │──────────────→│ DefaultPool      │
  │ 默认模型池    │               │ IsDefaultForType │
  │ ModelGroups   │               │ 的 ModelGroup    │
  └──────┬───────┘               └─────────────────┘
         │ 未命中
         ▼
  ┌──────────────┐     命中      ┌─────────────────┐
  │ Tier 3:      │──────────────→│ Legacy           │
  │ 传统直连      │               │ IsMain/IsIntent  │
  │ LLM Models    │               │ /IsVision 标记   │
  └──────────────┘               └─────────────────┘
```

### 5.4 Run/Worker 消息流转图

```
Client                    Controller                  Worker                    EventStore
  │                           │                          │                          │
  │ POST /messages/run        │                          │                          │
  │──────────────────────────→│                          │                          │
  │                           │ persist user msg         │                          │
  │                           │ persist AI placeholder   │                          │
  │                           │ enqueue(runId)           │                          │
  │                           │─────────────────────────→│                          │
  │  ← 200 { runId }         │                          │                          │
  │←──────────────────────────│                          │                          │
  │                           │                          │ dequeue                  │
  │ GET /chat-runs/{id}/stream│                          │ status=Running           │
  │──────────────────────────→│                          │                          │
  │  ← SSE: snapshot         │                          │ LLM streaming            │
  │←──────────────────────────│                          │─────────────────────────→│
  │                           │                          │ append events            │
  │  ← SSE: delta events     │←─────────────────────────│ (CancellationToken.None) │
  │←──────────────────────────│                          │                          │
  │  ← SSE: done             │                          │ status=Completed         │
  │←──────────────────────────│                          │                          │
  │                           │                          │                          │
  │ [断线重连]                 │                          │                          │
  │ GET /stream?afterSeq=N    │                          │                          │
  │──────────────────────────→│                          │                          │
  │  ← SSE: 从 seq N 续传     │                          │                          │
  │←──────────────────────────│                          │                          │
```

---

## 6. 修改优先级建议

### P0 - 阻断性问题（影响稳定性，建议立即修复）

| # | 问题 | 工作量 |
|---|------|--------|
| 1 | **Tauri shutdown hook**：添加 `ExitRequested` 处理，调用 `cancel_all()` + await spawned tasks | 小 |
| 2 | **`tokio::select!` 替换轮询式取消**：所有 SSE 循环改为 select! 模式 | 中 |
| 3 | **Streaming client 超时配置**：添加 `connect_timeout(10s)` + `tcp_keepalive(30s)` | 小 |
| 4 | **上传闪烁修复**：`loadGroups` 增加 `silent` 模式，后台刷新不触发 loading | 小 |

### P1 - 体验问题（影响用户体验，建议短期修复）

| # | 问题 | 工作量 |
|---|------|--------|
| 5 | **Token 槽位隔离**：`send_message` 和 `subscribe_chat_run` 使用独立 token | 小 |
| 6 | **JoinHandle 追踪**：存储 spawn 返回的 handle，支持状态查询和 shutdown await | 中 |
| 7 | **前端业务映射清理**（12 处）：后端 API 补充 displayName，前端迁移 | 大 |
| 8 | **appKey 身份违规修复**：`imageGen.ts` 中的 appKey 移到后端 Controller | 小 |

### P2 - 架构演进（影响扩展性，建议中期规划）

| # | 问题 | 工作量 |
|---|------|--------|
| 9 | **多文档架构改造**：sessionStore + messageStore 从单槽位改为 Map 结构 | 大 |
| 10 | **ImageMaster 代码层重命名**：渐进式重命名为 VisualAgent（DB 集合名保留） | 大 |
| 11 | **路由规范统一**：admin API 中的 `/v1/` 路由迁移到 `/api/{module}` | 中 |
| 12 | **CLAUDE.md 规则更新**：按 4.1-4.3 节建议补充和修订 | 小 |

### P3 - 清理工作（技术债务，低优先级）

| # | 问题 | 工作量 |
|---|------|--------|
| 13 | 删除 `DesktopLabTab.tsx` 中的 Guide SSE 残留 | 极小 |
| 14 | 更新 `.cursor/rules/prd-api.mdc` SmartModelScheduler 引用 | 极小 |
| 15 | 删除 `AdminInitController.cs.backup` | 极小 |
| 16 | 补充架构图到 CLAUDE.md 或 doc/ | 小 |
