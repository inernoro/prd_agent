# Page Agent Bridge 操作规范

Agent 通过 CDS Bridge 操作预览页面时的强制规则。

## 端点 URL 规约（2026-04-19 核对)

> **分支 id 在 URL path 里,不在 body 里。** 历史上文档里有误把 branchId
> 写进 body、URL 用 `POST /api/bridge/command` 的版本 —— 那个会返回
> `Cannot POST /api/bridge/command` (404)。正确路径必须带 `:branchId`。

| 用途 | 方法 | URL |
|------|------|-----|
| 启动 Bridge session | POST | `/api/bridge/start-session` (branchId 放 body) |
| 结束 session | POST | `/api/bridge/end-session` (branchId 放 body) |
| **发送命令** | **POST** | **`/api/bridge/command/:branchId`** (branchId 放 path) |
| 读取页面 state | GET | `/api/bridge/state/:branchId` |
| 握手请求(可选) | POST | `/api/bridge/handshake-request` (branchId 放 body) |
| 查询握手状态 | GET | `/api/bridge/handshake-status/:id` |

源码真值见 `cds/src/routes/bridge.ts`。若 AI Agent 遇到 "Cannot POST
/api/bridge/..." 错误,先比对上表,多半是误把 branchId 写到了 body/URL
的错位置。

## 强制规则

### 1. 操作前必须带 description

每条 `POST /api/bridge/command/:branchId` 必须包含 `description` 字段，用中文描述操作意图。用户在 Widget 操作面板中看到的就是这个文字。

```bash
# ✅ 正确 (branchId 在 URL, description 在 body)
curl -X POST "$CDS/api/bridge/command/$BRANCH_ID" \
  -H "Content-Type: application/json" \
  -d '{"action":"click","params":{"index":6},"description":"点击「登录」按钮"}'

# ❌ 会 404 (branchId 漏了 URL)
curl -X POST "$CDS/api/bridge/command" \
  -d '{"branchId":"xxx","action":"click","params":{"index":6}}'

# ❌ 缺 description,用户看不懂 AI 要干啥
curl -X POST "$CDS/api/bridge/command/$BRANCH_ID" \
  -d '{"action":"click","params":{"index":6}}'
```

### 2. 页面内跳转用 `spa-navigate`，禁止 `navigate`

`navigate` 会全页面刷新，导致 `sessionStorage` 中的登录 token 丢失。登录后的所有页面跳转必须使用 `spa-navigate`。

```json
// ✅ 登录后跳转
{"action":"spa-navigate","params":{"url":"/literary"},"description":"跳转到文学创作页面"}
// ❌ 会丢 session
{"action":"navigate","params":{"url":"/literary"}}
```

`navigate` 仅用于：登录页（未登录状态，不怕丢 token）。

### 3. 必须 start-session / end-session

操作前必须调 `POST /api/bridge/start-session`，操作结束必须调 `POST /api/bridge/end-session`。Widget 只有在 session 激活后才开始轮询，避免在 Activity Monitor 中产生噪音。

```bash
# 开始
curl -X POST "$CDS/api/bridge/start-session" -d '{"branchId":"xxx"}'
# ...操作...
# 结束
curl -X POST "$CDS/api/bridge/end-session" -d '{"branchId":"xxx","summary":"完成了登录和缺陷评论"}'
```

### 4. 操作前先 snapshot

每次操作序列开始时，先发一条 `snapshot` 获取最新 DOM 和元素索引。元素索引在页面变化后会失效。

### 4. 登录流程标准化

```
1. navigate → /login              （未登录可用 navigate）
2. type index:0 "用户名" clear:true
3. type index:1 "密码" clear:true
4. click index:2                   （登录按钮）
5. 等待 5s
6. snapshot                        （确认登录成功）
7. 之后只用 spa-navigate 和 click
```

### 5. 鼠标轨迹自动触发

`click` 和 `type` 操作会自动触发鼠标轨迹动画（光标移动 → 目标高亮 → 执行）。Agent 无需额外操作，Widget 自动处理视觉反馈。

## 指令参考

| action | 参数 | 说明 |
|--------|------|------|
| `snapshot` | `{}` | 读取页面 DOM + 状态 |
| `click` | `{index}` | 点击第 N 个可交互元素（带鼠标动画） |
| `type` | `{index, text, clear?}` | 在输入框中输入文本（带鼠标动画） |
| `scroll` | `{direction, pixels?}` | 滚动页面 |
| `spa-navigate` | `{url}` | SPA 内部跳转（不刷新页面） |
| `navigate` | `{url}` | 全页面跳转（仅用于登录页） |
| `evaluate` | `{script}` | 执行 JS（调试用） |
