# PRD Agent IM 架构重设计方案

> **版本**: v1.0
> **日期**: 2026-02-06
> **状态**: 提案 (Proposal)
> **范围**: prd-desktop、prd-admin、prd-api 实时通信层

---

## 1. 现状诊断

### 1.1 当前架构总结

```
prd-desktop (桌面端)                        prd-admin (Web 管理端)
┌────────────────────────┐                  ┌────────────────────────┐
│ React → Tauri Event    │                  │ React → fetch()        │
│ ↕                      │                  │ ↕                      │
│ Rust SSE Proxy (847行) │                  │ readSseStream() (57行) │
│ ↕                      │                  │ ↕                      │
│ HTTP SSE (每群组一条)    │                  │ HTTP SSE (每消息一条)   │
└────────┬───────────────┘                  └────────┬───────────────┘
         │                                           │
         ▼                                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  PrdAgent.Api 后端                            │
│  ┌───────────────────────┐  ┌──────────────────────────┐    │
│  │ GroupsController      │  │ MessagesController       │    │
│  │ GET /groups/{gid}/    │  │ POST /sessions/{sid}/    │    │
│  │   messages/stream     │  │   messages               │    │
│  │ (持久 SSE 连接)        │  │ (一次性 SSE 响应)         │    │
│  └───────────┬───────────┘  └──────────────────────────┘    │
│              ▼                                               │
│  ┌───────────────────────┐                                  │
│  │ GroupMessageStreamHub │ (内存 Channel, 单进程, 无法横扩)  │
│  └───────────────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心问题清单

| # | 问题 | 根因 |
|---|------|------|
| 1 | **连接时间长** | 每次进入群组都要建立新的 HTTP SSE 连接（TCP 握手 + TLS + 401 重试 + afterSeq 回放） |
| 2 | **群组切换卡顿** | 切换 = 断开旧 SSE + 销毁 UI + 清空消息 + 新建 SSE + 从服务端重拉消息 |
| 3 | **上传闪烁 3 次** | `loadGroups()` 的 `loading` 状态导致 ChatContainer 反复卸载/重挂 |
| 4 | **停止 dotnet 很慢** | Rust SSE 任务卡在 `stream.next().await` 上，无 `select!` 取消、无超时 |
| 5 | **断开连接慢** | 无 shutdown hook，CancellationToken 轮询式检查而非中断式 |
| 6 | **不支持多文档** | sessionStore 单槽位（一个 document、一个 sessionId） |
| 7 | **注脚/引用** | citations 事件依赖流式连接状态，断线丢失 |
| 8 | **桌面/Web 不兼容** | 两端完全不同的实时架构（Rust SSE 代理 vs fetch SSE），无代码复用 |
| 9 | **无法水平扩展** | GroupMessageStreamHub 是纯内存，多实例部署消息不互通 |

### 1.3 问题本质

**一句话**：当前架构是 "N 条短生命周期 SSE 连接 + 单槽位状态 + 每端独立实现"，应改为 "1 条长生命周期 WebSocket 连接 + 多槽位状态 + 共享协议层"。

---

## 2. 新架构设计

### 2.1 架构总览

```
prd-desktop (Tauri)                  prd-admin (Web)              第三方 (Open Platform)
┌──────────────────┐                ┌──────────────────┐          ┌────────────────┐
│ React 层         │                │ React 层         │          │ REST/SSE       │
│ ┌──────────────┐ │                │ ┌──────────────┐ │          │ (保持现有)      │
│ │ WsClient     │ │                │ │ WsClient     │ │          └────────────────┘
│ │ (共享 TS 库)  │ │                │ │ (共享 TS 库)  │ │                  │
│ └──────┬───────┘ │                │ └──────┬───────┘ │                  │
│        │ WebSocket│                │        │WebSocket│                  │
└────────┼─────────┘                └────────┼─────────┘                  │
         │                                   │                            │
         ▼                                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PrdAgent.Api 后端                                    │
│                                                                             │
│  ┌──────────────────────────────────────────────────────┐                   │
│  │          RealtimeHub (WebSocket endpoint)             │                   │
│  │   /api/v1/realtime                                    │                   │
│  │                                                       │                   │
│  │   ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │                   │
│  │   │ Subscribe  │  │ Unsubscribe  │  │ SendMessage │ │                   │
│  │   │ (topic)    │  │ (topic)      │  │ (over WS)   │ │                   │
│  │   └────────────┘  └──────────────┘  └─────────────┘ │                   │
│  │                                                       │                   │
│  │   Topics:                                             │                   │
│  │     group:{groupId}     → 群组消息 + 流式增量          │                   │
│  │     run:{runId}         → 单次运行事件流               │                   │
│  │     preview:{sessionId} → PRD 预览问答                │                   │
│  │     system:{userId}     → 系统通知                     │                   │
│  └──────────────────────────────────────────────────────┘                   │
│                          │                                                   │
│                          ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐                   │
│  │      TopicRouter (内存 + 可选 Redis PubSub)           │                   │
│  │      替代 GroupMessageStreamHub                        │                   │
│  │                                                       │                   │
│  │      单实例：ConcurrentDictionary (内存)               │                   │
│  │      多实例：Redis Pub/Sub 作为跨进程通道               │                   │
│  └──────────────────────────────────────────────────────┘                   │
│                                                                             │
│  现有的 Controller + Service + Worker 层保持不变                              │
│  （ChatRunWorker、ChatService、GroupsController REST API 等）                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **单连接多路复用** | 每客户端一条 WebSocket，所有 topic 在同一连接上订阅/退订 |
| **Topic 订阅模型** | 客户端显式 subscribe/unsubscribe，服务端按 topic 路由事件 |
| **Seq 连续性保证** | 每个 topic 独立的 seq 序列，断线重连传 lastSeq 即可续传 |
| **Local-First 缓存** | 客户端按 groupId 缓存消息，切换群组 = 指针切换，不清数据 |
| **协议库共享** | 桌面端和 Web 端共享同一个 TypeScript WebSocket 客户端库 |
| **渐进式迁移** | 现有 SSE 端点保留（Open Platform 等第三方仍需要），新架构并行运行 |
| **优雅关闭** | 服务端发 `shutdown` 帧 → 客户端延迟重连 → 无卡死 |

---

## 3. 协议设计

### 3.1 WebSocket 端点

```
GET /api/v1/realtime?token={accessToken}
Upgrade: websocket
```

认证方式：连接时通过 query param 传 token（WebSocket 不支持自定义 header）。连接建立后 token 过期由服务端推送 `auth_expired` 消息。

### 3.2 消息帧格式 (JSON)

所有消息共享同一外层结构：

```typescript
// 客户端 → 服务端
interface ClientFrame {
  id: string;              // 请求 ID (用于 ack 匹配)
  type: 'subscribe' | 'unsubscribe' | 'send' | 'cancel' | 'ping';
  topic?: string;          // subscribe/unsubscribe 时必填
  afterSeq?: number;       // subscribe 时可选，断点续传
  payload?: any;           // send 时携带业务数据
}

// 服务端 → 客户端
interface ServerFrame {
  type: 'event' | 'ack' | 'error' | 'pong' | 'shutdown';
  topic?: string;          // event 时必填
  event?: string;          // 事件子类型：message | delta | blockEnd | citations | ...
  seq?: number;            // event 时携带 topic 内的序列号
  data?: any;              // 事件数据
  requestId?: string;      // ack/error 时关联 ClientFrame.id
  code?: string;           // error 时的错误码
  message?: string;        // error 时的人类可读消息
  reconnectAfter?: number; // shutdown 时建议的重连延迟 (ms)
}
```

### 3.3 交互时序

#### 连接建立 + 订阅群组

```
Client                                    Server
  │                                          │
  │ ── WS Connect /realtime?token=xxx ────→  │
  │ ←── 101 Switching Protocols ────────── │
  │                                          │
  │ ── { type: "subscribe",                  │
  │      id: "req-1",                        │
  │      topic: "group:abc123",              │
  │      afterSeq: 42 } ──────────────────→  │
  │                                          │
  │ ←── { type: "ack",                       │ (订阅成功)
  │       requestId: "req-1" } ──────────── │
  │                                          │
  │ ←── { type: "event",                     │ (回放 seq 43-45)
  │       topic: "group:abc123",             │
  │       event: "message",                  │
  │       seq: 43,                           │
  │       data: {...} } ────────────────── │
  │ ←── { type: "event", seq: 44, ... } ── │
  │ ←── { type: "event", seq: 45, ... } ── │
  │                                          │
  │ ←── { type: "event",                     │ (实时推送)
  │       topic: "group:abc123",             │
  │       event: "delta",                    │
  │       seq: 0,                            │
  │       data: { messageId, content,        │
  │               blockId } } ────────────── │
```

#### 切换群组（关键：无销毁重建）

```
Client                                    Server
  │                                          │
  │ ── { type: "subscribe",                  │ (订阅新群组)
  │      id: "req-2",                        │
  │      topic: "group:def456",              │
  │      afterSeq: 0 } ──────────────────→   │
  │                                          │
  │ ←── { type: "ack", requestId: "req-2" } │
  │ ←── [回放 group:def456 历史消息]          │
  │                                          │
  │  注意：group:abc123 保持订阅！             │
  │  客户端 UI 切换指针，不销毁连接            │
  │  旧群组的消息仍在后台接收并缓存            │
```

#### 发送消息（通过 WS，非 REST）

```
Client                                    Server
  │                                          │
  │ ── { type: "send",                       │
  │      id: "req-3",                        │
  │      topic: "group:abc123",              │
  │      payload: {                          │
  │        content: "分析一下登录模块",        │
  │        role: "PM",                       │
  │        replyTo: null                     │
  │      } } ────────────────────────────→   │
  │                                          │
  │ ←── { type: "ack",                       │ (消息已入队)
  │       requestId: "req-3",               │
  │       data: { runId: "run-xxx" } } ──── │
  │                                          │
  │ ←── { type: "event",                     │ (广播：用户消息)
  │       topic: "group:abc123",             │
  │       event: "message",                  │
  │       seq: 46, data: {...} } ────────── │
  │                                          │
  │ ←── { type: "event",                     │ (AI 流式增量)
  │       topic: "group:abc123",             │
  │       event: "delta",                    │
  │       data: { messageId, content,        │
  │               blockId } } ────────────── │
  │       ... (多个 delta)                    │
  │                                          │
  │ ←── { type: "event",                     │ (AI 完成)
  │       topic: "group:abc123",             │
  │       event: "messageUpdated",           │
  │       seq: 47, data: {...} } ────────── │
```

#### 优雅关闭（解决 dotnet 停止慢的问题）

```
Client                                    Server
  │                                          │
  │                                          │ ← SIGTERM / 手动停止
  │                                          │
  │ ←── { type: "shutdown",                  │ (通知所有客户端)
  │       reconnectAfter: 3000 } ────────── │
  │                                          │
  │ (客户端收到 shutdown)                      │
  │ → 停止发送新请求                           │
  │ → 等 3 秒后尝试重连                        │
  │                                          │
  │                                          │ ← WebSocket Close frame
  │ ←── Close(1001, "going away") ────────── │
  │                                          │
  │                                          │ ← 服务端干净退出 ✓
```

### 3.4 心跳机制

```
每 30 秒：
  Client → { type: "ping" }
  Server → { type: "pong" }

如果 45 秒无 pong：
  Client 认为连接断开 → 自动重连 (指数退避 1s-30s)
  重连时对每个已订阅 topic 发 subscribe + afterSeq
```

与 SSE 的区别：WebSocket 有原生 Ping/Pong 帧，还可以在应用层叠加业务心跳。

---

## 4. 客户端架构（共享协议层）

### 4.1 共享库 `@prd-agent/realtime`

提取到独立包（可以是 monorepo workspace package），桌面端和 Web 端共享：

```typescript
// @prd-agent/realtime/src/WsClient.ts
export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, TopicSubscription> = new Map();
  private reconnectAttempts = 0;
  private pendingAcks: Map<string, PendingAck> = new Map();

  constructor(private config: WsClientConfig) {
    super();
  }

  // ─── 连接管理 ─────────────────────────────────
  connect(token: string): void;
  disconnect(): void;

  // ─── 订阅管理 ─────────────────────────────────
  subscribe(topic: string, afterSeq?: number): TopicSubscription;
  unsubscribe(topic: string): void;

  // ─── 发送消息 ─────────────────────────────────
  send(topic: string, payload: any): Promise<AckResponse>;
  cancel(topic: string, payload: any): Promise<AckResponse>;

  // ─── 事件 ────────────────────────────────────
  // 'connected'    → 连接建立
  // 'disconnected' → 连接断开 (reason)
  // 'reconnecting' → 正在重连 (attempt)
  // 'shutdown'     → 服务端通知关闭
  // 'event'        → 收到业务事件 (topic, event, seq, data)
  // 'error'        → 错误 (code, message)

  // ─── 内部 ────────────────────────────────────
  private handleFrame(frame: ServerFrame): void;
  private reconnect(): void;     // 指数退避
  private startHeartbeat(): void;
  private resubscribeAll(): void; // 重连后自动恢复所有订阅
}

export interface TopicSubscription {
  topic: string;
  lastSeq: number;
  status: 'subscribing' | 'active' | 'paused';
  on(event: string, handler: (data: any, seq: number) => void): void;
  off(event: string, handler: Function): void;
}
```

### 4.2 桌面端变化

#### 删除的代码（约 820 行）

| 文件 | 删除内容 | 行数 |
|------|----------|------|
| `session.rs` | 5 个 SSE 函数 + SSE parser + StreamCancelState | ~600 |
| `useGroupStreamReconnect.ts` | 整个文件 | ~220 |

#### Rust 层简化

Rust 层不再做 SSE 代理。保留：
- REST API 调用（文档上传、群组 CRUD 等）
- Auth token 安全存储
- 原生功能（自动更新、深度链接、窗口管理）

WebSocket 连接由 React 层直接建立（Tauri WebView 支持标准 WebSocket API）。

```
之前: React → Tauri invoke → Rust HTTP SSE → 解析 → Tauri emit → React 监听
之后: React → WebSocket (直连后端) → React 处理
```

#### React 层改造

```typescript
// App.tsx - 初始化
const wsClient = useMemo(() => new WsClient({
  baseUrl: settingsStore.apiBaseUrl,
  heartbeatInterval: 30_000,
  reconnectBackoff: { initial: 1000, max: 30_000, multiplier: 2 },
}), []);

// 登录后连接
useEffect(() => {
  if (isAuthenticated) {
    wsClient.connect(accessToken);
  }
  return () => wsClient.disconnect();
}, [isAuthenticated]);

// ChatContainer.tsx - 订阅当前群组
useEffect(() => {
  if (!activeGroupId) return;
  const lastSeq = getLastGroupSeq(activeGroupId);
  const sub = wsClient.subscribe(`group:${activeGroupId}`, lastSeq);

  sub.on('message', (data, seq) => ingestGroupBroadcastMessage(data, seq));
  sub.on('delta', (data) => appendToStreamingMessage(data));
  sub.on('blockEnd', (data) => endStreamingBlock(data));
  sub.on('citations', (data) => setCitations(data));
  sub.on('messageUpdated', (data, seq) => handleMessageUpdated(data, seq));

  return () => {
    // 注意：不 unsubscribe！保持后台接收
    sub.off('message');
    sub.off('delta');
    // ...
  };
}, [activeGroupId]);
```

### 4.3 Web 端 (prd-admin) 兼容

prd-admin 可以渐进式采用：

**阶段 1（立即）**：保持现有 request-response SSE，不动。

**阶段 2（当需要群组协作功能时）**：引入 `@prd-agent/realtime` 库，在管理后台的对话页面使用 WebSocket。

**阶段 3（统一）**：所有实时功能迁移到 WebSocket，SSE 仅保留给 Open Platform（外部 API 兼容性）。

---

## 5. 多文档架构

### 5.1 新的 Store 模型

```typescript
// ━━━ sessionStore.ts (重设计) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface GroupContext {
  sessionId: string;
  document: Document | null;
  role: UserRole;
  mode: InteractionMode;
  lastSeq: number;
  scrollPosition?: number;      // 保存滚动位置
}

interface SessionState {
  // 核心：按群组索引的上下文 Map
  contextByGroup: Record<string, GroupContext>;

  // 当前活跃群组
  activeGroupId: string | null;

  // 便捷 getter
  readonly activeContext: GroupContext | null;
  readonly activeDocument: Document | null;
  readonly activeSessionId: string | null;

  // 操作
  activateGroup(groupId: string): void;            // 纯指针切换，无网络请求
  setGroupContext(groupId: string, ctx: Partial<GroupContext>): void;
  removeGroupContext(groupId: string): void;
  ensureGroupContext(groupId: string): Promise<void>; // 懒加载：如果没有上下文则从服务端获取
}

// ━━━ messageStore.ts (重设计) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface GroupMessageState {
  messages: Message[];
  localMinSeq: number;
  localMaxSeq: number;
  hasMoreOlder: boolean;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingPendingText: string;
  streamingBlocks: Map<string, StreamingBlock>;
}

interface MessageState {
  // 核心：按群组索引的消息缓存
  cacheByGroup: Record<string, GroupMessageState>;

  // 当前展示的群组
  activeGroupId: string | null;

  // 便捷 getter
  readonly activeMessages: Message[];
  readonly activeIsStreaming: boolean;

  // 操作（全部带 groupId 参数，不依赖 activeGroupId）
  ingestEvent(groupId: string, event: string, data: any, seq: number): void;
  appendDelta(groupId: string, data: DeltaData): void;
  loadOlderMessages(groupId: string): Promise<void>;

  // 切换展示
  setActiveGroup(groupId: string): void;  // 纯指针切换

  // 缓存管理
  evictGroup(groupId: string): void;      // 释放内存
  readonly cachedGroupIds: string[];
}
```

### 5.2 群组切换对比

```
之前 (单槽位 + SSE):
  1. cancel_stream('group')        ← 断开旧 SSE (网络往返)
  2. bindSession(null)             ← 清空消息
  3. setActiveGroupId(newId)       ← UI 闪烁 (无数据)
  4. open_group_session(newId)     ← REST API 调用 (网络往返)
  5. setSession(session, doc)      ← 设置新上下文
  6. subscribe_group_messages()    ← 建立新 SSE (网络往返 + 握手)
  7. syncFromServer()              ← 拉取消息 (网络往返)
  总计: 至少 4 次网络往返, 500ms-2s 可感知延迟

之后 (多槽位 + WebSocket):
  1. setActiveGroup(newId)         ← 纯内存指针切换 (<1ms)
  2. (如果缓存为空) ensureGroupContext(newId)  ← 首次加载
  3. (如果未订阅) wsClient.subscribe(...)      ← WS 帧发送 (<5ms)
  总计: 首次 1 次网络往返 (REST 获取上下文), 后续 0 次
```

### 5.3 缓存策略

```typescript
const MAX_CACHED_GROUPS = 10;        // 最多缓存 10 个群组的消息
const MAX_MESSAGES_PER_GROUP = 200;  // 每组最多 200 条消息在内存中
const EVICTION_POLICY = 'lru';       // 最久未访问的群组先淘汰

// 在 setActiveGroup 中：
// 1. 如果缓存数超过 MAX_CACHED_GROUPS，淘汰 LRU 群组
// 2. 淘汰 = 删除消息数组 + 保留 lastSeq (重连时用)
// 3. 重新进入已淘汰群组时，从 lastSeq 续传
```

---

## 6. 文件上传重设计

### 6.1 当前问题

```
上传 → 创建群组 → loadGroups(loading:true) → ChatContainer 卸载
→ loadGroups(loading:false) → ChatContainer 挂载
→ 5 秒后 loadGroups ×3 (闪烁 ×3)
```

### 6.2 新方案

```typescript
async function handleUpload(file: File) {
  // 1. 上传文档
  const { document } = await invoke('upload_document', { content });

  // 2. 创建群组
  const { groupId } = await invoke('create_group', { prdDocumentId: document.id, groupName });

  // 3. 直接将新群组插入 store（不重新拉取全量列表）
  groupListStore.getState().addGroup({
    groupId,
    groupName,
    prdDocumentId: document.id,
    // ... 最小字段集
  });

  // 4. 初始化群组上下文
  const session = await invoke('open_group_session', { groupId });
  sessionStore.getState().setGroupContext(groupId, {
    sessionId: session.id,
    document,
    role: 'PM',
    mode: 'QA',
    lastSeq: 0,
  });

  // 5. 切换到新群组（纯指针）
  sessionStore.getState().activateGroup(groupId);

  // 6. WebSocket 订阅（如果已连接）
  wsClient.subscribe(`group:${groupId}`, 0);

  // 7. 后台静默更新群名（无闪烁）
  setTimeout(async () => {
    const detail = await invoke('get_group_detail', { groupId });
    groupListStore.getState().updateGroupName(groupId, detail.groupName);
  }, 5000);
}
```

关键变化：
- 无 `loadGroups()`：直接 `addGroup()` 到 store
- 无 `loading` 状态：ChatContainer 不会卸载
- 群名更新用 `updateGroupName()` 而非全量刷新
- 零闪烁

---

## 7. 后端改造

### 7.1 新增 RealtimeHub

```csharp
// PrdAgent.Api/Hubs/RealtimeHub.cs
public class RealtimeHub
{
    private readonly ConcurrentDictionary<string, WebSocketConnection> _connections = new();
    private readonly IGroupMessageStreamHub _groupHub;  // 复用现有 Hub
    private readonly IServiceProvider _sp;

    public async Task HandleConnection(WebSocket ws, string userId, CancellationToken ct)
    {
        var conn = new WebSocketConnection(ws, userId);
        _connections[conn.Id] = conn;

        try
        {
            await foreach (var frame in conn.ReadFramesAsync(ct))
            {
                switch (frame.Type)
                {
                    case "subscribe":
                        await HandleSubscribe(conn, frame, ct);
                        break;
                    case "unsubscribe":
                        HandleUnsubscribe(conn, frame);
                        break;
                    case "send":
                        await HandleSend(conn, frame, ct);
                        break;
                    case "cancel":
                        await HandleCancel(conn, frame, ct);
                        break;
                    case "ping":
                        await conn.SendAsync(new { type = "pong" }, ct);
                        break;
                }
            }
        }
        finally
        {
            // 清理所有订阅
            foreach (var sub in conn.Subscriptions)
                sub.Value.Dispose();
            _connections.TryRemove(conn.Id, out _);
        }
    }

    private async Task HandleSubscribe(WebSocketConnection conn, ClientFrame frame, CancellationToken ct)
    {
        var topic = frame.Topic!;
        var afterSeq = frame.AfterSeq ?? 0;

        if (topic.StartsWith("group:"))
        {
            var groupId = topic[6..];

            // 1. 回放历史 (afterSeq → 最新)
            var history = await _messageService.GetMessagesAfterSeqAsync(groupId, afterSeq);
            foreach (var msg in history)
            {
                await conn.SendEventAsync(topic, "message", msg.GroupSeq, msg, ct);
            }

            // 2. 订阅实时推送
            var sub = _groupHub.Subscribe(groupId);
            conn.Subscriptions[topic] = sub;

            // 3. 启动转发循环
            _ = Task.Run(async () =>
            {
                await foreach (var evt in sub.Reader.ReadAllAsync(ct))
                {
                    await conn.SendEventAsync(topic, evt.Type, evt.Seq, evt.Data, ct);
                }
            }, ct);
        }

        await conn.SendAckAsync(frame.Id, ct);
    }

    private async Task HandleSend(WebSocketConnection conn, ClientFrame frame, CancellationToken ct)
    {
        var topic = frame.Topic!;

        if (topic.StartsWith("group:"))
        {
            var groupId = topic[6..];
            // 复用现有 ChatService 逻辑
            // 创建 Run → Worker 后台执行 → 事件通过 GroupMessageStreamHub 推送回来
            var runId = await _chatService.CreateRunAsync(groupId, conn.UserId, frame.Payload, ct);
            await conn.SendAckAsync(frame.Id, new { runId }, ct);
        }
    }
}
```

### 7.2 Startup 注册

```csharp
// Program.cs
app.MapGet("/api/v1/realtime", async (HttpContext ctx, RealtimeHub hub) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        return;
    }

    var userId = ctx.User.FindFirst("sub")?.Value;
    var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await hub.HandleConnection(ws, userId!, ctx.RequestAborted);
});

// 保留现有 SSE 端点（向后兼容 Open Platform 等）
```

### 7.3 优雅关闭

```csharp
// Program.cs
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(() =>
{
    var hub = app.Services.GetRequiredService<RealtimeHub>();
    // 通知所有客户端：3 秒后重连
    hub.BroadcastShutdown(reconnectAfter: 3000).GetAwaiter().GetResult();
    // 等待 1 秒让消息发出
    Thread.Sleep(1000);
    // 关闭所有 WebSocket
    hub.CloseAll().GetAwaiter().GetResult();
});
```

---

## 8. 注脚/引用 (Citations) 修复

### 8.1 当前问题

Citations 事件是 `seq: 0` 的非持久化事件，断线时丢失。重连后无法恢复。

### 8.2 修复方案

```
方案 A（推荐）：Citations 持久化到消息中
  - ChatService 在 AI 完成后，将 citations 写入 Message.Citations 字段
  - messageUpdated 事件的 data 中包含完整 citations
  - 重连回放 message 事件时，citations 已包含在消息数据中
  - 流式过程中的 citations 事件仍独立推送（实时体验）

方案 B：Citations 事件改为带 seq
  - 将 citations 事件的 seq 改为非零值
  - 回放逻辑按 seq 排序推送，citations 能被回放
  - 缺点：增加回放逻辑复杂度
```

推荐方案 A，因为它与 `messageUpdated` 的"最终一致性"模型一致：
- 流式过程中：`citations` 事件实时推送（用户立即看到引用）
- 流式完成后：`messageUpdated` 包含完整消息 + citations（断线重连的兜底）

---

## 9. 迁移策略

### 9.1 分阶段迁移（3 个阶段）

```
Phase 1 (1-2 周): 后端 WebSocket + 桌面端适配
  ├── 新增 RealtimeHub (WebSocket endpoint)
  ├── 桌面端引入 WsClient 共享库
  ├── 桌面端 ChatContainer 切换到 WebSocket
  ├── 删除 Rust SSE 代理代码 (session.rs 5 个 SSE 函数)
  ├── 删除 useGroupStreamReconnect.ts
  ├── 重构 sessionStore + messageStore 为多槽位
  └── Citations 持久化

Phase 2 (1 周): 体验优化
  ├── 文件上传零闪烁 (addGroup + activateGroup)
  ├── 群组切换零延迟 (指针切换 + LRU 缓存)
  ├── 优雅关闭 (shutdown 帧)
  └── Rust 层清理 (删除 SSE 相关函数和依赖)

Phase 3 (后续): Web 端统一
  ├── prd-admin 引入 @prd-agent/realtime 库
  ├── AiChatPage 迁移到 WebSocket (可选)
  └── 旧 SSE 端点仅保留给 Open Platform
```

### 9.2 数据迁移

- **MongoDB**：无结构变更。消息、群组、会话模型不变。
- **Redis**：RunEventStore 不变。
- **localStorage**：sessionStore 的 persist 结构变更，需版本迁移：

```typescript
// sessionStore persist config
migrate: (persisted: any, version: number) => {
  if (version < 2) {
    // v1 (旧): { sessionId, activeGroupId, document, ... }
    // v2 (新): { contextByGroup: {}, activeGroupId, ... }
    const migrated = {
      contextByGroup: {},
      activeGroupId: persisted.activeGroupId,
    };
    if (persisted.activeGroupId && persisted.sessionId) {
      migrated.contextByGroup[persisted.activeGroupId] = {
        sessionId: persisted.sessionId,
        document: persisted.document,
        role: persisted.currentRole || 'PM',
        mode: persisted.mode || 'QA',
        lastSeq: persisted.lastGroupSeqByGroup?.[persisted.activeGroupId] || 0,
      };
    }
    return migrated;
  }
  return persisted;
},
version: 2,
```

---

## 10. 对比总结

| 维度 | 当前架构 | 新架构 | 改善 |
|------|----------|--------|------|
| **连接数** | N 条 SSE (每群组 1 条) | 1 条 WebSocket | N:1 |
| **连接建立** | TCP+TLS+HTTP+SSE 每次 200-500ms | 一次建立，后续 0ms | 快 ∞ |
| **群组切换** | 断开+销毁+重建 500ms-2s | 指针切换 <1ms | 快 500x |
| **上传体验** | 闪烁 3 次 | 零闪烁 | ✓ |
| **停止后端** | 卡死 5-30s | 优雅关闭 <3s | 快 10x |
| **多文档** | 不支持 | 多槽位缓存 | ✓ |
| **断线恢复** | 逐群组重连 | 单连接恢复 + 批量 resubscribe | 快 N 倍 |
| **引用丢失** | 断线丢失 | 持久化到消息 | ✓ |
| **代码共享** | 0% (桌面 Rust SSE vs Web fetch SSE) | 90%+ (共享 WsClient) | ✓ |
| **水平扩展** | 内存 Hub 不可扩展 | 可选 Redis PubSub | ✓ |
| **总代码量** | SSE 相关 ~1,650 行 | WsClient 共享库 ~400 行 | 减少 76% |
