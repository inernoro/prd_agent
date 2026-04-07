# Page Agent Bridge — 编码 Agent 的浏览器之眼

> **日期**：2026-04-06 | **状态**：已落地（HTTP 轮询 + 按需激活）
>
> 让编码 Agent 通过 CDS 预览页面的 Widget 读取 DOM、执行操作，形成"感知→决策→操作→反馈"闭环。

## 一、管理摘要

- **解决什么问题**：编码 Agent 部署代码后无法验证页面渲染结果，只能依赖 API 级别的冒烟测试
- **方案概述**：在 CDS Widget 中集成 Bridge Client，通过 HTTP 轮询与 CDS 端点通信，Agent 通过 REST API 读取页面状态并下发操作指令（带鼠标轨迹动画）
- **关键约束**：Bridge 运行在用户浏览器中，Agent 不能自行打开页面；需要用户打开预览页后 Agent 调用 `start-session` 激活
- **影响范围**：仅改动 CDS 模块（`cds/src/`），对主项目代码零侵入

---

## 二、会话生命周期

```
┌─ Agent ─────────┐    ┌─ CDS Server ────────┐    ┌─ Widget (浏览器) ──────────┐
│                  │    │                      │    │                            │
│ start-session ──────>│ activeSessions.add()  │    │ 每10s GET /check           │
│                  │    │                      │<───│ {active:false} → 不轮询    │
│                  │    │                      │    │                            │
│                  │    │ (Agent激活后)         │<───│ {active:true} → 激活!      │
│                  │    │                      │    │ 启动3s心跳轮询             │
│                  │    │                      │    │                            │
│ command ────────────>│ pendingCommands.push() │    │                            │
│ (await响应)      │    │                      │<───│ POST /heartbeat            │
│                  │    │ 返回命令 ────────────────>│ 光标移动→高亮→执行          │
│                  │    │                      │<───│ POST /result               │
│ <── 响应 ───────────│ resolve(Promise)      │    │                            │
│                  │    │                      │    │                            │
│ end-session ────────>│ 队列 __end_session    │    │                            │
│                  │    │                      │<───│ 取到 __end_session         │
│                  │    │                      │    │ "✅ AI 操作完成"            │
│                  │    │ endSession()         │    │ 停止轮询                   │
└──────────────────┘    └──────────────────────┘    └────────────────────────────┘
```

### 三种状态

| Widget 状态 | 触发条件 | 行为 |
|------------|---------|------|
| **休眠** | 默认 / end-session 后 | 每 10s 轻量 GET `/check` 检查激活，无 Activity 噪音 |
| **活跃** | Agent 调 `start-session` | 每 3s POST `/heartbeat` 上报状态 + 拉取命令 |
| **执行中** | 收到命令 | 鼠标轨迹动画 → 高亮目标 → 执行操作 → 回传结果 |

---

## 三、数据流详解

### 3.1 命令执行完整链路

```
Agent                          CDS BridgeService               Widget
  │                               │                               │
  │ POST /command ────────────────>│                               │
  │ {action:"click",              │ conn.pendingCommands.push(cmd)│
  │  params:{index:6},            │ new Promise(resolve)          │
  │  description:"点击登录"}       │ 15s 超时定时器启动             │
  │ (阻塞等待...)                 │                               │
  │                               │         POST /heartbeat ◄────│
  │                               │ heartbeat() → shift队首命令   │
  │                               │ {command: cmd} ──────────────>│
  │                               │                               │
  │                               │                    ┌──────────┤
  │                               │                    │ 动画序列  │
  │                               │                    │ ① 光标移动│
  │                               │                    │   (400ms) │
  │                               │                    │ ② 高亮目标│
  │                               │                    │   (200ms) │
  │                               │                    │ ③ 执行操作│
  │                               │                    │ ④ 高亮淡出│
  │                               │                    │   (3s)    │
  │                               │                    └──────────┤
  │                               │                               │
  │                               │         POST /result ◄────────│
  │                               │ submitResult()                │
  │                               │   resolve(response) ─────────>│
  │ <── BridgeResponse ──────────│                               │
  │ {success, state}              │                               │
```

### 3.2 数据结构

```typescript
// Agent → CDS
interface BridgeCommand {
  id: string;              // 4字节十六进制，匹配响应用
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'spa-navigate' | 'evaluate' | 'snapshot';
  params: Record<string, unknown>;
  description?: string;    // 显示在 Widget 操作面板中
}

// CDS → Agent（每个命令的响应）
interface BridgeResponse {
  id: string;
  success: boolean;
  error?: string;
  data?: string;           // evaluate 的返回值
  state: PageState;        // 操作后的最新页面状态
}

// Widget 每次心跳上报
interface PageState {
  url: string;
  title: string;
  domTree: string;         // 简化 DOM（交互元素带 [index]）
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  consoleErrors: string[]; // 最近 20 条 console.error
  networkErrors: string[]; // 最近 10 条失败网络请求
  timestamp: number;
}
```

---

## 四、REST API

### 4.1 Agent 调用的端点

| 端点 | 方法 | 用途 | Activity 可见 |
|------|------|------|:---:|
| `/api/bridge/start-session` | POST | 激活会话，Widget 开始轮询 | ✓ |
| `/api/bridge/connections` | GET | 查看活跃连接 | ✓ |
| `/api/bridge/state/:branchId` | GET | 读取最新页面状态 | ✓ |
| `/api/bridge/command/:branchId` | POST | 下发操作指令（同步等待） | ✓ |
| `/api/bridge/navigate-request` | POST | 请求用户打开页面 | ✓ |
| `/api/bridge/end-session` | POST | 结束操作，Widget 停止轮询 | ✓ |

### 4.2 Widget 内部端点（Activity 中隐藏）

| 端点 | 方法 | 用途 | 频率 |
|------|------|------|------|
| `/api/bridge/check/:branchId` | GET | 轻量激活检查（无 body） | 每 10s |
| `/api/bridge/heartbeat` | POST | 心跳 + 上报状态 + 拉取命令 | 每 3s（活跃时） |
| `/api/bridge/result` | POST | 回传命令执行结果 | 按需 |
| `/api/bridge/navigate-requests/:branchId` | GET | 轮询导航请求 | 每 10s |

---

## 五、操作指令参考

| action | 参数 | 鼠标动画 | 说明 |
|--------|------|:---:|------|
| `snapshot` | `{}` | — | 读取 DOM + 状态 |
| `click` | `{index}` | ✓ | 点击第 N 个可交互元素 |
| `type` | `{index, text, clear?}` | ✓ | 输入文本（React 兼容） |
| `scroll` | `{direction, pixels?}` | — | 垂直滚动 |
| `spa-navigate` | `{url}` | — | SPA 内部跳转（不丢 session） |
| `navigate` | `{url}` | — | 全页面跳转（**仅登录页**） |
| `evaluate` | `{script}` | — | 执行 JS，返回值截断 10KB |

### spa-navigate 实现

> **设计决策**：最初尝试了四种策略（找 `<a>` 点击 → 注入 `<a>` → 文字匹配按钮 → pushState），全部失败——React Router v6 BrowserRouter 不拦截原生 `<a>` 点击，pushState 不触发路由更新。

**最终方案：CustomEvent + NavigationBridge 组件**

```
Widget (非 React)                         React App
  │                                         │
  │ dispatchEvent(CustomEvent               │
  │   'bridge:navigate',                    │
  │   {detail:{path:'/report-agent'}})      │
  │ ─────────────────────────────────────>  │
  │                                         │ NavigationBridge 组件
  │                                         │ useEffect 监听 'bridge:navigate'
  │                                         │ → navigate(path)
  │                                         │ React Router 正常 SPA 导航
```

- **React 端**：`App.tsx` 新增 `NavigationBridge` 组件，用 `useNavigate()` 监听 window 的 `bridge:navigate` CustomEvent
- **Widget 端**：`spa-navigate` 简化为一行 `dispatchEvent`
- **为什么可靠**：CustomEvent 是标准 DOM API，不受框架限制；`useNavigate()` 是 React Router 官方导航方式

---

## 六、视觉反馈系统

### 6.1 鼠标轨迹

- 渐变蓝色 SVG 箭头光标 + 旋转光环 + 辉光呼吸动画
- `click`/`type` 操作前：光标从当前位置平滑移动到目标元素中心（400ms 贝塞尔曲线）
- 到达后停留，光标不自动消失

### 6.2 目标高亮

- 到达目标后：蓝色脉冲高亮框（`cds-el-highlight`）
- 操作执行后：高亮切换为 3 秒淡出（`cds-el-highlight-fade`）
- 光标保持停留在最后操作位置

### 6.3 操作面板

- Badge 上方自动弹出，显示步骤列表
- 每步状态图标：○等待 → ◎执行中 → ✓完成 / ✗失败
- `end-session` 时显示「✅ AI 操作完成」
- 所有步骤完成 15 秒后自动隐藏

---

## 七、关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 通信方式 | HTTP 轮询（非 WebSocket） | WebSocket 通过 4 层代理不稳定（心跳 PING 断连） |
| 激活模式 | 按需（非自动） | 避免页面打开就产生"Bridge 已连接"噪音 |
| 命令队列 | 数组 FIFO（非单槽） | 防止 Agent 连发命令覆盖丢失 |
| Activity 过滤 | heartbeat/result/check 隐藏 | 只保留有意义的 start/command/end |
| Session 存储 | sessionStorage（非 localStorage） | 项目规则禁止 localStorage |
| SPA 导航 | CustomEvent + React NavigationBridge | useNavigate() 只能在组件内，CustomEvent 是唯一可靠的跨层通信 |
| DOM 提取格式 | `[index]<tag attrs> text />`  | 参考 page-agent 的 flatTreeToString |
| end-session 清理 | Widget 响应后清理（非固定延迟） | 避免"Widget 已停止但连接仍在"的窗口 |

---

## 八、超时与容量

| 参数 | 值 | 说明 |
|------|-----|------|
| 命令超时 | 15s | Widget 未响应则返回 timeout 错误 |
| 连接 TTL | 20s | 无心跳 20 秒视为断连 |
| 心跳间隔（活跃） | 3s | 激活后的轮询频率 |
| 激活检查间隔 | 10s | 休眠时的轻量检查 |
| DOM 最大深度 | 15 层 | 防止超深 DOM 卡死 |
| DOM 最大节点 | 500 个 | 防止超大页面卡死 |
| Console 错误上限 | 20 条 | Ring buffer |
| Network 错误上限 | 10 条 | Ring buffer |
| 操作面板最大步骤 | 8 条 | 最新 8 条 |
| evaluate 返回值上限 | 10KB | 截断防爆 |

---

## 九、文件索引

| 层级 | 文件 | 职责 |
|------|------|------|
| 服务层 | `cds/src/services/bridge.ts` | BridgeService：连接管理 + 命令队列 + 会话生命周期 |
| 路由层 | `cds/src/routes/bridge.ts` | REST API 端点定义 |
| 集成层 | `cds/src/server.ts` | 路由挂载 + Activity 过滤 |
| 初始化 | `cds/src/index.ts` | BridgeService 实例化 + activity 回调 |
| 浏览器端 | `cds/src/widget-script.ts` | Bridge Client 全部逻辑（DOM 提取/操作执行/动画/轮询） |
| React 桥接 | `prd-admin/src/app/App.tsx` | NavigationBridge 组件（监听 CustomEvent → useNavigate） |
| 规则 | `.claude/rules/bridge-ops.md` | Agent 使用 Bridge 的强制规则 |
| 技能 | `.claude/skills/bridge/SKILL.md` | `/bridge` 技能文档 |

---

## 十、已知限制

| # | 限制 | 影响 | 规避方案 |
|---|------|------|---------|
| 1 | `navigate` 丢 session | 全页面刷新清空 sessionStorage | 登录后只用 `spa-navigate` 或 `click` |
| 2 | 首页卡片文字为空 | DOM 提取拿不到图片/CSS 渲染的内容 | 用 `evaluate` 搜索 textContent |
| 3 | 命令最大延迟 3s | 轮询间隔决定 | 可调小但增加服务器负载 |
| 4 | 需要用户打开页面 | Agent 不能自行打开浏览器 | 发 navigate-request 请用户打开 |
| 5 | 模板字符串中正则转义 | `\/` 在 TS 模板中变成 `/` | 避免正则，用字符串方法替代 |

### 已解决的历史限制

| 问题 | 解决方案 |
|------|---------|
| SPA 导航不生效 | `NavigationBridge` 组件 + `CustomEvent`（`prd-admin/src/app/App.tsx`）|
| 命令连发覆盖丢失 | 单槽改为 FIFO 数组队列 |
| Widget 自动连接噪音 | 按需激活（start-session / end-session）|
| WebSocket 四层代理断连 | 改用 HTTP 轮询 |

---

## 十一、关联文档

- `doc/design.cds.md` — CDS 核心架构
- `.claude/rules/bridge-ops.md` — Bridge 操作强制规则
- `.claude/skills/bridge/SKILL.md` — `/bridge` 技能使用指南
- alibaba/page-agent — DOM 提取格式参考
