# Page Agent Bridge — 编码 Agent 网页操控通道

> **日期**：2026-04-04 | **状态**：设计中
>
> 本文档描述如何通过 CDS Widget 注入 Page Agent 能力，使编码 Agent 能远程读取和操控预览页面。

## 一、管理摘要

- **解决什么问题**：编码 Agent 部署完代码后无法验证页面渲染是否正确，只能做 API 级冒烟测试，缺少"眼睛"和"手"
- **方案概述**：在 CDS Widget 中注入 Page Agent Bridge，当用户打开预览页时自动建立 WebSocket 通道，编码 Agent 通过 CDS Bridge API 远程读取页面 DOM 状态并执行操作
- **业务价值**：编码 Agent 可在用户打开页面后自动执行页面级验证，替代人工逐页点击检查
- **影响范围**：CDS 模块新增 Bridge 端点 + Widget 注入 Bridge 客户端，不改动主项目代码
- **核心约束**：Bridge 运行在用户浏览器中，Agent 不能自己打开页面，必须用户先打开

---

## 二、问题背景

### 现状

| 层级 | 现有能力 | 缺失 |
|------|---------|------|
| API 测试 | curl 链式冒烟测试（`smoke-test-*.sh`） | ✅ 已有 |
| 页面渲染验证 | 无 | ❌ 需要人工打开浏览器 |
| 交互流程验证 | 无 | ❌ 需要人工点击操作 |
| 错误感知 | 后端日志 | ❌ 前端 JS 错误、Console 警告无法感知 |

### CDS 已有基础

1. **Widget 自动注入**：CDS Proxy 已能将 `<script>` 注入所有预览页面的 `</body>` 前（`widget-script.ts`）
2. **AI 占用检测**：Widget 已有 `aiOccupant` 状态 + SSE activity stream 监听（30 秒 TTL）
3. **WebSocket 代理**：CDS Proxy 已有完整的 WebSocket upgrade 透传能力
4. **BranchBadge**：前端已有左下角固定定位的分支标识组件

---

## 三、技术方案

### 3.1 架构总览

```
┌─ 用户浏览器 ─────────────────────────────────────────────────┐
│                                                              │
│  预览页面（任意分支）                                          │
│  ┌────────────────────────────────────────────────────┐      │
│  │  CDS Widget（已有）                                  │      │
│  │  ├── 分支信息 / 部署控制（已有）                       │      │
│  │  ├── AI 占用检测（已有）                              │      │
│  │  └── Bridge Client（新增）◄──────────┐               │      │
│  │       ├── DOM 采集器（复用 page-agent）│               │      │
│  │       ├── 操作执行器（复用 page-agent）│               │      │
│  │       └── 状态上报 + 指令拉取         │               │      │
│  └───────────────────────────────────────┼──────────┘      │
│                                          │ WebSocket        │
└──────────────────────────────────────────┼─────────────────┘
                                           │
                                           ▼
┌─ CDS Server ────────────────────────────────────────────────┐
│                                                              │
│  Bridge Hub（新增）                                           │
│  ├── WebSocket 端点: /_cds/bridge/ws                         │
│  ├── REST 端点:                                              │
│  │    GET  /_cds/bridge/sessions       ← 查询在线页面        │
│  │    GET  /_cds/bridge/state/:sid     ← 读取页面状态        │
│  │    POST /_cds/bridge/execute/:sid   ← 下发操作指令        │
│  │    GET  /_cds/bridge/result/:rid    ← 获取操作结果        │
│  └── 内存会话管理（无持久化）                                  │
│                                                              │
└──────────────────────────────────────────┬──────────────────┘
                                           │ HTTP API
                                           ▼
┌─ 编码 Agent（Claude Code / 任意 Agent）──────────────────────┐
│                                                              │
│  1. GET  /sessions         → 发现哪些页面在线                 │
│  2. GET  /state/:sid       → 读取页面可交互元素、路由、Console │
│  3. POST /execute/:sid     → 下发操作（click/type/navigate）  │
│  4. GET  /result/:rid      → 获取操作结果 + 操作后新状态       │
│  5. 循环 2-4               → 实现多步验证流程                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 数据流：一次完整操作

```
Agent                     CDS Bridge Hub              Browser Widget
  │                            │                            │
  │ GET /sessions              │                            │
  │───────────────────────────>│                            │
  │ [{sid:"abc", url:"/dashboard", branch:"feat-x"}]       │
  │<───────────────────────────│                            │
  │                            │                            │
  │ GET /state/abc             │                            │
  │───────────────────────────>│   ws: getState             │
  │                            │───────────────────────────>│
  │                            │   ws: stateResult          │
  │                            │<───────────────────────────│
  │ {url, title, elements[], console[], route}              │
  │<───────────────────────────│                            │
  │                            │                            │
  │ POST /execute/abc          │                            │
  │ {action:"click",           │   ws: execute              │
  │  target:"提交按钮"}        │───────────────────────────>│
  │ → rid: "r1"               │                            │
  │<───────────────────────────│                            │
  │                            │         (执行操作)          │
  │                            │   ws: executeResult        │
  │                            │<───────────────────────────│
  │ GET /result/r1             │                            │
  │───────────────────────────>│                            │
  │ {success, newUrl, newState, console, duration}          │
  │<───────────────────────────│                            │
```

### 3.3 三层数据模型

Bridge Client 采集页面信息分三层，按需请求：

#### Layer 1: 基础信息（每次自动附带）

```typescript
interface PageBasicState {
  url: string            // window.location.href
  title: string          // document.title
  route: string          // SPA 路由路径
  viewport: { width: number, height: number }
  timestamp: number
}
```

#### Layer 2: 可交互元素（getState 时采集）

```typescript
interface InteractiveElement {
  index: number          // 元素编号，操作时引用
  tag: string            // button / input / a / select ...
  role: string           // ARIA role
  text: string           // 可见文本或 aria-label
  type?: string          // input type
  value?: string         // 当前值
  disabled: boolean
  visible: boolean       // 是否在视口内
  selector: string       // 唯一 CSS 选择器（备用定位）
}
```

> 复用 page-agent 的 `page-controller` 包的 DOM 解析能力，它用文本语义而非选择器定位元素，不需要多模态 LLM。

#### Layer 3: 诊断信息（按需采集）

```typescript
interface DiagnosticState {
  consoleErrors: string[]       // console.error 缓冲
  consoleWarnings: string[]     // console.warn 缓冲
  networkErrors: NetworkError[] // 失败的 fetch/XHR
  jsErrors: string[]            // window.onerror 捕获
}
```

### 3.4 操作指令集

| 指令 | 参数 | 说明 |
|------|------|------|
| `click` | `{target: string}` | 点击元素。target 为自然语言描述或元素 index |
| `type` | `{target: string, text: string}` | 在输入框输入文字 |
| `navigate` | `{url: string}` | 导航到指定 URL |
| `scroll` | `{direction: "up"\|"down", amount?: number}` | 滚动页面 |
| `select` | `{target: string, value: string}` | 选择下拉选项 |
| `wait` | `{condition: string, timeout?: number}` | 等待条件满足（元素出现/消失/文字变化） |
| `eval` | `{script: string}` | 执行任意 JS（仅限调试，安全边界内） |
| `getState` | `{layers?: number[]}` | 获取指定层级的页面状态 |

每个指令执行后自动返回 Layer 1 基础信息 + 操作结果。

### 3.5 安全边界

| 规则 | 说明 |
|------|------|
| **仅 CDS 环境** | Bridge 只在 CDS Widget 注入时激活，生产环境不存在此代码 |
| **分支隔离** | 每个 WebSocket 会话绑定 branchId，Agent 只能操作目标分支的页面 |
| **eval 受限** | `eval` 指令仅允许读取操作（获取变量值），禁止修改 DOM 或发起网络请求 |
| **超时熔断** | 单条指令执行超时 10 秒自动中断，防止阻塞页面 |
| **会话 TTL** | WebSocket 断开后会话保留 30 秒（与现有 AI 占用 TTL 一致），超时自动清理 |

---

## 四、与 page-agent 的复用关系

alibaba/page-agent 是 MIT 协议的开源项目，monorepo 包含 8 个子包。

### 复用的包

| 包 | 用途 | 复用方式 |
|---|------|---------|
| `page-controller` | DOM 元素定位 + 操作执行（click/type/scroll） | npm 依赖，在 Widget Bridge Client 中调用 |
| `core` | DOM 解析、元素可见性判断、文本语义匹配 | npm 依赖 |

### 不复用的包

| 包 | 原因 |
|---|------|
| `llms` | 我们用编码 Agent 做决策，不需要浏览器端调 LLM |
| `mcp` | 它走 Chrome 扩展做中转，我们用 CDS WebSocket 直连 |
| `extension` | CDS Widget 注入替代扩展，不需要 Chrome 扩展 |
| `ui` | CDS Widget 已有完整 UI，不需要额外浮窗 |
| `page-agent` | 主包耦合了 LLM 调用链，我们只需要底层的 controller 和 core |

### 关键技术差异

```
page-agent 原架构：
  浏览器内 LLM 调用 → page-controller 执行 → 结果回显

我们的架构：
  服务端编码 Agent → CDS Bridge API → WebSocket → page-controller 执行 → 结果回传 Agent
```

核心区别：**决策在服务端（编码 Agent），执行在浏览器端（page-controller）**。page-agent 的 LLM-in-browser 方案对我们无价值，但它的 DOM 操作层正好是我们需要的。

---

## 五、实现计划

### Phase 1: 最小可用（Bridge + 读取 + 操作）

```
cds/
├── src/
│   ├── services/
│   │   └── bridge-hub.ts          # 新增：Bridge 会话管理 + WebSocket Hub
│   ├── routes/
│   │   └── bridge-routes.ts       # 新增：REST API 端点
│   └── widget-script.ts           # 修改：注入 Bridge Client 代码
└── package.json                   # 新增依赖：page-agent/core, page-agent/page-controller
```

#### 5.1 CDS Server 侧

**bridge-hub.ts** — 核心服务

```typescript
// 会话管理
interface BridgeSession {
  sid: string              // 会话 ID
  branchId: string         // 分支标识
  ws: WebSocket            // 浏览器端 WebSocket
  lastSeen: number         // 最后活跃时间
  currentState?: PageBasicState
  pendingRequests: Map<string, PendingRequest>  // rid → 等待中的指令
}

// 服务接口
class BridgeHub {
  sessions: Map<string, BridgeSession>

  // 浏览器连接
  handleConnection(ws, branchId): void
  handleDisconnect(sid): void

  // Agent 调用
  getSessions(branchId?): SessionInfo[]
  getState(sid, layers?): Promise<PageState>
  execute(sid, command): Promise<{ rid: string }>
  getResult(rid): Promise<ExecuteResult>
}
```

**bridge-routes.ts** — REST 端点

```
GET  /_cds/bridge/sessions              → bridgeHub.getSessions()
GET  /_cds/bridge/sessions?branch=xxx   → bridgeHub.getSessions(branchId)
GET  /_cds/bridge/state/:sid            → bridgeHub.getState(sid)
POST /_cds/bridge/execute/:sid          → bridgeHub.execute(sid, body)
GET  /_cds/bridge/result/:rid           → bridgeHub.getResult(rid)
```

#### 5.2 Widget 侧（浏览器端）

在现有 `widget-script.ts` 的 IIFE 中追加 Bridge Client 模块：

```javascript
// ── Bridge Client ──
var bridgeWs = null;
var bridgeReconnectTimer = null;
var consoleBuffer = [];    // 拦截 console.error/warn
var networkErrors = [];    // 拦截 fetch 错误

function initBridge() {
  var wsUrl = location.protocol === 'https:' ? 'wss://' : 'ws://';
  wsUrl += location.host + '/_cds/bridge/ws?branch=' + BRANCH_ID;

  bridgeWs = new WebSocket(wsUrl);
  bridgeWs.onopen = function() { reportState(); };
  bridgeWs.onmessage = function(e) { handleBridgeCommand(JSON.parse(e.data)); };
  bridgeWs.onclose = function() {
    bridgeReconnectTimer = setTimeout(initBridge, 3000);
  };
}

function handleBridgeCommand(msg) {
  // msg.type: 'getState' | 'execute'
  // 调用 page-controller 的能力执行操作
  // 将结果通过 ws.send 回传
}

// 拦截 console 和网络错误
var origError = console.error;
console.error = function() {
  consoleBuffer.push(Array.from(arguments).join(' '));
  if (consoleBuffer.length > 50) consoleBuffer.shift();
  origError.apply(console, arguments);
};
```

> page-controller 的 DOM 解析和元素操作函数将作为 npm 依赖在构建时打包进 Widget。

#### 5.3 与现有 AI 占用机制联动

Bridge 活跃时，复用已有的 `aiOccupant` 状态：

- Bridge Client 连接后 → 通过 activity stream 广播 AI 占用事件
- Widget 显示"AI 操控中"蓝色光圈边框（已有 `cds-ai-active` 样式）
- 指令执行期间 → 光圈持续显示
- Bridge 断开 → 30 秒 TTL 后光圈消失

用户在页面上能直观看到"AI 正在操控这个页面"。

### Phase 2: 增强（未来）

| 特性 | 说明 |
|------|------|
| 无人模式 | CDS 端启动 headless browser（Puppeteer），加载预览页，Badge 自动连接 |
| 截图对比 | Layer 4 增加 viewport 截图能力，Agent 可做视觉回归 |
| 录制回放 | 记录 Agent 操作序列，可导出为 Playwright 测试脚本 |
| 多标签页 | 同一分支多个页面同时在线，Agent 可在页面间切换 |

---

## 六、验收标准

| # | 场景 | 前置条件 | 验收标准 |
|---|------|---------|---------|
| **V1** | 页面上线感知 | 用户在浏览器打开预览页 | Bridge Client 自动连接，Agent 通过 `GET /sessions` 能看到该页面在线 |
| **V2** | 读取页面状态 | 用户已打开页面 | Agent 通过 `GET /state/:sid` 获取到页面标题、路由、可交互元素列表 |
| **V3** | 执行操作 | 用户已打开页面 | Agent 通过 `POST /execute/:sid` 下发点击/输入指令，用户浏览器中的页面发生对应变化 |
| **V4** | 操作反馈闭环 | Agent 下发操作后 | `GET /result/:rid` 返回操作是否成功 + 操作后的新页面状态 |
| **V5** | 错误感知 | 页面有 JS 报错或 API 异常 | Agent 读取状态时 Layer 3 包含 console 错误信息 |
| **V6** | 非侵入 | 生产环境 | CDS Widget 不注入 Bridge Client，对线上零影响 |
| **V7** | AI 占用提示 | Agent 正在操控页面 | 页面顶部显示"AI 操控中"徽标 + 蓝色光圈边框 |

---

## 七、关联文档

| 文档 | 关系 |
|------|------|
| `doc/design.cds.md` | CDS 架构设计（Widget 注入、Proxy、WebSocket 代理） |
| `doc/plan.cds-deployment.md` | CDS 部署计划（环境变量、端口分配） |
| [alibaba/page-agent](https://github.com/alibaba/page-agent) | 复用其 page-controller + core 包 |

---

## 八、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| page-agent 包 API 不稳定 | 中 | 中 | 锁定版本，必要时 fork |
| Widget JS 体积过大影响页面加载 | 低 | 中 | page-controller 轻量（无截图/无 LLM），tree-shake 后 < 20KB |
| WebSocket 频繁断连 | 低 | 低 | 自动重连 + 会话 30 秒 TTL 保活 |
| Agent 操作导致页面崩溃 | 中 | 低 | 单指令 10 秒超时，eval 受限，崩溃后 Bridge 自动重连 |
