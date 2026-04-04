# Page Agent Bridge — 编码 Agent 的浏览器之眼

> **日期**：2026-04-04 | **状态**：设计中
>
> 让编码 Agent 通过 CDS 预览页面的 Badge 读取 DOM、执行操作，形成"感知→决策→操作→反馈"闭环。

## 一、管理摘要

- **解决什么问题**：编码 Agent 部署代码后无法验证页面渲染结果，只能依赖 API 级别的冒烟测试
- **方案概述**：在 CDS Widget 中集成轻量级 Bridge Client（复用 alibaba/page-agent 的 DOM 解析思路），通过 WebSocket 与 CDS Bridge 端点双向通信，编码 Agent 通过 CDS REST API 读取页面状态并下发操作指令
- **业务价值**：Agent 获得"眼睛和手"——能看到用户浏览器中的真实页面、执行点击/输入等操作、感知 JS 错误，从而自主验证页面功能
- **关键约束**：Bridge Client 运行在用户浏览器中，Agent 不能自行打开页面；需要用户打开预览页后建立连接
- **影响范围**：仅改动 CDS 模块（`cds/src/`），对主项目代码零侵入

---

## 二、用户场景

### 场景 A：有人模式（Phase 1）

1. 编码 Agent 在 CDS 部署完代码后，需要验证页面
2. Agent 通过 CDS Bridge API 发起"导航请求"（`POST /api/bridge/navigate-request`）
3. CDS Widget 在用户浏览器中展示蓝色脉冲动效 + 提示文字："AI 请求打开 /defects 页面"
4. 用户点击按钮，浏览器导航到目标页面
5. Badge Bridge Client 自动连接 WebSocket，上报页面 DOM 树
6. Agent 通过 Bridge API 读取状态、下发操作、验证结果

### 场景 B：无人模式（未来）

- CDS 端启动 headless browser，加载预览页，Bridge Client 同样连接
- 架构完全复用，仅在 CDS 端加一个 browser launcher

---

## 三、核心架构

```
┌─ 用户浏览器 ─────────────────────────────────────────────────┐
│                                                              │
│  CDS Widget (已有，注入到每个预览页)                           │
│  ├── 部署面板 (已有)                                         │
│  ├── AI 占用指示 (已有)                                      │
│  └── Bridge Client (新增)                                    │
│      ├── DOM 提取器: 遍历 DOM → 简化文本格式                  │
│      ├── 操作执行器: click / type / scroll / evaluate         │
│      ├── 状态采集器: console 错误 / 网络异常 / 路由变化        │
│      └── WebSocket 客户端 → CDS Bridge                       │
│                                                              │
└──────────────────────────────┬────────────────────────────────┘
                               │ WebSocket (ws://cds:9900/bridge/ws)
                               ▼
┌─ CDS Server ────────────────────────────────────────────────┐
│                                                              │
│  Bridge 端点 (新增)                                          │
│  ├── WebSocket Hub: 管理每个分支的 Bridge 连接                │
│  ├── GET  /api/bridge/state/:branchId   → Agent 读取页面状态 │
│  ├── POST /api/bridge/command/:branchId → Agent 下发操作指令 │
│  ├── POST /api/bridge/navigate-request  → Agent 请求用户导航 │
│  └── GET  /api/bridge/connections       → 查看所有活跃连接   │
│                                                              │
│  分支隔离: WebSocket 按 branchId 分组，一个分支一个连接       │
│                                                              │
└──────────────────────────────┬────────────────────────────────┘
                               │ REST API
                               ▼
┌─ 编码 Agent ────────────────────────────────────────────────┐
│                                                              │
│  通过 CDS REST API 操作:                                     │
│  1. POST /api/bridge/navigate-request → 请求用户打开页面     │
│  2. GET  /api/bridge/state/:branchId  → 读取 DOM + 状态     │
│  3. POST /api/bridge/command/:branchId → 下发操作指令        │
│  4. 读取返回结果 → 决策下一步 → 循环                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 分支隔离保证

- 每个 CDS 分支有独立的预览环境（独立容器、独立端口）
- Widget 注入时携带 `BRANCH_ID`（已有机制）
- WebSocket 连接按 `branchId` 注册，Agent 只能操作自己分支的预览页
- 不同分支的 Bridge 连接完全隔离，不存在跨分支操作风险

---

## 四、Bridge Client（浏览器端）

### 4.1 DOM 提取器

参考 alibaba/page-agent 的 `page-controller` 的 `flatTreeToString()` 设计，将 DOM 简化为 LLM 可消费的文本格式：

```
[0]<nav> 侧边栏导航
  [1]<a href="/dashboard"> 仪表盘 />
  [2]<a href="/defects" class="active"> 缺陷管理 />
  [3]<a href="/settings"> 设置 />
/>
[4]<main> 主内容区域
  [5]<h1> 缺陷列表 />
  [6]<input type="text" placeholder="搜索缺陷..." />
  [7]<button> 新建缺陷 />
  [8]<table>
    [9]<tr> #001 登录页白屏 — 严重 — 未修复 />
    [10]<tr> #002 上传超时 — 一般 — 已修复 />
  />
/>
```

**规则**：
- 只保留可交互元素（带 `[index]` 编号）和语义文本
- 过滤不可见元素（`display:none`、`visibility:hidden`、零尺寸）
- 过滤 CDS Widget 自身（`data-cds-widget-root`、`data-page-agent-ignore`）
- 每个元素保留关键属性：`href`、`type`、`placeholder`、`value`、`class`（仅 `active`/`disabled`/`selected` 等状态类）
- 最大深度 15 层，最大节点数 500（防止 DOM 过大）

### 4.2 操作执行器

| 操作 | 参数 | 行为 |
|------|------|------|
| `click` | `{ index: number }` | 模拟完整点击链（pointerdown → mousedown → focus → pointerup → mouseup → click） |
| `type` | `{ index: number, text: string, clear?: boolean }` | 聚焦输入框，可选清空后输入文本 |
| `scroll` | `{ direction: 'up'\|'down', pixels?: number }` | 页面或容器滚动 |
| `navigate` | `{ url: string }` | 浏览器导航到指定 URL（同源限制） |
| `evaluate` | `{ script: string }` | 执行任意 JS 并返回结果 |
| `snapshot` | `{}` | 立即采集当前 DOM 树 + 页面信息 |

### 4.3 状态采集器

每次操作执行后自动采集并上报：

```typescript
interface PageState {
  url: string;                    // 当前完整 URL
  title: string;                  // 页面标题
  domTree: string;                // 简化 DOM 文本
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  consoleErrors: string[];        // 最近 20 条 console.error
  networkErrors: string[];        // 最近 10 条失败请求（4xx/5xx）
  timestamp: number;
}
```

### 4.4 Console / Network 拦截

```javascript
// Console 拦截（仅 error 级别）
var origError = console.error;
console.error = function() {
  consoleErrors.push(Array.from(arguments).join(' '));
  if (consoleErrors.length > 20) consoleErrors.shift();
  origError.apply(console, arguments);
};

// Network 拦截（仅失败请求）
var origFetch = window.fetch;
window.fetch = function() {
  return origFetch.apply(this, arguments).then(function(res) {
    if (!res.ok) {
      networkErrors.push(res.status + ' ' + res.url);
      if (networkErrors.length > 10) networkErrors.shift();
    }
    return res;
  });
};
```

---

## 五、CDS Bridge 端点

### 5.1 WebSocket Hub

```
ws://cds-host:9900/bridge/ws?branchId=xxx
```

- 每个 `branchId` 最多一个活跃 WebSocket 连接（后连接替换前连接）
- 连接建立后立即发送一次 `snapshot` 指令，获取初始页面状态
- 心跳：每 15 秒 ping/pong
- 断线后 Widget 自动重连（指数退避 1s → 2s → 4s → 8s，最大 30s）

**消息协议**：

```typescript
// CDS → Widget（下行指令）
interface BridgeCommand {
  id: string;          // 指令 ID（用于匹配响应）
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'evaluate' | 'snapshot';
  params: Record<string, unknown>;
}

// Widget → CDS（上行响应）
interface BridgeResponse {
  id: string;          // 对应的指令 ID
  success: boolean;
  error?: string;
  state: PageState;    // 操作后的页面状态
}

// Widget → CDS（主动上报）
interface BridgeEvent {
  type: 'connected' | 'disconnected' | 'page-changed' | 'error';
  state?: PageState;
  error?: string;
}
```

### 5.2 REST API

| 端点 | 方法 | 用途 | 请求体 | 响应 |
|------|------|------|--------|------|
| `/api/bridge/connections` | GET | 查看所有活跃 Bridge 连接 | — | `{ connections: [{ branchId, url, connectedAt }] }` |
| `/api/bridge/state/:branchId` | GET | 读取页面状态 | — | `PageState \| { error: 'no connection' }` |
| `/api/bridge/command/:branchId` | POST | 下发操作指令 | `BridgeCommand` | `BridgeResponse`（同步等待） |
| `/api/bridge/navigate-request` | POST | 请求用户打开页面 | `{ branchId, url, reason }` | `{ requestId }` |

**指令执行流程**（同步等待模式）：

```
Agent POST /api/bridge/command/my-branch
  body: { action: "click", params: { index: 7 } }
    ↓
CDS 通过 WebSocket 发给 Widget
    ↓
Widget 执行 click → 等待 DOM 稳定（300ms）→ 采集新状态
    ↓
Widget 通过 WebSocket 返回 BridgeResponse
    ↓
CDS 返回给 Agent
    ↓
Agent 读取新状态，决策下一步
```

超时：单条指令最长等待 15 秒，超时返回 `{ success: false, error: "timeout" }`。

---

## 六、导航请求 UI

当 Agent 需要用户打开特定页面时，在 CDS Widget 中展示视觉提示。

### 6.1 视觉设计

- 蓝色脉冲圆点 + 边框发光动效（复用已有 `cds-ai-border-glow`）
- 面板从 Badge 上方弹出，包含：目标 URL、原因说明、"打开页面"和"忽略"按钮
- 点击"打开页面"→ 浏览器导航到目标 URL → Bridge 自动连接
- 点击"忽略"→ 面板消失
- 30 秒无操作自动收起（不自动导航）

### 6.2 通信流程

```
Agent POST /api/bridge/navigate-request
  body: { branchId: "my-branch", url: "/defects", reason: "验证缺陷列表排序" }
    ↓
CDS 广播 SSE 事件到 Widget（通过 activity-stream）
    ↓
Widget 展示导航请求面板
    ↓
用户点击"打开页面"
    ↓
浏览器 window.location.href = url
    ↓
新页面加载 → Widget 重新注入 → Bridge Client 自动连接
    ↓
Agent 轮询 /api/bridge/state/:branchId 等待连接就绪
```

---

## 七、安全边界

| 约束 | 实现 |
|------|------|
| 仅限 CDS 预览环境 | Bridge Client 只在 Widget 注入时启用（CDS Proxy 注入） |
| 生产环境不加载 | 生产环境不经过 CDS Proxy，不会注入 Widget |
| 分支隔离 | WebSocket 按 `branchId` 分组，Agent 只能操作自己分支 |
| 操作审计 | 所有 Bridge 指令记录到 Activity Stream |
| `evaluate` 限制 | JS 执行仅在 Bridge 连接存在时可用，返回值截断为 10KB |
| 导航限制 | `navigate` 仅允许同源 URL，禁止跳转外部站点 |

---

## 八、与现有机制的关系

| 现有机制 | 关系 |
|----------|------|
| CDS Widget 注入（`widget-script.ts`） | Bridge Client 代码追加到 Widget IIFE 中 |
| AI 占用检测（`aiOccupant` + SSE） | Bridge 连接时自动触发 AI 占用状态 |
| Activity Stream | Bridge 操作记录为 `source: 'ai'` 的 activity 事件 |
| 分支 Badge（`BranchBadge.tsx`） | 共存，Bridge 状态指示器附加到 CDS Widget Badge 旁 |
| CDS WebSocket Proxy（`proxy.ts`） | Bridge WebSocket 走 CDS master 端点，不走分支 proxy |

---

## 九、验收标准

| # | 场景 | 前置条件 | 验收标准 |
|---|------|---------|---------|
| V1 | Bridge 连接 | 用户在浏览器打开预览页 | Badge 自动连上 CDS Bridge，Agent 通过 `GET /api/bridge/connections` 看到连接 |
| V2 | 读取页面 | 用户已打开页面 | Agent 通过 `GET /api/bridge/state/:branchId` 读取到页面标题、路由、可交互元素列表 |
| V3 | 操作页面 | 用户已打开页面 | Agent 通过 `POST /api/bridge/command` 下发"click"指令，用户浏览器里的页面发生对应变化 |
| V4 | 闭环反馈 | Agent 下发操作后 | Bridge 返回操作结果 + 操作后的新页面状态 |
| V5 | 错误感知 | 页面有 JS 错误或 API 异常 | Agent 能通过 `state.consoleErrors` / `state.networkErrors` 读取到错误信息 |
| V6 | 非侵入 | 生产环境 | Badge 不加载（不经过 CDS Proxy），对线上零影响 |
| V7 | 导航请求 | Agent 需要用户打开新页面 | CDS Widget 展示蓝色脉冲动效 + 提示，用户点击后导航并自动建立连接 |

---

## 十、关联文档

- `doc/design.cds.md` — CDS 核心架构
- `doc/spec.cds.md` — CDS 功能规格
- alibaba/page-agent — DOM 提取格式参考（`page-controller` 包的 `flatTreeToString`）
